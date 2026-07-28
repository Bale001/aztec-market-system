use ::aztec::{
    macros::notes::note,
    protocol::{
        address::AztecAddress,
        traits::{Deserialize, Packable, Serialize},
    },
};

// Private notes are end-to-end encrypted messages whose existence on-chain is
// just an opaque commitment. A packed note may hold AT MOST 8 fields: the
// protocol caps a private log at 16 fields, of which one is the delivery tag
// and four are encryption/encoding overhead (ephemeral key, metadata, note
// storage slot, owner, randomness). These structs are sized accordingly.

/// One order. Two copies exist, identical in content: one owned by the
/// buyer (their receipt) and one owned by the vendor's inbox address (their
/// order intake). Everything the settlement paths need is snapshotted here
/// at purchase time, so later config changes cannot rewrite an order's
/// terms. (The payment asset is NOT snapshotted: update_config forbids
/// changing it, so settlement paths read it from config instead.)
///
/// The note deliberately holds NO buyer address (Option A): the vendor's copy
/// would otherwise reveal who bought. The buyer's account is never needed by
/// the vendor -- refunds are buyer-pull and fulfillment status is public -- so
/// the two parties are told apart purely by `msg_sender == vendor_inbox`
/// (vendor) vs not (buyer), and buyer-side payouts go to `msg_sender`.
#[derive(Deserialize, Eq, Packable, Serialize)]
#[note]
pub struct OrderNote {
    pub order_id: Field,
    pub listing_id: Field,
    /// Finalization collateral escrowed on top of `amount` (snapshot of
    /// config.finalization_collateral): back to the buyer when they finalize
    /// with feedback, to the vendor on a timeout claim.
    pub collateral: u128,
    /// price x quantity, escrowed at this order's own OrderEscrow address.
    pub amount: u128,
    /// Marketplace fee due on settlement (snapshot of config.fee_bps).
    pub fee: u128,
    /// The vendor's order inbox (from the sealed listing document); the only
    /// account allowed to accept, refund, and claim after timeout.
    pub vendor_inbox: AztecAddress,
    /// Unix seconds after which the vendor may claim an accepted order.
    pub timeout_at: u64,
    /// Which variant and which shipping method the buyer chose, packed as
    /// `option_index * 256 + shipping_index` (see pack_selection). Two numbers
    /// in one field because this note is AT its 8-field cap; the vendor decodes
    /// them against the listing document's own option and shipping lists, which
    /// is where the labels live. The circuit already proved the amount matches
    /// these choices, so this is the vendor's instruction, not a claim to check.
    pub selection: Field,
}

/// The keys to one order's escrow. Two copies, identical: one to the buyer
/// (so a fresh device can recover the order) and one to the vendor's inbox.
///
/// Each order's funds sit at their own OrderEscrow instance, which nobody ever
/// deploys -- it is only an address both parties derive locally. Deriving it
/// needs this note plus the matching OrderNote: `escrow_secret` gives the
/// instance's keys and salt, and the OrderNote's amounts complete the terms the
/// address commits to. That is why this is a SEPARATE note: the terms do not
/// fit alongside them under the 8-field cap above.
///
/// `escrow_secret` is deliberately shared with the vendor. It lets them see
/// the escrow's notes and settle it. (They do not need it to know the order is
/// PAID: place_order opens and funds the escrow in the same transaction that
/// writes this note, so the note existing is the proof.) It cannot be used to
/// steal: spending the
/// escrow's cUSDC needs cUSDC to accept the spend, and it requires
/// `from == msg_sender`, which only the escrow's own code can be. A leaked
/// secret exposes exactly one order, which is the point of per-order escrow.
///
/// `buyer_auth` is the HASH poseidon2([buyer_secret]) and travels here because
/// the vendor needs it to derive the address. The preimage never leaves the
/// buyer: it is what stops the vendor, who holds every other key here, from
/// calling the two escrow paths that pay their caller.
#[derive(Deserialize, Eq, Packable, Serialize)]
#[note]
pub struct OrderEscrowNote {
    pub order_id: Field,
    pub escrow_secret: Field,
    pub buyer_auth: Field,
}

/// Buyer-chosen delivery/contact text for one order, packed 31 bytes per
/// field (186 bytes max). Owned by the vendor's inbox; an observer cannot
/// even tell such a memo exists.
#[derive(Deserialize, Eq, Packable, Serialize)]
#[note]
pub struct OrderMemoNote {
    pub order_id: Field,
    pub data: [Field; 6],
}
