// The Creator's deploy pipeline (spec sec.22 steps 10-16, sec.24, sec.26),
// hidden-markets edition (AD-2) with fully on-chain data (AD-3): every market
// is hidden behind an access secret, and everything a market needs lives on
// the chain itself -- there is no off-chain publisher to depend on.
//
//   1. generate the market access secret (or use the caller's)
//   2. validate + canonicalize the metadata, seal it (AES-256-GCM under a
//      key derived from the secret)
//   3. deploy the Marketplace contract with the sealed blob as constructor
//      data (config taken from the document's onchain mirror, so mirror and
//      chain cannot diverge at deploy time)
//   4. cross-check the contract's marketplace_id against the client-side
//      derivation (creator, nonce, config commitment)
//   5. register in the global registry under
//      lookup_key = poseidon2(secret, DOMAIN_MARKET_LOOKUP)
//   6. read the registry entry back and require it is ours (front-run guard)
//
// The access secret never leaves the client: on-chain there is only the
// lookup key and ciphertext. Every step verifies; nothing is retried or
// defaulted. Throws on the first inconsistency.

import { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractClassFromArtifact } from '@aztec/aztec.js/contracts';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { MarketplaceContract, MarketplaceRegistryContract } from '@market/contract-bindings';
import {
  deriveMarketLookupKey,
  deriveMarketplaceId,
  deriveUsernameHash,
  generateMarketAccessSecret,
} from '@market/identity';
import {
  bytesToFields,
  fieldsToBytes,
  openMetadata,
  sealMetadata,
  toBlobArray,
  type MarketplaceMetadata,
} from '@market/market-metadata';

import { computeConfigCommitment, toContractConfig } from './config.js';
import { ensureContractRegistered, type RegistersContracts } from './register.js';
import { acceptedPaymentAssets } from './token.js';

export interface DeployMarketplaceOptions {
  wallet: Wallet & RegistersContracts;
  /** Node the wallet is connected to; used to register contract instances. */
  node: AztecNode;
  /**
   * Deployer address (the tx sender / marketplace_id creator). AD-8: this is
   * NOT the owner — for creator anonymity the caller should deploy from a
   * throwaway account funded only via the sponsored FPC.
   */
  from: AztecAddress;
  /**
   * The owner's per-market ACCOUNT address (account model). It is stored as the
   * superadmin; every admin action authenticates by acting from this account
   * (msg_sender). Derive it from the universal seed + the access secret (which
   * is why `accessSecret` must be supplied, not generated, when deploying) so
   * it is recoverable. A single-market, non-L1-linked account.
   */
  superadmin: AztecAddress;
  /**
   * The owner's username, registered to `superadmin` by the constructor -- so
   * it costs no extra transaction and is paid by whoever pays for the deploy.
   * (The owner's per-market account is brand new and holds nothing, so it could
   * not fund a `register` call of its own.) Stored on-chain only as
   * hash(username, accessSecret).
   */
  ownerUsername: string;
  fee?: { paymentMethod: FeePaymentMethod };
  registryAddress: AztecAddress;
  /** Full metadata document (unknown until validated). */
  metadata: unknown;
  deploymentNonce: bigint;
  /**
   * Market access secret. Omit to generate a fresh random one (the normal
   * case). The returned secret is the market link -- it cannot be recovered
   * if lost.
   */
  accessSecret?: Fr;
  txTimeoutSeconds?: number;
}

export interface DeployedMarketplace {
  /**
   * The market access secret: the ONLY way to find and decrypt this market.
   * Share it as the market link; losing it makes the market unreachable.
   */
  accessSecret: Fr;
  /** poseidon2(accessSecret, DOMAIN_MARKET_LOOKUP) -- the registry key. */
  lookupKey: Fr;
  marketplaceId: Fr;
  /** The owner's per-market account address stored on-chain as superadmin. */
  superadminIdentity: Fr;
  marketplaceAddress: AztecAddress;
  deployTxHash: string;
  registerTxHash: string;
}

