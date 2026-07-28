use ::aztec::{
    protocol::{address::AztecAddress, hash::poseidon2_hash},
    test::helpers::test_environment::{DeployOptions, TestEnvironment},
};
use test_arbiter::TestArbiter;
use token::Token;

use crate::OrderEscrow;
use crate::terms::EscrowTerms;

pub global MINTED: u128 = 1_000_000;
pub global AMOUNT: u128 = 10_000;
pub global FEE: u128 = 250;
pub global COLLATERAL: u128 = 500;
pub global ORDER_ID: Field = 0x0de1;
pub global BUYER_SECRET: Field = 0x5ec1e7;

// The per-order secret the escrow's keys derive from. In production this is
// derived per order and handed to the vendor inside the order note; here it is
// the TXE deployment secret, which is how the escrow's keys reach the keystore.
pub global ORDER_SECRET: Field = 0xe5c20;

pub unconstrained fn buyer_auth() -> Field {
    poseidon2_hash([BUYER_SECRET])
}

pub unconstrained fn deploy_token(env: &mut TestEnvironment, minter: AztecAddress) -> AztecAddress {
    let initializer = Token::interface().constructor_with_minter(
        "TestToken0000000000000000000000",
        "TT00000000000000000000000000000",
        6,
        minter,
        AztecAddress::zero(),
    );
    env.deploy("@token_contract/Token").with_public_initializer(minter, initializer)
}

// Puts the arbitrating marketplace's order state where the escrow will read it.
// The block must be MINED, not merely scheduled: the escrow reads the ANCHOR
// block header, which is a settled block.
pub unconstrained fn set_order_state(
    env: &mut TestEnvironment,
    arbiter: AztecAddress,
    caller: AztecAddress,
    state: u8,
) {
    env.call_public(caller, TestArbiter::at(arbiter).set_order_state(ORDER_ID, state));
    env.mine_block();
}

// A funded, opened escrow. Returns (env, escrow, token, arbiter, terms, buyer,
// vendor, treasury).
pub unconstrained fn setup() -> (
    TestEnvironment,
    AztecAddress,
    AztecAddress,
    AztecAddress,
    EscrowTerms,
    AztecAddress,
    AztecAddress,
    AztecAddress,
) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let token = deploy_token(&mut env, admin);

    let arbiter = env.deploy("@test_arbiter_contract/TestArbiter").without_initializer();
    let order_states_slot = env.execute_utility(TestArbiter::at(arbiter).order_states_slot());

    let buyer = env.create_light_account();
    let vendor = env.create_light_account();
    let treasury = env.create_light_account();
    env.call_private(admin, Token::at(token).mint_to_private(buyer, MINTED));

    let terms = EscrowTerms {
        asset: token,
        marketplace: arbiter,
        order_states_slot,
        order_id: ORDER_ID,
        vendor,
        treasury,
        amount: AMOUNT,
        fee: FEE,
        collateral: COLLATERAL,
        buyer_auth: buyer_auth(),
    };

    // The escrow's address commits to `terms`; its keys come from ORDER_SECRET.
    // No public deployment is involved on a real network -- see main.nr.
    let escrow = env
        .deploy_opts(DeployOptions::new().with_secret(ORDER_SECRET), "OrderEscrow")
        .with_private_initializer(buyer, OrderEscrow::interface().open(terms));

    // Fund it: the price AND the buyer's finalization collateral. Self-authorized
    // (from == msg_sender), so no authwit needed.
    env.call_private(
        buyer,
        Token::at(token).transfer_private_to_private(buyer, escrow, AMOUNT + COLLATERAL, 0),
    );

    (env, escrow, token, arbiter, terms, buyer, vendor, treasury)
}
