// Marketplace -- one instance per marketplace (PLAN.md D1).
//
// M1: configuration + superadmin + moderator roles + immutable
// marketplace_id. M3/AD-3: sealed (AEAD-encrypted) metadata and listing
// blobs live in public storage as 31-byte-packed field chunks; on-chain does
// NOT mean readable -- without the market access secret the blobs are
// ciphertext. M4/AD-4: account-model vendors. A vendor's identity is its
// per-market ACCOUNT address (msg_sender) -- a single-market account that is
// never linked to L1 or to the user's universal wallet. Vendor actions enter
// through PRIVATE functions that enqueue internal public writes; the per-market
// account is revealed only where it must be (e.g. the public deposit transfer
// in register_vendor), and the user's L1-facing wallet never appears in
// marketplace state or calldata.
//
// Vendor deposits are custodied in this contract's PUBLIC balance of the
// payment asset (AD-4). Ingress hides the vendor (Token::transfer_to_public
// from a private balance); egress pays into a privately prepared partial
// note, so withdrawal reveals no recipient either. Disputes are OFF-CHAIN
// (parties + operator over SimpleX, AD-6): the contract holds no dispute
// state and never slashes deposits.
//
// marketplace_id = poseidon2([creator, deployment_nonce, config_commitment])
// where creator is the deploying sender. Config may change later; the id
// never does (PublicImmutable, readable from private circuits).

mod test;
mod market_config;
mod listing_record;
mod vendor_record;
mod order_note;

use ::aztec::macros::aztec;

