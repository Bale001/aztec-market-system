// Marketplace identity & nullifier derivation (TypeScript side).
//
// Field-for-field mirror of `contracts/market-protocol/src/lib.nr` — the Noir
// source of truth. Both use Poseidon2 over the same input layouts, so values
// derived here are exactly what the contracts compute in-circuit. The test
// suite pins cross-language vectors; if you change anything here, change the
// Noir library in the same commit and update the vectors.

import { poseidon2Hash, poseidon2HashBytes } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import {
  DOMAIN_CATEGORY,
  DOMAIN_DISPUTE_COMMITMENT,
  DOMAIN_IDENTITY,
  DOMAIN_MARKET_LOOKUP,
  DOMAIN_ORDER_ID,
  DOMAIN_ORDER_SETTLEMENT,
  DOMAIN_PRICE_BLINDING,
  DOMAIN_PRICE_COMMITMENT,
} from '@market/shared-types';

/** Values accepted wherever a field element is expected. */
export type FieldLike = Fr | bigint | { toField(): Fr };

export function toFr(value: FieldLike, name: string): Fr {
  if (value instanceof Fr) {
    return value;
  }
  if (typeof value === 'bigint') {
    return new Fr(value);
  }
  if (typeof value.toField === 'function') {
    return value.toField();
  }
  throw new Error(`${name}: expected an Fr, bigint, or object with toField()`);
}

/**
 * marketplace_id = poseidon2([creator, deployment_nonce, config_commitment])
 *
 * Mirrors `market_protocol::derive_marketplace_id`. `creator` is the deploying
 * address (AztecAddress instances work via toField()).
 */
export async function deriveMarketplaceId(
  creator: FieldLike,
  deploymentNonce: FieldLike,
  configCommitment: FieldLike,
): Promise<Fr> {
  return poseidon2Hash([
    toFr(creator, 'creator'),
    toFr(deploymentNonce, 'deploymentNonce'),
    toFr(configCommitment, 'configCommitment'),
  ]);
}

/**
 * marketplace_identity = poseidon2([user_secret, marketplace_id, DOMAIN_IDENTITY])
 *
 * Mirrors `market_protocol::derive_marketplace_identity`. Derived client-side
 * only; the wallet address never appears in marketplace state.
 */
export async function deriveMarketplaceIdentity(
  userSecret: FieldLike,
  marketplaceId: FieldLike,
): Promise<Fr> {
  return poseidon2Hash([
    toFr(userSecret, 'userSecret'),
    toFr(marketplaceId, 'marketplaceId'),
    new Fr(DOMAIN_IDENTITY),
  ]);
}

/**
 * lookup_key = poseidon2([access_secret, DOMAIN_MARKET_LOOKUP])
 *
 * Mirrors `market_protocol::derive_market_lookup_key`. The access secret is
 * the shareable market link (portal/#/m/<secret>); the registry is keyed by
 * this derived value so on-chain data reveals nothing without the secret.
 */
export async function deriveMarketLookupKey(accessSecret: FieldLike): Promise<Fr> {
  return poseidon2Hash([toFr(accessSecret, 'accessSecret'), new Fr(DOMAIN_MARKET_LOOKUP)]);
}

/**
 * Generates a fresh market access secret. A full random field element
 * (~254 bits of entropy) -- never derived from market names or other
 * guessable inputs.
 */
export function generateMarketAccessSecret(): Fr {
  return Fr.random();
}

/**
 * Generates a fresh per-user marketplace secret. The user's pseudonymous
 * identity on every market derives from this; losing it means losing vendor
 * (and later buyer) roles built on it.
 */
export function generateUserSecret(): Fr {
  return Fr.random();
}

/**
 * blinding = poseidon2([access_secret, listing_id, DOMAIN_PRICE_BLINDING])
 *
 * Mirrors `market_protocol::derive_price_blinding` (AD-4). Recomputable by
 * every holder of the market link, unguessable by anyone else.
 */
export async function derivePriceBlinding(
  accessSecret: FieldLike,
  listingId: FieldLike,
): Promise<Fr> {
  return poseidon2Hash([
    toFr(accessSecret, 'accessSecret'),
    toFr(listingId, 'listingId'),
    new Fr(DOMAIN_PRICE_BLINDING),
  ]);
}

/** Most variants and shipping methods a listing may price. Mirrors Noir. */
export const MAX_PRICE_OPTIONS = 8;
export const MAX_SHIPPING_OPTIONS = 4;

/**
 * commitment = poseidon2([blinding, DOMAIN_PRICE_COMMITMENT, nOpt, nShip,
 *                         optionPrices[0..7], shippingPrices[0..3]])
 *
 * Mirrors `market_protocol::derive_price_commitment` (AD-4). Stored publicly in
 * the listing record; the prices themselves stay inside the sealed document.
 *
 * A listing prices two independent choices -- which variant, and which shipping
 * method -- so one commitment covers the whole TABLE. Unused slots are hashed
 * as zeros, which fixes the preimage size and binds the counts, so a vendor
 * cannot grow the table after buyers have seen it. The circuit rebuilds this
 * exact hash and then computes the order amount itself, which is why the amount
 * never has to be trusted.
 *
 * A plain single-price listing is a table with one option and one shipping row.
 */
