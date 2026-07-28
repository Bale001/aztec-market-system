// Wallet/session plumbing (account model).
//
// A user has ONE universal account and, per market, one or more per-market
// accounts derived from it:
//
// - VIEWER (connect): read-only. A throwaway, never-deployed account for
//   simulations (resolving markets, reading state). Free.
//
// - UNIVERSAL (connectUniversal): the L1-facing account. Initializerless
//   (free to stand up), persistent (keys in localStorage). It holds the real
//   cUSDC and the private fee-juice credit inside the shared PrivateFPC, and
//   it NEVER registers on any market. It funds escrow/deposits for the
//   per-market accounts and pays its own fees from its FPC credit. This is the
//   "Wallet" tab's account.
//
// - PER-MARKET (connectMarketAccount): the actor on a market. Derived
//   deterministically from the universal seed + the market access secret +
//   an index (so a user can hold several accounts per market), initializerless
//   (free, never deployed). Its ADDRESS is the market identity (msg_sender);
//   the vendor/mod/owner a user is on a market IS one of these accounts.
//
//   It is an INBOX ONLY: it RECEIVES (vendor earnings settle to vendor_inbox =
//   this address) but never PAYS for anything -- purchases and vendor deposits
//   come straight from the universal wallet. It holds no fee-juice credit
//   either, so it cannot fund its own withdrawal: the "My account" page moves
//   the balance out with the UNIVERSAL wallet as tx sender + fee payer and this
//   account merely authorizing the debit by authwit (see pullCusdc).
//
// FEES: the universal account pays from its own credit inside the shared
// PrivateFPC (Wonderland's standard contract, canonical instance -- the widest
// possible anonymity set). Per-market accounts (vendor/moderator/owner) pay via
// the SPONSORED FPC, which exists on the sandbox and testnet. The standard FPC
// has no delegated-payer call, so on a network without a sponsored FPC those
// accounts would need their own funding path -- revisit before mainnet.
//
// BUYING is done DIRECTLY by the universal account: it places, owns, pays, and
// settles orders (no per-market buyer account). Two facts make this the right
// call:
//   1. Bridging L1->L2 does NOT reveal the L2 address, so the universal account
//      is not L1-linked -- it is just a pseudonymous account.
//   2. cUSDC (aztec-standards) delivers ALL private transfers constrained; there
//      is no unconstrained transfer. So the old "traceless" universal->per-market
//      top-up hop is no longer traceless -- it registers a universal<->per-market
//      handshake, and the per-market->marketplace escrow registers another, which
//      an observer can chain. Routing buyers through a per-market account
//      therefore buys ZERO cross-market unlinkability now, at real complexity.
// So the universal account pays escrow directly (place_order's `payer` == the
// buyer == universal). Per-market accounts remain for VENDOR/MODERATOR/OWNER
// roles (msg_sender identity), not for buying.

import { NO_FROM } from '@aztec/aztec.js/account';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod, type FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { MarketplaceRegistryContract } from '@market/contract-bindings';
import { CANONICAL_FPC_SALT, FPCFeePaymentMethod, registerPrivateFpc } from '@market/deployment';
import { deriveMarketAccountKeys } from '@market/identity';

import { installSpendGate, setUserFeePayer } from './spend.js';

export interface Session {
  wallet: EmbeddedWallet;
  node: AztecNode;
  from: AztecAddress;
  /** The node URL this session connected to (used for network/token resolution). */
  nodeUrl: string;
}

/** Persisted universal-account key material (hex strings); the exportable seed. */
export interface AccountKeys {
  secretKey: string;
  salt: string;
  signingKey: string;
}

/** The universal-account session (the Wallet tab): holds cUSDC + FPC credit. */
export interface UniversalSession extends Session {
  /** Fee payment from the universal account's own shared-FPC credit. */
  paymentMethod: FeePaymentMethod;
  fpcAddress: AztecAddress;
  /** Dev bootstrap fee path (sponsored FPC) for funding/first-tx. */
  bootstrapPaymentMethod: SponsoredFeePaymentMethod;
  /** The exportable universal seed keys. */
  accountKeys: AccountKeys;
}

/** A market session: acting AS a per-market account on a specific market. */
export interface TransactionalSession extends Session {
  /** The L1-facing universal account: funds escrow/deposits, never on a market. */
  universal: AztecAddress;
  /**
   * Gas payment for the UNIVERSAL account (its private FPC credit). It sends
   * and pays for EVERY market transaction -- buyer operations directly, and
   * per-market-account actions by delegation (see {@link marketAction}).
   */
  universalPaymentMethod: FeePaymentMethod;
  fpcAddress: AztecAddress;
  /** The market access secret (the link); derives this per-market account. */
  accessSecret: Fr;
  /** Which per-market account (0 = the default/anonymous one). */
  accountIndex: number;
  /** The exportable universal seed keys. */
  accountKeys: AccountKeys;
}

