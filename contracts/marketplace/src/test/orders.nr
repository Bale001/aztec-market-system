// Order-flow TXE tests (AD-5).
//
// This contract holds NO order funds -- each order's money sits at its own
// OrderEscrow instance -- so what is tested here is the whole of the
// marketplace's job: the order notes, the authorization rules, and the public
// lifecycle word whose TERMINAL values are what later authorize the escrow to
// pay out. The money itself is tested in the order-escrow package (which drives
// that word directly through a test arbiter) and end-to-end in the live TS
// suite, where the two contracts meet.

use crate::test::utils;
use crate::Marketplace;
use market_protocol::{
    DISPUTE_OUTCOME_PAY_VENDOR, DISPUTE_OUTCOME_REFUND_BUYER,
    ORDER_STATE_CANCELLED, ORDER_STATE_COMPLETED, ORDER_STATE_SETTLED_VENDOR,
    ORDER_STATUS_SHIPPED, PERM_MODERATE_LISTINGS, PERM_RESOLVE_DISPUTES,
};

// A stand-in buyer dispute-auth commitment (AD-6). In production this is
// poseidon2([dispute_secret, DOMAIN_DISPUTE_COMMITMENT]); the tests only need
// a nonzero value that dispute_order stores and get_dispute_commitment returns.
global TEST_DISPUTE_COMMITMENT: Field = 0xd15c07;

// ---------------------------------------------------------------------------
// Placing an order: note delivery, all private
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_place_order_delivers_the_order_privately() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();

    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);

    // Both parties hold the identical order note, and the vendor got the
    // delivery memo. The amounts are snapshotted from config so later config
    // changes cannot alter them -- and because they are also the escrow's
    // terms, that snapshot is what fixes the address the money sits at.
    let (vendor_orders, vendor_count) =
        env.execute_utility(Marketplace::at(marketplace).get_orders(vendor, 0));
    assert_eq(vendor_count, 1);
    assert_eq(vendor_orders[0].order_id, order_id);
    assert_eq(vendor_orders[0].listing_id, 1);
    assert_eq(vendor_orders[0].collateral, utils::FINALIZATION_COLLATERAL);
    assert_eq(vendor_orders[0].amount, utils::ORDER_AMOUNT);
    assert_eq(vendor_orders[0].fee, utils::ORDER_FEE);
    // The vendor's copy carries NO buyer address (Option A).
    assert_eq(vendor_orders[0].vendor_inbox, vendor);

    // No feedback exists until an order is finalized.
    assert_eq(env.execute_utility(Marketplace::at(marketplace).get_feedback_count(0)), 0);

    let (buyer_orders, buyer_count) =
        env.execute_utility(Marketplace::at(marketplace).get_orders(buyer, 0));
    assert_eq(buyer_count, 1);
    assert_eq(buyer_orders[0].order_id, order_id);

    let (memos, memo_count) =
        env.execute_utility(Marketplace::at(marketplace).get_order_memos(vendor, 0));
    assert_eq(memo_count, 1);
    assert_eq(memos[0].order_id, order_id);
    assert_eq(memos[0].data[0], 0x3e30);

    // BOTH parties get the escrow keys. The vendor needs them to settle the
    // order; the buyer needs them to recover it on another device. Neither
    // needs them to know the order is paid -- place_order opened and funded the
    // escrow in the same transaction that wrote these notes.
    let (vendor_escrows, vendor_escrow_count) =
        env.execute_utility(Marketplace::at(marketplace).get_order_escrows(vendor, 0));
    assert_eq(vendor_escrow_count, 1);
    assert_eq(vendor_escrows[0].order_id, order_id);
    assert_eq(vendor_escrows[0].escrow_secret, utils::test_escrow_secret(1));
    // The vendor gets the buyer's auth HASH, never its preimage -- that is
    // what stops them calling the escrow paths that pay their caller.
    assert_eq(vendor_escrows[0].buyer_auth, utils::TEST_BUYER_AUTH);

    let (buyer_escrows, buyer_escrow_count) =
        env.execute_utility(Marketplace::at(marketplace).get_order_escrows(buyer, 0));
    assert_eq(buyer_escrow_count, 1);
    assert_eq(buyer_escrows[0].escrow_secret, vendor_escrows[0].escrow_secret);

    // Nothing is accepted or settled yet.
    assert(!env.execute_utility(Marketplace::at(marketplace).is_order_accepted(order_id)));
    assert(!env.execute_utility(Marketplace::at(marketplace).is_order_settled(order_id)));
    assert_eq(env.execute_utility(Marketplace::at(marketplace).get_order_state(order_id)), 0);
}

