// Admin/moderation helpers (M4): superadmin-path operations the Portal's
// admin dashboard uses. Vendor approval/suspension lives in vendors.ts.

import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { MarketplaceContract } from '@market/contract-bindings';
import {
  bytesToFields,
  fieldsToBytes,
  sealMetadata,
  toBlobArray,
  type MarketplaceMetadata,
} from '@market/market-metadata';
import { ListingStatus } from '@market/shared-types';

import { asBigInt, asFrArray } from './deploy.js';
import { sendActingAs } from './act.js';
import { ensureContractRegistered, type RegistersContracts } from './register.js';

interface AdminSessionOptions {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  /** Who sends and pays (defaults to `from`); see sendActingAs. */
  sender?: AztecAddress;
  marketplaceAddress: AztecAddress;
}

async function marketplaceAt(options: AdminSessionOptions) {
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
 * Reads the market's owner identity (AD-8): a pseudonym, not a wallet address.
 * A caller is the owner iff deriveMarketplaceIdentity(theirSecret, marketId)
 * equals this value.
 */
export async function getSuperadminIdentity(options: AdminSessionOptions): Promise<Fr> {
  const marketplace = await marketplaceAt(options);
  const result = (
    await marketplace.methods.get_superadmin_identity().simulate({ from: options.from })
  ).result;
  return new Fr(result as bigint);
}

/**
 * Owner: grant a moderator's per-market account a permission bitmap (PERM_*
 * bits in @market/shared-types). Account model: a PRIVATE call from the owner's
 * per-market account (msg_sender), targeting the moderator by account address.
 * The owner resolves a known username to an address via getUserAddress.
 */
export async function assignModerator(
  options: AdminSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    moderator: AztecAddress;
    permissions: bigint;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const marketplace = await marketplaceAt(options);
  return sendActingAs(options, (account, nonce) =>
    marketplace.methods.assign_moderator(options.moderator, options.permissions, account, nonce),
  );
}

/** Owner: strip a moderator of all permissions (private, msg_sender authed). */
export async function removeModerator(
  options: AdminSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    moderator: AztecAddress;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const marketplace = await marketplaceAt(options);
  return sendActingAs(options, (account, nonce) =>
    marketplace.methods.remove_moderator(options.moderator, account, nonce),
  );
}

/** Reads a moderator identity's permission bitmap (0 = not a moderator). */
export async function getModeratorPermissions(
  options: AdminSessionOptions & { moderatorIdentity: Fr },
): Promise<bigint> {
  const marketplace = await marketplaceAt(options);
  return (
    await marketplace.methods
      .get_moderator_permissions(options.moderatorIdentity)
      .simulate({ from: options.from })
  ).result as bigint;
}

/**
 * Owner: replace the market's sealed metadata blob (the Customize page's save
 * path). The document is validated + canonicalized + sealed under the access
 * secret exactly like at deploy time, then written via the superadmin-gated
 * `set_metadata` (private, owner-secret authed). Reads the blob back and
 * requires it is byte-for-byte what was written. Returns the validated
 * document so the caller can update its UI without re-resolving.
 *
 * NOTE: this replaces only the sealed presentation document. The `onchain`
 * mirror inside it is display-only -- changing it here does NOT change the
 * contract's MarketConfig (that is update_config). Callers editing
 * presentation must carry the existing `onchain` block over unchanged.
 */
export async function setMarketplaceMetadata(
  options: AdminSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    accessSecret: Fr;
    /** Full replacement metadata document (unknown until validated). */
    metadata: unknown;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string; metadata: MarketplaceMetadata }> {
  const { from, accessSecret } = options;

  const sealed = await sealMetadata(options.metadata, accessSecret);
  const blob = toBlobArray(bytesToFields(sealed.sealed));

  const marketplace = await marketplaceAt(options);
  const { txHash } = await sendActingAs(options, (account, nonce) =>
    marketplace.methods.set_metadata(blob, sealed.sealed.length, account, nonce),
  );

  // Read the blob back and require it is exactly ours; a concurrent writer or
  // a silent failure must surface here, not as a stale storefront.
  const len = asBigInt(
    (await marketplace.methods.get_metadata_len().simulate({ from })).result,
    'get_metadata_len',
  );
  const fields = asFrArray(
    (await marketplace.methods.get_metadata_data().simulate({ from })).result,
    'get_metadata_data',
  );
  const stored = fieldsToBytes(fields, Number(len));
  if (
    stored.length !== sealed.sealed.length ||
    !stored.every((b, i) => b === sealed.sealed[i])
  ) {
    throw new Error(
      'the metadata read back from the contract is not what was written -- ' +
        'refresh the market and retry',
    );
  }

  return { txHash, metadata: sealed.metadata };
}

/**
 * Moderation: force a listing's status (remove, restore, pause). AD-8: a single
 * private path for the owner (all permissions) or a PERM_MODERATE_LISTINGS
 * moderator, authorized by `userSecret`.
 */
export async function setListingStatusAsAdmin(
  options: AdminSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    listingId: bigint;
    status: ListingStatus.Active | ListingStatus.Paused | ListingStatus.Removed;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const { listingId, status } = options;
  const marketplace = await marketplaceAt(options);
  return sendActingAs(options, (account, nonce) =>
    marketplace.methods.set_listing_status(new Fr(listingId), status, account, nonce),
  );
}
