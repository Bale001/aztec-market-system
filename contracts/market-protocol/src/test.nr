use crate::{
    derive_action_nullifier, derive_dispute_auth_tag, derive_dispute_commitment,
    derive_market_lookup_key, pack_selection,
    derive_marketplace_id, derive_marketplace_identity, derive_order_id,
    derive_order_settlement_nullifier, derive_price_blinding, derive_price_commitment,
    DOMAIN_ESCROW_KEYS, DOMAIN_IDENTITY, DOMAIN_MARKET_LOOKUP,
    DOMAIN_METADATA, DOMAIN_ORDER_ID, DOMAIN_ORDER_SETTLEMENT, DOMAIN_PRICE_BLINDING,
    DOMAIN_PRICE_COMMITMENT, DOMAIN_VENDOR_REGISTRATION,
};
use protocol_types::{address::AztecAddress, traits::FromField};

global SECRET: Field = 0x1234;
global OTHER_SECRET: Field = 0x5678;
global MARKET_A: Field = 0xaaaa;
global MARKET_B: Field = 0xbbbb;

// A plain single-price listing: one variant, one (free) shipping method --
// the commonest table by far, and what the old single-price listing became.
fn commit_one(price: Field, blinding: Field) -> Field {
    derive_price_commitment([price, 0, 0, 0, 0, 0, 0, 0], 1, [0, 0, 0, 0], 1, blinding)
}

#[test]
fn domain_constants_are_distinct() {
    let domains = [
        DOMAIN_IDENTITY,
        DOMAIN_VENDOR_REGISTRATION,
        DOMAIN_ORDER_SETTLEMENT,
        DOMAIN_METADATA,
        DOMAIN_MARKET_LOOKUP,
        DOMAIN_PRICE_BLINDING,
        DOMAIN_PRICE_COMMITMENT,
        // Retired but still checked: nothing derives from it any more, and the
        // point of keeping it is that no future domain reuses the number.
        DOMAIN_ESCROW_KEYS,
        DOMAIN_ORDER_ID,
    ];
    for i in 0..9 {
        for j in 0..9 {
            if i != j {
                assert(domains[i] != domains[j]);
            }
        }
    }
}

#[test]
fn marketplace_id_is_deterministic() {
    let creator = AztecAddress::from_field(0x1111);
    let a = derive_marketplace_id(creator, 7, 0x2222);
    let b = derive_marketplace_id(creator, 7, 0x2222);
    assert_eq(a, b);
}

#[test]
fn marketplace_id_changes_with_each_input() {
    let creator = AztecAddress::from_field(0x1111);
    let other_creator = AztecAddress::from_field(0x9999);
    let base = derive_marketplace_id(creator, 7, 0x2222);
    assert(derive_marketplace_id(other_creator, 7, 0x2222) != base);
    assert(derive_marketplace_id(creator, 8, 0x2222) != base);
    assert(derive_marketplace_id(creator, 7, 0x3333) != base);
}

#[test]
fn identity_is_scoped_per_marketplace() {
    let id_a = derive_marketplace_identity(SECRET, MARKET_A);
    let id_b = derive_marketplace_identity(SECRET, MARKET_B);
    assert(id_a != id_b);
}

#[test]
fn identity_differs_per_user() {
    let mine = derive_marketplace_identity(SECRET, MARKET_A);
    let theirs = derive_marketplace_identity(OTHER_SECRET, MARKET_A);
    assert(mine != theirs);
}

#[test]
fn nullifiers_are_domain_separated() {
    let order_id = 0x77;
    let settle = derive_action_nullifier(SECRET, MARKET_A, DOMAIN_ORDER_SETTLEMENT, order_id);
    let register = derive_action_nullifier(SECRET, MARKET_A, DOMAIN_VENDOR_REGISTRATION, order_id);
    assert(settle != register);
}