// The order amount must open the listing's public price commitment -- it is
// what the buyer will fund the escrow with.
#[test(should_fail_with = "prices do not open the listing's price commitment")]
unconstrained fn test_fail_wrong_price() {
    let (mut env, marketplace, _token, vendor, buyer, _admin) = utils::setup_order_market();
    // An escrow for the price the buyer is trying to pay. The price check
    // rejects them before the escrow is ever reached, which is the point: a
    // buyer cannot buy their way past it by funding a matching escrow.
    let cheap = (utils::LISTING_PRICE - 1) * (utils::ORDER_QUANTITY as u128);
    let terms = utils::expected_escrow_terms(&mut env, marketplace, buyer, vendor, 7, cheap);
    let escrow = utils::escrow_address_for(7, terms);
    let _ = env.call_private(
        buyer,
        Marketplace::at(marketplace).place_order(
            utils::ACCESS_SECRET,
            1,
            // A table the listing never committed to: one unit cheaper.
            [(utils::LISTING_PRICE - 1) as Field, 0, 0, 0, 0, 0, 0, 0],
            1,
            utils::test_shipping_prices(),
            1,
            0,
            0,
            utils::ORDER_QUANTITY,
            vendor,
            7,
            [0; 6],
            utils::test_escrow_secret(7),
            utils::TEST_BUYER_AUTH,
            escrow,
            buyer,
            0x7000,
        ),
    );
}

// A listing prices variants and shipping independently, and the commitment
// binds the WHOLE table -- so the amount is computed from proven prices rather
// than taken from the buyer.
#[test]
unconstrained fn test_multi_option_order_prices_the_chosen_rows() {
    let (mut env, marketplace, token, vendor, buyer, _admin) =
        utils::setup_priced_market([100, 250, 0, 0, 0, 0, 0, 0], 2, [10, 40, 0, 0], 2);

    // The dearer variant, the dearer shipping, two of them: shipping is charged
    // ONCE for the order, only the item scales with quantity.
    let order_id = utils::place_priced_order(&mut env, marketplace, token, buyer, vendor, 1, 1, 1, 2);

    let (orders, count) = env.execute_utility(Marketplace::at(marketplace).get_orders(vendor, 0));
    assert_eq(count, 1);
    assert_eq(orders[0].order_id, order_id);
    assert_eq(orders[0].amount, 250 * 2 + 40);
    // The vendor learns WHICH rows to ship from the packed selection.
    assert_eq(orders[0].selection, 1 * 256 + 1);
}

// Unused table slots are committed as ZEROS. Selecting one would buy the
// listing for free, so the index bounds are the only thing preventing it --
// this is the single most important check in place_order.
#[test(should_fail_with = "option is not offered by this listing")]
unconstrained fn test_fail_buying_an_unoffered_option_for_free() {
    let (mut env, marketplace, token, vendor, buyer, _admin) =
        utils::setup_priced_market([100, 250, 0, 0, 0, 0, 0, 0], 2, [10, 40, 0, 0], 2);

    // Slot 5 is an unused zero: priced at nothing, and never offered.
    let _ = utils::place_priced_order(&mut env, marketplace, token, buyer, vendor, 1, 5, 0, 1);
}

#[test(should_fail_with = "shipping method is not offered by this listing")]
unconstrained fn test_fail_choosing_unoffered_shipping() {
    let (mut env, marketplace, token, vendor, buyer, _admin) =
        utils::setup_priced_market([100, 250, 0, 0, 0, 0, 0, 0], 2, [10, 40, 0, 0], 2);

    let _ = utils::place_priced_order(&mut env, marketplace, token, buyer, vendor, 1, 0, 3, 1);
}