#[aztec]
pub contract Marketplace {
    use ::aztec::macros::{
        functions::{authorize_once, external, initializer, only_self},
        storage::storage,
    };
    use ::aztec::context::PrivateContext;
    use ::aztec::history::storage::public_storage_historical_read;
    use ::aztec::messages::delivery::MessageDelivery;
    use ::aztec::note::{
        note_getter_options::NoteGetterOptions, note_interface::NoteProperties,
        note_viewer_options::NoteViewerOptions,
    };
    use ::aztec::oracle::nullifiers::check_nullifier_exists;
    use ::aztec::protocol::{
        address::AztecAddress,
        hash::poseidon2_hash,
        traits::{FromField, Serialize, ToField},
    };
    use ::aztec::state_vars::{Map, Owned, PrivateSet, PublicImmutable, PublicMutable, StateVariable};
    use ::aztec::utils::comparison::Comparator;

    use token::Token;
    use order_escrow::OrderEscrow;
    use order_escrow::terms::EscrowTerms;

    use market_protocol::{
        derive_marketplace_id,
        derive_contact_address_tag, derive_dispute_auth_tag, derive_feedback_tag,
        derive_order_fulfillment_tag,
        derive_order_id, derive_order_settlement_nullifier,
        derive_price_blinding, derive_price_commitment, derive_vendor_listings_tag,
        pack_selection, MAX_PRICE_OPTIONS, MAX_SHIPPING_OPTIONS,
        DISPUTE_OUTCOME_PAY_VENDOR, DISPUTE_OUTCOME_REFUND_BUYER,
        ORDER_STATE_ACCEPTED, ORDER_STATE_CANCELLED, ORDER_STATE_COMPLETED,
        ORDER_STATE_DISPUTED, ORDER_STATE_NONE,
        ORDER_STATE_RULED_PAY_VENDOR, ORDER_STATE_RULED_REFUND_BUYER,
        ORDER_STATE_SETTLED_VENDOR,
        ORDER_STATUS_DELIVERED,
        LISTING_POLICY_APPROVAL,
        ORDER_STATUS_SHIPPED, PERM_ALL, PERM_MANAGE_VENDORS, PERM_MODERATE_LISTINGS,
        PERM_RESOLVE_DISPUTES,
        VENDOR_POLICY_APPROVAL, VENDOR_POLICY_BOTH, VENDOR_POLICY_DEPOSIT,
        VENDOR_STATUS_ACTIVE, VENDOR_STATUS_NONE, VENDOR_STATUS_PENDING, VENDOR_STATUS_SUSPENDED,
    };

    use crate::listing_record::{
        ListingRecord, LISTING_STATUS_ACTIVE, LISTING_STATUS_NONE, LISTING_STATUS_PAUSED,
        LISTING_STATUS_PENDING, LISTING_STATUS_REMOVED,
    };
    use crate::market_config::MarketConfig;
    use crate::order_note::{OrderEscrowNote, OrderMemoNote, OrderNote};
    use crate::vendor_record::VendorRecord;

    // Sealed blobs are packed 31 bytes per field (a field holds < 32 bytes).
    // 128 fields = 3968 bytes, the hard cap for the METADATA blob (listings
    // moved off-chain to Arweave). Mirrored by packages/market-metadata.
    pub global BLOB_MAX_FIELDS: u32 = 128;
    pub global BLOB_FIELD_BYTES: u32 = 31;
    pub global BLOB_MAX_BYTES: u32 = 3968;

    // Feedback blobs: 12 fields = 372 bytes per entry. The blob is sealed
    // client-side (rating + short statement) with its own byte length packed
    // into the leading two bytes, so the chain stores plain field chunks --
    // no extra length column. Mirrored by packages/market-metadata.
    pub global FEEDBACK_FIELDS: u32 = 12;

    // Contact-address blobs (sealed SimpleX links, AD-6): 32 fields =
    // 992 bytes, enough for a full-length SimpleX contact link plus AEAD
    // overhead. Mirrored by packages/market-metadata.
    pub global CONTACT_MAX_FIELDS: u32 = 32;
    pub global CONTACT_MAX_BYTES: u32 = 992;

    // Listing ids start at 1 so that 0 is a null for the ordering links
    // (`next`, and a category's head/tail). With 0-based ids "end of chain"
    // would be indistinguishable from "points at listing 0".
    pub global LISTING_FIRST_ID: u64 = 1;

    // Reserved keys inside a CATEGORY bucket. Unlike the vendor and feedback
    // buckets, a category bucket stores no payload array -- the order is the
    // chain through each record's `next`, so only these three keys are used.
    pub global CATEGORY_COUNT_KEY: Field = 0;
    pub global CATEGORY_HEAD_KEY: Field = 1;
    pub global CATEGORY_TAIL_KEY: Field = 2;

    #[storage]
    struct Storage<Context> {
        // AD-8: the owner is a per-market ACCOUNT address (the `superadmin`
        // passed at construction), not the user's L1-facing wallet -- a
        // single-market account that need not be linked to whoever paid to
        // deploy. It is the top-tier role (treated as holding every
        // permission); admin actions authenticate in private by the caller's
        // address, and the enqueued (only_self) public part asserts it equals
        // this stored address.
        superadmin_identity: PublicMutable<Field, Context>,
        // Immutable so vendor circuits can read it privately.
        marketplace_id: PublicImmutable<Field, Context>,
        // Sealed metadata blob: byte length + 31-byte-packed field chunks.
        metadata_len: PublicMutable<u32, Context>,
        metadata_data: Map<Field, PublicMutable<Field, Context>, Context>,
        config: PublicMutable<MarketConfig, Context>,
        // moderator ADDRESS (msg_sender().to_field()) -> permission bitmap
        // (PERM_* bits). 0 means "not a moderator". Account-model: roles are
        // keyed by the acting account's address, not a derived pseudonym.
        moderators: Map<Field, PublicMutable<u64, Context>, Context>,
        // Usernames (account model). A user "registers" a per-market account
        // under a username; the username itself is never stored in plaintext.
        // The client commits it as username_hash = hash(username, market_secret)
        // and both directions are kept:
        //   users_forward: username_hash -> account address (lets the owner
        //     resolve a known username to an address, e.g. to appoint a mod);
        //   users_reverse: account address -> username_hash (lets a buyer
        //     verify a listing's "Sold by: <username>" -- recompute the hash
        //     from the plaintext username in the Arweave doc and compare).
        // Flat maps (light for the type-complexity budget); 0 = unregistered.
        users_forward: Map<Field, PublicMutable<Field, Context>, Context>,
        users_reverse: Map<Field, PublicMutable<Field, Context>, Context>,
        // Vendors: keyed by the vendor's per-market account address, plus a
        // sequential index (0..vendor_count-1 -> vendor_id) so admins can
        // enumerate them.
        vendor_count: PublicMutable<u64, Context>,
        vendor_ids: Map<Field, PublicMutable<Field, Context>, Context>,
        vendors: Map<Field, PublicMutable<VendorRecord, Context>, Context>,
        // Listings: sequential ids 1..listing_count (enumerable without an
        // indexer by anyone holding the market link). The content lives on
        // Arweave; each record holds an encrypted pointer to it. Ids are
        // 1-BASED so 0 is a free null for the ordering links; the id is
        // identity only -- DISPLAY ORDER is the per-category chain.
        listing_count: PublicMutable<u64, Context>,
        listings: Map<Field, PublicMutable<ListingRecord, Context>, Context>,
        // THE generic per-subject bucket map. A nested Map is the compiler's
        // heaviest storage type (the Storage struct sits at the
        // type-complexity cap), so every per-subject dataset shares this one
        // under a domain-separated outer tag; a new dataset is a new tag,
        // never a new storage field. Uniform layout inside every bucket:
        // key 0 = entry count (or byte length), payload starts at key 1.
        //
        //   category_tag (bakes DOMAIN_CATEGORY):
        //     per-category listing ORDER, a singly-linked list rather than a
        //     positional array: key 0 = entry count, key 1 = head listing id,
        //     key 2 = tail listing id, and each record's `next` carries the
        //     chain (0 = end). Lets a link holder browse one category without
        //     scanning the market; a listing appears exactly once (category
        //     is immutable) and the record's status decides visibility.
        //     A chain, not an array, so move_listing can reorder in O(1) --
        //     an array would have to shift every entry after the moved one.
        //     THIS BUCKET HAS NO PAYLOAD ARRAY; the other tags below still do.
        //   derive_vendor_listings_tag(vendor_id):
        //     per-creator listing index (append-only), same shape. Feeds the
        //     vendor tab, per-vendor moderation, and the public storefront;
        //     leaks nothing (the creator account address is public in every record).
        //   derive_feedback_tag(listing_id):
        //     sealed rating+statement blobs, FEEDBACK_FIELDS chunks per
        //     entry (entry i's chunk j at key 1 + i*FEEDBACK_FIELDS + j).
        //     Only confirm_completion appends (one per order, enforced by
        //     the settlement nullifier).
        //   derive_contact_address_tag(identity) (AD-6):
        //     the sealed SimpleX address an identity published; key 0 is the
        //     byte length. Only the identity's secret holder can write it.
        buckets: Map<Field, Map<Field, PublicMutable<Field, Context>, Context>, Context>,
        // Orders (AD-5). All order state lives in encrypted notes, keyed by
        // the owning address: the buyer holds a receipt copy, the vendor's
        // inbox holds the intake copy plus the delivery memo, and status
        // updates flow as notes between the two.
        orders: Owned<PrivateSet<OrderNote, Context>, Context>,
        order_memos: Owned<PrivateSet<OrderMemoNote, Context>, Context>,
        // The keys to each order's own escrow instance. A separate set from
        // `orders` only because the two do not fit in one note under the
        // 8-field cap; the same two parties hold identical copies of both.
        order_escrows: Owned<PrivateSet<OrderEscrowNote, Context>, Context>,
        // The ONE public word per order: its anonymous lifecycle state, keyed
        // by the opaque order_id (see ORDER_STATE_*: none -> accepted ->
        // disputed -> ruled). Strictly monotonic, which serializes acceptance
        // against cancellation, disputes against timeout settlement, and lets
        // private circuits prove any threshold from a historical block with a
        // single read. An observer learns only that SOME order advanced.
        // Dispute RESOLUTION content stays off-chain (the app's private
        // messages, AD-6); rulings are one bounded flag (see resolve_dispute).
        order_states: Map<Field, PublicMutable<u8, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        superadmin: AztecAddress,
        owner_username_hash: Field,
        deployment_nonce: Field,
        config: MarketConfig,
        metadata_data: [Field; 128],
        metadata_len: u32,
    ) {
        // Account model: the owner's per-market ACCOUNT address is the
        // superadmin, passed in (the deployer may be a different account, so
        // the market need not be linked to whoever paid to deploy it). It is a
        // single-market, non-L1-linked account, so revealing it here is safe.
        assert(!superadmin.is_zero(), "superadmin must not be zero");
        assert(owner_username_hash != 0, "owner_username_hash must not be zero");
        assert(metadata_len > 0, "metadata must not be empty");
        assert(metadata_len <= BLOB_MAX_BYTES, "metadata exceeds the on-chain size cap");
        config.assert_valid();

        let config_commitment = poseidon2_hash(config.serialize());
        let marketplace_id =
            derive_marketplace_id(self.msg_sender(), deployment_nonce, config_commitment);

        self.storage.superadmin_identity.write(superadmin.to_field());
        // Register the owner's username as part of the DEPLOY itself, rather
        // than in a follow-up transaction. The owner's per-market account is
        // brand new and holds nothing, so it could not pay for a `register`
        // call of its own; doing it here means the deployer's wallet -- which
        // is already paying for this transaction -- covers it. Both user maps
        // are necessarily empty on a new market, so _register's uniqueness
        // asserts could not fail and are not repeated.
        self.storage.users_forward.at(owner_username_hash).write(superadmin.to_field());
        self.storage.users_reverse.at(superadmin.to_field()).write(owner_username_hash);
        self.storage.marketplace_id.initialize(marketplace_id);
        self.storage.config.write(config);

        self.storage.metadata_len.write(metadata_len);
        let num_fields = (metadata_len + BLOB_FIELD_BYTES - 1) / BLOB_FIELD_BYTES;
        for i in 0..BLOB_MAX_FIELDS {
            if i < num_fields {
                self.storage.metadata_data.at(i as Field).write(metadata_data[i]);
            }
        }
    }

    // ------------------------------------------------------------------
    // Superadmin-only configuration
    // ------------------------------------------------------------------

    // Account model: owner-only actions authenticate by the caller's ADDRESS
    // (self.msg_sender()). The enqueued (only_self) public part asserts it
    // equals the stored superadmin address. The owner acts from a per-market
    // account, so no wallet/L1-linked address ever appears.
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn update_config(new_config: MarketConfig, account: AztecAddress, authwit_nonce: Field) {
        self.enqueue_self._update_config(account.to_field(), new_config);
    }

    #[external("public")]
    #[only_self]
    fn _update_config(caller_identity: Field, new_config: MarketConfig) {
        assert(
            self.storage.superadmin_identity.read() == caller_identity,
            "caller is not the superadmin",
        );
        new_config.assert_valid();
        // The payment asset is IMMUTABLE: escrowed orders, vendor deposits,
        // and slash claims are all denominated in it, and settlement paths
        // read it from config rather than snapshotting it per order (the
        // order note's slot went to the finalization collateral instead).
        assert(
            new_config.payment_asset == self.storage.config.read().payment_asset,
            "the payment asset cannot change; funds in escrow are denominated in it",
        );
        self.storage.config.write(new_config);
    }

    // Replaces the sealed metadata blob. Chunks past the new length are
    // overwritten up to the OLD field count so stale data never survives.
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn set_metadata(metadata_data: [Field; 128], metadata_len: u32, account: AztecAddress, authwit_nonce: Field) {
        self.enqueue_self._set_metadata(account.to_field(), metadata_data, metadata_len);
    }

    #[external("public")]
    #[only_self]
    fn _set_metadata(caller_identity: Field, metadata_data: [Field; 128], metadata_len: u32) {
        assert(
            self.storage.superadmin_identity.read() == caller_identity,
            "caller is not the superadmin",
        );
        assert(metadata_len > 0, "metadata must not be empty");
        assert(metadata_len <= BLOB_MAX_BYTES, "metadata exceeds the on-chain size cap");

        let old_fields =
            (self.storage.metadata_len.read() + BLOB_FIELD_BYTES - 1) / BLOB_FIELD_BYTES;
        let new_fields = (metadata_len + BLOB_FIELD_BYTES - 1) / BLOB_FIELD_BYTES;
        self.storage.metadata_len.write(metadata_len);
        for i in 0..BLOB_MAX_FIELDS {
            if i < new_fields {
                self.storage.metadata_data.at(i as Field).write(metadata_data[i]);
            } else if i < old_fields {
                self.storage.metadata_data.at(i as Field).write(0);
            }
        }
    }

    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn transfer_superadmin(new_superadmin: AztecAddress, account: AztecAddress, authwit_nonce: Field) {
        self.enqueue_self._transfer_superadmin(
            account.to_field(),
            new_superadmin.to_field(),
        );
    }

    #[external("public")]
    #[only_self]
    fn _transfer_superadmin(caller_identity: Field, new_superadmin_identity: Field) {
        assert(
            self.storage.superadmin_identity.read() == caller_identity,
            "caller is not the superadmin",
        );
        assert(new_superadmin_identity != 0, "new superadmin_identity must not be zero");
        self.storage.superadmin_identity.write(new_superadmin_identity);
    }

    // ------------------------------------------------------------------
    // Moderator management (superadmin-only; moderators are keyed by the
    // moderator's per-market ACCOUNT ADDRESS). The superadmin, knowing a
    // moderator's plaintext username, resolves it to their address via
    // users_forward off-chain and passes that address here.
    // ------------------------------------------------------------------

    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn assign_moderator(moderator: AztecAddress, permissions: u64, account: AztecAddress, authwit_nonce: Field) {
        self.enqueue_self._assign_moderator(
            account.to_field(),
            moderator.to_field(),
            permissions,
        );
    }

    #[external("public")]
    #[only_self]
    fn _assign_moderator(caller_identity: Field, moderator_identity: Field, permissions: u64) {
        assert(
            self.storage.superadmin_identity.read() == caller_identity,
            "caller is not the superadmin",
        );
        assert(moderator_identity != 0, "moderator_identity must not be zero");
        assert(permissions != 0, "permissions must not be empty");
        assert((permissions & PERM_ALL) == permissions, "unknown permission bits");
        self.storage.moderators.at(moderator_identity).write(permissions);
    }

    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn remove_moderator(moderator: AztecAddress, account: AztecAddress, authwit_nonce: Field) {
        self.enqueue_self._remove_moderator(account.to_field(), moderator.to_field());
    }

    // ------------------------------------------------------------------
    // User registration (account model). A per-market account claims a
    // username; the plaintext is never stored -- the client commits it as
    // username_hash = hash(username, market_secret). Registration makes an
    // account addressable by handle (for "Sold by" verification and for the
    // owner to appoint mods by username) and is a prerequisite for becoming
    // a vendor. One username per account, one account per username.
    // ------------------------------------------------------------------

    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn register(username_hash: Field, account: AztecAddress, authwit_nonce: Field) {
        assert(username_hash != 0, "username_hash must not be zero");
        self.enqueue_self._register(account.to_field(), username_hash);
    }

    #[external("public")]
    #[only_self]
    fn _register(account: Field, username_hash: Field) {
        assert(
            self.storage.users_forward.at(username_hash).read() == 0,
            "username is already taken",
        );
        assert(
            self.storage.users_reverse.at(account).read() == 0,
            "this account already registered a username",
        );
        self.storage.users_forward.at(username_hash).write(account);
        self.storage.users_reverse.at(account).write(username_hash);
    }

    // ------------------------------------------------------------------
    // Contact addresses (AD-6): any per-market account (moderator, vendor,
    // superadmin) publishes the sealed SimpleX address the dispute flow
    // should reach them at. The entry is keyed by the caller's ACCOUNT
    // ADDRESS, so the write itself is the attestation that the address
    // belongs to that account. Overwriting rotates it.
    // ------------------------------------------------------------------

    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn set_contact_address(data: [Field; 32], len: u32, account: AztecAddress, authwit_nonce: Field) {
        self.enqueue_self._set_contact_address(account.to_field(), data, len);
    }

    // Chunks past the new length are overwritten up to the OLD field count
    // so stale data never survives a rotation (same shape as _set_metadata).
    #[external("public")]
    #[only_self]
    fn _set_contact_address(identity: Field, data: [Field; 32], len: u32) {
        assert(len > 0, "contact address must not be empty");
        assert(len <= CONTACT_MAX_BYTES, "contact address exceeds the on-chain size cap");
        // A sealed blob always has a nonzero first chunk (its leading bytes
        // are the blob's own length header + AEAD material).
        assert(data[0] != 0, "contact address blob must be sealed");
        let bucket = self.storage.buckets.at(derive_contact_address_tag(identity));
        let old_fields =
            ((bucket.at(0).read() as u32) + BLOB_FIELD_BYTES - 1) / BLOB_FIELD_BYTES;
        let new_fields = (len + BLOB_FIELD_BYTES - 1) / BLOB_FIELD_BYTES;
        bucket.at(0).write(len as Field);
        for i in 0..CONTACT_MAX_FIELDS {
            if i < new_fields {
                bucket.at((1 + i) as Field).write(data[i]);
            } else if i < old_fields {
                bucket.at((1 + i) as Field).write(0);
            }
        }
    }

    #[external("public")]
    #[only_self]
    fn _remove_moderator(caller_identity: Field, moderator_identity: Field) {
        assert(
            self.storage.superadmin_identity.read() == caller_identity,
            "caller is not the superadmin",
        );
        assert(
            self.storage.moderators.at(moderator_identity).read() != 0,
            "not a moderator",
        );
        self.storage.moderators.at(moderator_identity).write(0);
    }

    // ------------------------------------------------------------------
    // Vendor registration (AD-4). Account model: the vendor's per-market
    // ACCOUNT (msg_sender) is the vendor identity; double-registration is
    // serialized by the public "already registered" check (no nullifier).
    // The deposit, if any, is paid publicly from the per-market account
    // (fund it privately from the universal account first); the vendor
    // account is revealed by that public transfer, but it is single-market
    // and not L1-linked. Policy is re-checked against the live config in
    // public so a concurrent config change reverts rather than registering
    // under stale terms. A vendor must first have registered a username.
    // ------------------------------------------------------------------

    // Two authwits: `authwit_nonce` authorizes the DEPOSIT transfer out of
    // `deposit_payer`, `account_authwit_nonce` authorizes acting AS `account`.
    #[authorize_once("account", "account_authwit_nonce")]
    #[external("private")]
    fn register_vendor(
        deposit_asset: AztecAddress,
        deposit_amount: u128,
        deposit_payer: AztecAddress,
        authwit_nonce: Field,
        account: AztecAddress,
        account_authwit_nonce: Field,
    ) {
        let vendor_id = account.to_field();

        // The vendor IDENTITY is msg_sender (the per-market vendor account), but
        // the deposit is funded by `deposit_payer` (typically the universal
        // wallet) via an authwit -- so no per-market top-up hop is needed.
        if deposit_amount > 0 as u128 {
            self.call(Token::at(deposit_asset).transfer_private_to_public(
                deposit_payer,
                self.address,
                deposit_amount,
                authwit_nonce,
            ));
        }

        self.enqueue_self._complete_vendor_registration(vendor_id, deposit_asset, deposit_amount);
    }

    #[external("public")]
    #[only_self]
    fn _complete_vendor_registration(
        vendor_id: Field,
        deposit_asset: AztecAddress,
        deposit_amount: u128,
    ) {
        assert(
            self.storage.users_reverse.at(vendor_id).read() != 0,
            "register a username before becoming a vendor",
        );
        let config = self.storage.config.read();
        let requires_deposit = (config.vendor_policy == VENDOR_POLICY_DEPOSIT)
            | (config.vendor_policy == VENDOR_POLICY_BOTH);
        if requires_deposit {
            // Amount first: "no deposit at all" then reports the missing
            // deposit, not a zero-address asset.
            assert(
                deposit_amount == config.vendor_deposit,
                "deposit does not match the configured vendor_deposit",
            );
            assert(
                deposit_asset.eq(config.payment_asset),
                "deposit must be in the configured payment asset",
            );
        } else {
            assert(deposit_amount == 0 as u128, "this market's policy takes no deposit");
        }

        // Account model: the vendor_id is the caller's per-market account, so
        // this public check is what serializes double-registration (there is
        // no registration nullifier) and keeps the record write idempotent.
        assert(
            self.storage.vendors.at(vendor_id).read().status == VENDOR_STATUS_NONE,
            "vendor is already registered",
        );

        let needs_approval = (config.vendor_policy == VENDOR_POLICY_APPROVAL)
            | (config.vendor_policy == VENDOR_POLICY_BOTH);
        let status = if needs_approval { VENDOR_STATUS_PENDING } else { VENDOR_STATUS_ACTIVE };

        let stored_asset = if deposit_amount > 0 as u128 {
            deposit_asset
        } else {
            AztecAddress::zero()
        };
        self.storage.vendors.at(vendor_id).write(VendorRecord {
            status,
            deposit: deposit_amount,
            deposit_asset: stored_asset,
            withdrawal_requested_at: 0,
            active_orders: 0,
        });

        let index = self.storage.vendor_count.read();
        self.storage.vendor_ids.at(index as Field).write(vendor_id);
        self.storage.vendor_count.write(index + 1);
    }

    // Superadmin path for approving (PENDING -> ACTIVE), suspending, and
    // reinstating vendors. Moderators use the private entry below.
    // Vendor status change: the owner (treated as holding every permission,
    // AD-8) or a moderator with PERM_MANAGE_VENDORS. Private identity auth.
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn set_vendor_status(vendor: AztecAddress, status: u8, account: AztecAddress, authwit_nonce: Field) {
        self.enqueue_self._set_vendor_status_by_moderator(
            account.to_field(),
            vendor.to_field(),
            status,
        );
    }

    #[external("public")]
    #[only_self]
    fn _set_vendor_status_by_moderator(caller_identity: Field, vendor_id: Field, status: u8) {
        let sa = self.storage.superadmin_identity.read();
        let permissions = if caller_identity == sa {
            PERM_ALL
        } else {
            self.storage.moderators.at(caller_identity).read()
        };
        assert(
            (permissions & PERM_MANAGE_VENDORS) != 0,
            "caller lacks the manage-vendors permission",
        );
        let updated = apply_vendor_status_change(self.storage.vendors.at(vendor_id).read(), status);
        self.storage.vendors.at(vendor_id).write(updated);
    }

    // ------------------------------------------------------------------
    // Vendor deposits. Custodied in this contract's public balance of the
    // payment asset; only the withdrawal flow moves them out (AD-4, spec
    // sec.28). Withdrawal works regardless of vendor status so an admin can
    // never lock funds by suspending -- but it strips listing authorization
    // on deposit-requiring markets since the deposit drops to zero.
    // ------------------------------------------------------------------

    // Two authwits, as in register_vendor: one for the deposit transfer, one
    // to act as `account`.
    #[authorize_once("account", "account_authwit_nonce")]
    #[external("private")]
    fn top_up_deposit(
        deposit_asset: AztecAddress,
        amount: u128,
        deposit_payer: AztecAddress,
        authwit_nonce: Field,
        account: AztecAddress,
        account_authwit_nonce: Field,
    ) {
        assert(amount > 0 as u128, "top-up amount must be positive");

        // Funded by `deposit_payer` (typically the universal wallet), not
        // necessarily the vendor's per-market account. See register_vendor.
        self.call(Token::at(deposit_asset).transfer_private_to_public(
            deposit_payer,
            self.address,
            amount,
            authwit_nonce,
        ));

        self.enqueue_self._complete_top_up(account.to_field(), deposit_asset, amount);
    }

    #[external("public")]
    #[only_self]
    fn _complete_top_up(vendor_id: Field, deposit_asset: AztecAddress, amount: u128) {
        let mut record = self.storage.vendors.at(vendor_id).read();
        assert(record.status != VENDOR_STATUS_NONE, "vendor is not registered");
        if record.deposit > 0 as u128 {
            assert(
                deposit_asset.eq(record.deposit_asset),
                "top-up must use the asset the existing deposit is held in",
            );
        } else {
            let config = self.storage.config.read();
            assert(
                deposit_asset.eq(config.payment_asset),
                "deposit must be in the configured payment asset",
            );
            record.deposit_asset = deposit_asset;
        }
        record.deposit += amount;
        self.storage.vendors.at(vendor_id).write(record);
    }

    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn request_deposit_withdrawal(account: AztecAddress, authwit_nonce: Field) {
        self.enqueue_self._complete_withdrawal_request(account.to_field());
    }

    #[external("public")]
    #[only_self]
    fn _complete_withdrawal_request(vendor_id: Field) {
        let mut record = self.storage.vendors.at(vendor_id).read();
        assert(record.deposit > 0 as u128, "vendor has no deposit");
        record.withdrawal_requested_at = self.context.timestamp();
        self.storage.vendors.at(vendor_id).write(record);
    }

    // Pays the entire deposit back into a partial note prepared in private,
    // so the receiving account never becomes public.
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn execute_deposit_withdrawal(deposit_asset: AztecAddress, recipient: AztecAddress, account: AztecAddress, authwit_nonce: Field) {
        let vendor_id = account.to_field();

        // Prepare a commitment (partial note) `recipient` owns (typically the
        // universal wallet, so the deposit lands back where it was funded from);
        // the marketplace is the completer, so only its later public call can
        // fund it. This keeps the receiving account private (aztec-standards
        // commitment flow, replacing prepare/finalize_transfer_to_private).
        let commitment = self.call(
            Token::at(deposit_asset).initialize_transfer_commitment(recipient, self.address),
        );

        self.enqueue_self._finalize_deposit_withdrawal(vendor_id, deposit_asset, commitment);
    }

    #[external("public")]
    #[only_self]
    fn _finalize_deposit_withdrawal(
        vendor_id: Field,
        deposit_asset: AztecAddress,
        commitment: Field,
    ) {
        let mut record = self.storage.vendors.at(vendor_id).read();
        assert(record.deposit > 0 as u128, "vendor has no deposit");
        assert(
            deposit_asset.eq(record.deposit_asset),
            "withdrawal must use the asset the deposit is held in",
        );
        assert(record.withdrawal_requested_at > 0, "withdrawal was not requested");
        let config = self.storage.config.read();
        // The withdrawal delay is the order timeout: after it, any order the
        // vendor walked away from has become claimable/cancellable, so the
        // deposit no longer backs in-flight commitments. (Disputes are
        // off-chain and never touch deposits.)
        let unlock_at = record.withdrawal_requested_at + config.order_timeout;
        assert(self.context.timestamp() >= unlock_at, "withdrawal delay has not elapsed");
        // Reserved guard: `active_orders` is NOT currently maintained (orders
        // are fully private and cannot update a per-vendor public counter
        // without revealing which vendor sold), so this is presently always
        // true -- the time-lock above is what actually gates withdrawal. Kept
        // so the guard is already in place if per-vendor order accounting is
        // ever added.
        assert(record.active_orders == 0, "vendor has active orders");

        // Fund the vendor's commitment from the marketplace's public deposit
        // balance (self-authorized: from == this contract == msg_sender).
        Token::at(deposit_asset)
            .transfer_public_to_commitment(self.address, commitment, record.deposit, 0)
            .call(self.context);

        record.deposit = 0;
        record.deposit_asset = AztecAddress::zero();
        record.withdrawal_requested_at = 0;
        self.storage.vendors.at(vendor_id).write(record);
    }

    // ------------------------------------------------------------------
    // Listings (AD-4): created and edited only by authorized vendors through
    // private entries. Account model: the creator IS the caller's per-market
    // account address (msg_sender). Authorization against the live config
    // happens in the enqueued public part. Buyers verify a listing's
    // "Sold by: <username>" by recomputing hash(username, market_secret) from
    // the plaintext username in the Arweave doc and comparing it to
    // users_reverse[creator]. `expected_listing_id` pins the id the price
    // commitment was blinded with -- a concurrent creation reverts cleanly.
    // ------------------------------------------------------------------

    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn create_listing(
        expected_listing_id: u64,
        payload_pointer: [Field; 2],
        price_commitment: Field,
        category_tag: Field,
        account: AztecAddress, authwit_nonce: Field,
    ) {
        self.enqueue_self._create_listing_checked(
            account.to_field(),
            expected_listing_id,
            payload_pointer,
            price_commitment,
            category_tag,
        );
    }

    #[external("public")]
    #[only_self]
    fn _create_listing_checked(
        vendor_id: Field,
        expected_listing_id: u64,
        payload_pointer: [Field; 2],
        price_commitment: Field,
        category_tag: Field,
    ) {
        let config = self.storage.config.read();
        assert_vendor_may_list(self.storage.vendors.at(vendor_id).read(), config);
        assert(payload_pointer[0] != 0, "payload pointer must not be empty");
        assert(price_commitment != 0, "price_commitment must not be zero");

        // Ids are 1-based: the n-th listing ever created has id n.
        let id = self.storage.listing_count.read() + LISTING_FIRST_ID;
        assert(
            id == expected_listing_id,
            "listing id changed concurrently; re-derive the price commitment",
        );

        // APPROVAL markets hold new listings for moderation; OPEN markets go
        // live immediately.
        let initial_status = if config.listing_policy == LISTING_POLICY_APPROVAL {
            LISTING_STATUS_PENDING
        } else {
            LISTING_STATUS_ACTIVE
        };
        self.storage.listings.at(id as Field).write(ListingRecord {
            creator: vendor_id,
            status: initial_status,
            price_commitment,
            pointer_0: payload_pointer[0],
            pointer_1: payload_pointer[1],
            category_tag,
            // New listings go to the END of their category's chain, which is
            // the order every existing market already displays.
            next: 0,
        });
        self.storage.listing_count.write(id);

        // Link this listing onto the tail of its category's chain. The old tail
        // is the only record that has to change, so this stays O(1) however
        // large the category grows. Status (not the chain) decides visibility,
        // so a paused or removed listing keeps its place in the order.
        let cat_bucket = self.storage.buckets.at(category_tag);
        let cat_n = cat_bucket.at(CATEGORY_COUNT_KEY).read();
        let cat_tail = cat_bucket.at(CATEGORY_TAIL_KEY).read();
        if cat_tail == 0 {
            // First listing in this category: it is both head and tail.
            cat_bucket.at(CATEGORY_HEAD_KEY).write(id as Field);
        } else {
            let mut tail_record = self.storage.listings.at(cat_tail).read();
            tail_record.next = id as Field;
            self.storage.listings.at(cat_tail).write(tail_record);
        }
        cat_bucket.at(CATEGORY_TAIL_KEY).write(id as Field);
        cat_bucket.at(CATEGORY_COUNT_KEY).write(cat_n + 1);

        // And to its creator's bucket (same append-only rules; a listing's
        // creator never changes).
        let vendor_bucket = self.storage.buckets.at(derive_vendor_listings_tag(vendor_id));
        let vendor_n = vendor_bucket.at(0).read();
        vendor_bucket.at(vendor_n + 1).write(id as Field);
        vendor_bucket.at(0).write(vendor_n + 1);
    }

    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn update_listing_payload(
        listing_id: Field,
        payload_pointer: [Field; 2],
        price_commitment: Field,
        category_tag: Field,
        account: AztecAddress, authwit_nonce: Field,
    ) {
        self.enqueue_self._update_listing_checked(
            account.to_field(),
            listing_id,
            payload_pointer,
            price_commitment,
            category_tag,
        );
    }

    #[external("public")]
    #[only_self]
    fn _update_listing_checked(
        vendor_id: Field,
        listing_id: Field,
        payload_pointer: [Field; 2],
        price_commitment: Field,
        category_tag: Field,
    ) {
        let config = self.storage.config.read();
        assert_vendor_may_list(self.storage.vendors.at(vendor_id).read(), config);
        assert(payload_pointer[0] != 0, "payload pointer must not be empty");
        assert(price_commitment != 0, "price_commitment must not be zero");

        let mut record = self.storage.listings.at(listing_id).read();
        assert(record.creator == vendor_id, "listing belongs to a different vendor");
        assert(
            (record.status == LISTING_STATUS_ACTIVE)
                | (record.status == LISTING_STATUS_PAUSED)
                | (record.status == LISTING_STATUS_PENDING),
            "listing is not editable",
        );
        // Category is fixed at creation so the per-category index stays clean
        // (each listing appears once, in one bucket). To recategorize, remove
        // and recreate.
        assert(
            category_tag == record.category_tag,
            "a listing's category cannot change; remove and recreate it",
        );

        record.price_commitment = price_commitment;
        record.pointer_0 = payload_pointer[0];
        record.pointer_1 = payload_pointer[1];
        // On APPROVAL markets, any content/price edit returns the listing to
        // moderation -- otherwise an approved listing could be swapped for
        // different (off-chain) content. It disappears from buyers until
        // re-approved.
        if config.listing_policy == LISTING_POLICY_APPROVAL {
            record.status = LISTING_STATUS_PENDING;
        }
        self.storage.listings.at(listing_id).write(record);
    }

    // Vendors manage their own listings between ACTIVE and PAUSED, or remove
    // them permanently. A REMOVED listing (by vendor or moderation) is not
    // vendor-revivable; only the moderation path below can restore it.
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn set_listing_status_as_vendor(listing_id: Field, status: u8, account: AztecAddress, authwit_nonce: Field) {
        self.enqueue_self._set_listing_status_by_vendor(
            account.to_field(),
            listing_id,
            status,
        );
    }

    #[external("public")]
    #[only_self]
    fn _set_listing_status_by_vendor(vendor_id: Field, listing_id: Field, status: u8) {
        assert(
            (status == LISTING_STATUS_ACTIVE)
                | (status == LISTING_STATUS_PAUSED)
                | (status == LISTING_STATUS_REMOVED),
            "invalid listing status",
        );
        let mut record = self.storage.listings.at(listing_id).read();
        assert(record.creator == vendor_id, "listing belongs to a different vendor");
        // A PENDING listing may only be WITHDRAWN by its vendor (-> REMOVED);
        // it can never be self-activated (that is the moderator's job).
        let editable = (record.status == LISTING_STATUS_ACTIVE)
            | (record.status == LISTING_STATUS_PAUSED)
            | ((record.status == LISTING_STATUS_PENDING) & (status == LISTING_STATUS_REMOVED));
        assert(editable, "listing is not editable");
        record.status = status;
        self.storage.listings.at(listing_id).write(record);
    }

    // Listing moderation: the owner (all permissions, AD-8) or a moderator with
    // PERM_MODERATE_LISTINGS, both through the one private identity-checked path.
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn set_listing_status(listing_id: Field, status: u8, account: AztecAddress, authwit_nonce: Field) {
        self.enqueue_self._set_listing_status_by_moderator(
            account.to_field(),
            listing_id,
            status,
        );
    }

    #[external("public")]
    #[only_self]
    fn _set_listing_status_by_moderator(caller_identity: Field, listing_id: Field, status: u8) {
        let sa = self.storage.superadmin_identity.read();
        let permissions = if caller_identity == sa {
            PERM_ALL
        } else {
            self.storage.moderators.at(caller_identity).read()
        };
        assert(
            (permissions & PERM_MODERATE_LISTINGS) != 0,
            "caller lacks the moderate-listings permission",
        );
        let updated =
            apply_listing_status_change(self.storage.listings.at(listing_id).read(), status);
        self.storage.listings.at(listing_id).write(updated);
    }

    // Reorders a listing WITHIN ITS CATEGORY -- the owner's merchandising lever
    // (promote to the top, bury, or slot it next to a particular listing).
    //
    // The caller supplies BOTH neighbours, walked client-side from the category
    // head, and the contract verifies them. That is what keeps a move O(1):
    // searching the chain inside the transaction would cost an unbounded number
    // of storage reads, and a caller who lies about a neighbour simply fails the
    // assert rather than corrupting the order. `current_prev == 0` means the
    // listing is currently at the head; `new_prev == 0` means move it there.
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn move_listing(
        listing_id: Field,
        current_prev: Field,
        new_prev: Field,
        account: AztecAddress,
        authwit_nonce: Field,
    ) {
        self.enqueue_self._move_listing_checked(
            account.to_field(),
            listing_id,
            current_prev,
            new_prev,
        );
    }

    #[external("public")]
    #[only_self]
    fn _move_listing_checked(
        caller_identity: Field,
        listing_id: Field,
        current_prev: Field,
        new_prev: Field,
    ) {
        let sa = self.storage.superadmin_identity.read();
        let permissions = if caller_identity == sa {
            PERM_ALL
        } else {
            self.storage.moderators.at(caller_identity).read()
        };
        assert(
            (permissions & PERM_MODERATE_LISTINGS) != 0,
            "caller lacks the moderate-listings permission",
        );
        assert(listing_id != 0, "listing id must not be zero");
        assert(new_prev != listing_id, "cannot move a listing after itself");

        let mut record = self.storage.listings.at(listing_id).read();
        assert(record.status != LISTING_STATUS_NONE, "listing does not exist");

        // A move to where it already is is a no-op. Skipping it also guarantees
        // current_prev and new_prev name DIFFERENT records below, so the relink
        // cannot read a copy of the record the unlink just wrote.
        if current_prev != new_prev {
            let tag = record.category_tag;
            let bucket = self.storage.buckets.at(tag);

            // Unlink, proving the claimed predecessor really precedes it.
            if current_prev == 0 {
                assert(
                    bucket.at(CATEGORY_HEAD_KEY).read() == listing_id,
                    "listing is not at the head of its category",
                );
                bucket.at(CATEGORY_HEAD_KEY).write(record.next);
            } else {
                let mut prev_record = self.storage.listings.at(current_prev).read();
                assert(
                    prev_record.next == listing_id,
                    "current_prev does not precede the listing",
                );
                prev_record.next = record.next;
                self.storage.listings.at(current_prev).write(prev_record);
            }
            if bucket.at(CATEGORY_TAIL_KEY).read() == listing_id {
                bucket.at(CATEGORY_TAIL_KEY).write(current_prev);
            }

            // Relink. Every read here happens AFTER the unlink writes above --
            // reading the target first would let a stale `next` resurrect the
            // old position and silently drop the listing out of the chain.
            if new_prev == 0 {
                record.next = bucket.at(CATEGORY_HEAD_KEY).read();
                bucket.at(CATEGORY_HEAD_KEY).write(listing_id);
            } else {
                let mut target = self.storage.listings.at(new_prev).read();
                assert(target.status != LISTING_STATUS_NONE, "new_prev listing does not exist");
                assert(
                    target.category_tag == tag,
                    "cannot move a listing into a different category",
                );
                record.next = target.next;
                target.next = listing_id;
                self.storage.listings.at(new_prev).write(target);
                if bucket.at(CATEGORY_TAIL_KEY).read() == new_prev {
                    bucket.at(CATEGORY_TAIL_KEY).write(listing_id);
                }
            }
            self.storage.listings.at(listing_id).write(record);
        }
    }

    // ------------------------------------------------------------------
    // Orders (AD-5). place_order is FULLY private: listing and config
    // values are proven against the anchor block header instead of being
    // read in a public call, and the order itself exists only as encrypted
    // notes. An outside observer of a purchase sees nothing attributable at
    // all.
    //
    // THIS CONTRACT NEVER HOLDS ORDER FUNDS. Each order's money sits at its
    // own OrderEscrow instance -- an address the buyer derives and funds in
    // the same transaction, which nobody ever deploys. What is recorded here
    // is the ORDER, and this contract's job in settlement is to decide, in
    // public where transactions serialize, which terminal state an order
    // reaches; the escrow only follows that decision. See order_note.nr for
    // how the parties derive the address, and order-escrow/src/main.nr for
    // why the split is forced rather than chosen.
    // ------------------------------------------------------------------

    #[external("private")]
    fn place_order(
        access_secret: Field,
        listing_id: u64,
        // The listing's full price table, proven against the on-chain
        // commitment below, plus which row of each list the buyer chose.
        option_prices: [Field; MAX_PRICE_OPTIONS],
        option_count: u32,
        shipping_prices: [Field; MAX_SHIPPING_OPTIONS],
        shipping_count: u32,
        option_index: u32,
        shipping_index: u32,
        quantity: u32,
        vendor_inbox: AztecAddress,
        order_nonce: Field,
        memo: [Field; 6],
        escrow_secret: Field,
        buyer_auth: Field,
        // This order's escrow. Supplied rather than derived because a circuit
        // cannot compute a contract address; the `open` call below is what
        // forces it to be the right one.
        escrow_address: AztecAddress,
        // The account funding the escrow, which must authorize the pull.
        payer: AztecAddress,
        authwit_nonce: Field,
    ) -> Field {
        assert(access_secret != 0, "access_secret must not be zero");
        assert(quantity >= 1, "quantity must be at least 1");
        assert(escrow_secret != 0, "escrow_secret must not be zero");
        assert(buyer_auth != 0, "buyer_auth must not be zero");
        // `vendor_inbox` is supplied by the buyer from the sealed listing
        // document and is intentionally NOT bound on-chain to the listing's
        // creator -- doing so would need a public read and leak the purchase.
        // The buyer escrows their own funds, so a wrong inbox only hurts the
        // buyer; the sold-by / inbox link is verified off-chain.
        assert(!vendor_inbox.is_zero(), "vendor_inbox must not be zero");
        assert(!escrow_address.is_zero(), "escrow_address must not be zero");
        assert(!payer.is_zero(), "payer must not be zero");

        // Prove the listing's current state against the anchor block header
        // -- a fresh historical block every private read request is checked
        // against, with no public execution and therefore no leak.
        let header = self.context.get_anchor_block_header();
        let listing_slot = self.storage.listings.at(listing_id as Field).get_storage_slot();
        // ListingRecord packs as {creator, status, price_commitment, pointer_0,
        // pointer_1} (keep in sync with listing_record.nr).
        let status = public_storage_historical_read(header, listing_slot + 1, self.address);
        assert(status == LISTING_STATUS_ACTIVE as Field, "listing is not active");
        let commitment = public_storage_historical_read(header, listing_slot + 2, self.address);

        // The buyer knows the market link, so they can recompute the price
        // blinding and prove -- in-circuit, revealing nothing -- that the
        // prices they are about to pay are the listing's own.
        //
        // The whole TABLE is proven, not one price: a listing prices variants
        // and shipping methods independently, and the on-chain commitment binds
        // all of them at once. The buyer supplies the table and their two
        // choices; the amount is then computed HERE, from the proven table, so
        // it is never taken on the buyer's word.
        let blinding = derive_price_blinding(access_secret, listing_id as Field);
        assert(
            derive_price_commitment(
                option_prices,
                option_count,
                shipping_prices,
                shipping_count,
                blinding,
            )
                == commitment,
            "prices do not open the listing's price commitment",
        );

        // Unused table slots are committed as ZEROS, so an out-of-range index
        // would price the order at nothing. These two asserts are the only
        // thing standing between the listing and being bought for free.
        assert(option_index < option_count, "option is not offered by this listing");
        assert(shipping_index < shipping_count, "shipping method is not offered by this listing");
        let unit_price = option_prices[option_index] as u128;
        let shipping_price = shipping_prices[shipping_index] as u128;

        // Snapshot the config terms the same way. They are baked into the
        // order note; later config changes cannot rewrite a placed order.
        let config_slot = self.storage.config.get_storage_slot();
        // MarketConfig packs as {payment_asset, fee_bps, vendor_policy,
        // vendor_deposit, order_timeout, finalization_collateral,
        // listing_policy} (keep in sync with market_config.nr).
        let payment_asset = AztecAddress::from_field(public_storage_historical_read(
            header,
            config_slot,
            self.address,
        ));
        let fee_bps = public_storage_historical_read(header, config_slot + 1, self.address);
        let order_timeout = public_storage_historical_read(header, config_slot + 4, self.address);
        let collateral_raw =
            public_storage_historical_read(header, config_slot + 5, self.address);
        let collateral = collateral_raw as u128;

        // Shipping is charged ONCE per order; only the item scales with
        // quantity.
        let amount = unit_price * (quantity as u128) + shipping_price;
        let fee = (amount * (fee_bps as u128)) / 10000;
        // Header timestamps only move forward, so "recent block time +
        // timeout" is a sound (slightly conservative) deadline.
        let timeout_at = header.timestamp() + (order_timeout as u64);

        let buyer = self.msg_sender();
        let marketplace_id = self.storage.marketplace_id.read();
        let order_id = derive_order_id(marketplace_id, listing_id as Field, buyer, order_nonce);

        // PROOF OF PAYMENT. An order note must not be creatable without the money
        // behind it, and this contract cannot check that by looking: an escrow's
        // address is a hash of its class, its keys and its initializer
        // arguments, none of which a circuit can compute. So instead of checking
        // the escrow, this OPENS it.
        //
        // The terms are built HERE, from values this function derived itself,
        // and then `open` is called on the address the buyer supplied. The
        // private kernel only admits that call if the address really is the one
        // those terms produce, so a buyer who names any other address -- their
        // own, a friend's, an escrow for a cheaper order -- fails the call
        // rather than getting a free order note. The binding is the kernel's
        // address rule, not a check we wrote.
        //
        // The treasury is the owner (the superadmin IS the fee recipient), read
        // from the same anchor block as the config.
        let treasury = AztecAddress::from_field(public_storage_historical_read(
            header,
            self.storage.superadmin_identity.get_storage_slot(),
            self.address,
        ));
        let terms = EscrowTerms {
            asset: payment_asset,
            marketplace: self.address,
            // Taken from our own storage rather than an argument: the escrow
            // reads this slot on THIS contract, so only we can say where it is.
            order_states_slot: self.storage.order_states.get_storage_slot(),
            order_id,
            vendor: vendor_inbox,
            treasury,
            amount,
            fee,
            collateral,
            buyer_auth,
        };
        self.call(OrderEscrow::at(escrow_address).open(terms));

        // ...and only now move the money, into that same proven address. The
        // payer is whichever account holds the buyer's cUSDC (typically their
        // L1-facing universal account) and authorizes this pull with an authwit;
        // the ORDER stays owned by msg_sender, so the payer is never revealed to
        // the vendor. Nothing pools here: the funds land in the escrow, which
        // this contract cannot spend.
        self.call(Token::at(payment_asset).transfer_private_to_private(
            payer,
            escrow_address,
            amount + collateral,
            authwit_nonce,
        ));

        let note = OrderNote {
            order_id,
            listing_id: listing_id as Field,
            collateral,
            amount,
            fee,
            vendor_inbox,
            timeout_at,
            selection: pack_selection(option_index, shipping_index),
        };
        // Both copies are identical and carry NO buyer address. The buyer still
        // receives their receipt copy (delivered to `buyer` = msg_sender here),
        // but the vendor's copy reveals nothing about who bought.
        self.storage.orders.at(vendor_inbox).insert(note).deliver(
            MessageDelivery::onchain_constrained(),
        );
        self.storage.orders.at(buyer).insert(note).deliver(MessageDelivery::onchain_constrained());

        // The escrow keys, to both parties. The vendor needs them to settle the
        // order (they already know it is PAID -- the escrow was opened and
        // funded above, in this transaction); the buyer needs them to recover
        // the order on another device.
        let escrow_note = OrderEscrowNote { order_id, escrow_secret, buyer_auth };
        self.storage.order_escrows.at(vendor_inbox).insert(escrow_note).deliver(
            MessageDelivery::onchain_constrained(),
        );
        self.storage.order_escrows.at(buyer).insert(escrow_note).deliver(
            MessageDelivery::onchain_constrained(),
        );

        self.storage.order_memos.at(vendor_inbox).insert(OrderMemoNote { order_id, data: memo })
            .deliver(MessageDelivery::onchain_constrained());

        order_id
    }

    // The vendor commits to fulfilling. This is the only order step with a
    // public component: an anonymous flag keyed by the opaque order_id,
    // needed so cancellation can be serialized against it (and so the
    // timeout claim can later prove acceptance happened). An observer
    // learns only "an order on this market was accepted".
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn accept_order(order_id: Field, account: AztecAddress, authwit_nonce: Field) {
        let vendor_inbox = account;
        let note = get_order_note(self.storage.orders, vendor_inbox, order_id);
        assert(note.vendor_inbox == vendor_inbox, "caller is not this order's vendor");

        // Acceptance is the public ACCEPTED state below; the buyer reads it via
        // is_order_accepted. No per-buyer note is sent (that would need the
        // buyer's address).
        self.enqueue_self._mark_accepted(order_id);
    }

    #[external("public")]
    #[only_self]
    fn _mark_accepted(order_id: Field) {
        assert(
            self.storage.order_states.at(order_id).read() == ORDER_STATE_NONE,
            "order was already accepted",
        );
        self.storage.order_states.at(order_id).write(ORDER_STATE_ACCEPTED);
    }

    // The buyer disputes an ACCEPTED order: an anonymous public flag keyed by
    // the opaque order_id (an observer learns only "some order was disputed").
    // While set, the vendor's timeout settlement is blocked, so the order can
    // only end by the buyer confirming or the vendor refunding -- the flag is
    // what makes the off-chain arbitration binding. One dispute per order.
    //
    // `dispute_commitment` (AD-6) is poseidon2([dispute_secret,
    // DOMAIN_DISPUTE_COMMITMENT]) for a random secret the buyer keeps. It is
    // stored publicly alongside the flag. Because ONLY the buyer can reach this
    // function (it spends their order note), later revealing `dispute_secret`
    // in the off-chain dispute room and matching this commitment proves the
    // anonymous room participant is the buyer -- with one hash, no ZK proof,
    // and without revealing the buyer's address.
    #[external("private")]
    fn dispute_order(order_id: Field, dispute_commitment: Field) {
        assert(dispute_commitment != 0, "dispute_commitment must not be zero");
        let caller = self.msg_sender();
        let note = get_order_note(self.storage.orders, caller, order_id);
        // Only the buyer and the vendor hold a copy of this order's note, so
        // "not the vendor" identifies the buyer without any stored buyer field.
        assert(caller != note.vendor_inbox, "caller is not this order's buyer");

        // The vendor learns of the dispute from the public DISPUTED state
        // (is_order_disputed); no per-buyer note is sent.
        self.enqueue_self._mark_disputed(order_id, dispute_commitment);
    }

    #[external("public")]
    #[only_self]
    fn _mark_disputed(order_id: Field, dispute_commitment: Field) {
        // Only accepted orders are disputable: before acceptance the buyer
        // can simply cancel for a full refund.
        let state = self.storage.order_states.at(order_id).read();
        assert(
            state != ORDER_STATE_NONE,
            "order is not accepted; cancel it instead of disputing",
        );
        assert(state == ORDER_STATE_ACCEPTED, "order is already disputed");
        self.storage.order_states.at(order_id).write(ORDER_STATE_DISPUTED);
        // Publish the buyer's authentication commitment (bucket key 0). Stored
        // once, at the single DISPUTED transition; the monotonic state word
        // above guarantees this runs exactly once per order.
        self.storage.buckets.at(derive_dispute_auth_tag(order_id)).at(0).write(dispute_commitment);
    }

    // Bounded arbitration: a moderator holding PERM_RESOLVE_DISPUTES (or the
    // superadmin) rules a DISPUTED order toward one of the two legitimate
    // outcomes. The ruling is one anonymous public flag -- the arbiter never
    // touches funds, cannot target undisputed orders, and learns nothing (the
    // order id came from the dispute room). Execution stays with the winning
    // party: claim_refund for the buyer, the (immediately unblocked)
    // timeout claim for the vendor. Write-once; the voluntary paths (buyer
    // confirm, vendor refund) stay open and moot the ruling via the
    // settlement nullifier.
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn resolve_dispute(order_id: Field, outcome: u8, account: AztecAddress, authwit_nonce: Field) {
        self.enqueue_self._resolve_dispute(account.to_field(), order_id, outcome);
    }

    #[external("public")]
    #[only_self]
    fn _resolve_dispute(caller_identity: Field, order_id: Field, outcome: u8) {
        let sa = self.storage.superadmin_identity.read();
        let permissions = if caller_identity == sa {
            PERM_ALL
        } else {
            self.storage.moderators.at(caller_identity).read()
        };
        assert(
            (permissions & PERM_RESOLVE_DISPUTES) != 0,
            "caller lacks the resolve-disputes permission",
        );
        assert(
            (outcome == DISPUTE_OUTCOME_REFUND_BUYER) | (outcome == DISPUTE_OUTCOME_PAY_VENDOR),
            "invalid dispute outcome",
        );
        let state = self.storage.order_states.at(order_id).read();
        assert(
            (state != ORDER_STATE_RULED_REFUND_BUYER) & (state != ORDER_STATE_RULED_PAY_VENDOR),
            "dispute is already ruled",
        );
        assert(state == ORDER_STATE_DISPUTED, "order is not disputed");
        let ruled = if outcome == DISPUTE_OUTCOME_REFUND_BUYER {
            ORDER_STATE_RULED_REFUND_BUYER
        } else {
            ORDER_STATE_RULED_PAY_VENDOR
        };
        self.storage.order_states.at(order_id).write(ruled);
    }

    // NOTE: there is no `claim_refund` here. REFUND_BUYER is already terminal,
    // so it authorizes the escrow's own `claim_refund` directly and the buyer
    // pulls from the escrow without touching this contract again.

    // The vendor's dispute escape valve (and goodwill refund): AUTHORIZES a
    // full refund -- amount plus the buyer's finalization collateral -- which
    // the buyer then pulls themselves (claim_refund). Pull, not push: the
    // vendor never learns the buyer's address, so it cannot send funds
    // directly. It sets the very same REFUND_BUYER state an arbiter's refund
    // ruling does, and thereafter the vendor can no longer timeout-settle.
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn refund_order(order_id: Field, account: AztecAddress, authwit_nonce: Field) {
        let vendor_inbox = account;
        let note = get_order_note(self.storage.orders, vendor_inbox, order_id);
        assert(note.vendor_inbox == vendor_inbox, "caller is not this order's vendor");

        self.enqueue_self._offer_refund(order_id);
    }

    #[external("public")]
    #[only_self]
    fn _offer_refund(order_id: Field) {
        // Offerable from an accepted (goodwill) or disputed (conceding) order,
        // never once already ruled/refunded/settled. The monotonic state word
        // excludes NONE and the ruled states, so this runs at most once.
        let state = self.storage.order_states.at(order_id).read();
        assert(
            (state == ORDER_STATE_ACCEPTED) | (state == ORDER_STATE_DISPUTED),
            "order cannot be refunded in its current state",
        );
        self.storage.order_states.at(order_id).write(ORDER_STATE_RULED_REFUND_BUYER);
    }

    // Buyer walks away before the vendor commits. This AUTHORIZES the refund
    // by moving the order to CANCELLED; the buyer then pulls the escrow
    // themselves (OrderEscrow::claim_refund).
    //
    // The authorization has to happen here rather than in the escrow because
    // it is a race: the enqueued public assert guarantees the order was NOT
    // accepted, so if the vendor's acceptance landed first this whole
    // transaction reverts. The escrow can only read a historical block, where
    // a stale "not yet accepted" would let a buyer refund an order the vendor
    // has already started shipping.
    #[external("private")]
    fn cancel_order(order_id: Field) {
        let caller = self.msg_sender();
        let note = get_order_note(self.storage.orders, caller, order_id);
        assert(caller != note.vendor_inbox, "caller is not this order's buyer");

        // One terminal settlement per order, ever: the protocol enforces
        // global nullifier uniqueness.
        self.context.push_nullifier_unsafe(derive_order_settlement_nullifier(order_id));

        self.enqueue_self._cancel(order_id);
    }

    #[external("public")]
    #[only_self]
    fn _cancel(order_id: Field) {
        assert(
            self.storage.order_states.at(order_id).read() == ORDER_STATE_NONE,
            "order was already accepted; resolve it with the vendor instead of cancelling",
        );
        self.storage.order_states.at(order_id).write(ORDER_STATE_CANCELLED);
    }

    // Buyer confirms receipt AND leaves feedback (a sealed rating+statement
    // blob, mandatory -- the finalization collateral exists to make paying
    // this transaction's fee worthwhile). This moves the order to COMPLETED,
    // which authorizes the escrow's `release`: the vendor gets paid, the
    // marketplace fee is split off, and the collateral returns to the buyer.
    // The appended feedback is opaque ciphertext, so an observer learns only
    // that SOME order of this listing completed.
    //
    // The buyer normally sends this and `OrderEscrow::release` in one
    // transaction -- the escrow reads COMPLETED from a historical block, so
    // the release lands in a LATER block regardless. Leaving them apart is
    // harmless: nobody but the buyer can release, and COMPLETED is terminal.
    #[external("private")]
    fn confirm_completion(order_id: Field, feedback: [Field; 12]) {
        let caller = self.msg_sender();
        let note = get_order_note(self.storage.orders, caller, order_id);
        assert(caller != note.vendor_inbox, "caller is not this order's buyer");
        // A sealed feedback blob always has a nonzero first chunk (its
        // leading bytes are the blob's own length header + AEAD material).
        assert(feedback[0] != 0, "feedback is required to finalize an order");

        self.context.push_nullifier_unsafe(derive_order_settlement_nullifier(order_id));

        self.enqueue_self._complete(order_id, note.listing_id, feedback);
    }

    #[external("public")]
    #[only_self]
    fn _complete(order_id: Field, listing_id: Field, feedback: [Field; 12]) {
        // A disputed order cannot be quietly finalized around the dispute;
        // it has to be resolved (or the vendor has to concede a refund).
        let state = self.storage.order_states.at(order_id).read();
        assert(
            (state == ORDER_STATE_NONE) | (state == ORDER_STATE_ACCEPTED),
            "order cannot be completed in its current state",
        );
        self.storage.order_states.at(order_id).write(ORDER_STATE_COMPLETED);

        let data = feedback;
        assert(data[0] != 0, "feedback must not be empty");
        let bucket = self.storage.buckets.at(derive_feedback_tag(listing_id));
        let n = bucket.at(0).read();
        let base = 1 + n * (FEEDBACK_FIELDS as Field);
        for j in 0..FEEDBACK_FIELDS {
            bucket.at(base + j as Field).write(data[j]);
        }
        bucket.at(0).write(n + 1);
    }

    // The buyer went silent after the vendor accepted: once the snapshotted
    // timeout passes, the vendor can settle. Time and acceptance are both
    // proven from historical block data (timestamps and the accept flag are
    // monotonic), so this too is fully private.
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn claim_timeout_settlement(order_id: Field, account: AztecAddress, authwit_nonce: Field) {
        let vendor_inbox = account;
        let note = get_order_note(self.storage.orders, vendor_inbox, order_id);
        assert(note.vendor_inbox == vendor_inbox, "caller is not this order's vendor");

        let header = self.context.get_anchor_block_header();
        // ONE historical read serves both checks (the state is monotonic):
        // any state past NONE proves acceptance, and a PAY_VENDOR ruling
        // additionally waives the deadline -- the human arbitration already
        // took its time.
        let state_slot = self.storage.order_states.at(order_id).get_storage_slot();
        let state = public_storage_historical_read(header, state_slot, self.address);
        if state != ORDER_STATE_RULED_PAY_VENDOR as Field {
            assert(header.timestamp() >= note.timeout_at, "order timeout has not elapsed");
        }
        assert(state != 0, "order was never accepted; the buyer can cancel instead");

        self.context.push_nullifier_unsafe(derive_order_settlement_nullifier(order_id));

        // Serialized in public: if the buyer's dispute lands first, this whole
        // authorization reverts -- unless an arbiter ruled PAY_VENDOR, which
        // re-opens exactly this path. THIS is the check the escrow cannot make
        // for itself, which is why the escrow waits for SETTLED_VENDOR instead
        // of reading the timeout and the dispute flag directly.
        self.enqueue_self._settle_to_vendor(order_id);
    }

    #[external("public")]
    #[only_self]
    fn _settle_to_vendor(order_id: Field) {
        let state = self.storage.order_states.at(order_id).read();
        assert(
            (state == ORDER_STATE_ACCEPTED) | (state == ORDER_STATE_RULED_PAY_VENDOR),
            "order is disputed; resolve it with the buyer or await a ruling",
        );
        self.storage.order_states.at(order_id).write(ORDER_STATE_SETTLED_VENDOR);
    }

    // Non-terminal fulfillment updates (shipped, delivered): written to the
    // order's PUBLIC fulfillment word (buckets, key 0), keyed by the opaque
    // order id. The buyer reads it via get_order_fulfillment -- so this
    // vendor->buyer channel needs no buyer address. An observer sees only an
    // opaque order id advancing, exactly like the accepted/disputed states.
    #[authorize_once("account", "authwit_nonce")]
    #[external("private")]
    fn update_order_status(order_id: Field, status: u8, account: AztecAddress, authwit_nonce: Field) {
        assert(
            (status == ORDER_STATUS_SHIPPED) | (status == ORDER_STATUS_DELIVERED),
            "only shipped/delivered updates are sent this way",
        );
        let vendor_inbox = account;
        let note = get_order_note(self.storage.orders, vendor_inbox, order_id);
        assert(note.vendor_inbox == vendor_inbox, "caller is not this order's vendor");

        self.enqueue_self._set_fulfillment(order_id, status);
    }

    #[external("public")]
    #[only_self]
    fn _set_fulfillment(order_id: Field, status: u8) {
        // SHIPPED (2) then DELIVERED (3) are increasing, so the latest write is
        // the furthest-along status; the reader treats it as a threshold.
        self.storage.buckets.at(derive_order_fulfillment_tag(order_id)).at(0).write(status as Field);
    }

    // ------------------------------------------------------------------
    // Utility (node-side reads, no tx)
    // ------------------------------------------------------------------

    #[external("utility")]
    unconstrained fn get_marketplace_id() -> Field {
        self.storage.marketplace_id.read()
    }

    #[external("utility")]
    unconstrained fn get_superadmin_identity() -> Field {
        self.storage.superadmin_identity.read()
    }

    #[external("utility")]
    unconstrained fn get_metadata_len() -> u32 {
        self.storage.metadata_len.read()
    }

    #[external("utility")]
    unconstrained fn get_metadata_data() -> [Field; 128] {
        let mut out = [0; 128];
        for i in 0..BLOB_MAX_FIELDS {
            out[i] = self.storage.metadata_data.at(i as Field).read();
        }
        out
    }

    #[external("utility")]
    unconstrained fn get_config() -> MarketConfig {
        self.storage.config.read()
    }

    #[external("utility")]
    unconstrained fn get_moderator_permissions(moderator_identity: Field) -> u64 {
        self.storage.moderators.at(moderator_identity).read()
    }

    // Users (account model). Resolve a username_hash to the account that
    // claimed it (0 = unclaimed), or an account to the username_hash it
    // registered (0 = unregistered). Lets the owner appoint a mod by handle
    // and lets a buyer verify a listing's "Sold by: <username>".
    #[external("utility")]
    unconstrained fn get_user_address(username_hash: Field) -> Field {
        self.storage.users_forward.at(username_hash).read()
    }

    #[external("utility")]
    unconstrained fn get_username_hash(account: Field) -> Field {
        self.storage.users_reverse.at(account).read()
    }

    // The sealed contact-address blob an identity published, plus its byte
    // length. A zero length means the identity never published one.
    #[external("utility")]
    unconstrained fn get_contact_address(identity: Field) -> ([Field; 32], u32) {
        let bucket = self.storage.buckets.at(derive_contact_address_tag(identity));
        let len = bucket.at(0).read() as u32;
        let fields = (len + BLOB_FIELD_BYTES - 1) / BLOB_FIELD_BYTES;
        let mut out = [0; 32];
        for i in 0..CONTACT_MAX_FIELDS {
            if i < fields {
                out[i] = bucket.at((1 + i) as Field).read();
            }
        }
        (out, len)
    }

    #[external("utility")]
    unconstrained fn get_vendor(vendor_id: Field) -> VendorRecord {
        self.storage.vendors.at(vendor_id).read()
    }

    #[external("utility")]
    unconstrained fn get_vendor_count() -> u64 {
        self.storage.vendor_count.read()
    }

    #[external("utility")]
    unconstrained fn get_vendor_id_at(index: u64) -> Field {
        self.storage.vendor_ids.at(index as Field).read()
    }

    #[external("utility")]
    unconstrained fn get_listing_count() -> u64 {
        self.storage.listing_count.read()
    }

    #[external("utility")]
    unconstrained fn get_listing(listing_id: Field) -> ListingRecord {
        self.storage.listings.at(listing_id).read()
    }

    // Bulk record reads for the storefront index: fetch LISTING_PAGE records at
    // a time so a client can enumerate + category-filter thousands of listings
    // with O(count/page) cheap simulations (no off-chain fetch), then fetch the
    // Arweave content only for the page it displays. Ids are sequential, so
    // `page_index * LISTING_PAGE + i` is the id of the i-th record on the page;
    // the returned count is how many of the slots are real (the last page may
    // be short, and beyond listing_count records read as zeroed/None).
    #[external("utility")]
    unconstrained fn get_listings(page_index: u64) -> ([ListingRecord; 20], u32) {
        let total = self.storage.listing_count.read();
        let start = page_index * 20;
        let mut out = [std::mem::zeroed(); 20];
        let mut n: u32 = 0;
        for i in 0..20 {
            // Ids are 1-based, so the last valid id IS listing_count.
            let id = start + i as u64 + LISTING_FIRST_ID;
            if id <= total {
                out[i] = self.storage.listings.at(id as Field).read();
                n += 1;
            }
        }
        (out, n)
    }

    // How many entries a category bucket holds (append-only; includes listings
    // that were later paused/removed -- the record's status decides visibility).
    #[external("utility")]
    unconstrained fn get_category_count(category_tag: Field) -> u64 {
        self.storage.buckets.at(category_tag).at(0).read() as u64
    }

    // A page of one category's listings IN DISPLAY ORDER: the records, their
    // ids, and the cursor to continue from. Browsing a category touches only
    // that category's entries, never the whole market. The caller filters by
    // status (Active) and dedups.
    //
    // Paging is CURSOR-based, not index-based: the order is a chain, so there
    // is no way to jump to the n-th entry without walking the ones before it.
    // Pass 0 to start at the head and then feed each returned cursor back in;
    // a returned cursor of 0 means the category is exhausted. For the
    // sequential browsing the storefront actually does this is cheaper than
    // the old positional index -- every page costs one read per entry.
    #[external("utility")]
    unconstrained fn get_category_listings(
        category_tag: Field,
        cursor: Field,
    ) -> ([ListingRecord; 20], [Field; 20], Field, u32) {
        let bucket = self.storage.buckets.at(category_tag);
        let mut id = if cursor == 0 {
            bucket.at(CATEGORY_HEAD_KEY).read()
        } else {
            cursor
        };
        let mut records = [std::mem::zeroed(); 20];
        let mut ids = [0; 20];
        let mut n: u32 = 0;
        for i in 0..20 {
            if id != 0 {
                let record = self.storage.listings.at(id).read();
                ids[i] = id;
                records[i] = record;
                id = record.next;
                n += 1;
            }
        }
        // Whatever the walk stopped on is where the next page resumes.
        (records, ids, id, n)
    }

    // How many listings a vendor has created (all statuses; append-only).
    #[external("utility")]
    unconstrained fn get_vendor_listing_count(vendor_id: Field) -> u64 {
        self.storage.buckets.at(derive_vendor_listings_tag(vendor_id)).at(0).read() as u64
    }

    // A page of one vendor's listings: the records AND their ids, read via
    // the per-vendor index. Returns ALL statuses -- vendors manage their
    // paused/removed items and admins moderate them; public viewers filter to
    // Active client-side.
    #[external("utility")]
    unconstrained fn get_vendor_listings(
        vendor_id: Field,
        page_index: u64,
    ) -> ([ListingRecord; 20], [Field; 20], u32) {
        let bucket = self.storage.buckets.at(derive_vendor_listings_tag(vendor_id));
        let total = bucket.at(0).read() as u64;
        let start = page_index * 20;
        let mut records = [std::mem::zeroed(); 20];
        let mut ids = [0; 20];
        let mut n: u32 = 0;
        for i in 0..20 {
            let idx = start + i as u64;
            if idx < total {
                let id = bucket.at((idx as Field) + 1).read();
                ids[i] = id;
                records[i] = self.storage.listings.at(id).read();
                n += 1;
            }
        }
        (records, ids, n)
    }

    // How many feedback entries a listing has received (each backed by one
    // finalized order).
    #[external("utility")]
    unconstrained fn get_feedback_count(listing_id: Field) -> u64 {
        self.storage.buckets.at(derive_feedback_tag(listing_id)).at(0).read() as u64
    }

    // A page of a listing's sealed feedback blobs: 4 entries per page, 12
    // chunks each (flattened); the second element is how many of the page's
    // slots are real. Each blob carries its own byte length in its leading
    // two bytes; only link holders can decrypt the contents.
    #[external("utility")]
    unconstrained fn get_feedback_page(listing_id: Field, page_index: u64) -> ([Field; 48], u32) {
        let bucket = self.storage.buckets.at(derive_feedback_tag(listing_id));
        let total = bucket.at(0).read() as u64;
        let start = page_index * 4;
        let mut data = [0; 48];
        let mut n: u32 = 0;
        for i in 0..4 {
            let idx = start + i as u64;
            if idx < total {
                let base = 1 + (idx * (FEEDBACK_FIELDS as u64)) as Field;
                for j in 0..FEEDBACK_FIELDS {
                    data[i * 12 + j] = bucket.at(base + j as Field).read();
                }
                n += 1;
            }
        }
        (data, n)
    }

    // ------------------------------------------------------------------
    // Order utility reads. Notes are only visible to PXEs that own them, so
    // these return data for accounts the caller actually controls.
    // ------------------------------------------------------------------

    #[external("utility")]
    unconstrained fn get_orders(owner: AztecAddress, page_index: u32) -> ([OrderNote; 10], u32) {
        let options = NoteViewerOptions::new().set_limit(10).set_offset(page_index * 10);
        let notes = self.storage.orders.at(owner).view_notes(options);
        let mut out = [std::mem::zeroed(); 10];
        for i in 0..10 {
            if i < notes.len() {
                out[i] = notes.get_unchecked(i);
            }
        }
        (out, notes.len())
    }

    #[external("utility")]
    unconstrained fn get_order_memos(
        owner: AztecAddress,
        page_index: u32,
    ) -> ([OrderMemoNote; 10], u32) {
        let options = NoteViewerOptions::new().set_limit(10).set_offset(page_index * 10);
        let notes = self.storage.order_memos.at(owner).view_notes(options);
        let mut out = [std::mem::zeroed(); 10];
        for i in 0..10 {
            if i < notes.len() {
                out[i] = notes.get_unchecked(i);
            }
        }
        (out, notes.len())
    }

    /// The escrow keys for the caller's orders. Pairs with get_orders: the two
    /// notes together are what a party rebuilds the escrow address and its
    /// terms from.
    #[external("utility")]
    unconstrained fn get_order_escrows(
        owner: AztecAddress,
        page_index: u32,
    ) -> ([OrderEscrowNote; 10], u32) {
        let options = NoteViewerOptions::new().set_limit(10).set_offset(page_index * 10);
        let notes = self.storage.order_escrows.at(owner).view_notes(options);
        let mut out = [std::mem::zeroed(); 10];
        for i in 0..10 {
            if i < notes.len() {
                out[i] = notes.get_unchecked(i);
            }
        }
        (out, notes.len())
    }

    // The order's public fulfillment status (0 = none, else ORDER_STATUS_*
    // SHIPPED/DELIVERED), keyed by the opaque order id. Either party reads it
    // with just the order id; no buyer address is involved.
    #[external("utility")]
    unconstrained fn get_order_fulfillment(order_id: Field) -> u8 {
        self.storage.buckets.at(derive_order_fulfillment_tag(order_id)).at(0).read() as u8
    }

    /// True once any terminal settlement (confirm, cancel, timeout claim)
    /// happened for this order.
    #[external("utility")]
    unconstrained fn is_order_settled(order_id: Field) -> bool {
        check_nullifier_exists(derive_order_settlement_nullifier(order_id))
    }

    /// The raw lifecycle word (ORDER_STATE_*). The escrow reads exactly this
    /// slot from a historical block to decide whether it may pay out.
    #[external("utility")]
    unconstrained fn get_order_state(order_id: Field) -> u8 {
        self.storage.order_states.at(order_id).read()
    }

    /// The order is LIVE and the vendor has committed to it. Spelled out
    /// rather than "past NONE": the terminal states sit above the live ones
    /// numerically, and CANCELLED is reached from NONE without an acceptance
    /// ever happening.
    #[external("utility")]
    unconstrained fn is_order_accepted(order_id: Field) -> bool {
        let state = self.storage.order_states.at(order_id).read();
        (state == ORDER_STATE_ACCEPTED)
            | (state == ORDER_STATE_DISPUTED)
            | (state == ORDER_STATE_RULED_REFUND_BUYER)
            | (state == ORDER_STATE_RULED_PAY_VENDOR)
    }

    /// Read from the stored dispute commitment, not the lifecycle word: a
    /// terminal state overwrites the word, and "this order was disputed" has
    /// to survive the settlement that ended it.
    #[external("utility")]
    unconstrained fn is_order_disputed(order_id: Field) -> bool {
        self.storage.buckets.at(derive_dispute_auth_tag(order_id)).at(0).read() != 0
    }

    #[external("utility")]
    unconstrained fn get_dispute_outcome(order_id: Field) -> u8 {
        let state = self.storage.order_states.at(order_id).read();
        if state == ORDER_STATE_RULED_REFUND_BUYER {
            DISPUTE_OUTCOME_REFUND_BUYER
        } else if state == ORDER_STATE_RULED_PAY_VENDOR {
            DISPUTE_OUTCOME_PAY_VENDOR
        } else {
            0
        }
    }

    // The buyer's dispute authentication commitment for an order (AD-6), or 0
    // if the order was never disputed. A moderator recomputes
    // poseidon2([revealed_secret, DOMAIN_DISPUTE_COMMITMENT]) and matches it
    // against this to confirm -- automatically, offline -- that the party in
    // the dispute room is the genuine buyer.
    #[external("utility")]
    unconstrained fn get_dispute_commitment(order_id: Field) -> Field {
        self.storage.buckets.at(derive_dispute_auth_tag(order_id)).at(0).read()
    }

    // ------------------------------------------------------------------
    // Shared checks (public-context helpers)
    // ------------------------------------------------------------------

    // Fetches an order note from `owner`'s set by order id, proving its
    // existence in-circuit. Order notes are never nullified; the settlement
    // nullifier is what closes an order.
    #[contract_library_method]
    fn get_order_note(
        orders: Owned<PrivateSet<OrderNote, &mut PrivateContext>, &mut PrivateContext>,
        owner: AztecAddress,
        order_id: Field,
    ) -> OrderNote {
        let notes = orders.at(owner).get_notes(NoteGetterOptions::new()
            .select(OrderNote::properties().order_id, Comparator.EQ, order_id)
            .set_limit(1));
        assert(notes.len() == 1, "order note not found for this account");
        notes.get(0).note
    }

    // A vendor may create/edit listings while ACTIVE and, on deposit-requiring
    // markets, holding at least the currently configured deposit. Raising
    // vendor_deposit therefore de-authorizes under-deposited vendors until
    // they top up; withdrawing the deposit does the same.
    #[contract_library_method]
    fn assert_vendor_may_list(record: VendorRecord, config: MarketConfig) {
        assert(record.status == VENDOR_STATUS_ACTIVE, "vendor is not active");
        let requires_deposit = (config.vendor_policy == VENDOR_POLICY_DEPOSIT)
            | (config.vendor_policy == VENDOR_POLICY_BOTH);
        if requires_deposit {
            assert(
                record.deposit >= config.vendor_deposit,
                "vendor deposit is below the required amount",
            );
        }
    }

    // Admin/moderator vendor-status transitions: approve (PENDING -> ACTIVE),
    // suspend, reinstate. Registration state itself is never erased and
    // deposits are untouchable from here (spec sec.28).
    #[contract_library_method]
    fn apply_vendor_status_change(record: VendorRecord, status: u8) -> VendorRecord {
        assert(
            (status == VENDOR_STATUS_ACTIVE) | (status == VENDOR_STATUS_SUSPENDED),
            "invalid vendor status",
        );
        assert(record.status != VENDOR_STATUS_NONE, "vendor is not registered");
        let mut updated = record;
        updated.status = status;
        updated
    }

    // Moderation may set any of the three live statuses on any existing
    // listing: approve a PENDING one (-> ACTIVE), reject it (-> REMOVED),
    // pause/restore an ACTIVE one, or restore a REMOVED one after an appeal.
    #[contract_library_method]
    fn apply_listing_status_change(record: ListingRecord, status: u8) -> ListingRecord {
        assert(
            (status == LISTING_STATUS_ACTIVE)
                | (status == LISTING_STATUS_PAUSED)
                | (status == LISTING_STATUS_REMOVED),
            "invalid listing status",
        );
        assert(record.status != LISTING_STATUS_NONE, "listing does not exist");
        let mut updated = record;
        updated.status = status;
        updated
    }
}
