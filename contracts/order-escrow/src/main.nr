// OrderEscrow -- one instance per order, never deployed by anyone.
//
// WHY THIS SHAPE. Escrow held in a shared pool has to be openable by whoever
// settles it, which means the settling party can read the whole pool. Per-order
// escrow removes the pool: each order is its own address, holding exactly one
// order's funds, with keys derived from a per-order secret the buyer hands the
// vendor inside the order note. A leaked secret exposes exactly one order.
//
// NOBODY DEPLOYS THIS, AND NOBODY PUBLISHES ITS CLASS EITHER. Each order's
// instance is only ever an address the parties derive locally. That is sound at
// the protocol level, not a trick: the private kernel's
// `validate_contract_address` proves the called function belongs to the class
// and that `address == compute_from_class_id(class_id,
// salted_initialization_hash, public_keys)`, and never once checks that the
// instance was deployed. The address IS the commitment to the code.
//
// The CLASS need not be published either, which is verified live: the orders
// integration suite asserts the node has neither the class nor the instance
// while this contract moves real cUSDC. Publication exists so a sequencer can
// fetch PUBLIC bytecode and so strangers can fetch the artifact; this contract
// has no public functions, and both parties already ship the artifact. The
// kernel takes the class's private-function tree as a client-side hint.
//
// CONSEQUENCE: PRIVATE FUNCTIONS ONLY. Public execution needs bytecode a
// sequencer can fetch, and an undeployed instance has none. So this contract
// has no public functions and no storage. Two things follow:
//
//   - Terms live in the address (they are `open`'s initializer arguments) and
//     are carried forward by a siloed nullifier rather than by storage. See
//     terms.nr.
//   - It also means no enqueued public assert, so this contract cannot
//     serialize itself against a concurrent transaction; a historical read is
//     all it has. So it does not DECIDE anything. The marketplace, which can
//     serialize in public, owns the clock, the arbitration and every race, and
//     records the outcome in its `order_states` word; each payout below simply
//     follows one TERMINAL value of that word, read from the anchor block
//     header. Reading a terminal state late is harmless -- nothing leaves one.
//     The marketplace is bound into the address, so it cannot be swapped for a
//     friendlier one after funding.
//
// WHY NEITHER PARTY CAN STEAL. Both hold the escrow's keys, which is what lets
// each of them settle. Holding the nullifier key lets a PXE COMPUTE a nullifier
// for the escrow's cUSDC notes, but emitting one requires cUSDC's own circuit
// to accept the spend, and it checks `from == msg_sender` or an authwit from
// `from`. Only this contract's code can be `msg_sender` for its own address.
//
// THIS CONTRACT MUST THEREFORE NEVER IMPLEMENT `verify_private_authwit`. An
// account contract does, which is precisely why the escrow must not be one:
// either party could then sign as the escrow and drain it directly through
// cUSDC, bypassing every rule below.

mod test;
pub mod terms;

use ::aztec::macros::aztec;

