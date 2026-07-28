// market_protocol -- shared protocol library for the Aztec Market System.
//
// Single source of truth (Noir side) for domain-separation constants and the
// Poseidon2 derivations of marketplace identifiers, per-marketplace user
// identities, and action nullifiers. `packages/identity` (TypeScript) mirrors
// these exactly; the two must never diverge.
//
// `protocol_types::hash::poseidon2_hash` is the same function as
// `aztec::protocol::hash::poseidon2_hash` (aztec-nr re-exports protocol_types
// as `protocol`), so values derived here match contract-side hashing.

mod test;

use protocol_types::{address::AztecAddress, hash::poseidon2_hash, traits::ToField};

// ---------------------------------------------------------------------------
// Domain-separation constants
//
// Used as the third input of identity derivation and the third input of
// action nullifiers. Identity derivation hashes 3 fields and nullifiers hash
// 4 fields, and Noir's Poseidon2 includes the input length in its IV, so the
// two families cannot collide even where constants overlap.
// ---------------------------------------------------------------------------

/// Per-marketplace user identity (spec sec.14): the wallet address never appears
/// in marketplace state; this identity does.
pub global DOMAIN_IDENTITY: Field = 1;

/// Vendor registration nullifier (subject = 0). NOTE: the current account-model
/// Marketplace does NOT emit this nullifier -- double-registration is blocked by
/// a public "already registered" check keyed by the vendor's account address.
/// Retained for cross-language parity; do not reuse the value.
pub global DOMAIN_VENDOR_REGISTRATION: Field = 2;

/// Order settlement nullifier (subject = order_id): double-settle impossible.
pub global DOMAIN_ORDER_SETTLEMENT: Field = 3;

// Domain 4 (dispute finalization) is RETIRED: disputes moved off-chain
// (SimpleX). Do not reuse the value.

/// Metadata commitment (subject-free): binds the canonical metadata document
/// hash into a single Field stored on-chain.
pub global DOMAIN_METADATA: Field = 5;

/// Registry lookup key for hidden markets: derived from the market access
/// secret so the on-chain registry key reveals nothing about the market and
/// cannot be linked to the marketplace_id without the secret.
pub global DOMAIN_MARKET_LOOKUP: Field = 6;

/// Price blinding factor (AD-4): derived from the market access secret and
/// the listing id, so every link holder can recompute it but outsiders
/// cannot brute-force prices out of price commitments.
pub global DOMAIN_PRICE_BLINDING: Field = 7;

/// Price commitment (AD-4): binds a listing's hidden price into a public
/// Field that buyers open in-circuit when funding an order.
pub global DOMAIN_PRICE_COMMITMENT: Field = 8;

/// RETIRED -- RESERVED, NEVER REUSE THIS NUMBER.
///
/// The marketplace contract used to be deployed with encryption keys derived
/// from poseidon2([access_secret, DOMAIN_ESCROW_KEYS]), so that every link
/// holder could see the pooled order escrow and prove settlements against it.
/// That was the leak which forced the per-order escrow: a key EVERY link holder
/// can derive means every link holder can read the pool, so a pooled escrow can
/// never be private per order.
///
/// Order money now sits at per-order OrderEscrow addresses whose keys come from
/// a secret shared only with that order's two parties, and the marketplace is
/// deployed with NO encryption keys at all -- it holds no private notes, and
/// the market link confers no ability to decrypt anything about it. Nothing
/// derives from this constant any more; it is kept only so the number is never
/// handed to a new domain.
pub global DOMAIN_ESCROW_KEYS: Field = 9;

/// Order identifier (AD-5): an opaque hash; the only order-scoped value that
/// ever appears in public state (the acceptance flag).
pub global DOMAIN_ORDER_ID: Field = 10;

/// Listing category tag: computed client-side as poseidon2([access_secret,
/// category_field, DOMAIN_CATEGORY]) and stored opaquely per listing. The
/// contract never computes it; this constant exists only for cross-language
/// parity with packages/shared-types.
pub global DOMAIN_CATEGORY: Field = 11;

