use ::aztec::protocol::{
    address::AztecAddress,
    hash::poseidon2_hash,
    traits::{Deserialize, Packable, Serialize, ToField},
};

/// Everything one escrowed order needs to know.
///
/// These are the INITIALIZER's arguments, which matters more than it looks: an
/// Aztec address is `compute_from_class_id(class_id, salted_initialization_hash,
/// public_keys)`, so the address is already a commitment to this exact struct.
/// Fund a different set of terms and you are funding a different address.
///
/// The escrow has no storage to keep these in (an undeployed contract cannot
/// execute public functions, so it has no public state, and notes would need
/// keys the settling party may not hold). Instead `open` hashes them into a
/// nullifier and every later call re-supplies them and proves that nullifier
/// exists. Nullifiers are siloed per contract, so only THIS escrow's `open`
/// could have published it.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct EscrowTerms {
    /// cUSDC.
    pub asset: AztecAddress,
    /// The marketplace whose public order state authorizes this escrow. Every
    /// payout here follows a TERMINAL state that contract already committed to
    /// under its own public asserts -- it owns the clock and the race
    /// resolution, which is why no deadline appears in these terms. Bound into
    /// the address, so it cannot be swapped for a friendlier arbiter after the
    /// buyer has funded.
    pub marketplace: AztecAddress,
    /// Base storage slot of the marketplace's `order_states` map. Supplied
    /// rather than assumed so the escrow needs no compile-time knowledge of the
    /// marketplace's storage layout.
    pub order_states_slot: Field,
    pub order_id: Field,
    /// Where a completed order pays.
    pub vendor: AztecAddress,
    /// Where the marketplace fee goes.
    pub treasury: AztecAddress,
    pub amount: u128,
    pub fee: u128,
    /// The buyer's finalization collateral, escrowed on top of `amount`: back
    /// to the buyer when they finalize, forfeited to the vendor when the vendor
    /// has to finalize for them.
    pub collateral: u128,
    /// poseidon2([buyer_secret]). The buyer proves themselves by preimage, so
    /// no buyer address is ever recorded -- the vendor must never learn it.
    pub buyer_auth: Field,
}

impl EscrowTerms {
    /// The commitment `open` publishes and every other entry point checks.
    pub fn commitment(self) -> Field {
        poseidon2_hash([
            self.asset.to_field(),
            self.marketplace.to_field(),
            self.order_states_slot,
            self.order_id,
            self.vendor.to_field(),
            self.treasury.to_field(),
            self.amount as Field,
            self.fee as Field,
            self.collateral as Field,
            self.buyer_auth,
        ])
    }
}
