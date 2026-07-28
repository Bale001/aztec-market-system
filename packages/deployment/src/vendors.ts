// Vendor pipeline (M4, AD-4). Account model: a vendor's on-chain identity IS
// their per-market account address (msg_sender); there is no derived
// pseudonym and no userSecret. A user first claims a username (registerUser),
// then registers as a vendor from that same account. Deposits move from the
// account's private token balance into the marketplace's public balance
// (fund the per-market account privately from the universal account first)
// and return through a privately prepared partial note.
//
// Follows the same verify-everything rules as deploy.ts: read back what was
// written, throw on the first inconsistency, no fallbacks.

import { AztecAddress } from '@aztec/aztec.js/addresses';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { MarketplaceContract } from '@market/contract-bindings';
import { deriveUsernameHash } from '@market/identity';
import { VendorPolicy, VendorStatus } from '@market/shared-types';

import { asBigInt, asFr } from './deploy.js';
import { sendActingAs, type ActingExtras } from './act.js';
import { ensureContractRegistered, type RegistersContracts } from './register.js';

/** On-chain vendor record, keyed by the vendor's account address (as a field). */
export interface VendorRecord {
  vendorId: Fr;
  status: VendorStatus;
  deposit: bigint;
  depositAsset: Fr;
  withdrawalRequestedAt: bigint;
  activeOrders: bigint;
}

interface VendorSessionOptions {
  wallet: Wallet & RegistersContracts;
  /** Node the wallet is connected to; used to register contract instances. */
  node: AztecNode;
  from: AztecAddress;
  /** Who sends and pays (defaults to `from`); see sendActingAs. */
  sender?: AztecAddress;
  marketplaceAddress: AztecAddress;
}

async function marketplaceAt(options: VendorSessionOptions) {
  await ensureContractRegistered(
    options.wallet,
    options.node,
    options.marketplaceAddress,
    MarketplaceContract.artifact,
    'marketplace',
  );
  return MarketplaceContract.at(options.marketplaceAddress, options.wallet);
}

/**
 * Claims a username for the caller's per-market account (the account-model
 * prerequisite for becoming a vendor, and what makes the account addressable
 * by handle). The plaintext username never touches the chain -- only the
 * commitment hash(username, accessSecret). Reads the commitment back.
 */
export async function registerUser(
  options: VendorSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    /** The market access secret; the username hash is bound to it. */
    accessSecret: Fr;
    username: string;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string; usernameHash: Fr }> {
  const { from } = options;
  const usernameHash = await deriveUsernameHash(options.username, options.accessSecret);

  const marketplace = await marketplaceAt(options);
  const { txHash } = await sendActingAs(options, (account, nonce) =>
    marketplace.methods.register(usernameHash, account, nonce),
  );

  const stored = asFr(
    (await marketplace.methods.get_username_hash(from.toField()).simulate({ from })).result,
    'get_username_hash',
  );
  if (!stored.equals(usernameHash)) {
    throw new Error('username hash read back from the contract does not match what was registered');
  }
  return { txHash, usernameHash };
}

/**
 * Resolves a registered username to its account address (users_forward).
 * Throws if no account claimed that username on this market: the caller is
 * about to target the account (appoint a moderator, suspend a vendor), and a
 * silent zero-address would target nobody.
 */
export async function resolveUsername(
  options: VendorSessionOptions & { username: string; accessSecret: Fr },
): Promise<AztecAddress> {
  const usernameHash = await deriveUsernameHash(options.username, options.accessSecret);
  const marketplace = await marketplaceAt(options);
  const address = asFr(
    (await marketplace.methods.get_user_address(usernameHash).simulate({ from: options.from }))
      .result,
    'get_user_address',
  );
  if (address.isZero()) {
    throw new Error(`no account has registered the username "${options.username}" on this market`);
  }
  return AztecAddress.fromFieldUnsafe(address);
}

/**
 * Whether a username is already claimed on this market (a free simulation).
 *
 * Unlike {@link resolveUsername} -- which targets an account it expects to
 * exist and throws when it does not -- absence is the EXPECTED, useful answer
 * here: it means the name is available. Use it to check a handle before
 * spending a transaction on `registerUser`. Advisory only: two claims can race,
 * so the contract's own "username is already taken" assert remains the guard.
 */
export async function isUsernameTaken(
  options: VendorSessionOptions & { username: string; accessSecret: Fr },
): Promise<boolean> {
  const usernameHash = await deriveUsernameHash(options.username, options.accessSecret);
  const marketplace = await marketplaceAt(options);
  const address = asFr(
    (await marketplace.methods.get_user_address(usernameHash).simulate({ from: options.from }))
      .result,
    'get_user_address',
  );
  return !address.isZero();
}

