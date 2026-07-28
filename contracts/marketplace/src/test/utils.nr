use ::aztec::{
    protocol::{address::AztecAddress, hash::poseidon2_hash, traits::{FromField, Serialize, ToField}},
    test::helpers::{
        authwit::add_private_authwit_from_call,
        test_environment::{DeployOptions, TestEnvironment},
        txe_oracles,
    },
};
use order_escrow::OrderEscrow;
use order_escrow::terms::EscrowTerms;

use market_protocol::{
    derive_order_id, derive_price_blinding, derive_price_commitment,
    LISTING_POLICY_APPROVAL, LISTING_POLICY_OPEN,
    VENDOR_POLICY_APPROVAL, VENDOR_POLICY_DEPOSIT, VENDOR_POLICY_OPEN,
};
use token::Token;

use crate::market_config::MarketConfig;
use crate::Marketplace;

pub global TEST_NONCE: Field = 42;
// Two-chunk (40-byte) stand-in for a sealed metadata blob.
pub global TEST_METADATA_LEN: u32 = 40;
pub global TEST_METADATA_CHUNK_0: Field = 0xd0c1;
pub global TEST_METADATA_CHUNK_1: Field = 0xd0c2;

// Account model: a user's identity on a market IS their per-market account
// address (msg_sender), so tests use dedicated accounts, not secrets. Vendors
// must claim a username (register) before becoming a vendor; a username_hash
// is any nonzero commitment (in production hash(username, market_secret)), so
// tests derive a deterministic unique one per account.
pub unconstrained fn test_username_hash(account: AztecAddress) -> Field {
    poseidon2_hash([account.to_field(), 0x757365720000])
}

// Registers a username for `account` so it can become a vendor / be addressed
// by handle. Idempotent-unsafe: call once per account.
pub unconstrained fn register_user(
    env: &mut TestEnvironment,
    marketplace: AztecAddress,
    account: AztecAddress,
) {
    env.call_private(account, Marketplace::at(marketplace).register(test_username_hash(account), account, 0));
}

// Contract tests treat the price commitment as an opaque nonzero field; its
// derivation is pinned in market_protocol tests and mirrored in TS.
pub global TEST_PRICE_COMMITMENT: Field = 0x9c1;
pub global DEPOSIT_AMOUNT: u128 = 1000;

pub unconstrained fn test_metadata_blob() -> [Field; 128] {
    let mut blob = [0; 128];
    blob[0] = TEST_METADATA_CHUNK_0;
    blob[1] = TEST_METADATA_CHUNK_1;
    blob
}

pub unconstrained fn default_config() -> MarketConfig {
    MarketConfig {
        payment_asset: AztecAddress::from_field(0xa55e7),
        fee_bps: 250,
        vendor_policy: VENDOR_POLICY_APPROVAL,
        vendor_deposit: 0,
        order_timeout: 604800,
        finalization_collateral: 0,
        listing_policy: LISTING_POLICY_OPEN,
    }
}

// Config whose listings require moderator approval before going live.
pub unconstrained fn approval_listing_config() -> MarketConfig {
    let mut config = open_config();
    config.listing_policy = LISTING_POLICY_APPROVAL;
    config
}

pub unconstrained fn open_config() -> MarketConfig {
    let mut config = default_config();
    config.vendor_policy = VENDOR_POLICY_OPEN;
    config
}

pub unconstrained fn deposit_config(payment_asset: AztecAddress) -> MarketConfig {
    let mut config = default_config();
    config.payment_asset = payment_asset;
    config.vendor_policy = VENDOR_POLICY_DEPOSIT;
    config.vendor_deposit = DEPOSIT_AMOUNT;
    config
}

// Deploys a marketplace with the default (approval-policy) config, `admin`
// acting as both deployer (creator) and superadmin.
pub unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let marketplace_address = deploy(&mut env, admin, TEST_NONCE, default_config());
    (env, marketplace_address, admin)
}