// PROOF OF PAYMENT. An order note must not be creatable without the money
// behind it. place_order cannot check that by looking -- an escrow's address is
// a hash of its class, keys and INITIALIZER ARGUMENTS, none of which a circuit
// can compute -- so it builds the terms itself and OPENS the address the buyer
// named. The private kernel admits that call only if the address really is the
// one those terms produce, which makes the buyer unable to name anything else.
//
// Here the buyer escrows for a single unit and orders ORDER_QUANTITY of them.
// Every other substitution fails identically (a friendlier vendor, a smaller
// collateral, another market's order id): they are all just different terms,
// and therefore a different address.
#[test(should_fail_with = "Initialization hash does not match")]
unconstrained fn test_fail_escrow_opened_for_a_cheaper_order() {
    let (mut env, marketplace, _token, vendor, buyer, _admin) = utils::setup_order_market();

    // Terms for one unit rather than ORDER_QUANTITY of them.
    let cheap =
        utils::expected_escrow_terms(&mut env, marketplace, buyer, vendor, 7, utils::LISTING_PRICE);
    let cheap_escrow = utils::escrow_address_for(7, cheap);

    let _ = env.call_private(
        buyer,
        Marketplace::at(marketplace).place_order(
            utils::ACCESS_SECRET,
            1,
            utils::test_option_prices(),
            1,
            utils::test_shipping_prices(),
            1,
            0,
            0,
            utils::ORDER_QUANTITY,
            vendor,
            7,
            [0; 6],
            utils::test_escrow_secret(7),
            utils::TEST_BUYER_AUTH,
            cheap_escrow,
            buyer,
            0x7000,
        ),
    );
}

// ---------------------------------------------------------------------------
// Acceptance: the one anonymous public bit + the buyer's status note
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_accept_order() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);

    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));

    // Acceptance is the public ACCEPTED state; the buyer reads it directly, no
    // per-buyer note (that would need the buyer's address).
    assert(env.execute_utility(Marketplace::at(marketplace).is_order_accepted(order_id)));
}

// Accepting twice fails on the public flag.
#[test(should_fail_with = "order was already accepted")]
unconstrained fn test_fail_double_accept() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
}

// Only the vendor named in the order can accept it: the buyer holds an
// identical note copy, but the vendor_inbox field does not match them.
#[test(should_fail_with = "caller is not this order's vendor")]
unconstrained fn test_fail_buyer_cannot_accept() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(buyer, Marketplace::at(marketplace).accept_order(order_id, buyer, 0));
}

// ---------------------------------------------------------------------------
// Settlement authorization (the checks fire before any transfer)
// ---------------------------------------------------------------------------

// The vendor holds a copy of the note but cannot cancel: cancellation is the
// buyer's right.
#[test(should_fail_with = "caller is not this order's buyer")]
unconstrained fn test_fail_vendor_cannot_cancel() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).cancel_order(order_id));
}

// A stranger has no order note at all -- to them the order does not exist.
#[test(should_fail_with = "order note not found for this account")]
unconstrained fn test_fail_stranger_cannot_confirm() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    let stranger = env.create_light_account();
    env.call_private(
        stranger,
        Marketplace::at(marketplace).confirm_completion(order_id, utils::test_feedback_blob()),
    );
}

// Finalizing WITHOUT feedback is not allowed: the collateral exists to make
// the buyer pay the finalization fee, and the feedback is what they pay for.
#[test(should_fail_with = "feedback is required to finalize an order")]
unconstrained fn test_fail_confirm_without_feedback() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(
        buyer,
        Marketplace::at(marketplace).confirm_completion(order_id, [0; 12]),
    );
}

