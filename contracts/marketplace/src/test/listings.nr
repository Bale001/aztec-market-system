use ::aztec::{
    protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment,
};

use crate::listing_record::{
    LISTING_STATUS_ACTIVE, LISTING_STATUS_PAUSED, LISTING_STATUS_PENDING, LISTING_STATUS_REMOVED,
};
use crate::test::utils;
use crate::Marketplace;
use market_protocol::{PERM_MODERATE_LISTINGS, VENDOR_STATUS_ACTIVE, VENDOR_STATUS_SUSPENDED};

// Account model: a listing's creator is the vendor's account address; a
// vendor's identity is that address (utils::vendor_id_of).

// Stand-in for an encrypted Arweave pointer (2 fields; [0] must be non-zero).
unconstrained fn pointer_of(marker: Field) -> [Field; 2] {
    [marker, marker + 1]
}

// Stand-in category tag (opaque field; the contract only stores it).
global TEST_CATEGORY_TAG: Field = 0x0ca7;

// Open market with one ACTIVE vendor; returns (env, marketplace, admin, vendor).
unconstrained fn setup_with_vendor() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let (mut env, marketplace, admin) = utils::setup_open();
    let vendor = env.create_light_account();
    utils::register_vendor_no_deposit(&mut env, marketplace, vendor);
    (env, marketplace, admin, vendor)
}

// An APPROVAL-policy market (listings need moderator approval) with one
// already-active vendor.
unconstrained fn setup_approval_market() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let marketplace = utils::deploy(&mut env, admin, utils::TEST_NONCE, utils::approval_listing_config());
    let vendor = env.create_light_account();
    utils::register_vendor_no_deposit(&mut env, marketplace, vendor);
    (env, marketplace, admin, vendor)
}

unconstrained fn create_default_listing(
    env: &mut TestEnvironment,
    marketplace: AztecAddress,
    vendor: AztecAddress,
    expected_id: u64,
    marker: Field,
) {
    env.call_private(
        vendor,
        Marketplace::at(marketplace).create_listing(
            expected_id,
            pointer_of(marker),
            utils::TEST_PRICE_COMMITMENT,
            TEST_CATEGORY_TAG, vendor, 0,
        ),
    );
}

// ---------------------------------------------------------------------------
// Creation by authorized vendors (private entry)
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_vendor_creates_listing() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();

    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);

    let count = env.execute_utility(Marketplace::at(marketplace).get_listing_count());
    assert_eq(count, 1);

    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.creator, utils::vendor_id_of(vendor));
    assert_eq(record.status, LISTING_STATUS_ACTIVE);
    assert_eq(record.price_commitment, utils::TEST_PRICE_COMMITMENT);
    assert_eq(record.pointer_0, 0x100);
    assert_eq(record.pointer_1, 0x101);
    assert_eq(record.category_tag, TEST_CATEGORY_TAG);
}

#[test]
unconstrained fn test_listing_ids_are_sequential() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();

    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    create_default_listing(&mut env, marketplace, vendor, 2, 0x200);

    let count = env.execute_utility(Marketplace::at(marketplace).get_listing_count());
    assert_eq(count, 2);
    let second = env.execute_utility(Marketplace::at(marketplace).get_listing(2));
    assert_eq(second.pointer_0, 0x200);
}

#[test(should_fail_with = "listing id changed concurrently")]
unconstrained fn test_fail_create_listing_stale_expected_id() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    create_default_listing(&mut env, marketplace, vendor, 1, 0x200);
}

#[test(should_fail_with = "vendor is not active")]
unconstrained fn test_fail_non_vendor_cannot_create() {
    let (mut env, marketplace, _admin) = utils::setup_open();
    let stranger = env.create_light_account();
    create_default_listing(&mut env, marketplace, stranger, 1, 0x100);
}

// On approval-policy markets a registration alone (PENDING) grants nothing.
#[test(should_fail_with = "vendor is not active")]
unconstrained fn test_fail_pending_vendor_cannot_create() {
    let (mut env, marketplace, _admin) = utils::setup();
    let vendor = env.create_light_account();
    utils::register_vendor_no_deposit(&mut env, marketplace, vendor);
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
}

#[test(should_fail_with = "price_commitment must not be zero")]
unconstrained fn test_fail_zero_price_commitment() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();
    env.call_private(
        vendor,
        Marketplace::at(marketplace).create_listing(1, pointer_of(0x100), 0, TEST_CATEGORY_TAG, vendor, 0),
    );
}

