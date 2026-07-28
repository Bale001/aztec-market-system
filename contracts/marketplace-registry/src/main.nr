// MarketplaceRegistry -- the single global lookup table for hidden markets.
//
// Maps lookup_key -> RegistryRecord { owner, contract_address, status }.
// Public state only, but deliberately opaque: lookup_key =
// poseidon2(access_secret, DOMAIN_MARKET_LOOKUP), and the market's content
// (sealed metadata + listings) lives encrypted inside the Marketplace
// contract itself (AD-3) -- scanning the registry reveals only that records
// exist. Every market is hidden; there is no public directory (AD-2).
//
// Registration is permissionless and first-come-first-served per key; only
// the registering owner can update an entry afterwards. The registry cannot
// verify that a lookup_key was honestly derived -- the Portal detects
// squatted keys because AEAD decryption of the market's metadata blob fails
// without the access secret the honest creator used.

mod test;
mod registry_record;

use ::aztec::macros::aztec;

#[aztec]
pub contract MarketplaceRegistry {
    use ::aztec::macros::{functions::{external, initializer}, storage::storage};
    use ::aztec::protocol::address::AztecAddress;
    use ::aztec::state_vars::{Map, PublicMutable};

    use crate::registry_record::{
        RegistryRecord, STATUS_ACTIVE, STATUS_SUSPENDED, STATUS_UNREGISTERED,
    };

    #[storage]
    struct Storage<Context> {
        records: Map<Field, PublicMutable<RegistryRecord, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor() {}

    // Registers a marketplace under its secret-derived lookup key.
    // Fails if the key is already taken.
    #[external("public")]
    fn register(lookup_key: Field, contract_address: AztecAddress) {
        assert(!contract_address.is_zero(), "contract_address must not be zero");

        let existing = self.storage.records.at(lookup_key).read();
        assert(existing.status == STATUS_UNREGISTERED, "lookup_key already registered");

        self.storage.records.at(lookup_key).write(RegistryRecord {
            owner: self.msg_sender(),
            contract_address,
            status: STATUS_ACTIVE,
        });
    }

    // Owner-only: activate/suspend the registry entry.
    #[external("public")]
    fn set_status(lookup_key: Field, status: u8) {
        assert(
            (status == STATUS_ACTIVE) | (status == STATUS_SUSPENDED),
            "invalid status",
        );
        let mut record = self.storage.records.at(lookup_key).read();
        assert(record.status != STATUS_UNREGISTERED, "lookup_key not registered");
        assert(record.owner.eq(self.msg_sender()), "caller is not the entry owner");
        record.status = status;
        self.storage.records.at(lookup_key).write(record);
    }

    // Resolution path used by the Portal (via node RPC, no tx).
    #[external("utility")]
    unconstrained fn get_record(lookup_key: Field) -> RegistryRecord {
        self.storage.records.at(lookup_key).read()
    }
}
