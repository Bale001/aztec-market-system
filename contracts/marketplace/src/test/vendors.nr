use ::aztec::{
    protocol::{address::AztecAddress, traits::ToField},
    test::helpers::authwit::add_private_authwit_from_call,
};

use crate::test::utils;
use crate::Marketplace;
use market_protocol::{
    PERM_MANAGE_VENDORS, VENDOR_STATUS_ACTIVE, VENDOR_STATUS_PENDING, VENDOR_STATUS_SUSPENDED,
};
use token::Token;

// Account model: a vendor's identity is its per-market account address; a
// vendor must claim a username (register) before registering as a vendor.

// ---------------------------------------------------------------------------
// Registration per policy
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_open_policy_registers_active() {
    let (mut env, marketplace, _admin) = utils::setup_open();
    let vendor = env.create_light_account();
    utils::register_vendor_no_deposit(&mut env, marketplace, vendor);

    let vendor_id = utils::vendor_id_of(vendor);
    let record = env.execute_utility(Marketplace::at(marketplace).get_vendor(vendor_id));
    assert_eq(record.status, VENDOR_STATUS_ACTIVE);
    assert_eq(record.deposit, 0);
    assert_eq(record.active_orders, 0);

    // Enumeration index points back at the account address.
    let count = env.execute_utility(Marketplace::at(marketplace).get_vendor_count());
    assert_eq(count, 1);
    let listed_id = env.execute_utility(Marketplace::at(marketplace).get_vendor_id_at(0));
    assert_eq(listed_id, vendor_id);
}

#[test]
unconstrained fn test_approval_policy_registers_pending_then_approved() {
    let (mut env, marketplace, admin) = utils::setup();
    let vendor = env.create_light_account();
    utils::register_vendor_no_deposit(&mut env, marketplace, vendor);

    let vendor_id = utils::vendor_id_of(vendor);
    let record = env.execute_utility(Marketplace::at(marketplace).get_vendor(vendor_id));
    assert_eq(record.status, VENDOR_STATUS_PENDING);

    env.call_private(
        admin,
        Marketplace::at(marketplace).set_vendor_status(vendor, VENDOR_STATUS_ACTIVE, admin, 0),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_vendor(vendor_id));
    assert_eq(record.status, VENDOR_STATUS_ACTIVE);
}

// A second vendor registration from the same account is rejected by the
// "already registered" public check.
#[test(should_fail_with = "vendor is already registered")]
unconstrained fn test_fail_duplicate_registration() {
    let (mut env, marketplace, _admin) = utils::setup_open();
    let vendor = env.create_light_account();
    utils::register_vendor_no_deposit(&mut env, marketplace, vendor);
    // Already a registered user + vendor; a second register_vendor reverts.
    env.call_private(
        vendor,
        Marketplace::at(marketplace).register_vendor(AztecAddress::zero(), 0, vendor, 0, vendor, 0),
    );
}

#[test(should_fail_with = "register a username before becoming a vendor")]
unconstrained fn test_fail_vendor_without_username() {
    let (mut env, marketplace, _admin) = utils::setup_open();
    let vendor = env.create_light_account();
    // No register() call: registering as a vendor must fail.
    env.call_private(
        vendor,
        Marketplace::at(marketplace).register_vendor(AztecAddress::zero(), 0, vendor, 0, vendor, 0),
    );
}

#[test(should_fail_with = "this market's policy takes no deposit")]
unconstrained fn test_fail_deposit_on_no_deposit_market() {
    let (mut env, marketplace, admin) = utils::setup_open();
    let token = utils::deploy_token(&mut env, admin);
    let vendor = env.create_contract_account();
    env.call_private(admin, Token::at(token).mint_to_private(vendor, utils::DEPOSIT_AMOUNT));
    utils::register_vendor_with_deposit(&mut env, marketplace, token, vendor, 1);
}