/**
 * The send/pay half of any marketplace call made AS the per-market account:
 * the universal wallet sends the transaction and pays its fee, while the
 * per-market account stays the on-chain identity (proven by an authwit the
 * deployment layer builds). Spread this into a wrapper's options alongside
 * `from: session.from`.
 *
 * Buyer operations (place_order, cancel, confirm, claim_refund, dispute) act as
 * the universal account itself -- they pass `from: session.universal` and
 * `fee: { paymentMethod: session.universalPaymentMethod }` directly instead.
 */
export function marketAction(session: TransactionalSession): {
  sender: AztecAddress;
  fee: { paymentMethod: FeePaymentMethod };
} {
  return {
    sender: session.universal,
    fee: { paymentMethod: session.universalPaymentMethod },
  };
}

const UNIVERSAL_STORAGE_KEY = 'market.universal.v1';

// ONE EmbeddedWallet per app, shared by every session. v5's PXE keeps state in
// a SQLite-OPFS store that allows only ONE sync access handle per file per
// origin, so a second EmbeddedWallet.create in the same renderer would fail.
let sharedWallet: {
  nodeUrl: string;
  promise: Promise<{ node: AztecNode; wallet: EmbeddedWallet }>;
} | null = null;

async function getSharedWallet(nodeUrl: string): Promise<{ node: AztecNode; wallet: EmbeddedWallet }> {
  installSpendGate();
  if (sharedWallet !== null && sharedWallet.nodeUrl !== nodeUrl) {
    const old = await sharedWallet.promise.catch(() => null);
    sharedWallet = null;
    if (old !== null) {
      await old.wallet.stop();
    }
  }
  if (sharedWallet === null) {
    const entry = {
      nodeUrl,
      promise: (async () => {
        const node = createAztecNodeClient(nodeUrl);
        // The local sandbox accepts fake proofs and is thrown away each run, so
        // dev stays fast with ephemeral state + no proving. ANY other node (the
        // testnet) REQUIRES real proofs, and wants a persistent store so notes/
        // orders survive restarts and each launch doesn't re-sync real history.
        const isLocal = /localhost|127\.0\.0\.1/.test(nodeUrl);
        const wallet = await EmbeddedWallet.create(node, {
          ephemeral: isLocal,
          pxeConfig: { proverEnabled: !isLocal },
        });
        return { node, wallet };
      })(),
    };
    entry.promise.catch(() => {
      if (sharedWallet === entry) {
        sharedWallet = null;
      }
    });
    sharedWallet = entry;
  }
  return sharedWallet.promise;
}

/**
 * Salt for the single shared PrivateFPC instance: Wonderland's CANONICAL one, so
 * every wallet registers the same standard FPC address and the fee-payment
 * anonymity set spans every project using it -- not just this marketplace.
 * Version-pinned (see CANONICAL_FPC_AZTEC_VERSION); refresh on an Aztec upgrade.
 */
export const MARKET_FPC_SALT = CANONICAL_FPC_SALT;

export async function connect(nodeUrl: string): Promise<Session> {
  const { node, wallet } = await getSharedWallet(nodeUrl);
  // Local-only viewer identity; not deployed, not funded.
  const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  return { wallet, node, from: account.address, nodeUrl };
}

export function loadStoredAccountKeys(): AccountKeys | null {
  const raw = localStorage.getItem(UNIVERSAL_STORAGE_KEY);
  if (raw === null) {
    return null;
  }
  const parsed = JSON.parse(raw) as AccountKeys;
  if (!parsed.secretKey || !parsed.salt || !parsed.signingKey) {
    throw new Error('stored account keys are malformed; clear app data to reset');
  }
  return parsed;
}

export function storeAccountKeys(keys: AccountKeys): void {
  localStorage.setItem(UNIVERSAL_STORAGE_KEY, JSON.stringify(keys));
}

/** Loads the universal-account keys (the seed), creating+storing them if absent. */
export function loadOrCreateAccountKeys(): AccountKeys {
  const stored = loadStoredAccountKeys();
  if (stored !== null) {
    return stored;
  }
  const keys: AccountKeys = {
    secretKey: Fr.random().toString(),
    salt: Fr.random().toString(),
    signingKey: GrumpkinScalar.random().toString(),
  };
  storeAccountKeys(keys);
  return keys;
}