export async function deployMarketplace(
  options: DeployMarketplaceOptions,
): Promise<DeployedMarketplace> {
  const { wallet, node, from, superadmin, fee, registryAddress, metadata, deploymentNonce } =
    options;
  const wait = { timeout: options.txTimeoutSeconds ?? 180 };

  // The wallet's PXE only knows contracts it deployed itself; a remembered
  // registry address from an earlier session must be (re-)registered.
  await ensureContractRegistered(
    wallet,
    node,
    registryAddress,
    MarketplaceRegistryContract.artifact,
    'registry',
  );

  // 1. The access secret is the market's capability; fresh and random unless
  // the caller brings one (e.g. re-deploying a market under the same link).
  const accessSecret = options.accessSecret ?? generateMarketAccessSecret();
  const lookupKey = await deriveMarketLookupKey(accessSecret);

  // 2. Validate, canonicalize, seal. The chain stores only ciphertext.
  const sealed = await sealMetadata(metadata, accessSecret);
  const metadataBlob = toBlobArray(bytesToFields(sealed.sealed));

  // 3. Deploy the Marketplace with the sealed blob on-chain from block one.
  // Config comes from the document's own onchain mirror so the two cannot
  // diverge at deploy time.
  const config = toContractConfig(sealed.metadata.onchain);

  // The marketplace_id is deterministic from the deployer + nonce + config, so
  // we can derive it BEFORE deploying and later assert the contract computed
  // the same value. Account model: the superadmin is the owner's per-market
  // account address (passed in), not a derived pseudonym.
  const expectedId = await deriveMarketplaceId(
    from,
    deploymentNonce,
    await computeConfigCommitment(config),
  );

  // NO ENCRYPTION KEYS. The marketplace is deployed with the default (empty)
  // public keys, so nothing can encrypt a note to it and there is no viewing
  // key for it to hold -- which means the market link confers no ability to
  // decrypt anything about this contract.
  //
  // It used to be deployed with keys derived from the access secret, so that
  // link holders could see the pooled order escrow and prove settlements
  // against it. Per-order escrows removed the pool, and with it the only thing
  // those keys ever decrypted. Leaving them in place would have been a standing
  // trap: any private note this contract later held would be readable by
  // everyone holding the link, silently. Removing them makes that structural
  // rather than a property someone has to remember.
  //
  // If a future feature genuinely needs this contract to receive notes, give it
  // keys from a fresh secret held by the owner -- never from the market link,
  // which by design is known to every visitor.
  const deployMethod = MarketplaceContract.deploy(
    wallet,
    superadmin,
    await deriveUsernameHash(options.ownerUsername, accessSecret),
    new Fr(deploymentNonce),
    config,
    metadataBlob,
    BigInt(sealed.sealed.length),
  );
  await deployMethod.simulate({ from });
  const { contract: marketplace, receipt: deployReceipt } = await deployMethod.send({
    from,
    ...(fee ? { fee } : {}),
    wait,
  });

  // 4. The contract derived marketplace_id in-circuit; require it matches the
  // value we derived the owner identity from before registering anything.
  const onchainId = asFr(
    (await marketplace.methods.get_marketplace_id().simulate({ from })).result,
    'get_marketplace_id',
  );
  if (!onchainId.equals(expectedId)) {
    throw new Error(
      `marketplace_id mismatch: contract derived ${onchainId.toString()}, ` +
        `client derived ${expectedId.toString()} — config serialization is out of sync`,
    );
  }

  // 5. Register in the global registry under the secret-derived lookup key.
  const registry = await MarketplaceRegistryContract.at(registryAddress, wallet);
  const { receipt: registerReceipt } = await registry.methods
    .register(lookupKey, marketplace.address)
    .send({ from, ...(fee ? { fee } : {}), wait });

  // 6. Read the entry back and require it is OURS. A mempool front-runner
  // could have squatted the lookup key first (docs/DECISIONS.md AD-2); a
  // reverted register can still be included, so don't trust the send alone.
  // Detect capture now, while the link is unshared and rotating is free.
  const entry = (await registry.methods.get_record(lookupKey).simulate({ from })).result as {
    owner: AztecAddress;
    contract_address: AztecAddress;
    status: bigint;
  };
  if (!entry.owner.equals(from) || !entry.contract_address.equals(marketplace.address)) {
    throw new Error(
      'registry entry for this lookup key is not ours (front-run/squatted); ' +
        'redeploy with a fresh access secret',
    );
  }

  return {
    accessSecret,
    lookupKey,
    marketplaceId: onchainId,
    superadminIdentity: superadmin.toField(),
    marketplaceAddress: marketplace.address,
    deployTxHash: deployReceipt.txHash.toString(),
    registerTxHash: registerReceipt.txHash.toString(),
  };
}

export interface ResolvedMarketplace {
  marketplaceAddress: AztecAddress;
  marketplaceId: Fr;
  status: number;
  /** Decrypted, validated metadata (throws before returning anything else). */
  metadata: MarketplaceMetadata;
}

/**
 * The Portal's resolution path, from the access secret alone (the market
 * link): derive the lookup key, fetch the registry record, read the sealed
 * metadata blob out of the marketplace contract's own storage, then decrypt
 * and validate. Everything comes from the chain; any Aztec node suffices.
 * GCM authentication makes a squatted lookup key or corrupted data fail here
 * rather than render (spec sec.12).
 */