#[test]
fn nullifiers_are_subject_separated() {
    let a = derive_action_nullifier(SECRET, MARKET_A, DOMAIN_ORDER_SETTLEMENT, 1);
    let b = derive_action_nullifier(SECRET, MARKET_A, DOMAIN_ORDER_SETTLEMENT, 2);
    assert(a != b);
}

// Cross-language vectors: packages/identity (TypeScript, poseidon2Hash from
// @aztec/foundation) must derive exactly these values. Mirrored in
// packages/identity/src/index.test.ts. If these change, the protocol changed
// -- update both sides in one commit.
#[test]
fn matches_typescript_vectors() {
    let id = derive_marketplace_id(AztecAddress::from_field(0x1111), 7, 0x2222);
    assert_eq(id, 0x144a87d92cb61ea880a399e60ff1f09df4518c1c5bbf21d03eb1c3dce60c10cd);

    let identity = derive_marketplace_identity(SECRET, MARKET_A);
    assert_eq(identity, 0x219817ba9ec2a8adde00c4d4daa0b034c285269f06e55fa08e2f18d7bedb6120);

    let nullifier = derive_action_nullifier(SECRET, MARKET_A, DOMAIN_ORDER_SETTLEMENT, 0x77);
    assert_eq(nullifier, 0x279cfc4c8f0af0d45239d2ef56596a5c7c2de9bc92848d822583a16f6a223ef4);

    // packages/market-metadata computeMetadataCommitment with a sha256 whose
    // big-endian halves are hi = 0x11, lo = 0x22.
    let metadata_commitment = crate::derive_metadata_commitment(0x11, 0x22);
    assert_eq(
        metadata_commitment,
        0x2856f314bb278d176fa31bd69bf462568393549477fd1a95b857215c48195bea,
    );

    // packages/identity deriveMarketLookupKey(0x5555).
    let lookup_key = derive_market_lookup_key(0x5555);
    assert_eq(lookup_key, 0x1e46d6657fc6ba7909b26ad684fddb694928a6dd7905ced5461499275afe6369);

    // packages/identity derivePriceBlinding(0x5555, 3) and
    // derivePriceCommitment([10, 20], [5, 7], blinding) -- two variants and two
    // shipping methods, so the vector exercises a real table rather than the
    // degenerate one-row case.
    let blinding = derive_price_blinding(0x5555, 3);
    assert_eq(blinding, 0x084f0884e8c43ec61ea80cf46eba1a83e9965397fd5aa93107f262b6470ff9e0);
    let table = derive_price_commitment([10, 20, 0, 0, 0, 0, 0, 0], 2, [5, 7, 0, 0], 2, blinding);
    assert_eq(table, 0x00e862019d00348bfe4223fdbb1b16f1a4950bc45af9d2a304d6f2ae71912ded);

    // packages/identity deriveOrderId(0xaaaa, 3, 0x1234, 0x77),
    // deriveOrderSettlementNullifier(order_id).
    let order_id = derive_order_id(MARKET_A, 3, AztecAddress::from_field(SECRET), 0x77);
    assert_eq(order_id, 0x268e6130ddc3bd0be3295d1a98f0f82324d17a1b3ee2b6955a4eab6b1b8df616);
    let settle = derive_order_settlement_nullifier(order_id);
    assert_eq(settle, 0x2b543ef4a7c6343de432296820f07044a587c8d3d336a1b7abcbfd98481b2b47);
}

#[test]
fn order_ids_are_scoped() {
    let buyer = AztecAddress::from_field(0x1234);
    let base = derive_order_id(MARKET_A, 3, buyer, 0x77);
    assert(derive_order_id(MARKET_B, 3, buyer, 0x77) != base);
    assert(derive_order_id(MARKET_A, 4, buyer, 0x77) != base);
    assert(derive_order_id(MARKET_A, 3, buyer, 0x78) != base);
    assert(derive_order_id(MARKET_A, 3, AztecAddress::from_field(0x9999), 0x77) != base);
}

