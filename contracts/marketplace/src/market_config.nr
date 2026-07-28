use ::aztec::protocol::{
    address::AztecAddress,
    traits::{Deserialize, Packable, Serialize},
};
use market_protocol::{LISTING_POLICY_APPROVAL, VENDOR_POLICY_BOTH, VENDOR_POLICY_DEPOSIT};

// Marketplace configuration, fixed by the creator at deployment and mutable
// only by the superadmin afterwards. Flat struct (nested structs in public
// storage are unreliable on this framework version). The Poseidon2 hash of
// its serialization is the config_commitment that feeds marketplace_id
// derivation.
#[derive(Deserialize, Serialize, Eq, Packable)]
pub struct MarketConfig {
    // Token used for payments, deposits, and escrow.
    pub payment_asset: AztecAddress,
    // Marketplace fee in basis points (0..=10000). The fee is paid to the
    // market's OWNER (superadmin_identity) -- it is the treasury, so there is
    // no separate fee_recipient to configure or keep in sync. Transferring
    // ownership moves the treasury with it.
    pub fee_bps: u32,
    // One of the VENDOR_POLICY_* constants in market_protocol.
    pub vendor_policy: u8,
    // Required vendor deposit; must be nonzero when the policy demands one.
    pub vendor_deposit: u128,
    // Seconds until an unconfirmed order becomes timeout-claimable.
    pub order_timeout: u64,
    // Extra amount a buyer escrows with every order, refunded when THEY
    // finalize (confirm receipt + leave feedback) and paid to the vendor when
    // the vendor is forced to settle by timeout instead -- the incentive for
    // buyers to pay the finalization fee. 0 disables the mechanism.
    // NOTE: place_order reads config fields by packed offset; keep the
    // declaration order in sync with its comment. (Disputes are OFF-CHAIN,
    // over SimpleX -- there is no dispute config here.)
    pub finalization_collateral: u128,
    // Listing authorization: one of LISTING_POLICY_* (market_protocol).
    // APPENDED last so place_order's existing offset reads never move; it does
    // change config_commitment (and thus marketplace_id), which is fine for
    // new deploys. 0 = OPEN, the default for any pre-existing serialization.
    pub listing_policy: u8,
}

impl MarketConfig {
    pub fn assert_valid(self) {
        assert(!self.payment_asset.is_zero(), "payment_asset must not be zero");
        assert(self.fee_bps <= 10000, "fee_bps must be at most 10000");
        assert(self.vendor_policy <= VENDOR_POLICY_BOTH, "invalid vendor_policy");
        let requires_deposit = (self.vendor_policy == VENDOR_POLICY_DEPOSIT)
            | (self.vendor_policy == VENDOR_POLICY_BOTH);
        if requires_deposit {
            assert(self.vendor_deposit > 0, "vendor_deposit required by vendor_policy");
        }
        assert(self.order_timeout > 0, "order_timeout must be positive");
        assert(self.listing_policy <= LISTING_POLICY_APPROVAL, "invalid listing_policy");
    }
}