// Domain 12 (feedback namespace) is RETIRED: feedback has its own storage
// maps now. Do not reuse the value.

// Bucket-tag domains (13..15): the marketplace keeps ONE generic nested
// storage map ("buckets" -- the Storage struct sits at the compiler's
// type-complexity cap, so per-subject datasets share it). Every dataset
// gets its own domain-separated outer key, so the namespaces are disjoint
// by construction. Category buckets are keyed by the existing category_tag
// (which bakes DOMAIN_CATEGORY into its hash already).

/// Contact-address bucket tag (AD-6): where an identity's sealed SimpleX
/// contact address lives.
pub global DOMAIN_CONTACT_ADDRESS: Field = 13;

/// Vendor-listings bucket tag: a vendor account's listing index.
pub global DOMAIN_VENDOR_LISTINGS: Field = 14;

/// Feedback bucket tag: a listing's sealed rating+statement blobs.
pub global DOMAIN_FEEDBACK: Field = 15;

/// Dispute-auth bucket tag (AD-6): where a disputed order's public
/// authentication commitment lives (bucket key 0). The buyer commits a random
/// secret here when they call dispute_order (only the buyer can, since it
/// spends their order note); revealing the secret in the dispute room later
/// proves -- with a single hash, no ZK proof -- that the anonymous room
/// participant is that buyer.
pub global DOMAIN_DISPUTE_AUTH: Field = 16;

/// Dispute authentication commitment (AD-6): poseidon2([dispute_secret,
/// DOMAIN_DISPUTE_COMMITMENT]). Hiding (the secret is a full random field) and
/// binding; mirrored by packages/identity::deriveDisputeCommitment.
pub global DOMAIN_DISPUTE_COMMITMENT: Field = 17;

/// Order fulfillment bucket tag: the public per-order shipped/delivered status
/// word (bucket key 0), keyed by the opaque order id. The vendor writes it and
/// the buyer reads it -- so vendor->buyer fulfillment updates need no buyer
/// address (the buyer's account is never delivered to the vendor).
pub global DOMAIN_ORDER_FULFILLMENT: Field = 18;

// ---------------------------------------------------------------------------
// Moderator permission bits (u64 bitmap stored per moderator identity)
// ---------------------------------------------------------------------------

pub global PERM_MODERATE_LISTINGS: u64 = 1;
pub global PERM_MANAGE_VENDORS: u64 = 2;
// Bounded arbitration: may rule a DISPUTED order toward one of the two
// legitimate outcomes (bit 4 stays retired from the old dispute system).
pub global PERM_RESOLVE_DISPUTES: u64 = 8;
// Bit 4 (resolve disputes) is RETIRED: disputes moved off-chain (SimpleX).

/// Mask of every known permission bit; assignments outside it are rejected.
pub global PERM_ALL: u64 = 11; // MODERATE_LISTINGS | MANAGE_VENDORS | RESOLVE_DISPUTES

// ---------------------------------------------------------------------------
// Vendor authorization policy (u8, stored in MarketConfig)
// ---------------------------------------------------------------------------

pub global VENDOR_POLICY_OPEN: u8 = 0;
pub global VENDOR_POLICY_APPROVAL: u8 = 1;
pub global VENDOR_POLICY_DEPOSIT: u8 = 2;
pub global VENDOR_POLICY_BOTH: u8 = 3;

// Listing authorization policy (u8 in MarketConfig): OPEN = new listings go
// live immediately (today's behavior); APPROVAL = new/edited listings are
// created PENDING and a moderator must approve them.
pub global LISTING_POLICY_OPEN: u8 = 0;
pub global LISTING_POLICY_APPROVAL: u8 = 1;

// ---------------------------------------------------------------------------
// Vendor status (u8, stored per vendor account address in marketplace state)
// ---------------------------------------------------------------------------