// ---------------------------------------------------------------------------
// Deposit policy: escrowed registration
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_deposit_registration_escrows_and_activates() {
    let (mut env, marketplace, _admin, token, vendor) = utils::setup_deposit_market();
    utils::register_vendor_with_deposit(&mut env, marketplace, token, vendor, 1);

    let vendor_id = utils::vendor_id_of(vendor);
    let record = env.execute_utility(Marketplace::at(marketplace).get_vendor(vendor_id));
    assert_eq(record.status, VENDOR_STATUS_ACTIVE);
    assert_eq(record.deposit, utils::DEPOSIT_AMOUNT);
    assert_eq(record.deposit_asset, token);

    let escrowed = env.view_public(Token::at(token).balance_of_public(marketplace));
    assert_eq(escrowed, utils::DEPOSIT_AMOUNT);
}

#[test(should_fail_with = "deposit does not match the configured vendor_deposit")]
unconstrained fn test_fail_wrong_deposit_amount() {
    let (mut env, marketplace, _admin, token, vendor) = utils::setup_deposit_market();
    utils::register_user(&mut env, marketplace, vendor);
    let wrong_amount = utils::DEPOSIT_AMOUNT - 1;
    let transfer_call = Token::at(token).transfer_private_to_public(vendor, marketplace, wrong_amount, 1);
    add_private_authwit_from_call(env, vendor, marketplace, transfer_call);
    env.call_private(
        vendor,
        Marketplace::at(marketplace).register_vendor(token, wrong_amount, vendor, 1, vendor, 0),
    );
}

#[test(should_fail_with = "deposit does not match the configured vendor_deposit")]
unconstrained fn test_fail_deposit_policy_without_deposit() {
    let (mut env, marketplace, _admin, _token, vendor) = utils::setup_deposit_market();
    utils::register_vendor_no_deposit(&mut env, marketplace, vendor);
}

// ---------------------------------------------------------------------------
// Vendor status management authorization
// ---------------------------------------------------------------------------

#[test(should_fail_with = "caller lacks the manage-vendors permission")]
unconstrained fn test_fail_stranger_cannot_set_vendor_status() {
    let (mut env, marketplace, _admin) = utils::setup_open();
    let vendor = env.create_light_account();
    utils::register_vendor_no_deposit(&mut env, marketplace, vendor);

    // A stranger account is neither the owner nor a moderator.
    let stranger = env.create_light_account();
    env.call_private(
        stranger,
        Marketplace::at(marketplace).set_vendor_status(vendor, VENDOR_STATUS_SUSPENDED, stranger, 0),
    );
}

#[test]
unconstrained fn test_moderator_manages_vendors_privately() {
    let (mut env, marketplace, admin) = utils::setup();
    let vendor = env.create_light_account();
    utils::register_vendor_no_deposit(&mut env, marketplace, vendor);

    let moderator = env.create_light_account();
    env.call_private(
        admin,
        Marketplace::at(marketplace).assign_moderator(moderator, PERM_MANAGE_VENDORS, admin, 0),
    );

    env.call_private(
        moderator,
        Marketplace::at(marketplace).set_vendor_status(vendor, VENDOR_STATUS_ACTIVE, moderator, 0),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_vendor(utils::vendor_id_of(vendor)));
    assert_eq(record.status, VENDOR_STATUS_ACTIVE);
}

#[test(should_fail_with = "caller lacks the manage-vendors permission")]
unconstrained fn test_fail_unpermissioned_moderator_cannot_manage_vendors() {
    let (mut env, marketplace, _admin) = utils::setup();
    let vendor = env.create_light_account();
    utils::register_vendor_no_deposit(&mut env, marketplace, vendor);

    let impostor = env.create_light_account();
    env.call_private(
        impostor,
        Marketplace::at(marketplace).set_vendor_status(vendor, VENDOR_STATUS_SUSPENDED, impostor, 0),
    );
}