/**
 * Reads an account's on-chain username commitment (hash(username,
 * accessSecret)), or Fr.ZERO if the account has claimed no username. Used to
 * verify a listing's "Sold by: <username>": recompute deriveUsernameHash on the
 * plaintext handle from the sealed document and compare to this.
 */
export async function getUsernameHash(
  options: VendorSessionOptions & { account: Fr },
): Promise<Fr> {
  const marketplace = await marketplaceAt(options);
  return asFr(
    (await marketplace.methods.get_username_hash(options.account).simulate({ from: options.from })).result,
    'get_username_hash',
  );
}

/**
 * Verifies that a listing's plaintext username is the one its creator committed
 * on-chain: true iff the creator has a registered username and it equals
 * hash(username, accessSecret). A false result means the listing is claiming a
 * handle its creator never registered (or none at all) -- display as unverified.
 */
export async function verifyVendorUsername(
  options: VendorSessionOptions & { account: Fr; username: string; accessSecret: Fr },
): Promise<boolean> {
  const stored = await getUsernameHash(options);
  if (stored.isZero()) {
    return false;
  }
  const expected = await deriveUsernameHash(options.username, options.accessSecret);
  return stored.equals(expected);
}

/** Reads the vendor record for a vendor account (its address as a field). */
export async function getVendorRecord(
  options: VendorSessionOptions & { vendorId: Fr },
): Promise<VendorRecord> {
  const marketplace = await marketplaceAt(options);
  const record = (
    await marketplace.methods.get_vendor(options.vendorId).simulate({ from: options.from })
  ).result as {
    status: bigint;
    deposit: bigint;
    deposit_asset: AztecAddress;
    withdrawal_requested_at: bigint;
    active_orders: bigint;
  };
  return {
    vendorId: options.vendorId,
    status: Number(record.status) as VendorStatus,
    deposit: record.deposit,
    depositAsset: record.deposit_asset.toField(),
    withdrawalRequestedAt: record.withdrawal_requested_at,
    activeOrders: record.active_orders,
  };
}

export interface RegisterVendorOptions extends VendorSessionOptions {
  fee?: { paymentMethod: FeePaymentMethod };
  /**
   * Deposit terms, required exactly when the market's vendor policy demands
   * a deposit. The vendor identity is `from` (the per-market account), but the
   * deposit is funded by `payer` (defaults to `from`; typically the universal
   * wallet, so no per-market top-up hop is needed). The token must expose
   * transfer_private_to_public, and the wallet must authwit for `payer`.
   */
  deposit?: {
    tokenAddress: AztecAddress;
    amount: bigint;
    /** Account whose cUSDC funds the deposit (defaults to `from`). */
    payer?: AztecAddress;
    createTransferInteraction: (
      from: AztecAddress,
      to: AztecAddress,
      amount: bigint,
      authwitNonce: Fr,
    ) => Promise<{ request(): Promise<{ calls: { name?: string }[] }> }>;
  };
  txTimeoutSeconds?: number;
}

export interface RegisteredVendor {
  vendorId: Fr;
  status: VendorStatus;
  txHash: string;
}

/**
 * Registers `from` (a per-market account that has already claimed a username)
 * as a vendor. On deposit-requiring markets the deposit moves in the same
 * transaction, authorized by an authwit for the marketplace to pull the
 * tokens. Reads the record back and returns the resulting status.
 */
