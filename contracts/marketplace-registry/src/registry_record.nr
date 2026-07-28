use ::aztec::protocol::{
    address::AztecAddress,
    traits::{Deserialize, Packable, Serialize},
};

// Registry status values (u8). 0 doubles as "never registered" since public
// storage reads as zero before the first write.
pub global STATUS_UNREGISTERED: u8 = 0;
pub global STATUS_ACTIVE: u8 = 1;
pub global STATUS_SUSPENDED: u8 = 2;

// One entry per lookup_key. Public state only, but opaque without the market
// access secret: the key is poseidon2(secret, domain), and everything else
// about the market (its sealed metadata and listings) lives in the
// Marketplace contract itself (AD-3). There is no directory and no listed
// flag -- every market is hidden by design; `owner` is the account that
// registered the entry and is the only one allowed to update it.
#[derive(Deserialize, Serialize, Eq, Packable)]
pub struct RegistryRecord {
    pub owner: AztecAddress,
    pub contract_address: AztecAddress,
    pub status: u8,
}