#[test(should_fail_with = "payload pointer must not be empty")]
unconstrained fn test_fail_empty_pointer() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();
    env.call_private(
        vendor,
        Marketplace::at(marketplace).create_listing(
            1,
            [0, 0],
            utils::TEST_PRICE_COMMITMENT,
            TEST_CATEGORY_TAG, vendor, 0,
        ),
    );
}

// ---------------------------------------------------------------------------
// Updates by the creator vendor only
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_creator_updates_payload() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);

    let new_commitment = utils::TEST_PRICE_COMMITMENT + 1;
    env.call_private(
        vendor,
        Marketplace::at(marketplace).update_listing_payload(
            1,
            [0xbeef, 0],
            new_commitment,
            TEST_CATEGORY_TAG, vendor, 0,
        ),
    );

    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.price_commitment, new_commitment);
    assert_eq(record.pointer_0, 0xbeef);
    assert_eq(record.pointer_1, 0);
    assert_eq(record.category_tag, TEST_CATEGORY_TAG);
}

#[test(should_fail_with = "a listing's category cannot change")]
unconstrained fn test_fail_update_changes_category() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    env.call_private(
        vendor,
        Marketplace::at(marketplace).update_listing_payload(
            1,
            [0xbeef, 0],
            utils::TEST_PRICE_COMMITMENT,
            TEST_CATEGORY_TAG + 1, vendor, 0,
        ),
    );
}

#[test]
unconstrained fn test_category_index_buckets_by_tag() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();

    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    create_default_listing(&mut env, marketplace, vendor, 2, 0x200);
    env.call_private(
        vendor,
        Marketplace::at(marketplace).create_listing(
            3,
            pointer_of(0x300),
            utils::TEST_PRICE_COMMITMENT,
            TEST_CATEGORY_TAG + 99, vendor, 0,
        ),
    );

    let a = env.execute_utility(Marketplace::at(marketplace).get_category_count(TEST_CATEGORY_TAG));
    assert_eq(a, 2);
    let b = env.execute_utility(Marketplace::at(marketplace).get_category_count(TEST_CATEGORY_TAG + 99));
    assert_eq(b, 1);

    let (records, ids, cursor, n) =
        env.execute_utility(Marketplace::at(marketplace).get_category_listings(TEST_CATEGORY_TAG, 0));
    assert_eq(n, 2);
    assert_eq(ids[0], 1);
    assert_eq(ids[1], 2);
    assert_eq(records[0].pointer_0, 0x100);
    assert_eq(records[1].pointer_0, 0x200);
    // The chain ended inside this page, so there is nothing to resume from.
    assert_eq(cursor, 0);
}

#[test]
unconstrained fn test_vendor_index_buckets_by_creator() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();
    let second = env.create_light_account();
    utils::register_vendor_no_deposit(&mut env, marketplace, second);

    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    create_default_listing(&mut env, marketplace, vendor, 2, 0x200);
    create_default_listing(&mut env, marketplace, second, 3, 0x300);

    let first_id = utils::vendor_id_of(vendor);
    let second_id = utils::vendor_id_of(second);

    assert_eq(env.execute_utility(Marketplace::at(marketplace).get_vendor_listing_count(first_id)), 2);
    assert_eq(env.execute_utility(Marketplace::at(marketplace).get_vendor_listing_count(second_id)), 1);
    assert_eq(env.execute_utility(Marketplace::at(marketplace).get_vendor_listing_count(0xdead)), 0);

    let (records, ids, n) =
        env.execute_utility(Marketplace::at(marketplace).get_vendor_listings(first_id, 0));
    assert_eq(n, 2);
    assert_eq(ids[0], 1);
    assert_eq(ids[1], 2);
    assert_eq(records[0].pointer_0, 0x100);
    assert_eq(records[1].pointer_0, 0x200);
    assert_eq(records[0].creator, first_id);

    let (_, second_ids, second_n) =
        env.execute_utility(Marketplace::at(marketplace).get_vendor_listings(second_id, 0));
    assert_eq(second_n, 1);
    assert_eq(second_ids[0], 3);
}

#[test(should_fail_with = "listing belongs to a different vendor")]
unconstrained fn test_fail_other_vendor_cannot_update() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);

    let intruder = env.create_light_account();
    utils::register_vendor_no_deposit(&mut env, marketplace, intruder);
    env.call_private(
        intruder,
        Marketplace::at(marketplace).update_listing_payload(
            1,
            pointer_of(0x300),
            utils::TEST_PRICE_COMMITMENT,
            TEST_CATEGORY_TAG, intruder, 0,
        ),
    );
}

