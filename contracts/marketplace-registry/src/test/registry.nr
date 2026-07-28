use crate::test::utils;
use crate::MarketplaceRegistry;
use crate::registry_record::{STATUS_ACTIVE, STATUS_SUSPENDED};
use ::aztec::protocol::{
    address::AztecAddress, storage::map::derive_storage_slot_in_map, traits::FromField,
};

// Lookup keys are poseidon2(access_secret, DOMAIN_MARKET_LOOKUP) in
// production; the registry treats them as opaque fields, so tests use
// arbitrary values.
global LOOKUP_KEY_1: Field = 0x1001;
global LOOKUP_KEY_2: Field = 0x1002;

// RegistryRecord packed field offsets within the records map slot.
global OFFSET_OWNER: Field = 0;
global OFFSET_CONTRACT_ADDRESS: Field = 1;
global OFFSET_STATUS: Field = 2;

unconstrained fn record_slot(lookup_key: Field) -> Field {
    derive_storage_slot_in_map(
        MarketplaceRegistry::storage_layout().records.slot,
        lookup_key,
    )
}

// ---------------------------------------------------------------------------
// Registration & resolution
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_register_and_resolve() {
    let (mut env, registry, _) = utils::setup();
    let creator = env.create_light_account();
    let marketplace_address = AztecAddress::from_field(0x2222);

    env.call_public(
        creator,
        MarketplaceRegistry::at(registry).register(LOOKUP_KEY_1, marketplace_address),
    );

    env.public_context_at(registry, |context| {
        let slot = record_slot(LOOKUP_KEY_1);
        let owner: AztecAddress = context.storage_read(slot + OFFSET_OWNER);
        let stored_address: AztecAddress = context.storage_read(slot + OFFSET_CONTRACT_ADDRESS);
        let status: u8 = context.storage_read(slot + OFFSET_STATUS);
        assert_eq(owner, creator);
        assert_eq(stored_address, marketplace_address);
        assert_eq(status, STATUS_ACTIVE);
    });
}

#[test]
unconstrained fn test_register_two_distinct_keys() {
    let (mut env, registry, _) = utils::setup();
    let creator = env.create_light_account();

    env.call_public(
        creator,
        MarketplaceRegistry::at(registry).register(LOOKUP_KEY_1, AztecAddress::from_field(0x2222)),
    );
    env.call_public(
        creator,
        MarketplaceRegistry::at(registry).register(LOOKUP_KEY_2, AztecAddress::from_field(0x3333)),
    );

    env.public_context_at(registry, |context| {
        let addr_1: AztecAddress = context.storage_read(record_slot(LOOKUP_KEY_1) + OFFSET_CONTRACT_ADDRESS);
        let addr_2: AztecAddress = context.storage_read(record_slot(LOOKUP_KEY_2) + OFFSET_CONTRACT_ADDRESS);
        assert_eq(addr_1, AztecAddress::from_field(0x2222));
        assert_eq(addr_2, AztecAddress::from_field(0x3333));
    });
}

// Duplicate key must be rejected -- even from the original owner.
#[test(should_fail)]
unconstrained fn test_fail_duplicate_registration() {
    let (mut env, registry, _) = utils::setup();
    let creator = env.create_light_account();

    env.call_public(
        creator,
        MarketplaceRegistry::at(registry).register(LOOKUP_KEY_1, AztecAddress::from_field(0x2222)),
    );
    env.call_public(
        creator,
        MarketplaceRegistry::at(registry).register(LOOKUP_KEY_1, AztecAddress::from_field(0x4444)),
    );
}

#[test(should_fail)]
unconstrained fn test_fail_register_zero_contract_address() {
    let (mut env, registry, _) = utils::setup();
    let creator = env.create_light_account();

    env.call_public(
        creator,
        MarketplaceRegistry::at(registry).register(LOOKUP_KEY_1, AztecAddress::zero()),
    );
}

// ---------------------------------------------------------------------------
// Owner-gated updates
// ---------------------------------------------------------------------------

#[test]
unconstrained fn test_owner_updates_status() {
    let (mut env, registry, _) = utils::setup();
    let creator = env.create_light_account();

    env.call_public(
        creator,
        MarketplaceRegistry::at(registry).register(LOOKUP_KEY_1, AztecAddress::from_field(0x2222)),
    );
    env.call_public(
        creator,
        MarketplaceRegistry::at(registry).set_status(LOOKUP_KEY_1, STATUS_SUSPENDED),
    );

    env.public_context_at(registry, |context| {
        let status: u8 = context.storage_read(record_slot(LOOKUP_KEY_1) + OFFSET_STATUS);
        assert_eq(status, STATUS_SUSPENDED);
    });
}

// Expected failure reason: "caller is not the entry owner"
#[test(should_fail)]
unconstrained fn test_fail_set_status_by_non_owner() {
    let (mut env, registry, _) = utils::setup();
    let creator = env.create_light_account();
    let stranger = env.create_light_account();

    env.call_public(
        creator,
        MarketplaceRegistry::at(registry).register(LOOKUP_KEY_1, AztecAddress::from_field(0x2222)),
    );
    env.call_public(
        stranger,
        MarketplaceRegistry::at(registry).set_status(LOOKUP_KEY_1, STATUS_SUSPENDED),
    );
}

// Expected failure reason: "lookup_key not registered"
#[test(should_fail)]
unconstrained fn test_fail_update_unregistered_entry() {
    let (mut env, registry, _) = utils::setup();
    let creator = env.create_light_account();

    env.call_public(
        creator,
        MarketplaceRegistry::at(registry).set_status(LOOKUP_KEY_1, STATUS_SUSPENDED),
    );
}

// Expected failure reason: "invalid status"
#[test(should_fail)]
unconstrained fn test_fail_set_invalid_status_value() {
    let (mut env, registry, _) = utils::setup();
    let creator = env.create_light_account();

    env.call_public(
        creator,
        MarketplaceRegistry::at(registry).register(LOOKUP_KEY_1, AztecAddress::from_field(0x2222)),
    );
    env.call_public(creator, MarketplaceRegistry::at(registry).set_status(LOOKUP_KEY_1, 9));
}