// Open-registration marketplace: any secret can become an ACTIVE vendor.
pub unconstrained fn setup_open() -> (TestEnvironment, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let marketplace_address = deploy(&mut env, admin, TEST_NONCE, open_config());
    (env, marketplace_address, admin)
}

// Deposit-policy marketplace with a real Token as payment asset and a funded
// vendor contract account (contract account: authwits require one). Returns
// (env, marketplace, admin, token, vendor).
pub unconstrained fn setup_deposit_market() -> (
    TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress,
) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let token = deploy_token(&mut env, admin);
    let marketplace_address = deploy(&mut env, admin, TEST_NONCE, deposit_config(token));
    let vendor = env.create_contract_account();
    env.call_private(admin, Token::at(token).mint_to_private(vendor, DEPOSIT_AMOUNT * 10));
    (env, marketplace_address, admin, token, vendor)
}

// Account model: the superadmin is the owner's account address. In tests the
// deployer `admin` is also the owner, so it is passed as the superadmin.
pub unconstrained fn deploy(
    env: &mut TestEnvironment,
    admin: AztecAddress,
    deployment_nonce: Field,
    config: MarketConfig,
) -> AztecAddress {
    let initializer_call_interface = Marketplace::interface().constructor(
        admin,
        test_username_hash(admin),
        deployment_nonce,
        config,
        test_metadata_blob(),
        TEST_METADATA_LEN,
    );
    env.deploy("Marketplace").with_public_initializer(admin, initializer_call_interface)
}

pub unconstrained fn deploy_token(env: &mut TestEnvironment, minter: AztecAddress) -> AztecAddress {
    // cUSDC is the aztec-standards Token; deploy that as the test token so the
    // marketplace's cross-contract calls resolve. `auth_contract = zero` disables
    // the compliance hook (Shield sets one on the real cUSDC; tests don't need it).
    // 6 decimals matches cUSDC (the marketplace is decimal-agnostic regardless).
    let initializer_call = Token::interface().constructor_with_minter(
        "TestToken0000000000000000000000",
        "TT00000000000000000000000000000",
        6,
        minter,
        AztecAddress::zero(),
    );
    env.deploy("@token_contract/Token").with_public_initializer(minter, initializer_call)
}

// A vendor's on-chain identity IS their account address (as a field).
pub unconstrained fn vendor_id_of(vendor: AztecAddress) -> Field {
    vendor.to_field()
}

// Registers a vendor on a no-deposit market (open or approval policy). The
// account must claim a username first (account model prerequisite).
pub unconstrained fn register_vendor_no_deposit(
    env: &mut TestEnvironment,
    marketplace: AztecAddress,
    vendor: AztecAddress,
) {
    register_user(env, marketplace, vendor);
    env.call_private(
        vendor,
        Marketplace::at(marketplace).register_vendor(AztecAddress::zero(), 0, vendor, 0, vendor, 0),
    );
}

// ---------------------------------------------------------------------------
// Order-flow fixtures (AD-5)
// ---------------------------------------------------------------------------

// The market link secret the order tests assume; price commitments and the
// escrow key secret derive from it.
pub global ACCESS_SECRET: Field = 0xacce55;
// The escrow key secret the marketplace is deployed with. In production this
// is derive_escrow_key_secret(access_secret); any known value works in TXE.
pub global ESCROW_SECRET: Field = 0xe5c401;
pub global LISTING_PRICE: u128 = 1000;
pub global ORDER_QUANTITY: u32 = 2;
pub global ORDER_AMOUNT: u128 = 2000; // price x quantity
pub global ORDER_FEE: u128 = 50; // 250 bps of 2000
// Finalization collateral the order market is configured with: escrowed on
// top of ORDER_AMOUNT, refunded to the buyer at confirmation (with feedback)
// or forfeited to the vendor on a timeout claim.
pub global FINALIZATION_COLLATERAL: u128 = 100;
pub global ORDER_ESCROW: u128 = 2100; // ORDER_AMOUNT + FINALIZATION_COLLATERAL
pub global BUYER_FUNDS: u128 = 10000;