pub global VENDOR_STATUS_NONE: u8 = 0;
pub global VENDOR_STATUS_PENDING: u8 = 1;
pub global VENDOR_STATUS_ACTIVE: u8 = 2;
pub global VENDOR_STATUS_SUSPENDED: u8 = 3;

// ---------------------------------------------------------------------------
// Order status values (u8, carried in encrypted StatusNotes -- never public)
// ---------------------------------------------------------------------------

pub global ORDER_STATUS_ACCEPTED: u8 = 1;
pub global ORDER_STATUS_SHIPPED: u8 = 2;
pub global ORDER_STATUS_DELIVERED: u8 = 3;
pub global ORDER_STATUS_CANCELLED: u8 = 4;
pub global ORDER_STATUS_COMPLETED: u8 = 5;
// Values 6/7 (disputed / dispute resolved) are RETIRED: they belonged to the
// removed on-chain dispute system. Do not reuse them.
// The vendor refunded the order in full (the dispute escape valve).
pub global ORDER_STATUS_REFUNDED: u8 = 8;
// The buyer disputed the order (new numbering; the on-chain flag is what
// blocks the vendor's timeout settlement).
pub global ORDER_STATUS_DISPUTED: u8 = 9;

// Dispute rulings (bounded arbitration): an authorized moderator/the owner
// rules a disputed order toward ONE of the two legitimate outcomes; the
// winning party executes the settlement themselves. 0 = unruled. These are
// the client-facing wire values (resolve_dispute's argument and
// get_dispute_outcome's result); on-chain they map onto ORDER_STATE_RULED_*.
pub global DISPUTE_OUTCOME_REFUND_BUYER: u8 = 1;
pub global DISPUTE_OUTCOME_PAY_VENDOR: u8 = 2;

// The per-order anonymous public lifecycle word (the order_states map):
// STRICTLY MONOTONIC -- every transition asserts its predecessor, so invalid
// combinations (disputed-but-unaccepted, ruled-but-undisputed) are
// unrepresentable, and private circuits can prove any threshold from a
// historical block with a single read.
//
// THIS WORD IS ALSO THE ORDER ESCROW'S AUTHORIZATION ORACLE. The per-order
// escrow has no public functions (nobody deploys it, so there is no bytecode a
// sequencer could run), which means it cannot enqueue a public assert and
// cannot serialize itself against a concurrent transaction. It can only read
// this word from a historical block. So the marketplace, which CAN serialize in
// public, decides; the escrow only follows an already-final decision.
//
// That is why the three TERMINAL states below exist. Each is written by a
// marketplace function whose enqueued public assert already resolved every
// race (cancel vs. accept, timeout-claim vs. dispute), and each authorizes
// exactly one escrow payout. Reading a terminal state from a stale anchor
// block is harmless -- states never leave them.
pub global ORDER_STATE_NONE: u8 = 0;
pub global ORDER_STATE_ACCEPTED: u8 = 1;
pub global ORDER_STATE_DISPUTED: u8 = 2;
pub global ORDER_STATE_RULED_REFUND_BUYER: u8 = 3;
pub global ORDER_STATE_RULED_PAY_VENDOR: u8 = 4;
/// Terminal: the buyer walked away before the vendor accepted. Authorizes the
/// escrow's `claim_refund` (amount + collateral back to the buyer).
pub global ORDER_STATE_CANCELLED: u8 = 5;
/// Terminal: the buyer confirmed receipt and left feedback. Authorizes the
/// escrow's `release` (vendor paid, fee to the treasury, collateral returned).
pub global ORDER_STATE_COMPLETED: u8 = 6;
/// Terminal: the vendor's timeout claim (or a PAY_VENDOR ruling) was accepted.
/// Authorizes the escrow's `claim` (vendor paid, fee to the treasury, and the
/// buyer's forfeited collateral to the vendor).
pub global ORDER_STATE_SETTLED_VENDOR: u8 = 7;