export async function derivePriceCommitment(
  optionPrices: readonly FieldLike[],
  shippingPrices: readonly FieldLike[],
  blinding: FieldLike,
): Promise<Fr> {
  if (optionPrices.length === 0 || optionPrices.length > MAX_PRICE_OPTIONS) {
    throw new Error(
      `a listing must price 1..${MAX_PRICE_OPTIONS} options, got ${optionPrices.length}`,
    );
  }
  if (shippingPrices.length === 0 || shippingPrices.length > MAX_SHIPPING_OPTIONS) {
    throw new Error(
      `a listing must price 1..${MAX_SHIPPING_OPTIONS} shipping methods, got ` +
        `${shippingPrices.length}`,
    );
  }
  const pad = (values: readonly FieldLike[], size: number, what: string): Fr[] => {
    const out = values.map((v, i) => toFr(v, `${what}[${i}]`));
    while (out.length < size) {
      out.push(Fr.ZERO);
    }
    return out;
  };
  return poseidon2Hash([
    toFr(blinding, 'blinding'),
    new Fr(DOMAIN_PRICE_COMMITMENT),
    new Fr(BigInt(optionPrices.length)),
    new Fr(BigInt(shippingPrices.length)),
    ...pad(optionPrices, MAX_PRICE_OPTIONS, 'optionPrices'),
    ...pad(shippingPrices, MAX_SHIPPING_OPTIONS, 'shippingPrices'),
  ]);
}

/**
 * The buyer's chosen rows, packed into the single field the order note has
 * spare. Mirrors `market_protocol::pack_selection`.
 */
export function packSelection(optionIndex: number, shippingIndex: number): Fr {
  return new Fr(BigInt(optionIndex) * 256n + BigInt(shippingIndex));
}

/** Inverse of {@link packSelection}, for the vendor reading an order note. */
export function unpackSelection(selection: FieldLike): {
  optionIndex: number;
  shippingIndex: number;
} {
  const packed = toFr(selection, 'selection').toBigInt();
  return { optionIndex: Number(packed / 256n), shippingIndex: Number(packed % 256n) };
}

/**
 * Normalizes a category label before hashing so trivially-different spellings
 * ("Electronics", " electronics ") map to the same tag: trim + lowercase +
 * collapse internal whitespace.
 */
export function normalizeCategory(category: string): string {
  return category.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * tag = poseidon2([access_secret, poseidon2HashBytes(normalized_category),
 * DOMAIN_CATEGORY])
 *
 * The access-secret-salted, on-chain category tag (single category per
 * listing). Every link holder computes the same tag for a given category name
 * and matches it against the on-chain records to filter cheaply; outsiders see
 * only an opaque field. An empty category returns Fr.ZERO ("uncategorized").
 */
export async function deriveCategoryTag(
  accessSecret: FieldLike,
  category: string,
): Promise<Fr> {
  const normalized = normalizeCategory(category);
  if (normalized === '') {
    return Fr.ZERO;
  }
  const categoryField = await poseidon2HashBytes(Buffer.from(normalized, 'utf8'));
  return poseidon2Hash([
    toFr(accessSecret, 'accessSecret'),
    categoryField,
    new Fr(DOMAIN_CATEGORY),
  ]);
}

/**
 * order_id = poseidon2([marketplace_id, listing_id, buyer, nonce, DOMAIN_ORDER_ID])
 *
 * Mirrors `market_protocol::derive_order_id` (AD-5).
 */
export async function deriveOrderId(
  marketplaceId: FieldLike,
  listingId: FieldLike,
  buyer: FieldLike,
  orderNonce: FieldLike,
): Promise<Fr> {
  return poseidon2Hash([
    toFr(marketplaceId, 'marketplaceId'),
    toFr(listingId, 'listingId'),
    toFr(buyer, 'buyer'),
    toFr(orderNonce, 'orderNonce'),
    new Fr(DOMAIN_ORDER_ID),
  ]);
}

/**
 * settlement_nullifier = poseidon2([order_id, DOMAIN_ORDER_SETTLEMENT])
 *
 * Mirrors `market_protocol::derive_order_settlement_nullifier` (AD-5). Its
 * on-chain existence (siloed by the marketplace contract) means the order
 * reached a terminal state.
 */
export async function deriveOrderSettlementNullifier(orderId: FieldLike): Promise<Fr> {
  return poseidon2Hash([toFr(orderId, 'orderId'), new Fr(DOMAIN_ORDER_SETTLEMENT)]);
}

/**
 * commitment = poseidon2([dispute_secret, DOMAIN_DISPUTE_COMMITMENT])
 *
 * Mirrors `market_protocol::derive_dispute_commitment` (AD-6). The buyer
 * publishes this when opening a dispute; revealing `dispute_secret` in the
 * dispute room and matching this hash proves buyer-ship without a ZK proof and
 * without revealing the buyer's address.
 */
export async function deriveDisputeCommitment(disputeSecret: FieldLike): Promise<Fr> {
  return poseidon2Hash([toFr(disputeSecret, 'disputeSecret'), new Fr(DOMAIN_DISPUTE_COMMITMENT)]);
}

/**
 * nullifier = poseidon2([user_secret, marketplace_id, domain, subject])
 *
 * Mirrors `market_protocol::derive_action_nullifier`. `domain` is one of the
 * DOMAIN_* constants in @market/shared-types; `subject` scopes the action
 * (0 for vendor registration, order_id for settlement, ...).
 */
export async function deriveActionNullifier(
  userSecret: FieldLike,
  marketplaceId: FieldLike,
  domain: FieldLike,
  subject: FieldLike,
): Promise<Fr> {
  return poseidon2Hash([
    toFr(userSecret, 'userSecret'),
    toFr(marketplaceId, 'marketplaceId'),
    toFr(domain, 'domain'),
    toFr(subject, 'subject'),
  ]);
}

export { decodeMarketLink, encodeMarketLink, isMarketLink, makeVanityMarketSecret, vanityPrefixError, VANITY_ALPHABET, VANITY_MAX_LENGTH } from "./market-link.js";
export {
  deriveMarketAccountKeys,
  deriveUsernameHash,
  usernameToField,
  MAX_USERNAME_BYTES,
  type MarketAccountKeys,
} from "./accounts.js";