// ---------------------------------------------------------------------------
// Deposit withdrawal: request -> delay -> private payout
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_deposit_withdrawal_after_delay() {
    let (mut env, marketplace, _admin, token, vendor) = utils::setup_deposit_market();
    utils::register_vendor_with_deposit(&mut env, marketplace, token, vendor, 1);
    let balance_after_deposit = env.execute_utility(Token::at(token).balance_of_private(vendor));

    env.call_private(vendor, Marketplace::at(marketplace).request_deposit_withdrawal(vendor, 0));

    env.advance_next_block_timestamp_by(utils::default_config().order_timeout + 1);
    env.call_private(vendor, Marketplace::at(marketplace).execute_deposit_withdrawal(token, vendor, vendor, 0));

    let record = env.execute_utility(Marketplace::at(marketplace).get_vendor(utils::vendor_id_of(vendor)));
    assert_eq(record.deposit, 0);
    assert_eq(record.withdrawal_requested_at, 0);

    let final_balance = env.execute_utility(Token::at(token).balance_of_private(vendor));
    assert_eq(final_balance, balance_after_deposit + utils::DEPOSIT_AMOUNT);
    let escrowed = env.view_public(Token::at(token).balance_of_public(marketplace));
    assert_eq(escrowed, 0);
}

#[test(should_fail_with = "withdrawal delay has not elapsed")]
unconstrained fn test_fail_withdrawal_before_delay() {
    let (mut env, marketplace, _admin, token, vendor) = utils::setup_deposit_market();
    utils::register_vendor_with_deposit(&mut env, marketplace, token, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).request_deposit_withdrawal(vendor, 0));
    env.call_private(vendor, Marketplace::at(marketplace).execute_deposit_withdrawal(token, vendor, vendor, 0));
}

#[test(should_fail_with = "withdrawal was not requested")]
unconstrained fn test_fail_withdrawal_without_request() {
    let (mut env, marketplace, _admin, token, vendor) = utils::setup_deposit_market();
    utils::register_vendor_with_deposit(&mut env, marketplace, token, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).execute_deposit_withdrawal(token, vendor, vendor, 0));
}

// After withdrawing, the vendor no longer meets the deposit bar and loses
// listing rights on deposit-requiring markets.
#[test(should_fail_with = "vendor deposit is below the required amount")]
unconstrained fn test_fail_listing_after_withdrawal() {
    let (mut env, marketplace, _admin, token, vendor) = utils::setup_deposit_market();
    utils::register_vendor_with_deposit(&mut env, marketplace, token, vendor, 1);
    env.call_private(vendor, Marketplace::at(marketplace).request_deposit_withdrawal(vendor, 0));
    env.advance_next_block_timestamp_by(utils::default_config().order_timeout + 1);
    env.call_private(vendor, Marketplace::at(marketplace).execute_deposit_withdrawal(token, vendor, vendor, 0));

    env.call_private(
        vendor,
        Marketplace::at(marketplace).create_listing(1, [0x100, 0], utils::TEST_PRICE_COMMITMENT, 0, vendor, 0),
    );
}

// Top-up restores the deposit bar (e.g. after the admin raises vendor_deposit).
#[test]
unconstrained fn test_top_up_deposit() {
    let (mut env, marketplace, _admin, token, vendor) = utils::setup_deposit_market();
    utils::register_vendor_with_deposit(&mut env, marketplace, token, vendor, 1);

    let top_up: u128 = 500;
    let transfer_call = Token::at(token).transfer_private_to_public(vendor, marketplace, top_up, 2);
    add_private_authwit_from_call(env, vendor, marketplace, transfer_call);
    env.call_private(vendor, Marketplace::at(marketplace).top_up_deposit(token, top_up, vendor, 2, vendor, 0));

    let record = env.execute_utility(Marketplace::at(marketplace).get_vendor(utils::vendor_id_of(vendor)));
    assert_eq(record.deposit, utils::DEPOSIT_AMOUNT + top_up);
    let escrowed = env.view_public(Token::at(token).balance_of_public(marketplace));
    assert_eq(escrowed, utils::DEPOSIT_AMOUNT + top_up);
}