// ---------------------------------------------------------------------------
// Derivations (all Poseidon2, per PLAN.md D2)
// ---------------------------------------------------------------------------

/// Globally unique marketplace identifier, computed at deployment and
/// registered in the MarketplaceRegistry. Immutable for the lifetime of the
/// marketplace.
pub fn derive_marketplace_id(
    creator: AztecAddress,
    deployment_nonce: Field,
    config_commitment: Field,
) -> Field {
    poseidon2_hash([creator.to_field(), deployment_nonce, config_commitment])
}

/// Per-marketplace user identity. Derived client-side from the user's secret;
/// unlinkable across marketplaces and to the wallet address.
pub fn derive_marketplace_identity(user_secret: Field, marketplace_id: Field) -> Field {
    poseidon2_hash([user_secret, marketplace_id, DOMAIN_IDENTITY])
}

/// Commitment to the canonical metadata document. The document's sha256 is
/// split into two 128-bit halves (big-endian: hi = bytes 0..16, lo = bytes
/// 16..32) so it fits into fields. Mirrored by
/// packages/market-metadata::computeMetadataCommitment.
pub fn derive_metadata_commitment(content_hash_hi: Field, content_hash_lo: Field) -> Field {
    poseidon2_hash([content_hash_hi, content_hash_lo, DOMAIN_METADATA])
}

/// Registry lookup key for a hidden market. Every market is hidden: the
/// registry is keyed by this value instead of the marketplace_id, and the
/// access secret (shared out-of-band as the market link) is the only way to
/// find or decrypt a market. The secret itself never appears on-chain.
/// Mirrored by packages/identity::deriveMarketLookupKey.
pub fn derive_market_lookup_key(access_secret: Field) -> Field {
    poseidon2_hash([access_secret, DOMAIN_MARKET_LOOKUP])
}

/// Price blinding factor for a listing (AD-4). Recomputable by every holder
/// of the market link; high-entropy, so the commitment leaks nothing.
/// Mirrored by packages/identity::derivePriceBlinding.
pub fn derive_price_blinding(access_secret: Field, listing_id: Field) -> Field {
    poseidon2_hash([access_secret, listing_id, DOMAIN_PRICE_BLINDING])
}

/// Most variants a listing may offer, and most shipping methods. Fixed because
/// the commitment below hashes every slot whether used or not: a fixed-size
/// preimage is what lets the circuit rebuild it without a Merkle path.
pub global MAX_PRICE_OPTIONS: u32 = 8;
pub global MAX_SHIPPING_OPTIONS: u32 = 4;

/// Public commitment to a listing's hidden PRICE TABLE (AD-4). Stored in the
/// listing record; verified by link holders against the sealed document and
/// opened in-circuit by buyers when funding an order (M5).
///
/// A listing prices two independent choices -- which variant, and which
/// shipping method -- so one price is not enough. Committing to the whole table
/// rather than to each price separately means ONE on-chain field still binds
/// every price a buyer could pay, and `place_order` can recompute the amount
/// itself instead of taking the buyer's word for it.
///
/// UNUSED SLOTS ARE HASHED TOO, as zeros. That is deliberate: it keeps the
/// preimage a fixed size, and it binds the counts, so a vendor cannot quietly
/// grow the table later. It also means the circuit MUST reject an index at or
/// past the count -- an unused slot prices at zero, and selecting one would buy
/// the listing for nothing. See place_order.
///
/// A plain single-price listing is just a table with one option and one
/// shipping method. Mirrored by packages/identity::derivePriceCommitment.
pub fn derive_price_commitment(
    option_prices: [Field; MAX_PRICE_OPTIONS],
    option_count: u32,
    shipping_prices: [Field; MAX_SHIPPING_OPTIONS],
    shipping_count: u32,
    blinding: Field,
) -> Field {
    poseidon2_hash([
        blinding,
        DOMAIN_PRICE_COMMITMENT,
        option_count as Field,
        shipping_count as Field,
        option_prices[0],
        option_prices[1],
        option_prices[2],
        option_prices[3],
        option_prices[4],
        option_prices[5],
        option_prices[6],
        option_prices[7],
        shipping_prices[0],
        shipping_prices[1],
        shipping_prices[2],
        shipping_prices[3],
    ])
}

