use ::aztec::{
    protocol::address::AztecAddress, test::helpers::test_environment::TestEnvironment,
};

use crate::MarketplaceRegistry;

// Deploys a fresh registry. Returns (env, registry_address, deployer).
pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();

    let deployer = env.create_light_account();

    let initializer_call_interface = MarketplaceRegistry::interface().constructor();
    let registry_address = env.deploy("MarketplaceRegistry").with_public_initializer(
        deployer,
        initializer_call_interface,
    );

    (env, registry_address, deployer)
}