// ---------------------------------------------------------------------------
// Terminal states. These are what authorize the escrow to pay out, and they
// are decided HERE -- in public, where transactions serialize -- precisely
// because the escrow can only read a historical block and so could not settle
// any of these races itself.
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_cancel_authorizes_the_refund() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);

    env.call_private(buyer, Marketplace::at(marketplace).cancel_order(order_id));

    assert_eq(
        env.execute_utility(Marketplace::at(marketplace).get_order_state(order_id)),
        ORDER_STATE_CANCELLED,
    );
    assert(env.execute_utility(Marketplace::at(marketplace).is_order_settled(order_id)));
}

// The race the escrow could not settle for itself: if the vendor's acceptance
// lands first, the cancellation reverts and the funds stay escrowed.
#[test(should_fail_with = "order was already accepted")]
unconstrained fn test_fail_cancel_after_accept() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(buyer, Marketplace::at(marketplace).cancel_order(order_id));
}

#[test]
unconstrained fn test_confirm_completion_authorizes_the_release() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));

    env.call_private(
        buyer,
        Marketplace::at(marketplace).confirm_completion(order_id, utils::test_feedback_blob()),
    );

    assert_eq(
        env.execute_utility(Marketplace::at(marketplace).get_order_state(order_id)),
        ORDER_STATE_COMPLETED,
    );
    // The feedback lands in the same public call as the state.
    assert_eq(env.execute_utility(Marketplace::at(marketplace).get_feedback_count(1)), 1);
}

// A disputed order cannot be quietly finalized around the dispute.
#[test(should_fail_with = "order cannot be completed in its current state")]
unconstrained fn test_fail_confirm_a_disputed_order() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));
    env.call_private(
        buyer,
        Marketplace::at(marketplace).confirm_completion(order_id, utils::test_feedback_blob()),
    );
}

#[test]
unconstrained fn test_timeout_claim_authorizes_the_vendor() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));

    // Default config order_timeout is 604800s.
    env.advance_next_block_timestamp_by(604800 + 60);
    env.mine_block();
    env.call_private(vendor, Marketplace::at(marketplace).claim_timeout_settlement(order_id, vendor, 0));

    assert_eq(
        env.execute_utility(Marketplace::at(marketplace).get_order_state(order_id)),
        ORDER_STATE_SETTLED_VENDOR,
    );
}

// The other race the escrow could not settle: a live dispute blocks the
// vendor's timeout claim, so SETTLED_VENDOR is never reached and the escrow
// stays shut. This is what makes the off-chain arbitration binding.
#[test(should_fail_with = "order is disputed")]
unconstrained fn test_fail_timeout_claim_while_disputed() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));

    env.advance_next_block_timestamp_by(604800 + 60);
    env.mine_block();
    env.call_private(vendor, Marketplace::at(marketplace).claim_timeout_settlement(order_id, vendor, 0));
}

// A PAY_VENDOR ruling re-opens the claim without waiting out the clock.
#[test]
unconstrained fn test_ruling_for_the_vendor_authorizes_settlement() {
    let (mut env, marketplace, token, vendor, buyer, admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));
    env.call_private(
        admin,
        Marketplace::at(marketplace).resolve_dispute(order_id, DISPUTE_OUTCOME_PAY_VENDOR, admin, 0),
    );

    env.call_private(vendor, Marketplace::at(marketplace).claim_timeout_settlement(order_id, vendor, 0));

    assert_eq(
        env.execute_utility(Marketplace::at(marketplace).get_order_state(order_id)),
        ORDER_STATE_SETTLED_VENDOR,
    );
}

// ---------------------------------------------------------------------------
// Timeout gating: deadline and acceptance are checked before authorization
// ---------------------------------------------------------------------------

#[test(should_fail_with = "order timeout has not elapsed")]
unconstrained fn test_fail_timeout_claim_too_early() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(vendor, Marketplace::at(marketplace).claim_timeout_settlement(order_id, vendor, 0));
}

#[test(should_fail_with = "order was never accepted")]
unconstrained fn test_fail_timeout_claim_without_accept() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    // Default config order_timeout is 604800s.
    env.advance_next_block_timestamp_by(604800 + 60);
    env.mine_block();
    env.call_private(vendor, Marketplace::at(marketplace).claim_timeout_settlement(order_id, vendor, 0));
}