// ---------------------------------------------------------------------------
// Status transitions: vendor self-service vs moderation
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_vendor_pauses_and_reactivates() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);

    env.call_private(
        vendor,
        Marketplace::at(marketplace).set_listing_status_as_vendor(1, LISTING_STATUS_PAUSED, vendor, 0),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.status, LISTING_STATUS_PAUSED);

    env.call_private(
        vendor,
        Marketplace::at(marketplace).set_listing_status_as_vendor(1, LISTING_STATUS_ACTIVE, vendor, 0),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.status, LISTING_STATUS_ACTIVE);
}

#[test(should_fail_with = "listing is not editable")]
unconstrained fn test_fail_vendor_cannot_revive_removed_listing() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);

    env.call_private(
        vendor,
        Marketplace::at(marketplace).set_listing_status_as_vendor(1, LISTING_STATUS_REMOVED, vendor, 0),
    );
    env.call_private(
        vendor,
        Marketplace::at(marketplace).set_listing_status_as_vendor(1, LISTING_STATUS_ACTIVE, vendor, 0),
    );
}

#[test]
unconstrained fn test_superadmin_moderates_listing() {
    let (mut env, marketplace, admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);

    env.call_private(
        admin,
        Marketplace::at(marketplace).set_listing_status(1, LISTING_STATUS_REMOVED, admin, 0),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.status, LISTING_STATUS_REMOVED);

    env.call_private(
        admin,
        Marketplace::at(marketplace).set_listing_status(1, LISTING_STATUS_ACTIVE, admin, 0),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.status, LISTING_STATUS_ACTIVE);
}

#[test]
unconstrained fn test_moderator_moderates_listing_privately() {
    let (mut env, marketplace, admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);

    let moderator = env.create_light_account();
    env.call_private(
        admin,
        Marketplace::at(marketplace).assign_moderator(moderator, PERM_MODERATE_LISTINGS, admin, 0),
    );

    env.call_private(
        moderator,
        Marketplace::at(marketplace).set_listing_status(1, LISTING_STATUS_REMOVED, moderator, 0),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.status, LISTING_STATUS_REMOVED);
}

#[test(should_fail_with = "caller lacks the moderate-listings permission")]
unconstrained fn test_fail_non_moderator_cannot_moderate() {
    let (mut env, marketplace, _admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);

    let stranger = env.create_light_account();
    env.call_private(
        stranger,
        Marketplace::at(marketplace).set_listing_status(1, LISTING_STATUS_REMOVED, stranger, 0),
    );
}

#[test(should_fail_with = "vendor is not active")]
unconstrained fn test_fail_suspended_vendor_cannot_create() {
    let (mut env, marketplace, admin, vendor) = setup_with_vendor();
    env.call_private(
        admin,
        Marketplace::at(marketplace).set_vendor_status(vendor, VENDOR_STATUS_SUSPENDED, admin, 0),
    );
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
}

// Sanity: the vendor registered by setup_with_vendor really is ACTIVE.
#[test]
unconstrained fn test_open_registration_activates_vendor() {
    let (env, marketplace, _admin, vendor) = setup_with_vendor();
    let record = env.execute_utility(Marketplace::at(marketplace).get_vendor(utils::vendor_id_of(vendor)));
    assert_eq(record.status, VENDOR_STATUS_ACTIVE);
}

// ---------------------------------------------------------------------------
// Listing approval (APPROVAL-policy markets)
// ---------------------------------------------------------------------------

// A new listing on an approval market is PENDING, not ACTIVE.
#[test]
unconstrained fn test_approval_market_lists_pending() {
    let (mut env, marketplace, _admin, vendor) = setup_approval_market();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.status, LISTING_STATUS_PENDING);
}

// A moderator approves a pending listing (-> ACTIVE).
#[test]
unconstrained fn test_moderator_approves_pending_listing() {
    let (mut env, marketplace, admin, vendor) = setup_approval_market();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    env.call_private(
        admin,
        Marketplace::at(marketplace).set_listing_status(1, LISTING_STATUS_ACTIVE, admin, 0),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.status, LISTING_STATUS_ACTIVE);
}

// A moderator rejects a pending listing (-> REMOVED).
#[test]
unconstrained fn test_moderator_rejects_pending_listing() {
    let (mut env, marketplace, admin, vendor) = setup_approval_market();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    env.call_private(
        admin,
        Marketplace::at(marketplace).set_listing_status(1, LISTING_STATUS_REMOVED, admin, 0),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.status, LISTING_STATUS_REMOVED);
}