/// Packs the buyer's chosen option and shipping indices into ONE field, so the
/// order note can carry the selection at its 8-field cap. The vendor decodes it
/// against the listing document's own option/shipping lists.
pub fn pack_selection(option_index: u32, shipping_index: u32) -> Field {
    (option_index as Field) * 256 + (shipping_index as Field)
}

/// Opaque order identifier (AD-5). Unpredictable to outsiders thanks to the
/// buyer-chosen random nonce; both parties can recompute it from their order
/// notes. Mirrored by packages/identity::deriveOrderId.
pub fn derive_order_id(
    marketplace_id: Field,
    listing_id: Field,
    buyer: AztecAddress,
    order_nonce: Field,
) -> Field {
    poseidon2_hash([marketplace_id, listing_id, buyer.to_field(), order_nonce, DOMAIN_ORDER_ID])
}

/// The settlement nullifier for an order (AD-5): pushed by every terminal
/// settlement path, making double-settlement impossible by construction.
/// Mirrored by packages/identity::deriveOrderSettlementNullifier.
pub fn derive_order_settlement_nullifier(order_id: Field) -> Field {
    poseidon2_hash([order_id, DOMAIN_ORDER_SETTLEMENT])
}

/// Bucket tag for an identity's published contact address (AD-6). Clients
/// never compute these tags: the contract's utility reads take the raw
/// subject (identity / vendor_id / listing_id) and derive the tag inside.
pub fn derive_contact_address_tag(identity: Field) -> Field {
    poseidon2_hash([identity, DOMAIN_CONTACT_ADDRESS])
}

/// Bucket tag for a vendor account's listing index.
pub fn derive_vendor_listings_tag(vendor_id: Field) -> Field {
    poseidon2_hash([vendor_id, DOMAIN_VENDOR_LISTINGS])
}

/// Bucket tag for a listing's feedback entries.
pub fn derive_feedback_tag(listing_id: Field) -> Field {
    poseidon2_hash([listing_id, DOMAIN_FEEDBACK])
}

/// Bucket tag for a disputed order's authentication commitment (AD-6), keyed
/// by the opaque order id. Same tag family as the other bucket tags.
pub fn derive_dispute_auth_tag(order_id: Field) -> Field {
    poseidon2_hash([order_id, DOMAIN_DISPUTE_AUTH])
}

/// The public commitment a buyer publishes when opening a dispute (AD-6).
/// Revealing `dispute_secret` in the dispute room and matching this hash
/// proves buyer-ship without a ZK proof and without revealing the buyer's
/// address. Mirrored by packages/identity::deriveDisputeCommitment.
pub fn derive_dispute_commitment(dispute_secret: Field) -> Field {
    poseidon2_hash([dispute_secret, DOMAIN_DISPUTE_COMMITMENT])
}

/// Bucket tag for an order's public fulfillment status (shipped/delivered),
/// keyed by the opaque order id. Same tag family as the other bucket tags.
pub fn derive_order_fulfillment_tag(order_id: Field) -> Field {
    poseidon2_hash([order_id, DOMAIN_ORDER_FULFILLMENT])
}

/// Action nullifier: emitted once per (user, marketplace, domain, subject) to
/// make replays impossible by construction.
pub fn derive_action_nullifier(
    user_secret: Field,
    marketplace_id: Field,
    domain: Field,
    subject: Field,
) -> Field {
    poseidon2_hash([user_secret, marketplace_id, domain, subject])
}