// Shared bootstrap: the sponsored FPC (dev fee path) and the shared PrivateFPC.
async function bootstrap(nodeUrl: string) {
  const { node, wallet } = await getSharedWallet(nodeUrl);

  const sponsoredFPC = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  const bootstrapPaymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);

  // The shared PrivateFPC (no deploy tx; same salt -> same address for all).
  const fpc = await registerPrivateFpc(wallet, MARKET_FPC_SALT);
  setUserFeePayer(fpc.address);

  return { node, wallet, fpcAddress: fpc.address, bootstrapPaymentMethod };
}

/** Creates the universal account (initializerless: usable with no deploy tx). */
async function universalAccount(wallet: EmbeddedWallet, keys: AccountKeys) {
  return wallet.createSchnorrInitializerlessAccount(
    Fr.fromString(keys.secretKey),
    Fr.fromString(keys.salt),
    GrumpkinScalar.fromString(keys.signingKey),
  );
}

export interface ConnectUniversalOptions {
  /** Keys pasted to restore a universal account on this device. */
  importedKeys?: AccountKeys;
  onProgress?: (message: string) => void;
}

/**
 * Opens the universal-account session (the Wallet tab). The universal account
 * is initializerless, so it needs no deploy; it pays its own fees from its
 * shared-FPC credit.
 */
export async function connectUniversal(
  nodeUrl: string,
  { importedKeys, onProgress }: ConnectUniversalOptions = {},
): Promise<UniversalSession> {
  const progress = onProgress ?? (() => {});
  progress('Connecting to the network…');
  const { node, wallet, fpcAddress, bootstrapPaymentMethod } = await bootstrap(nodeUrl);

  if (importedKeys !== undefined) {
    storeAccountKeys(importedKeys);
  }
  const accountKeys = loadOrCreateAccountKeys();
  const account = await universalAccount(wallet, accountKeys);

  return {
    wallet,
    node,
    from: account.address,
    nodeUrl,
    paymentMethod: new FPCFeePaymentMethod(fpcAddress),
    fpcAddress,
    bootstrapPaymentMethod,
    accountKeys,
  };
}

export interface ConnectMarketOptions {
  /** The market access secret (the link); derives the per-market account. */
  accessSecret: Fr;
  /** Which per-market account to act as (0 = default). */
  accountIndex: number;
  onProgress?: (message: string) => void;
}

/**
 * Opens a market session: derives (and creates, initializerless) the user's
 * per-market account at `accountIndex` for this market, ready to act as
 * msg_sender. Gas is paid by the sponsored FPC on dev; escrow/deposits are
 * paid by this account itself, topped up from the universal account via a
 * traceless private transfer (see the module note on ESCROW).
 */
export async function connectMarketAccount(
  nodeUrl: string,
  { accessSecret, accountIndex, onProgress }: ConnectMarketOptions,
): Promise<TransactionalSession> {
  const progress = onProgress ?? (() => {});
  progress('Connecting to the network…');
  const { node, wallet, fpcAddress } = await bootstrap(nodeUrl);

  const accountKeys = loadOrCreateAccountKeys();
  const universal = await universalAccount(wallet, accountKeys);

  progress('Preparing your market account…');
  const keys = await deriveMarketAccountKeys(
    Fr.fromString(accountKeys.secretKey),
    accessSecret,
    accountIndex,
  );
  const perMarket = await wallet.createSchnorrInitializerlessAccount(
    keys.secret,
    keys.salt,
    keys.signingKey,
  );

  return {
    wallet,
    node,
    from: perMarket.address,
    nodeUrl,
    universal: universal.address,
    // The universal account pays for everything from its own private FPC
    // credit; the per-market account is an inbox and holds no fee juice.
    universalPaymentMethod: new FPCFeePaymentMethod(fpcAddress),
    fpcAddress,
    accessSecret,
    accountIndex,
    accountKeys,
  };
}

/**
 * Forces the idle local network to build `count` blocks via throwaway account
 * deploys (paid by the bootstrap path). Used to let a pending L1->L2 fee-juice
 * message land in the message tree. Dev/local-network only.
 */
export async function advanceBlocks(session: { wallet: EmbeddedWallet; bootstrapPaymentMethod: SponsoredFeePaymentMethod }, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const account = await session.wallet.createSchnorrAccount(
      Fr.random(),
      Fr.random(),
      GrumpkinScalar.random(),
    );
    const deployMethod = await account.getDeployMethod();
    await deployMethod.send({
      from: NO_FROM,
      fee: { paymentMethod: session.bootstrapPaymentMethod },
      wait: { timeout: 120 },
    });
  }
}

/** Local-dev convenience: deploy a fresh global registry, paid via the FPC. */
export async function deployRegistry(session: UniversalSession): Promise<AztecAddress> {
  const { contract } = await MarketplaceRegistryContract.deploy(session.wallet).send({
    from: session.from,
    fee: { paymentMethod: session.paymentMethod },
    wait: { timeout: 180 },
  });
  return contract.address;
}
