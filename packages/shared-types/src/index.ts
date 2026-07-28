// Protocol constants shared across the Aztec Market System (TypeScript side).
//
// MUST stay identical to `contracts/market-protocol/src/lib.nr` — that file is
// the Noir source of truth. `packages/identity` has cross-language test
// vectors guarding the derivations built on these constants.

// ---------------------------------------------------------------------------
// Domain-separation constants (Field values)
// ---------------------------------------------------------------------------

export const DOMAIN_IDENTITY = 1n;
export const DOMAIN_VENDOR_REGISTRATION = 2n;
export const DOMAIN_ORDER_SETTLEMENT = 3n;
// Domain 4 (dispute finalization) is RETIRED: disputes moved off-chain
// (SimpleX). Do not reuse the value.
export const DOMAIN_METADATA = 5n;
/**
 * Registry lookup key for hidden markets: lookup_key = poseidon2([access_secret,
 * DOMAIN_MARKET_LOOKUP]). Every market is hidden; the access secret is the
 * shareable market link and never appears on-chain.
 */
export const DOMAIN_MARKET_LOOKUP = 6n;
/**
 * Price blinding factor (AD-4): blinding = poseidon2([access_secret,
 * listing_id, DOMAIN_PRICE_BLINDING]). Recomputable by link holders only.
 */
export const DOMAIN_PRICE_BLINDING = 7n;
/**
 * Price commitment (AD-4): commitment = poseidon2([price, blinding,
 * DOMAIN_PRICE_COMMITMENT]). Public per listing; opened in-circuit by buyers.
 */
export const DOMAIN_PRICE_COMMITMENT = 8n;
/**
 * RETIRED -- RESERVED, NEVER REUSE THIS NUMBER.
 *
 * The marketplace contract used to be deployed with encryption keys derived
 * from poseidon2([access_secret, DOMAIN_ESCROW_KEYS]), so link holders could
 * view the pooled order escrow. That was the leak which forced per-order
 * escrows: a key every link holder can derive means every link holder can read
 * the pool. The marketplace now deploys with NO encryption keys, and nothing
 * derives from this constant; it is kept only so the number is never handed to
 * a new domain.
 */
export const DOMAIN_ESCROW_KEYS = 9n;
/** Order identifier (AD-5): opaque hash; unpredictable to outsiders. */
export const DOMAIN_ORDER_ID = 10n;
/**
 * Listing category tag: tag = poseidon2([access_secret, category_field,
 * DOMAIN_CATEGORY]) where category_field = poseidon2HashBytes(category). Stored
 * on-chain per listing so link holders can filter by category cheaply; opaque
 * to outsiders (salted with the market access secret).
 */
export const DOMAIN_CATEGORY = 11n;
/**
 * Dispute-auth bucket tag (AD-6): the per-order storage key under which a
 * disputed order's public authentication commitment lives.
 */
export const DOMAIN_DISPUTE_AUTH = 16n;
/**
 * Dispute authentication commitment (AD-6): commitment =
 * poseidon2([dispute_secret, DOMAIN_DISPUTE_COMMITMENT]). The buyer publishes
 * it when disputing; revealing the secret in the dispute room proves buyer-ship
 * with a single hash instead of a ZK proof.
 */
export const DOMAIN_DISPUTE_COMMITMENT = 17n;
/**
 * Order fulfillment bucket tag (Option A): the public per-order shipped/
 * delivered status word, keyed by the opaque order id. Lets vendor->buyer
 * fulfillment updates avoid ever carrying the buyer's address.
 */
export const DOMAIN_ORDER_FULFILLMENT = 18n;
/**
 * Per-order escrow salt: salt = poseidon2([escrow_secret,
 * DOMAIN_ORDER_ESCROW_SALT]). CLIENT-SIDE ONLY -- it has no Noir counterpart,
 * because the escrow contract never derives its own address; the protocol
 * checks it, and both parties recompute it from the order's escrow note. Kept
 * here anyway so it can never collide with a domain that IS mirrored on-chain.
 */
export const DOMAIN_ORDER_ESCROW_SALT = 19n;

// ---------------------------------------------------------------------------
// Order lifecycle states (the marketplace's public per-order word). The three
// TERMINAL values are what authorize the per-order escrow to pay out: it has no
// public functions, so it cannot serialize against a concurrent transaction and
// only ever follows a decision the marketplace already made under its own
// public asserts. Mirrors ORDER_STATE_* in contracts/market-protocol/src/lib.nr.
// ---------------------------------------------------------------------------

