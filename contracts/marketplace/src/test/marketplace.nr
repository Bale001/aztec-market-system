use crate::test::utils;
use crate::Marketplace;
use ::aztec::protocol::{
    address::AztecAddress, hash::poseidon2_hash, storage::map::derive_storage_slot_in_map,
    traits::{FromField, Serialize, ToField},
};
use market_protocol::{derive_marketplace_id, PERM_MANAGE_VENDORS, PERM_MODERATE_LISTINGS};

// Account model: the superadmin and moderators are account ADDRESSES.

// ---------------------------------------------------------------------------
// Construction & marketplace_id derivation
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_constructor_initializes_state() {
    let (mut env, marketplace, admin) = utils::setup();

    let config = utils::default_config();
    let expected_id = derive_marketplace_id(
        admin,
        utils::TEST_NONCE,
        poseidon2_hash(config.serialize()),
    );

    let marketplace_id = env.execute_utility(Marketplace::at(marketplace).get_marketplace_id());
    assert_eq(marketplace_id, expected_id);

    env.public_context_at(marketplace, |context| {
        let superadmin_identity: Field =
            context.storage_read(Marketplace::storage_layout().superadmin_identity.slot);
        let metadata_len: u32 =
            context.storage_read(Marketplace::storage_layout().metadata_len.slot);
        let chunk_0: Field = context.storage_read(derive_storage_slot_in_map(
            Marketplace::storage_layout().metadata_data.slot,
            0,
        ));
        let chunk_1: Field = context.storage_read(derive_storage_slot_in_map(
            Marketplace::storage_layout().metadata_data.slot,
            1,
        ));
        let fee_bps: u32 = context.storage_read(Marketplace::storage_layout().config.slot + 1);

        // The superadmin is the owner's (here: the deployer admin's) address.
        assert_eq(superadmin_identity, admin.to_field());
        assert_eq(metadata_len, utils::TEST_METADATA_LEN);
        assert_eq(chunk_0, utils::TEST_METADATA_CHUNK_0);
        assert_eq(chunk_1, utils::TEST_METADATA_CHUNK_1);
        assert_eq(fee_bps, 250);
    });
}

#[test]
unconstrained fn test_marketplace_id_unique_per_nonce() {
    let (mut env, marketplace_a, admin) = utils::setup();
    let marketplace_b = utils::deploy(&mut env, admin, utils::TEST_NONCE + 1, utils::default_config());

    let config_commitment = poseidon2_hash(utils::default_config().serialize());
    let expected_a = derive_marketplace_id(admin, utils::TEST_NONCE, config_commitment);
    let expected_b = derive_marketplace_id(admin, utils::TEST_NONCE + 1, config_commitment);
    assert(expected_a != expected_b);

    let id_a = env.execute_utility(Marketplace::at(marketplace_a).get_marketplace_id());
    assert_eq(id_a, expected_a);
    let id_b = env.execute_utility(Marketplace::at(marketplace_b).get_marketplace_id());
    assert_eq(id_b, expected_b);
}

#[test(should_fail)]
unconstrained fn test_fail_constructor_excessive_fee() {
    let (mut env, _, admin) = utils::setup();
    let mut config = utils::default_config();
    config.fee_bps = 10001;
    let _ = utils::deploy(&mut env, admin, utils::TEST_NONCE + 1, config);
}

#[test(should_fail)]
unconstrained fn test_fail_constructor_deposit_policy_without_deposit() {
    let (mut env, _, admin) = utils::setup();
    let mut config = utils::default_config();
    config.vendor_policy = market_protocol::VENDOR_POLICY_DEPOSIT;
    config.vendor_deposit = 0;
    let _ = utils::deploy(&mut env, admin, utils::TEST_NONCE + 1, config);
}

// ---------------------------------------------------------------------------
// Config mutation authorization
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_superadmin_updates_config() {
    let (mut env, marketplace, admin) = utils::setup();

    let mut new_config = utils::default_config();
    new_config.fee_bps = 500;
    env.call_private(admin, Marketplace::at(marketplace).update_config(new_config, admin, 0));

    env.public_context_at(marketplace, |context| {
        let fee_bps: u32 = context.storage_read(Marketplace::storage_layout().config.slot + 1);
        assert_eq(fee_bps, 500);
    });
}

#[test(should_fail)]
unconstrained fn test_fail_non_admin_updates_config() {
    let (mut env, marketplace, _) = utils::setup();
    let stranger = env.create_light_account();

    let mut new_config = utils::default_config();
    new_config.fee_bps = 0;
    env.call_private(stranger, Marketplace::at(marketplace).update_config(new_config, stranger, 0));
}

#[test(should_fail)]
unconstrained fn test_fail_update_config_cannot_change_payment_asset() {
    let (mut env, marketplace, admin) = utils::setup();

    let mut new_config = utils::default_config();
    new_config.payment_asset = AztecAddress::from_field(0xbad);
    env.call_private(admin, Marketplace::at(marketplace).update_config(new_config, admin, 0));
}

