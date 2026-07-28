use ::aztec::test::helpers::test_environment::CallPrivateOptions;
use market_protocol::{
    ORDER_STATE_ACCEPTED, ORDER_STATE_CANCELLED, ORDER_STATE_COMPLETED, ORDER_STATE_DISPUTED,
    ORDER_STATE_RULED_REFUND_BUYER, ORDER_STATE_SETTLED_VENDOR,
};
use token::Token;

use crate::OrderEscrow;
use crate::test::utils::{AMOUNT, BUYER_SECRET, COLLATERAL, FEE, set_order_state, setup};

// The escrow decides nothing on its own: every payout below follows a TERMINAL
// value of the marketplace's public order state, which is where the clock, the
// arbitration and all of the race resolution live. See main.nr.

// ----------------------------------------------------------------------
// The happy paths. Both are the load-bearing claim: an escrow contract nobody
// deployed, holding real cUSDC, moving it under its own rules.
// ----------------------------------------------------------------------

#[test]
unconstrained fn buyer_releases_a_completed_order() {
    let (mut env, escrow, token, arbiter, terms, buyer, vendor, treasury) = setup();

    set_order_state(&mut env, arbiter, buyer, ORDER_STATE_COMPLETED);

    let before = env.execute_utility(Token::at(token).balance_of_private(buyer));
    env.call_private_opts(buyer, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).release(terms, BUYER_SECRET));

    assert_eq(
        env.execute_utility(Token::at(token).balance_of_private(vendor)),
        AMOUNT - FEE,
    );
    assert_eq(env.execute_utility(Token::at(token).balance_of_private(treasury)), FEE);
    // The buyer finalized, so their collateral comes back in full.
    assert_eq(
        env.execute_utility(Token::at(token).balance_of_private(buyer)),
        before + COLLATERAL,
    );
}

#[test]
unconstrained fn vendor_claims_a_settled_order() {
    let (mut env, escrow, token, arbiter, terms, _buyer, vendor, treasury) = setup();

    set_order_state(&mut env, arbiter, vendor, ORDER_STATE_SETTLED_VENDOR);
    env.call_private_opts(vendor, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).claim(terms));

    // The buyer went silent and the vendor had to finalize, so the collateral
    // is forfeited to the vendor on top of the payout.
    assert_eq(
        env.execute_utility(Token::at(token).balance_of_private(vendor)),
        AMOUNT - FEE + COLLATERAL,
    );
    assert_eq(env.execute_utility(Token::at(token).balance_of_private(treasury)), FEE);
}

// ----------------------------------------------------------------------
// Terms binding. Without this the escrow would take the caller's word for
// where to send the money.
// ----------------------------------------------------------------------

// The buyer re-points the escrow at themselves and settles. The nullifier
// `open` published commits to the ORIGINAL terms, so the forged set proves
// nothing and the call dies before any transfer.
#[test(should_fail)]
unconstrained fn forged_terms_are_rejected() {
    let (mut env, escrow, _token, arbiter, terms, buyer, _vendor, _treasury) = setup();

    let mut forged = terms;
    forged.vendor = buyer;

    set_order_state(&mut env, arbiter, buyer, ORDER_STATE_SETTLED_VENDOR);
    env.call_private_opts(buyer, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).claim(forged));
}

#[test(should_fail)]
unconstrained fn a_forged_fee_is_rejected() {
    let (mut env, escrow, _token, arbiter, terms, _buyer, vendor, _treasury) = setup();

    let mut forged = terms;
    forged.fee = 0 as u128;

    set_order_state(&mut env, arbiter, vendor, ORDER_STATE_SETTLED_VENDOR);
    env.call_private_opts(vendor, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).claim(forged));
}

// ----------------------------------------------------------------------
// Authorization. Both parties hold this escrow's keys -- that is what lets
// each of them settle -- so every entry point has to say who may call it.
// ----------------------------------------------------------------------

// `claim` is permissionless, and safely so: every destination is a bound term.
// A stranger calling it can only push the money where it was always going --
// which is what lets the vendor's fee-juice-less per-market account be settled
// for by somebody who can pay.
#[test]
unconstrained fn anyone_may_push_a_settled_order_to_the_vendor() {
    let (mut env, escrow, token, arbiter, terms, buyer, vendor, _treasury) = setup();

    set_order_state(&mut env, arbiter, buyer, ORDER_STATE_SETTLED_VENDOR);
    let stranger = env.create_light_account();
    env.call_private_opts(stranger, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).claim(terms));

    assert_eq(
        env.execute_utility(Token::at(token).balance_of_private(vendor)),
        AMOUNT - FEE + COLLATERAL,
    );
    // ...and nothing reached the caller.
    assert_eq(env.execute_utility(Token::at(token).balance_of_private(stranger)), 0);
}