// Client-side allowlist of Marketplace contract-class ids we trust. A buyer
// only ever transacts with a market whose ON-CHAIN bytecode hashes to one of
// these ids. This is the trust anchor the registry cannot provide: the
// registry accepts any address under any lookup key, and the sealed-metadata
// GCM check only proves the CREATOR knew the access secret -- NOT that they
// deployed our audited contract. Without this, a market's own creator could
// register a modified Marketplace (one that pockets escrow, ignores the price
// commitment, redirects fees, ...) and buyers would transact with it.
//
// Deliberately a SET, and deliberately client-side: a future client can trust
// several classes at once -- e.g. keep an older v1 class here alongside a new
// one -- giving backwards compatibility with markets deployed on old contracts
// without any on-chain change. (Aztec addresses commit to the class id, so an
// attacker cannot forge a class id for a given address.)
let acceptedMarketplaceClassIdsPromise: Promise<ReadonlySet<string>> | null = null;
export function acceptedMarketplaceClassIds(): Promise<ReadonlySet<string>> {
  if (acceptedMarketplaceClassIdsPromise === null) {
    acceptedMarketplaceClassIdsPromise = (async () => {
      const current = await getContractClassFromArtifact(MarketplaceContract.artifact);
      return new Set([current.id.toString()]);
    })();
    // On failure, clear the cache so the next call retries rather than
    // permanently rejecting every market.
    acceptedMarketplaceClassIdsPromise.catch(() => {
      acceptedMarketplaceClassIdsPromise = null;
    });
  }
  return acceptedMarketplaceClassIdsPromise;
}

/**
 * Asserts the contract deployed at `marketplaceAddress` runs a Marketplace
 * class the client trusts. Pins `currentContractClassId` -- the code that
 * actually executes now -- so an updatable contract that was migrated to
 * malicious bytecode is caught even though its address commits to the
 * original class. Throws (fails closed) on unknown bytecode.
 */
async function assertGenuineMarketplace(
  node: AztecNode,
  marketplaceAddress: AztecAddress,
): Promise<void> {
  const instance = await node.getContract(marketplaceAddress);
  if (instance === undefined) {
    throw new Error(
      `no contract is deployed at the market address ${marketplaceAddress.toString()}`,
    );
  }
  const accepted = await acceptedMarketplaceClassIds();
  const classId = instance.currentContractClassId.toString();
  if (!accepted.has(classId)) {
    throw new Error(
      `the contract at ${marketplaceAddress.toString()} is not a recognized Marketplace ` +
        `(class ${classId}); refusing to open a market backed by unknown bytecode`,
    );
  }
}

/**
 * Asserts a market prices its orders in a currency this client will transact
 * in, and that the storefront agrees with the contract about which one.
 *
 * CHECKS THE CONTRACT'S CONFIG, NOT THE SEALED METADATA. The config is what
 * place_order reads in-circuit and what an order's escrow terms are built
 * from; the metadata copy is a mirror for display. Checking only the mirror
 * would be checking the one value an attacker is free to write anything into.
 *
 * The mirror is then required to match, because the two are used by different
 * code paths: the desktop builds its token handle from the metadata while the
 * order pipeline uses the config. A market where they disagree is malformed at
 * best, and at worst is trying to get a buyer to fund an escrow in a token the
 * escrow was never denominated in.
 */
function assertPaymentAssetMirror(
  marketplaceAddress: AztecAddress,
  configAsset: AztecAddress,
  metadataAsset: string,
): void {
  const asset = configAsset.toString();
  // Via Fr, not fromStringUnsafe: metadata addresses are plain hex field
  // elements and are not required to be zero-padded to full width.
  const mirrored = AztecAddress.fromFieldUnsafe(Fr.fromString(metadataAsset)).toString();
  if (mirrored !== asset) {
    throw new Error(
      `the market at ${marketplaceAddress.toString()} advertises payment asset ${mirrored} ` +
        `but prices orders in ${asset}; refusing to open a market that misreports its ` +
        'own currency',
    );
  }
}

function assertAllowedPaymentAsset(
  marketplaceAddress: AztecAddress,
  configAsset: AztecAddress,
): void {
  const asset = configAsset.toString();
  if (!acceptedPaymentAssets().has(asset)) {
    throw new Error(
      `the market at ${marketplaceAddress.toString()} prices orders in an unrecognized ` +
        `currency (${asset}); refusing to open a market whose payment asset this client ` +
        'does not trust',
    );
  }
}