// ---------------------------------------------------------------------------
// Fulfillment status (public per-order word, keyed by the opaque order id)
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_vendor_sends_shipping_update() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));

    // No fulfillment status until the vendor sends one.
    assert_eq(env.execute_utility(Marketplace::at(marketplace).get_order_fulfillment(order_id)), 0);

    env.call_private(
        vendor,
        Marketplace::at(marketplace).update_order_status(order_id, ORDER_STATUS_SHIPPED, vendor, 0),
    );

    // The buyer reads it from the public word with just the order id.
    assert_eq(
        env.execute_utility(Marketplace::at(marketplace).get_order_fulfillment(order_id)),
        ORDER_STATUS_SHIPPED,
    );
}

// The buyer cannot send vendor-side fulfillment updates.
#[test(should_fail_with = "caller is not this order's vendor")]
unconstrained fn test_fail_buyer_cannot_send_status() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(
        buyer,
        Marketplace::at(marketplace).update_order_status(order_id, ORDER_STATUS_SHIPPED, buyer, 0),
    );
}

// ---------------------------------------------------------------------------
// Multiple orders
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_two_orders_are_independent() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let first = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    let second = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 2);
    assert(first != second);

    let (_, count) = env.execute_utility(Marketplace::at(marketplace).get_orders(vendor, 0));
    assert_eq(count, 2);
    // Each order carries its OWN escrow secret: a leak exposes exactly one
    // order, which is the whole point of per-order escrow.
    let (escrows, escrow_count) =
        env.execute_utility(Marketplace::at(marketplace).get_order_escrows(vendor, 0));
    assert_eq(escrow_count, 2);
    assert(escrows[0].escrow_secret != escrows[1].escrow_secret);

    // Accepting one leaves the other untouched.
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(second, vendor, 0));
    assert(!env.execute_utility(Marketplace::at(marketplace).is_order_accepted(first)));
    assert(env.execute_utility(Marketplace::at(marketplace).is_order_accepted(second)));
}

// ---------------------------------------------------------------------------
// Disputes: the anonymous on-chain flag (resolution itself is off-chain).
// The escrow-touching halves -- the DISPUTED public assert blocking the
// timeout payout, and the buyer's claim_refund after refund_order offers it --
// are covered by the live integration suite (TXE cannot spend the
// marketplace's escrow notes).
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_dispute_order_sets_public_flag() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));

    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));

    // The vendor learns of the dispute from this public flag (no per-party
    // note, so no buyer address is involved).
    assert(env.execute_utility(Marketplace::at(marketplace).is_order_disputed(order_id)));
    // The buyer's authentication commitment is published for the moderator to
    // check the in-room reveal against (AD-6).
    assert_eq(
        env.execute_utility(Marketplace::at(marketplace).get_dispute_commitment(order_id)),
        TEST_DISPUTE_COMMITMENT,
    );
}

// Before acceptance the buyer can simply cancel; disputing is not allowed.
#[test(should_fail_with = "order is not accepted; cancel it instead of disputing")]
unconstrained fn test_fail_dispute_before_acceptance() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));
}

// One dispute per order: the flag is monotonic.
#[test(should_fail_with = "order is already disputed")]
unconstrained fn test_fail_double_dispute() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));
    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));
}

// Only the order buyer can dispute (the vendor holds a note copy too, but
// `msg_sender == vendor_inbox` identifies and rejects them).
#[test(should_fail_with = "caller is not this order's buyer")]
unconstrained fn test_fail_vendor_cannot_dispute() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(vendor, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));
}

// Only the order vendor can offer a refund (fails at the vendor check).
#[test(should_fail_with = "caller is not this order's vendor")]
unconstrained fn test_fail_buyer_cannot_refund() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(buyer, Marketplace::at(marketplace).refund_order(order_id, buyer, 0));
}