// Dispute auth (AD-6): the per-order storage tag and the secret commitment
// use disjoint domains, so they never collide; the commitment binds the
// secret (a wrong secret cannot open a genuine commitment).
#[test]
fn dispute_commitment_binds_the_secret() {
    let order_id = derive_order_id(MARKET_A, 3, AztecAddress::from_field(SECRET), 0x77);
    let commitment = derive_dispute_commitment(0xc0ffee);
    assert(derive_dispute_commitment(0xc0ffef) != commitment);
    // The bucket tag (keyed by order id) is in a different domain from any
    // commitment, so storage keys never collide with committed values.
    assert(derive_dispute_auth_tag(order_id) != commitment);
    assert(derive_dispute_auth_tag(order_id) != derive_dispute_auth_tag(order_id + 1));
}

#[test]
fn lookup_key_differs_per_secret() {
    assert(derive_market_lookup_key(SECRET) != derive_market_lookup_key(OTHER_SECRET));
}

// Identity (3-input hash) must not collide with nullifiers (4-input hash)
// even when a nullifier reuses DOMAIN_IDENTITY-shaped inputs: Noir Poseidon2
// encodes input length in the IV.
#[test]
fn identity_and_nullifier_families_do_not_collide() {
    let identity = derive_marketplace_identity(SECRET, MARKET_A);
    let nullifier = derive_action_nullifier(SECRET, MARKET_A, DOMAIN_IDENTITY, 0);
    assert(identity != nullifier);
}

#[test]
fn price_blinding_is_scoped_per_listing_and_secret() {
    let base = derive_price_blinding(SECRET, 1);
    assert(derive_price_blinding(SECRET, 2) != base);
    assert(derive_price_blinding(OTHER_SECRET, 1) != base);
}

// Same price on two listings (or two markets) must yield unlinkable
// commitments: the blinding differs, so the commitments differ.
#[test]
fn equal_prices_produce_unlinkable_commitments() {
    let price = 995;
    let a = commit_one(price, derive_price_blinding(SECRET, 1));
    let b = commit_one(price, derive_price_blinding(SECRET, 2));
    assert(a != b);
}

#[test]
fn price_commitment_binds_the_price() {
    let blinding = derive_price_blinding(SECRET, 1);
    assert(commit_one(1000, blinding) != commit_one(1001, blinding));
}

#[test]
fn price_commitment_binds_every_row_of_the_table() {
    let blinding = derive_price_blinding(SECRET, 1);
    let base = derive_price_commitment([10, 20, 0, 0, 0, 0, 0, 0], 2, [5, 7, 0, 0], 2, blinding);

    // Changing ANY priced row changes the commitment -- a vendor cannot repoint
    // one variant after buyers have seen the listing.
    let variant = derive_price_commitment([10, 21, 0, 0, 0, 0, 0, 0], 2, [5, 7, 0, 0], 2, blinding);
    assert(base != variant);
    let shipping = derive_price_commitment([10, 20, 0, 0, 0, 0, 0, 0], 2, [5, 8, 0, 0], 2, blinding);
    assert(base != shipping);
}

#[test]
fn price_commitment_binds_the_counts() {
    let blinding = derive_price_blinding(SECRET, 1);
    // Same prices, different counts. Without binding the counts a vendor could
    // "reveal" an extra zero-priced row that buyers were never shown.
    let two = derive_price_commitment([10, 20, 0, 0, 0, 0, 0, 0], 2, [5, 0, 0, 0], 1, blinding);
    let three = derive_price_commitment([10, 20, 0, 0, 0, 0, 0, 0], 3, [5, 0, 0, 0], 1, blinding);
    assert(two != three);
}

#[test]
fn selection_packing_round_trips() {
    // The order note carries both indices in one field; they must not collide.
    assert(pack_selection(0, 0) != pack_selection(0, 1));
    assert(pack_selection(1, 0) != pack_selection(0, 1));
    assert_eq(pack_selection(3, 2), 3 * 256 + 2);
}