// A stand-in sealed feedback blob (rating + statement ciphertext; a real
// blob's first chunk is always nonzero -- it starts with the length header).
pub unconstrained fn test_feedback_blob() -> [Field; 12] {
    let mut blob = [0; 12];
    blob[0] = 0xfeed01;
    blob[1] = 0xfeed02;
    blob
}

// A marketplace wired for full order flows: real Token as payment asset,
// open vendor registration, a listed item whose price commitment matches
// LISTING_PRICE under ACCESS_SECRET, a funded buyer, and the escrow keys in
// the TXE keystore (via the deployment secret) so settlement transactions
// can spend the marketplace's own token notes.
// `admin` is both the superadmin and, since the owner IS the treasury, where
// the marketplace fee is paid.
// Returns (env, marketplace, token, vendor, buyer, admin).
pub unconstrained fn setup_order_market() -> (
    TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress,
) {
    setup_priced_market(test_option_prices(), 1, test_shipping_prices(), 1)
}

/// A market whose single listing carries an arbitrary price table -- one
/// variant and one free shipping method for the plain case, or several of each.
pub unconstrained fn setup_priced_market(
    option_prices: [Field; 8],
    option_count: u32,
    shipping_prices: [Field; 4],
    shipping_count: u32,
) -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let admin = env.create_light_account();
    let token = deploy_token(&mut env, admin);

    let mut config = default_config();
    config.payment_asset = token;
    config.vendor_policy = VENDOR_POLICY_OPEN;
    config.finalization_collateral = FINALIZATION_COLLATERAL;

    let initializer = crate::Marketplace::interface().constructor(
        admin,
        test_username_hash(admin),
        TEST_NONCE,
        config,
        test_metadata_blob(),
        TEST_METADATA_LEN,
    );
    let marketplace = env
        .deploy_opts(DeployOptions::new().with_secret(ESCROW_SECRET), "Marketplace")
        .with_public_initializer(admin, initializer);

    // An active vendor with one listing at LISTING_PRICE.
    let vendor = env.create_light_account();
    register_vendor_no_deposit(&mut env, marketplace, vendor);
    // Listing ids are 1-based, and the price blinding is bound to the id, so
    // both the blinding and the expected id here are 1.
    let commitment = derive_price_commitment(
        option_prices,
        option_count,
        shipping_prices,
        shipping_count,
        derive_price_blinding(ACCESS_SECRET, 1),
    );
    env.call_private(
        vendor,
        crate::Marketplace::at(marketplace).create_listing(1, [0x11c0, 0], commitment, 0, vendor, 0),
    );

    // A funded buyer (contract account: place_order needs an authwit).
    let buyer = env.create_contract_account();
    env.call_private(admin, Token::at(token).mint_to_private(buyer, BUYER_FUNDS));

    (env, marketplace, token, vendor, buyer, admin)
}

// Places the standard test order (LISTING_PRICE x ORDER_QUANTITY of listing
// 0) and returns its order_id.
// The standard test listing's price table: one variant at LISTING_PRICE, one
// free shipping method. Unused slots are zero and ARE part of the commitment.
pub unconstrained fn test_option_prices() -> [Field; 8] {
    [LISTING_PRICE as Field, 0, 0, 0, 0, 0, 0, 0]
}

pub unconstrained fn test_shipping_prices() -> [Field; 4] {
    [0, 0, 0, 0]
}