// `release` is the one payout that pays its CALLER (the collateral). Without
// the preimage check the vendor could finalize first and pocket it.
#[test(should_fail_with = "caller is not this order's buyer")]
unconstrained fn the_vendor_cannot_release_and_take_the_collateral() {
    let (mut env, escrow, _token, arbiter, terms, buyer, vendor, _treasury) = setup();

    set_order_state(&mut env, arbiter, buyer, ORDER_STATE_COMPLETED);
    env.call_private_opts(vendor, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).release(terms, 0xbad5ec1e7));
}

// ----------------------------------------------------------------------
// The escrow follows the marketplace and nothing else.
// ----------------------------------------------------------------------

#[test(should_fail_with = "order has not been finalized by the buyer")]
unconstrained fn release_needs_the_order_finalized() {
    let (mut env, escrow, _token, _arbiter, terms, buyer, _vendor, _treasury) = setup();

    env.call_private_opts(buyer, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).release(terms, BUYER_SECRET));
}

#[test(should_fail_with = "the marketplace has not authorized a vendor settlement")]
unconstrained fn vendor_cannot_claim_a_live_order() {
    let (mut env, escrow, _token, arbiter, terms, _buyer, vendor, _treasury) = setup();

    set_order_state(&mut env, arbiter, vendor, ORDER_STATE_ACCEPTED);
    env.call_private_opts(vendor, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).claim(terms));
}

// A live dispute never reaches SETTLED_VENDOR, because the marketplace's
// timeout claim asserts against it in public. This is what makes the off-chain
// arbitration binding.
#[test(should_fail_with = "the marketplace has not authorized a vendor settlement")]
unconstrained fn a_dispute_blocks_the_vendor_claim() {
    let (mut env, escrow, _token, arbiter, terms, _buyer, vendor, _treasury) = setup();

    set_order_state(&mut env, arbiter, vendor, ORDER_STATE_DISPUTED);
    env.call_private_opts(vendor, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).claim(terms));
}

// ----------------------------------------------------------------------
// Refunds. Buyer-PULL for the same reason the terms hold no buyer address:
// nobody else knows where to send it.
// ----------------------------------------------------------------------

#[test]
unconstrained fn buyer_pulls_a_refund_after_a_ruling() {
    let (mut env, escrow, token, arbiter, terms, buyer, _vendor, _treasury) = setup();

    set_order_state(&mut env, arbiter, buyer, ORDER_STATE_RULED_REFUND_BUYER);

    let before = env.execute_utility(Token::at(token).balance_of_private(buyer));
    env.call_private_opts(buyer, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).claim_refund(terms, BUYER_SECRET));

    // The FULL escrow returns; no fee is earned on an order that did not
    // complete, and the collateral was never at stake.
    assert_eq(
        env.execute_utility(Token::at(token).balance_of_private(buyer)),
        before + AMOUNT + COLLATERAL,
    );
}

#[test]
unconstrained fn buyer_pulls_a_refund_after_cancelling() {
    let (mut env, escrow, token, arbiter, terms, buyer, _vendor, _treasury) = setup();

    set_order_state(&mut env, arbiter, buyer, ORDER_STATE_CANCELLED);

    let before = env.execute_utility(Token::at(token).balance_of_private(buyer));
    env.call_private_opts(buyer, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).claim_refund(terms, BUYER_SECRET));

    assert_eq(
        env.execute_utility(Token::at(token).balance_of_private(buyer)),
        before + AMOUNT + COLLATERAL,
    );
}

#[test(should_fail_with = "no refund is available for this order")]
unconstrained fn buyer_cannot_refund_a_live_order() {
    let (mut env, escrow, _token, arbiter, terms, buyer, _vendor, _treasury) = setup();

    set_order_state(&mut env, arbiter, buyer, ORDER_STATE_ACCEPTED);
    env.call_private_opts(buyer, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).claim_refund(terms, BUYER_SECRET));
}

#[test(should_fail_with = "no refund is available for this order")]
unconstrained fn buyer_cannot_refund_a_completed_order() {
    let (mut env, escrow, _token, arbiter, terms, buyer, _vendor, _treasury) = setup();

    set_order_state(&mut env, arbiter, buyer, ORDER_STATE_COMPLETED);
    env.call_private_opts(buyer, CallPrivateOptions::new().with_additional_scopes([escrow]), OrderEscrow::at(escrow).claim_refund(terms, BUYER_SECRET));
}