export async function registerVendor(options: RegisterVendorOptions): Promise<RegisteredVendor> {
  const { wallet, from, deposit } = options;

  const marketplace = await marketplaceAt(options);

  const config = (await marketplace.methods.get_config().simulate({ from })).result as {
    payment_asset: AztecAddress;
    vendor_policy: bigint;
    vendor_deposit: bigint;
  };
  const policy = Number(config.vendor_policy) as VendorPolicy;
  const requiresDeposit = policy === VendorPolicy.Deposit || policy === VendorPolicy.Both;
  if (requiresDeposit && deposit === undefined) {
    throw new Error(
      `this market's vendor policy requires a deposit of ${config.vendor_deposit} ` +
        `of token ${config.payment_asset.toString()}`,
    );
  }
  if (!requiresDeposit && deposit !== undefined) {
    throw new Error("this market's policy takes no deposit");
  }

  const vendorId = from.toField();

  // The deposit half of register_vendor's argument list; zeroed on markets
  // that take no deposit.
  let depositArgs: [AztecAddress, bigint, AztecAddress, Fr];
  const extras: ActingExtras = {};
  if (deposit) {
    if (deposit.amount !== config.vendor_deposit) {
      throw new Error(
        `deposit amount ${deposit.amount} does not match the configured ` +
          `vendor_deposit ${config.vendor_deposit}`,
      );
    }
    if (!deposit.tokenAddress.toField().equals(config.payment_asset.toField())) {
      throw new Error(
        `deposit token ${deposit.tokenAddress.toString()} is not the configured ` +
          `payment asset ${config.payment_asset.toString()}`,
      );
    }
    const depositPayer = deposit.payer ?? from;
    const authwitNonce = Fr.random();
    const transfer = await deposit.createTransferInteraction(
      depositPayer,
      options.marketplaceAddress,
      deposit.amount,
      authwitNonce,
    );
    const payload = await transfer.request();
    const call = payload.calls[0];
    if (call === undefined) {
      throw new Error('transfer interaction produced no calls');
    }
    const witness = await wallet.createAuthWit(depositPayer, {
      caller: options.marketplaceAddress,
      call: call as never,
    });
    depositArgs = [deposit.tokenAddress, deposit.amount, depositPayer, authwitNonce];
    extras.authWitnesses = [witness];
    // When the deposit is funded by a different account (the universal wallet),
    // its cUSDC notes must be in the proving scope for the private transfer.
    if (!depositPayer.equals(from)) {
      extras.scopes = [depositPayer];
    }
  } else {
    depositArgs = [AztecAddress.ZERO, 0n, from, Fr.ZERO];
  }

  const { txHash } = await sendActingAs(
    options,
    (account, nonce) => marketplace.methods.register_vendor(...depositArgs, account, nonce),
    extras,
  );

  const record = await getVendorRecord({ ...options, vendorId });
  if (record.status === VendorStatus.None) {
    throw new Error('vendor record missing after registration transaction succeeded');
  }
  return { vendorId, status: record.status, txHash };
}

/**
 * Approve a pending vendor, or suspend/reinstate one. Account model: a private
 * call from the owner's or a PERM_MANAGE_VENDORS moderator's per-market
 * account (msg_sender), targeting the vendor by their account address.
 */
export async function setVendorStatus(
  options: VendorSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    vendor: AztecAddress;
    status: VendorStatus.Active | VendorStatus.Suspended;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const { vendor, status } = options;
  const marketplace = await marketplaceAt(options);
  const { txHash } = await sendActingAs(options, (account, nonce) =>
    marketplace.methods.set_vendor_status(vendor, status, account, nonce),
  );

  const record = await getVendorRecord({ ...options, vendorId: vendor.toField() });
  if (record.status !== status) {
    throw new Error(
      `vendor status is ${record.status} after setting it to ${status} -- ` +
        'a concurrent transaction changed it',
    );
  }
  return { txHash };
}

/** Enumerates all vendors (admin dashboards): index -> vendor address -> record. */
export async function listVendors(options: VendorSessionOptions): Promise<VendorRecord[]> {
  const marketplace = await marketplaceAt(options);
  const count = asBigInt(
    (await marketplace.methods.get_vendor_count().simulate({ from: options.from })).result,
    'get_vendor_count',
  );
  const vendors: VendorRecord[] = [];
  for (let i = 0n; i < count; i++) {
    const vendorId = asFr(
      (await marketplace.methods.get_vendor_id_at(i).simulate({ from: options.from })).result,
      'get_vendor_id_at',
    );
    const record = await getVendorRecord({ ...options, vendorId });
    if (record.status === VendorStatus.None) {
      throw new Error(`vendor index ${i} points at an unregistered vendor`);
    }
    vendors.push(record);
  }
  return vendors;
}

/**
 * Starts the deposit withdrawal clock. The deposit becomes withdrawable after
 * the withdrawal delay (order_timeout), provided the vendor has no active orders.
 */
export async function requestDepositWithdrawal(
  options: VendorSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const marketplace = await marketplaceAt(options);
  return sendActingAs(options, (account, nonce) =>
    marketplace.methods.request_deposit_withdrawal(account, nonce),
  );
}

/**
 * Withdraws the whole deposit into `recipient`'s PRIVATE token balance via a
 * partial note (defaults to `from`; pass the universal wallet to return it
 * where it was funded from). Fails on chain if the delay has not elapsed or
 * active orders exist.
 */
export async function executeDepositWithdrawal(
  options: VendorSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    tokenAddress: AztecAddress;
    /** Account the deposit is returned to (defaults to `from`). */
    recipient?: AztecAddress;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const { from, tokenAddress } = options;
  const recipient = options.recipient ?? from;
  const marketplace = await marketplaceAt(options);
  const { txHash } = await sendActingAs(options, (account, nonce) =>
    marketplace.methods.execute_deposit_withdrawal(tokenAddress, recipient, account, nonce),
  );

  const record = await getVendorRecord({ ...options, vendorId: from.toField() });
  if (record.deposit !== 0n) {
    throw new Error(`deposit is ${record.deposit} after withdrawal transaction succeeded`);
  }
  return { txHash };
}