#[aztec]
pub contract OrderEscrow {
    use ::aztec::macros::functions::{external, initializer};
    use ::aztec::context::{NullifierExistenceRequest, PrivateContext};
    use ::aztec::history::storage::public_storage_historical_read;
    use ::aztec::protocol::{
        hash::{compute_siloed_nullifier, poseidon2_hash},
        storage::map::derive_storage_slot_in_map,
    };

    use token::Token;
    use market_protocol::{
        ORDER_STATE_CANCELLED, ORDER_STATE_COMPLETED, ORDER_STATE_RULED_REFUND_BUYER,
        ORDER_STATE_SETTLED_VENDOR,
    };

    use crate::terms::EscrowTerms;

    /// Opens the escrow. The buyer calls this once, in the same transaction
    /// that funds the address; the protocol allows it once because the address
    /// commits to these arguments.
    ///
    /// It publishes a commitment to the terms so later calls can prove what
    /// this escrow was opened for without any storage to read.
    #[external("private")]
    #[initializer]
    fn open(terms: EscrowTerms) {
        assert(terms.order_id != 0, "order_id must not be zero");
        assert(terms.amount > 0 as u128, "amount must be greater than zero");
        assert(terms.fee <= terms.amount, "fee cannot exceed the escrowed amount");
        assert(!terms.vendor.is_zero(), "vendor must not be zero");
        assert(!terms.treasury.is_zero(), "treasury must not be zero");
        assert(!terms.marketplace.is_zero(), "marketplace must not be zero");
        assert(terms.buyer_auth != 0, "buyer_auth must not be zero");

        self.context.push_nullifier_unsafe(terms.commitment());
    }

    /// The buyer collects a finalized order: the vendor is paid, the treasury
    /// takes the fee, and the buyer's collateral comes back to them.
    ///
    /// Gated on COMPLETED, which only the marketplace's `confirm_completion`
    /// writes and only the buyer can reach. The buyer proves themselves again
    /// here by preimage because this is the one payout that pays the CALLER --
    /// without it the vendor, who also holds this escrow's keys, could pocket
    /// the collateral by calling first.
    #[external("private")]
    fn release(terms: EscrowTerms, buyer_secret: Field) {
        assert_opened_with(self.context, terms);
        assert(
            poseidon2_hash([buyer_secret]) == terms.buyer_auth,
            "caller is not this order's buyer",
        );
        assert(
            read_order_state(self.context, terms) == ORDER_STATE_COMPLETED,
            "order has not been finalized by the buyer",
        );

        pay_vendor(self.context, terms);
        if terms.collateral > 0 as u128 {
            // To msg_sender, not to a stored address: the buyer settles without
            // ever naming themselves.
            Token::at(terms.asset)
                .transfer_private_to_private(
                    self.address,
                    self.msg_sender(),
                    terms.collateral,
                    0,
                )
                .call(self.context);
        }
    }

    /// Pays out an order the buyer never finalized.
    ///
    /// Gated on SETTLED_VENDOR. The marketplace's `claim_timeout_settlement`
    /// writes it, and only after proving in PUBLIC that the order is accepted,
    /// not disputed, and past its deadline -- checks this contract could not
    /// make race-free itself. The buyer's collateral is forfeited here: the
    /// vendor was forced to finalize.
    ///
    /// PERMISSIONLESS ON PURPOSE. Every destination is a bound term, and this
    /// path takes no address from the caller and pays them nothing, so a
    /// stranger calling it can only push the money where it was always going.
    /// Checking the caller would buy nothing and cost a lot: a vendor's
    /// per-market account holds no fee juice, and this contract must never
    /// implement authwits (see the header), so requiring the vendor to be
    /// msg_sender would leave them unable to pay for their own settlement.
    #[external("private")]
    fn claim(terms: EscrowTerms) {
        assert_opened_with(self.context, terms);
        assert(
            read_order_state(self.context, terms) == ORDER_STATE_SETTLED_VENDOR,
            "the marketplace has not authorized a vendor settlement",
        );

        pay_vendor(self.context, terms);
        if terms.collateral > 0 as u128 {
            Token::at(terms.asset)
                .transfer_private_to_private(self.address, terms.vendor, terms.collateral, 0)
                .call(self.context);
        }
    }

    /// The buyer takes the money back: they cancelled before the vendor
    /// accepted, or the vendor/a moderator ruled for a refund.
    ///
    /// The refund is buyer-PULL for the same reason the terms hold no buyer
    /// address: nobody else knows where to send it. The full escrow returns,
    /// collateral included -- no fee is earned on an order that did not
    /// complete.
    #[external("private")]
    fn claim_refund(terms: EscrowTerms, buyer_secret: Field) {
        assert_opened_with(self.context, terms);
        assert(
            poseidon2_hash([buyer_secret]) == terms.buyer_auth,
            "caller is not this order's buyer",
        );

        let state = read_order_state(self.context, terms);
        assert(
            (state == ORDER_STATE_CANCELLED) | (state == ORDER_STATE_RULED_REFUND_BUYER),
            "no refund is available for this order",
        );

        Token::at(terms.asset)
            .transfer_private_to_private(
                self.address,
                self.msg_sender(),
                terms.amount + terms.collateral,
                0,
            )
            .call(self.context);
    }

    // ------------------------------------------------------------------
    // Library methods.
    // ------------------------------------------------------------------

    /// Proves this escrow was opened for exactly these terms.
    ///
    /// Without this every entry point would be taking the vendor and amount on
    /// the caller's word, and the buyer could redirect their own escrow. The
    /// nullifier is siloed to this contract, so only `open` can have produced
    /// it, and `open` runs at most once at an address that already commits to
    /// its arguments.
    #[contract_library_method]
    fn assert_opened_with(context: &mut PrivateContext, terms: EscrowTerms) {
        let siloed = compute_siloed_nullifier(context.this_address(), terms.commitment());
        context.assert_nullifier_exists(NullifierExistenceRequest::for_settled(siloed));
    }

    /// Reads the arbitrating marketplace's public order state from the anchor
    /// block. A historical read, so this stays a fully private call and reveals
    /// nothing about which order is being settled.
    #[contract_library_method]
    fn read_order_state(context: &mut PrivateContext, terms: EscrowTerms) -> u8 {
        let header = context.get_anchor_block_header();
        let slot = derive_storage_slot_in_map(terms.order_states_slot, terms.order_id);
        public_storage_historical_read(header, slot, terms.marketplace) as u8
    }

    /// Pays the vendor their amount less the fee, and the treasury the fee.
    #[contract_library_method]
    fn pay_vendor(context: &mut PrivateContext, terms: EscrowTerms) {
        let escrow = context.this_address();
        Token::at(terms.asset)
            .transfer_private_to_private(escrow, terms.vendor, terms.amount - terms.fee, 0)
            .call(context);
        if terms.fee > 0 as u128 {
            Token::at(terms.asset)
                .transfer_private_to_private(escrow, terms.treasury, terms.fee, 0)
                .call(context);
        }
    }
}