// Editing an APPROVED listing sends it back to PENDING (re-moderation).
#[test]
unconstrained fn test_edit_resets_approved_listing_to_pending() {
    let (mut env, marketplace, admin, vendor) = setup_approval_market();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    env.call_private(
        admin,
        Marketplace::at(marketplace).set_listing_status(1, LISTING_STATUS_ACTIVE, admin, 0),
    );
    // A content/price edit re-triggers moderation.
    env.call_private(
        vendor,
        Marketplace::at(marketplace).update_listing_payload(
            1,
            pointer_of(0x900),
            utils::TEST_PRICE_COMMITMENT,
            TEST_CATEGORY_TAG, vendor, 0,
        ),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.status, LISTING_STATUS_PENDING);
    assert_eq(record.pointer_0, 0x900);
}

// A vendor may WITHDRAW their own pending listing (-> REMOVED)...
#[test]
unconstrained fn test_vendor_withdraws_pending_listing() {
    let (mut env, marketplace, _admin, vendor) = setup_approval_market();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    env.call_private(
        vendor,
        Marketplace::at(marketplace).set_listing_status_as_vendor(1, LISTING_STATUS_REMOVED, vendor, 0),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.status, LISTING_STATUS_REMOVED);
}

// ...but a vendor can NEVER self-approve a pending listing.
#[test(should_fail_with = "listing is not editable")]
unconstrained fn test_fail_vendor_cannot_self_approve() {
    let (mut env, marketplace, _admin, vendor) = setup_approval_market();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    env.call_private(
        vendor,
        Marketplace::at(marketplace).set_listing_status_as_vendor(1, LISTING_STATUS_ACTIVE, vendor, 0),
    );
}

// Editing a still-pending listing keeps it pending (and applies the edit).
#[test]
unconstrained fn test_vendor_edits_own_pending_listing() {
    let (mut env, marketplace, _admin, vendor) = setup_approval_market();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    env.call_private(
        vendor,
        Marketplace::at(marketplace).update_listing_payload(
            1,
            pointer_of(0x555),
            utils::TEST_PRICE_COMMITMENT,
            TEST_CATEGORY_TAG, vendor, 0,
        ),
    );
    let record = env.execute_utility(Marketplace::at(marketplace).get_listing(1));
    assert_eq(record.status, LISTING_STATUS_PENDING);
    assert_eq(record.pointer_0, 0x555);
}

// ---------------------------------------------------------------------------
// Display order (per-category linked list). Order is deliberately independent
// of listing id, so these assert on the CHAIN, never on id arithmetic.
// ---------------------------------------------------------------------------

// The ids of one category's listings in display order (first page only).
unconstrained fn category_order(
    env: &mut TestEnvironment,
    marketplace: AztecAddress,
) -> ([Field; 20], u32) {
    let (_, ids, _, n) = env.execute_utility(
        Marketplace::at(marketplace).get_category_listings(TEST_CATEGORY_TAG, 0),
    );
    (ids, n)
}