export async function resolveMarketplace(options: {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  registryAddress: AztecAddress;
  accessSecret: Fr;
  /**
   * Skip the payment-asset allowlist. DEVELOPMENT ONLY: the local sandbox has
   * no real cUSDC, so each device deploys a mock at a fresh address that no
   * fixed list could ever contain.
   *
   * Defaults to false so the check FAILS CLOSED: a caller that forgets this
   * gets the protection, rather than silently losing it.
   *
   * Relaxes ONLY the allowlist. The storefront must still agree with the
   * contract about which currency it prices in, on every network.
   */
  allowUnlistedPaymentAsset?: boolean;
}): Promise<ResolvedMarketplace> {
  const { wallet, node, from, registryAddress, accessSecret } = options;

  // A viewing session never deployed anything: teach its PXE both contracts
  // (instances fetched from the node, artifacts from the bindings).
  await ensureContractRegistered(
    wallet,
    node,
    registryAddress,
    MarketplaceRegistryContract.artifact,
    'registry',
  );

  const lookupKey = await deriveMarketLookupKey(accessSecret);
  const registry = await MarketplaceRegistryContract.at(registryAddress, wallet);
  const record = (await registry.methods.get_record(lookupKey).simulate({ from })).result as {
    owner: AztecAddress;
    contract_address: AztecAddress;
    status: bigint;
  };
  const status = Number(record.status);
  if (status === 0) {
    throw new Error('no market is registered under this access secret');
  }
  const marketplaceAddress = record.contract_address;
  // Trust anchor: before reading or (later) transacting, require the on-chain
  // bytecode to be a Marketplace class we recognize. Gating at resolve covers
  // every subsequent action, since a market that fails here never opens.
  await assertGenuineMarketplace(node, marketplaceAddress);
  await ensureContractRegistered(
    wallet,
    node,
    marketplaceAddress,
    MarketplaceContract.artifact,
    'marketplace',
  );

  // Read the sealed blob straight out of contract storage and open it.
  // Failure here means a wrong secret, a squatted registry entry, or
  // corrupted data -- never render in any of those cases.
  const marketplace = await MarketplaceContract.at(marketplaceAddress, wallet);
  const metadataLen = asBigInt(
    (await marketplace.methods.get_metadata_len().simulate({ from })).result,
    'get_metadata_len',
  );
  if (metadataLen === 0n) {
    throw new Error('marketplace contract holds no metadata');
  }
  const blobFields = asFrArray(
    (await marketplace.methods.get_metadata_data().simulate({ from })).result,
    'get_metadata_data',
  );
  const sealedBytes = fieldsToBytes(blobFields, Number(metadataLen));
  const metadata = await openMetadata(sealedBytes, accessSecret);

  const marketplaceId = asFr(
    (await marketplace.methods.get_marketplace_id().simulate({ from })).result,
    'get_marketplace_id',
  );

  // Second trust anchor, alongside the class check above: recognized bytecode
  // is not enough if the money is denominated in a token the operator wrote.
  const config = (await marketplace.methods.get_config().simulate({ from })).result as {
    payment_asset: AztecAddress;
  };
  // ALWAYS, including in development. This is not an allowlist question: a
  // market whose storefront names a different currency from the one its
  // contract prices orders in is broken on any network, and would have a buyer
  // fund an escrow in a token it was never denominated in.
  assertPaymentAssetMirror(marketplaceAddress, config.payment_asset, metadata.onchain.paymentAsset);
  if (options.allowUnlistedPaymentAsset !== true) {
    assertAllowedPaymentAsset(marketplaceAddress, config.payment_asset);
  }

  // No key registration here any more. This used to verify the contract was
  // deployed with link-derived keys and called it an authenticity check, but it
  // never was one: registering under this lookup key already requires the
  // access secret, so anyone who could squat the registry entry could equally
  // deploy with the matching keys. The class-id allowlist above is the actual
  // trust anchor, and it is the only one that ever mattered.
  return { marketplaceAddress, marketplaceId, status, metadata };
}

export function asFr(value: unknown, source: string): Fr {
  if (value instanceof Fr) {
    return value;
  }
  if (typeof value === 'bigint') {
    return new Fr(value);
  }
  throw new Error(`${source} returned unexpected type ${typeof value}`);
}

export function asBigInt(value: unknown, source: string): bigint {
  if (typeof value === 'bigint') {
    return value;
  }
  throw new Error(`${source} returned unexpected type ${typeof value}`);
}

export function asFrArray(value: unknown, source: string): Fr[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} returned unexpected type ${typeof value}`);
  }
  return value.map((entry, i) => asFr(entry, `${source}[${i}]`));
}
