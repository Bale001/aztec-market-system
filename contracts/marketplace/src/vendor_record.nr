use ::aztec::protocol::{
    address::AztecAddress,
    traits::{Deserialize, Packable, Serialize},
};

// One entry per vendor, keyed by the vendor's per-market ACCOUNT address
// (msg_sender at registration, AD-4) -- a single-market account that is never
// linked to L1 or the user's universal wallet. Status values are the
// VENDOR_STATUS_* constants in market_protocol (0 doubles as "never registered"
// since public storage reads as zero before the first write).
//
// `deposit` is held in this marketplace's PUBLIC balance of `deposit_asset`
// (AD-4: public custody keeps future slashing enforceable; ingress and
// egress still hide the vendor's account). It can only leave through the
// withdrawal flow: request, wait `order_timeout` seconds, then execute. That
// time-lock is the actual backstop -- once it elapses, any order the vendor
// walked away from has become claimable/cancellable, so the deposit no longer
// backs in-flight commitments. No admin function touches deposits.
#[derive(Deserialize, Serialize, Eq, Packable)]
pub struct VendorRecord {
    pub status: u8,
    pub deposit: u128,
    pub deposit_asset: AztecAddress,
    pub withdrawal_requested_at: u64,
    // Reserved counter, NOT currently maintained: orders are fully private and
    // cannot update a per-vendor public record without revealing which vendor
    // sold, so the withdrawal guard on this field is presently a no-op (the
    // `order_timeout` time-lock is what gates withdrawal). See main.nr.
    pub active_orders: u64,
}