// The vendor's refund is now an OFFER: it flips the order to REFUND_BUYER, and
// the buyer pulls the escrow themselves (claim_refund, covered by the live
// suite). No funds move here, so the TXE can check the state transition.
#[test]
unconstrained fn test_vendor_refund_offers_refund() {
    let (mut env, marketplace, token, vendor, buyer, _admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(vendor, Marketplace::at(marketplace).refund_order(order_id, vendor, 0));

    assert_eq(
        env.execute_utility(Marketplace::at(marketplace).get_dispute_outcome(order_id)),
        DISPUTE_OUTCOME_REFUND_BUYER,
    );
}

// ---------------------------------------------------------------------------
// Bounded arbitration: rulings on disputed orders. The escrow-executing
// halves (the buyer's claim_refund; the unblocked timeout payout) are
// covered by the live integration suite.
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_superadmin_rules_refund() {
    let (mut env, marketplace, token, vendor, buyer, admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));

    env.call_private(
        admin,
        Marketplace::at(marketplace).resolve_dispute(order_id, DISPUTE_OUTCOME_REFUND_BUYER, admin, 0),
    );
    assert_eq(
        env.execute_utility(Marketplace::at(marketplace).get_dispute_outcome(order_id)),
        DISPUTE_OUTCOME_REFUND_BUYER,
    );
}

#[test]
unconstrained fn test_moderator_with_permission_rules_pay_vendor() {
    let (mut env, marketplace, token, vendor, buyer, admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));

    let moderator = env.create_light_account();
    env.call_private(
        admin,
        Marketplace::at(marketplace).assign_moderator(moderator, PERM_RESOLVE_DISPUTES, admin, 0),
    );
    env.call_private(
        moderator,
        Marketplace::at(marketplace).resolve_dispute(order_id, DISPUTE_OUTCOME_PAY_VENDOR, moderator, 0),
    );
    assert_eq(
        env.execute_utility(Marketplace::at(marketplace).get_dispute_outcome(order_id)),
        DISPUTE_OUTCOME_PAY_VENDOR,
    );
}

#[test(should_fail_with = "caller lacks the resolve-disputes permission")]
unconstrained fn test_fail_moderator_without_permission_cannot_rule() {
    let (mut env, marketplace, token, vendor, buyer, admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));

    // Has listing-moderation rights, but NOT the resolve-disputes bit.
    let moderator = env.create_light_account();
    env.call_private(
        admin,
        Marketplace::at(marketplace).assign_moderator(moderator, PERM_MODERATE_LISTINGS, admin, 0),
    );
    env.call_private(
        moderator,
        Marketplace::at(marketplace).resolve_dispute(order_id, DISPUTE_OUTCOME_REFUND_BUYER, moderator, 0),
    );
}

#[test(should_fail_with = "order is not disputed")]
unconstrained fn test_fail_cannot_rule_undisputed_order() {
    let (mut env, marketplace, token, vendor, buyer, admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(
        admin,
        Marketplace::at(marketplace).resolve_dispute(order_id, DISPUTE_OUTCOME_REFUND_BUYER, admin, 0),
    );
}

#[test(should_fail_with = "dispute is already ruled")]
unconstrained fn test_fail_double_ruling() {
    let (mut env, marketplace, token, vendor, buyer, admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));
    env.call_private(
        admin,
        Marketplace::at(marketplace).resolve_dispute(order_id, DISPUTE_OUTCOME_REFUND_BUYER, admin, 0),
    );
    env.call_private(
        admin,
        Marketplace::at(marketplace).resolve_dispute(order_id, DISPUTE_OUTCOME_PAY_VENDOR, admin, 0),
    );
}

#[test(should_fail_with = "invalid dispute outcome")]
unconstrained fn test_fail_invalid_outcome() {
    let (mut env, marketplace, token, vendor, buyer, admin) = utils::setup_order_market();
    let order_id = utils::place_test_order(&mut env, marketplace, token, buyer, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).accept_order(order_id, vendor, 0));
    env.call_private(buyer, Marketplace::at(marketplace).dispute_order(order_id, TEST_DISPUTE_COMMITMENT));
    env.call_private(admin, Marketplace::at(marketplace).resolve_dispute(order_id, 7, admin, 0));
}