// Three listings in one category: created 1, 2, 3, displayed in that order.
unconstrained fn setup_three_listings() -> (TestEnvironment, AztecAddress, AztecAddress) {
    let (mut env, marketplace, admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    create_default_listing(&mut env, marketplace, vendor, 2, 0x200);
    create_default_listing(&mut env, marketplace, vendor, 3, 0x300);
    (env, marketplace, admin)
}

#[test]
unconstrained fn test_new_listings_append_in_creation_order() {
    let (mut env, marketplace, _admin) = setup_three_listings();
    let (ids, n) = category_order(&mut env, marketplace);
    assert_eq(n, 3);
    assert_eq(ids[0], 1);
    assert_eq(ids[1], 2);
    assert_eq(ids[2], 3);
}

#[test]
unconstrained fn test_owner_promotes_listing_to_the_top() {
    let (mut env, marketplace, admin) = setup_three_listings();
    // Move the last listing to the head: its predecessor is 2, and its new
    // predecessor is "none".
    env.call_private(admin, Marketplace::at(marketplace).move_listing(3, 2, 0, admin, 0));
    let (ids, n) = category_order(&mut env, marketplace);
    assert_eq(n, 3);
    assert_eq(ids[0], 3);
    assert_eq(ids[1], 1);
    assert_eq(ids[2], 2);
}

#[test]
unconstrained fn test_owner_moves_listing_into_the_middle() {
    let (mut env, marketplace, admin) = setup_three_listings();
    // Move the head listing to sit after 2.
    env.call_private(admin, Marketplace::at(marketplace).move_listing(1, 0, 2, admin, 0));
    let (ids, n) = category_order(&mut env, marketplace);
    assert_eq(n, 3);
    assert_eq(ids[0], 2);
    assert_eq(ids[1], 1);
    assert_eq(ids[2], 3);
}

#[test]
unconstrained fn test_moving_the_tail_keeps_appends_at_the_end() {
    let (mut env, marketplace, admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    create_default_listing(&mut env, marketplace, vendor, 2, 0x200);
    create_default_listing(&mut env, marketplace, vendor, 3, 0x300);
    // 3 was the tail; promoting it must hand the tail back to 2, or the next
    // listing would be appended to a record that is no longer last.
    env.call_private(admin, Marketplace::at(marketplace).move_listing(3, 2, 0, admin, 0));
    create_default_listing(&mut env, marketplace, vendor, 4, 0x400);
    let (ids, n) = category_order(&mut env, marketplace);
    assert_eq(n, 4);
    assert_eq(ids[0], 3);
    assert_eq(ids[1], 1);
    assert_eq(ids[2], 2);
    assert_eq(ids[3], 4);
}

#[test]
unconstrained fn test_moving_a_listing_where_it_already_is_changes_nothing() {
    let (mut env, marketplace, admin) = setup_three_listings();
    env.call_private(admin, Marketplace::at(marketplace).move_listing(2, 1, 1, admin, 0));
    let (ids, n) = category_order(&mut env, marketplace);
    assert_eq(n, 3);
    assert_eq(ids[0], 1);
    assert_eq(ids[1], 2);
    assert_eq(ids[2], 3);
}

#[test(should_fail_with = "current_prev does not precede the listing")]
unconstrained fn test_fail_move_with_a_lying_predecessor() {
    let (mut env, marketplace, admin) = setup_three_listings();
    // 1 does not precede 3 (2 does). The claim is rejected rather than
    // silently corrupting the chain.
    env.call_private(admin, Marketplace::at(marketplace).move_listing(3, 1, 0, admin, 0));
}

#[test(should_fail_with = "listing is not at the head of its category")]
unconstrained fn test_fail_move_falsely_claiming_head_position() {
    let (mut env, marketplace, admin) = setup_three_listings();
    env.call_private(admin, Marketplace::at(marketplace).move_listing(2, 0, 3, admin, 0));
}

#[test(should_fail_with = "cannot move a listing after itself")]
unconstrained fn test_fail_move_listing_after_itself() {
    let (mut env, marketplace, admin) = setup_three_listings();
    env.call_private(admin, Marketplace::at(marketplace).move_listing(2, 1, 2, admin, 0));
}

#[test(should_fail_with = "caller lacks the moderate-listings permission")]
unconstrained fn test_fail_stranger_cannot_reorder_listings() {
    let (mut env, marketplace, _admin) = setup_three_listings();
    let stranger = env.create_light_account();
    env.call_private(
        stranger,
        Marketplace::at(marketplace).move_listing(3, 2, 0, stranger, 0),
    );
}

#[test]
unconstrained fn test_moderator_with_permission_can_reorder() {
    let (mut env, marketplace, admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    create_default_listing(&mut env, marketplace, vendor, 2, 0x200);
    let moderator = env.create_light_account();
    env.call_private(
        admin,
        Marketplace::at(marketplace).assign_moderator(moderator, PERM_MODERATE_LISTINGS, admin, 0),
    );
    env.call_private(
        moderator,
        Marketplace::at(marketplace).move_listing(2, 1, 0, moderator, 0),
    );
    let (ids, n) = category_order(&mut env, marketplace);
    assert_eq(n, 2);
    assert_eq(ids[0], 2);
    assert_eq(ids[1], 1);
}

#[test(should_fail_with = "cannot move a listing into a different category")]
unconstrained fn test_fail_move_across_categories() {
    let (mut env, marketplace, admin, vendor) = setup_with_vendor();
    create_default_listing(&mut env, marketplace, vendor, 1, 0x100);
    create_default_listing(&mut env, marketplace, vendor, 2, 0x200);
    env.call_private(
        vendor,
        Marketplace::at(marketplace).create_listing(
            3,
            pointer_of(0x300),
            utils::TEST_PRICE_COMMITMENT,
            TEST_CATEGORY_TAG + 99, vendor, 0,
        ),
    );
    // 3 lives in another category, so it can never be a valid neighbour here.
    env.call_private(admin, Marketplace::at(marketplace).move_listing(2, 1, 3, admin, 0));
}