#[test(should_fail)]
unconstrained fn test_fail_update_config_invalid() {
    let (mut env, marketplace, admin) = utils::setup();

    let mut new_config = utils::default_config();
    new_config.fee_bps = 20000;
    env.call_private(admin, Marketplace::at(marketplace).update_config(new_config, admin, 0));
}

#[test]
unconstrained fn test_superadmin_updates_metadata() {
    let (mut env, marketplace, admin) = utils::setup();

    let mut new_blob = [0; 128];
    new_blob[0] = 0xfeed;
    env.call_private(admin, Marketplace::at(marketplace).set_metadata(new_blob, 31, admin, 0));

    env.public_context_at(marketplace, |context| {
        let metadata_len: u32 =
            context.storage_read(Marketplace::storage_layout().metadata_len.slot);
        let chunk_0: Field = context.storage_read(derive_storage_slot_in_map(
            Marketplace::storage_layout().metadata_data.slot,
            0,
        ));
        let chunk_1: Field = context.storage_read(derive_storage_slot_in_map(
            Marketplace::storage_layout().metadata_data.slot,
            1,
        ));
        assert_eq(metadata_len, 31);
        assert_eq(chunk_0, 0xfeed);
        assert_eq(chunk_1, 0);
    });
}

#[test(should_fail)]
unconstrained fn test_fail_non_admin_updates_metadata() {
    let (mut env, marketplace, _) = utils::setup();
    let stranger = env.create_light_account();
    env.call_private(stranger, Marketplace::at(marketplace).set_metadata(utils::test_metadata_blob(), 31, stranger, 0));
}

#[test(should_fail)]
unconstrained fn test_fail_oversized_metadata() {
    let (mut env, marketplace, admin) = utils::setup();
    env.call_private(admin, Marketplace::at(marketplace).set_metadata(utils::test_metadata_blob(), 3969, admin, 0));
}

// ---------------------------------------------------------------------------
// Superadmin transfer
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_transfer_superadmin() {
    let (mut env, marketplace, admin) = utils::setup();

    // Ownership transfers to another account address.
    let new_owner = env.create_light_account();
    env.call_private(admin, Marketplace::at(marketplace).transfer_superadmin(new_owner, admin, 0));

    // The new owner now holds the role and can mutate config.
    let mut new_config = utils::default_config();
    new_config.fee_bps = 100;
    env.call_private(new_owner, Marketplace::at(marketplace).update_config(new_config, new_owner, 0));

    env.public_context_at(marketplace, |context| {
        let superadmin_identity: Field =
            context.storage_read(Marketplace::storage_layout().superadmin_identity.slot);
        assert_eq(superadmin_identity, new_owner.to_field());
    });
}

#[test(should_fail)]
unconstrained fn test_fail_old_admin_after_transfer() {
    let (mut env, marketplace, admin) = utils::setup();

    let new_owner = env.create_light_account();
    env.call_private(admin, Marketplace::at(marketplace).transfer_superadmin(new_owner, admin, 0));
    // The former owner (admin) no longer holds the role.
    env.call_private(
        admin,
        Marketplace::at(marketplace).set_metadata(utils::test_metadata_blob(), 31, admin, 0),
    );
}

// ---------------------------------------------------------------------------
// Moderator management
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_assign_and_remove_moderator() {
    let (mut env, marketplace, admin) = utils::setup();
    let moderator = env.create_light_account();
    let permissions = PERM_MODERATE_LISTINGS | PERM_MANAGE_VENDORS;

    env.call_private(
        admin,
        Marketplace::at(marketplace).assign_moderator(moderator, permissions, admin, 0),
    );
    env.public_context_at(marketplace, |context| {
        let slot = derive_storage_slot_in_map(
            Marketplace::storage_layout().moderators.slot,
            moderator.to_field(),
        );
        let stored: u64 = context.storage_read(slot);
        assert_eq(stored, permissions);
    });

    env.call_private(admin, Marketplace::at(marketplace).remove_moderator(moderator, admin, 0));
    env.public_context_at(marketplace, |context| {
        let slot = derive_storage_slot_in_map(
            Marketplace::storage_layout().moderators.slot,
            moderator.to_field(),
        );
        let stored: u64 = context.storage_read(slot);
        assert_eq(stored, 0);
    });
}

#[test(should_fail)]
unconstrained fn test_fail_non_admin_assigns_moderator() {
    let (mut env, marketplace, _) = utils::setup();
    let stranger = env.create_light_account();
    let moderator = env.create_light_account();
    env.call_private(
        stranger,
        Marketplace::at(marketplace).assign_moderator(moderator, PERM_MODERATE_LISTINGS, stranger, 0),
    );
}

#[test(should_fail)]
unconstrained fn test_fail_assign_unknown_permission_bits() {
    let (mut env, marketplace, admin) = utils::setup();
    let moderator = env.create_light_account();
    env.call_private(
        admin,
        Marketplace::at(marketplace).assign_moderator(moderator, 1024, admin, 0),
    );
}

#[test(should_fail)]
unconstrained fn test_fail_remove_nonexistent_moderator() {
    let (mut env, marketplace, admin) = utils::setup();
    let moderator = env.create_light_account();
    env.call_private(admin, Marketplace::at(marketplace).remove_moderator(moderator, admin, 0));
}