/// The escrow terms `place_order` will build for this order, rebuilt here the
/// way a buyer's client rebuilds them: from the market's own published config
/// and id, not from anything the test was told privately.
///
/// `amount` is the price the proven table works out to; the fee and collateral
/// follow from the config, so a test that gets the price wrong gets a different
/// address and is rejected -- which is the property under test.
pub unconstrained fn expected_escrow_terms(
    env: &mut TestEnvironment,
    marketplace: AztecAddress,
    buyer: AztecAddress,
    vendor_inbox: AztecAddress,
    order_nonce: Field,
    amount: u128,
) -> EscrowTerms {
    let config = env.execute_utility(Marketplace::at(marketplace).get_config());
    let marketplace_id = env.execute_utility(Marketplace::at(marketplace).get_marketplace_id());
    let treasury = env.execute_utility(Marketplace::at(marketplace).get_superadmin_identity());
    EscrowTerms {
        asset: config.payment_asset,
        marketplace,
        order_states_slot: Marketplace::storage_layout().order_states.slot,
        // Every test market has exactly one listing, and listing ids are 1-based.
        order_id: derive_order_id(marketplace_id, 1, buyer, order_nonce),
        vendor: vendor_inbox,
        treasury: AztecAddress::from_field(treasury),
        amount,
        fee: (amount * (config.fee_bps as u128)) / 10000,
        collateral: config.finalization_collateral,
        buyer_auth: TEST_BUYER_AUTH,
    }
}

/// This order's escrow address, registered with the TXE so the marketplace's
/// cross-contract `open` call can reach it.
///
/// Registered from the TERMS, deliberately. A contract's address commits to its
/// initializer arguments, so `place_order` opening this escrow is what proves
/// the buyer paid the right amount to the right order -- and the TXE enforces
/// that rule too: registering the instance any other way (with no initializer,
/// or with different terms) makes `open` fail with an initialization-hash
/// mismatch. So this must NOT go through `deploy(..).without_initializer()`.
///
/// It also must not go through `with_private_initializer`, which would RUN
/// `open` here; place_order runs it, inside the transaction that funds the
/// address. `txe_oracles::deploy` is the piece underneath both: it registers
/// the instance and stops.
pub unconstrained fn escrow_address_for(order_nonce: Field, terms: EscrowTerms) -> AztecAddress {
    let open = OrderEscrow::interface().open(terms);
    txe_oracles::deploy(
        "@order_escrow_contract/OrderEscrow",
        open.name,
        open.args,
        test_escrow_secret(order_nonce),
        0,
        AztecAddress::zero(),
    )
        .to_address()
}

/// Authorizes the marketplace to pull `amount` of the payment asset out of the
/// buyer, which is how place_order funds the escrow.
unconstrained fn authorize_escrow_funding(
    env: &mut TestEnvironment,
    marketplace: AztecAddress,
    token: AztecAddress,
    buyer: AztecAddress,
    escrow: AztecAddress,
    amount: u128,
    authwit_nonce: Field,
) {
    let transfer = Token::at(token).transfer_private_to_private(buyer, escrow, amount, authwit_nonce);
    add_private_authwit_from_call(*env, buyer, marketplace, transfer);
}

