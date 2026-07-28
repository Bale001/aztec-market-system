use ::aztec::protocol::traits::{Deserialize, Packable, Serialize};

// Listing status values (u8). 0 doubles as "never created" since public
// storage reads as zero before the first write.
pub global LISTING_STATUS_NONE: u8 = 0;
pub global LISTING_STATUS_ACTIVE: u8 = 1;
pub global LISTING_STATUS_PAUSED: u8 = 2;
pub global LISTING_STATUS_REMOVED: u8 = 3;
// Awaiting moderator approval (APPROVAL-policy markets). Invisible to
// buyers and non-orderable -- both browse and place_order already gate on
// ACTIVE -- until a moderator sets it ACTIVE (approve) or REMOVED (reject).
pub global LISTING_STATUS_PENDING: u8 = 4;

// One entry per listing id. Ids are sequential (0..listing_count-1) so that
// holders of the market link can enumerate listings without an indexer.
//
// The sealed (AEAD-encrypted) payload blob is stored on-chain next to this
// record (AD-3), 31-byte-packed into `payload_len` bytes of field chunks.
// Without the market link, an observer sees only how many listings exist,
// their status flags, and ciphertext.
//
// `creator` is the vendor's per-market ACCOUNT address -- a single-market
// account, never the user's L1-facing wallet.
//
// `price_commitment` (AD-4) publicly binds the listing's hidden price:
// poseidon2([price, poseidon2([access_secret, listing_id,
// DOMAIN_PRICE_BLINDING]), DOMAIN_PRICE_COMMITMENT]). Link holders verify it
// against the sealed price; buyers open it in-circuit when funding an order
// (M5). To an outsider it is an unbrute-forceable hash.
// The listing content itself lives OFF-chain: the full document (description,
// options, images) is AEAD-sealed and uploaded to Arweave, and the record
// stores only an ENCRYPTED POINTER to it -- the 32-byte Arweave transaction id
// sealed under the market link key (61 bytes packed into two fields). Only
// link holders can decrypt the pointer, and the Arweave tx id is itself a hash
// of the content, so the pointer doubles as an integrity commitment.
//
// `category_tag` is an access-secret-salted hash of the listing's single
// category (0 = uncategorized). It lets link holders filter by category
// cheaply -- reading the on-chain records, no off-chain fetch -- while staying
// opaque to outsiders (the salt is the market access secret, so a tag cannot
// be reversed to a category name without the market link). The client computes
// and matches it; the contract only stores it.
//
// `next` is the id of the listing that follows this one WITHIN ITS CATEGORY --
// the market's display order is a per-category singly-linked list whose head
// and tail live in the category bucket. 0 terminates the chain, which is why
// listing ids are 1-based (see LISTING_FIRST_ID in main.nr): a 0-based scheme
// would make "end of chain" indistinguishable from "points at listing 0".
// Ordering is deliberately NOT derived from the id, so an owner can promote a
// listing (move_listing) without touching its identity, its price commitment,
// or the off-chain payload bound to it.
//
// NB: place_order proves status and price_commitment from historical public
// storage by their PACKED OFFSETS within this struct (creator +0, status +1,
// price_commitment +2). Later fields are APPENDED so those offsets never move.
// Keep the field order in sync with main.nr.
#[derive(Deserialize, Serialize, Eq, Packable)]
pub struct ListingRecord {
    pub creator: Field,
    pub status: u8,
    pub price_commitment: Field,
    pub pointer_0: Field,
    pub pointer_1: Field,
    pub category_tag: Field,
    pub next: Field,
}