export const ORDER_STATE_NONE = 0;
export const ORDER_STATE_ACCEPTED = 1;
export const ORDER_STATE_DISPUTED = 2;
export const ORDER_STATE_RULED_REFUND_BUYER = 3;
export const ORDER_STATE_RULED_PAY_VENDOR = 4;
/** Terminal: buyer cancelled pre-acceptance. Authorizes escrow claim_refund. */
export const ORDER_STATE_CANCELLED = 5;
/** Terminal: buyer confirmed + left feedback. Authorizes escrow release. */
export const ORDER_STATE_COMPLETED = 6;
/** Terminal: vendor's timeout claim accepted. Authorizes escrow claim. */
export const ORDER_STATE_SETTLED_VENDOR = 7;

// ---------------------------------------------------------------------------
// Moderator permission bits (u64 bitmap)
// ---------------------------------------------------------------------------

export const PERM_MODERATE_LISTINGS = 1n;
export const PERM_MANAGE_VENDORS = 2n;
// Bit 4 (the OLD resolve-disputes) stays RETIRED from the removed on-chain
// dispute system; bounded arbitration got a fresh bit.
/** May rule a DISPUTED order toward one of the two legitimate outcomes. */
export const PERM_RESOLVE_DISPUTES = 8n;
/** Mask of every known permission bit; the contract rejects bits outside it. */
export const PERM_ALL = 11n;

/** A ruling on a disputed order (mirrors DISPUTE_OUTCOME_* in market-protocol). */
export enum DisputeOutcome {
  None = 0,
  RefundBuyer = 1,
  PayVendor = 2,
}

// ---------------------------------------------------------------------------
// Vendor authorization policy (u8 in MarketConfig)
// ---------------------------------------------------------------------------

export enum VendorPolicy {
  Open = 0,
  Approval = 1,
  Deposit = 2,
  Both = 3,
}

// ---------------------------------------------------------------------------
// Vendor status (u8, stored per pseudonymous vendor_id in Marketplace state)
// ---------------------------------------------------------------------------

export enum VendorStatus {
  None = 0,
  Pending = 1,
  Active = 2,
  Suspended = 3,
}

// ---------------------------------------------------------------------------
// Registry entry status (u8 in MarketplaceRegistry)
// ---------------------------------------------------------------------------

export enum RegistryStatus {
  Unregistered = 0,
  Active = 1,
  Suspended = 2,
}

// ---------------------------------------------------------------------------
// Listing status (u8 in Marketplace.listings; 0 = never created)
// ---------------------------------------------------------------------------

export enum ListingStatus {
  None = 0,
  Active = 1,
  Paused = 2,
  Removed = 3,
  /** Awaiting moderator approval (APPROVAL-policy markets); invisible to
   * buyers and non-orderable until approved (-> Active) or rejected. */
  Pending = 4,
}

// ---------------------------------------------------------------------------
// Listing authorization policy (u8 in MarketConfig)
// ---------------------------------------------------------------------------

export enum ListingPolicy {
  /** New listings go live immediately. */
  Open = 0,
  /** New (and edited) listings are held Pending until a moderator approves. */
  Approval = 1,
}

// ---------------------------------------------------------------------------
// Order status (u8, carried in encrypted StatusNotes -- never public)
// ---------------------------------------------------------------------------

export enum OrderStatus {
  Accepted = 1,
  Shipped = 2,
  Delivered = 3,
  Cancelled = 4,
  Completed = 5,
  // Values 6/7 (old disputed / dispute resolved) are RETIRED: they belonged
  // to the removed on-chain dispute system. Do not reuse them.
  /** The vendor refunded the order in full (the dispute escape valve). */
  Refunded = 8,
  /** The buyer disputed: an anonymous on-chain flag blocks the vendor's
   * timeout settlement until the buyer confirms or the vendor refunds. */
  Disputed = 9,
}

// ---------------------------------------------------------------------------
// Marketplace configuration (mirrors contracts/marketplace/src/market_config.nr)
// ---------------------------------------------------------------------------

/**
 * Field-for-field mirror of the Noir `MarketConfig` struct, in its exact
 * serialization order. Addresses are field elements as bigint.
 */
export interface MarketConfig {
  paymentAsset: bigint;
  /** Fee in bps; paid to the market's OWNER (superadmin), the treasury. */
  feeBps: number;
  vendorPolicy: VendorPolicy;
  vendorDeposit: bigint;
  orderTimeoutSeconds: bigint;
  finalizationCollateral: bigint;
  listingPolicy: ListingPolicy;
}