// No funds move: the marketplace never holds order money, so there is no
// authwit to take here. The buyer funds this order's own OrderEscrow address
// in the same transaction -- that half lives in the order-escrow package's
// tests and in the live TS suite, since the escrow is a separate contract.
/// Places an order against a market built with setup_priced_market, choosing
/// explicit rows of its table. The table is re-supplied here exactly as the
/// buyer's client would: place_order proves it against the commitment.
pub unconstrained fn place_priced_order(
    env: &mut TestEnvironment,
    marketplace: AztecAddress,
    _token: AztecAddress,
    buyer: AztecAddress,
    vendor_inbox: AztecAddress,
    order_nonce: Field,
    option_index: u32,
    shipping_index: u32,
    quantity: u32,
) -> Field {
    let mut memo = [0; 6];
    memo[0] = 0x3e30;
    let authwit_nonce = order_nonce + 0x2000;
    // The buyer works out the amount from the table exactly as place_order
    // will, then derives the escrow that amount belongs to and authorizes the
    // exact pull. An index the listing does not offer is rejected before any
    // transfer, so a rejected order never spends this authwit.
    let unit = if option_index == 0 { 100 } else { 250 } as u128;
    let ship = if shipping_index == 0 { 10 } else { 40 } as u128;
    let amount = unit * (quantity as u128) + ship;
    let terms = expected_escrow_terms(env, marketplace, buyer, vendor_inbox, order_nonce, amount);
    let escrow = escrow_address_for(order_nonce, terms);
    authorize_escrow_funding(
        env,
        marketplace,
        _token,
        buyer,
        escrow,
        amount + FINALIZATION_COLLATERAL,
        authwit_nonce,
    );
    env.call_private(
        buyer,
        crate::Marketplace::at(marketplace).place_order(
            ACCESS_SECRET,
            1,
            [100, 250, 0, 0, 0, 0, 0, 0],
            2,
            [10, 40, 0, 0],
            2,
            option_index,
            shipping_index,
            quantity,
            vendor_inbox,
            order_nonce,
            memo,
            test_escrow_secret(order_nonce),
            TEST_BUYER_AUTH,
            escrow,
            buyer,
            authwit_nonce,
        ),
    )
}

pub unconstrained fn place_test_order(
    env: &mut TestEnvironment,
    marketplace: AztecAddress,
    token: AztecAddress,
    buyer: AztecAddress,
    vendor_inbox: AztecAddress,
    order_nonce: Field,
) -> Field {
    let mut memo = [0; 6];
    memo[0] = 0x3e30;
    let authwit_nonce = order_nonce + 0x1000;
    let terms =
        expected_escrow_terms(env, marketplace, buyer, vendor_inbox, order_nonce, ORDER_AMOUNT);
    let escrow = escrow_address_for(order_nonce, terms);
    authorize_escrow_funding(
        env,
        marketplace,
        token,
        buyer,
        escrow,
        ORDER_AMOUNT + FINALIZATION_COLLATERAL,
        authwit_nonce,
    );
    env.call_private(
        buyer,
        crate::Marketplace::at(marketplace).place_order(
            ACCESS_SECRET,
            1,
            test_option_prices(),
            1,
            test_shipping_prices(),
            1,
            0, // option index
            0, // shipping index
            ORDER_QUANTITY,
            vendor_inbox,
            order_nonce,
            memo,
            test_escrow_secret(order_nonce),
            TEST_BUYER_AUTH,
            escrow,
            buyer,
            authwit_nonce,
        ),
    )
}

// Stand-ins for the per-order escrow values. In production `escrow_secret` is
// random per order and `buyer_auth` is poseidon2([buyer_secret]) for a secret
// only the buyer keeps; the marketplace only checks they are nonzero and
// delivers them, so distinct values per order are all the tests need.
pub unconstrained fn test_escrow_secret(order_nonce: Field) -> Field {
    poseidon2_hash([0xe5c20, order_nonce])
}

pub global TEST_BUYER_AUTH: Field = 0xb0a17;

// Registers a vendor on a deposit market: authwit for the deposit transfer,
// then the private registration call.
pub unconstrained fn register_vendor_with_deposit(
    env: &mut TestEnvironment,
    marketplace: AztecAddress,
    token: AztecAddress,
    vendor: AztecAddress,
    authwit_nonce: Field,
) {
    register_user(env, marketplace, vendor);
    let transfer_call =
        Token::at(token).transfer_private_to_public(vendor, marketplace, DEPOSIT_AMOUNT, authwit_nonce);
    add_private_authwit_from_call(*env, vendor, marketplace, transfer_call);
    env.call_private(
        vendor,
        Marketplace::at(marketplace).register_vendor(token, DEPOSIT_AMOUNT, vendor, authwit_nonce, vendor, 0),
    );
}
