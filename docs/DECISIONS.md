# Architecture Decisions

Amendments to `Aztec Market Specification.md` and `PLAN.md`, decided after M2.
Where these conflict with the original spec, these win.

## AD-1: Purchase assets and network fee juice are strictly separate (2026-07-10)

**Decision.** The asset used to buy products (`payment_asset`) never pays for
network execution, and the protocol never assumes it can.

**Background.** On Aztec, transaction fees are paid in fee juice — a
non-transferable protocol asset bridged from L1. A token can only "cover gas"
indirectly, via a Fee Payment Contract (FPC) that accepts the token and spends
its own fee juice. The fee payer of every transaction is public, which makes
fee strategy a privacy decision, not just a UX one: paying from your own
account links all your transactions; paying via a shared FPC hides you in that
FPC's anonymity set but requires trusting/funding it.

**Rules.**
1. Contract invariant: escrow and settlement logic touch only
   `payment_asset`. No contract deducts fees-for-gas from escrowed funds.
2. Client invariant (fee gate): before any user action, the app verifies the
   user can pay for the transaction (own fee juice or a working FPC) and
   throws with a clear "you need fee juice" message. No silent fallbacks, no
   retries. (Implemented when buyer/vendor flows land in M4+; Creator flows
   currently use the sandbox SponsoredFPC explicitly.)
3. Fee strategy is pluggable and chosen by the user (`fee?: { paymentMethod }`
   threads through every pipeline call). Market metadata may *recommend* an
   FPC; the protocol never requires one.

## AD-2: Every market is hidden (2026-07-10)

**Decision.** There are no public markets, no visibility tiers, and no public
directory. A market is reachable only through its **access secret** — a random
field element (~254 bits) generated at deployment, shared out-of-band as the
market link (`portal/#/m/<secret>`), analogous to an onion address. The
on-chain `MarketConfig` intentionally remains public (accepted trade-off:
config values are visible but unlabeled and unlinkable to any market
identity).

**Construction.**
- `lookup_key = poseidon2(access_secret, DOMAIN_MARKET_LOOKUP=6)` — the
  registry map key. The registry stores `lookup_key -> { owner,
  contract_address, metadata_commitment, status }`; there is no `listed` flag.
- `enc_key = sha256("aztec-market/metadata-enc/v1" || secret_be32)` — an
  AES-256-GCM key. Metadata is published only as a sealed blob
  (`0x01 || iv(12) || ciphertext+tag`); the on-chain commitment binds the
  *sealed* bytes: `poseidon2(sha256(sealed)_hi, sha256(sealed)_lo,
  DOMAIN_METADATA)`.
- The GCM IV is random per seal, so two markets with identical documents have
  unlinkable blobs and commitments.
- `marketplace_id` (creator/nonce/config derivation) stays as the internal
  protocol identity for user identities and nullifiers. It is recoverable
  from chain data and is therefore NOT a secret and NOT the market link.

**Resolution (Portal path).** secret → lookup_key → registry record → cross-
check the marketplace contract's stored commitment → fetch sealed blob by
commitment (client re-derives the commitment from the bytes) → AEAD-decrypt →
validate schema → require the plaintext be exactly canonical. Any failure
aborts; nothing unverified is ever rendered.

**Security properties.**
- Hidden without the secret: the metadata document (name, description,
  policies, everything), which registry record corresponds to which market,
  and any link between the shared market link and on-chain data.
- Still visible to everyone: that a marketplace-class contract exists at some
  address, its public `MarketConfig` values, and transaction activity/timing
  against it.
- Squatting is detection-only DoS: `register` is permissionless, so anyone
  can claim an arbitrary lookup_key, but they cannot produce a blob that
  decrypts under the corresponding secret — GCM authentication doubles as
  proof the registrant knew the secret. Verified by an integration test.
- The secret is a bearer capability. Anyone holding it can view the market;
  revocation = rotate (new secret, re-seal, new registry entry). Per-user
  access control is a possible later layer, not part of this decision.
- Front-running window: `register` calldata reveals the lookup_key in the
  mempool before inclusion. Impact is limited to the DoS above. Accepted for
  now; a private-function registration proving knowledge of the secret is the
  known upgrade path.

**Losing the secret loses the market.** It is generated client-side, returned
once by `deployMarketplace`, and stored nowhere else.

*(Amended by AD-3: the sealed blobs now live in contract storage rather than
an off-chain publisher, and the commitment indirection was removed. The
construction, secrecy properties, and squatting analysis above are otherwise
unchanged.)*

## AD-3: All market data lives on-chain (2026-07-10)

**Decision.** The sealed metadata and every sealed listing payload are stored
directly in the Marketplace contract's public storage. The off-chain
metadata publisher is removed from the protocol: it was a central
availability chokepoint (whoever ran it could take every market offline),
which defeats the purpose of a decentralized marketplace. Large binary
assets (images) stay off-chain by reference, with the strategy to be decided
in a later milestone.

**Construction.**
- Blobs are packed 31 bytes per BN254 field, stored as chunk maps with a
  byte-length slot (`BLOB_MAX_FIELDS = 128`, so **3968 bytes max per sealed
  blob** -- metadata and each listing payload). The TS codec is
  `bytesToFields`/`fieldsToBytes` in packages/market-metadata.
- The metadata blob is a constructor argument, so a market is complete and
  resolvable from its first block; `set_metadata` replaces it (zeroing stale
  chunks). Listing payloads are stored per listing id next to the record.
- Content commitments and the commitment->hash indirection are gone: the
  chain IS the canonical copy. Authenticity still comes from AEAD -- data
  that does not decrypt under the market secret is rejected, so even a
  malicious superadmin swapping in foreign ciphertext produces a
  verification failure for link holders, never wrong content.
- The registry record shrinks to `{ owner, contract_address, status }`.
- `derive_metadata_commitment` / DOMAIN_METADATA remain in the protocol for
  future off-chain assets (image references).

**Trade-offs accepted.**
- Real gas cost per byte of market data; text fields are effectively capped
  by the 3968-byte sealed-blob limit (sealing throws a descriptive error if
  a document is too large -- shorten the text).
- Every metadata/listing write is a public transaction touching up to 128
  storage slots.
- Resolution now needs only an Aztec node -- any node can serve any market,
  and the data inherits the rollup's data-availability guarantees.

**What "on-chain" does NOT change:** everything is still ciphertext (AD-2).
An observer sees that blobs exist and their sizes, nothing more.

The metadata-publisher service stays in the repo as dev tooling and a
candidate host for off-chain image blobs, but nothing in the protocol or
apps depends on it.

## AD-4: Private vendor & payment architecture (2026-07-11)

**Decision.** Orders are funded, verified, and settled without amounts,
parties, or even the marketplace address appearing in public data. Vendors
and buyers act under per-marketplace pseudonyms; their wallet addresses never
enter marketplace state. Escrow-until-completion is the custody model.

**How a payment stays hidden yet verified.** Private token balances on Aztec
are notes; a private function proves in-circuit that a note worth exactly
`amount` moved buyer -> escrow. A fully private transaction publishes only
nullifiers, note commitments, and encrypted logs. "The contract verified the
amount" is the circuit itself — nothing about it is public.

**Price commitments.** Listing prices are inside sealed blobs (AD-2), so the
contract cannot read them. Each listing therefore stores a public
`price_commitment = poseidon2(price, blinding, DOMAIN_PRICE_COMMITMENT)` with
`blinding = poseidon2(access_secret, listing_id, DOMAIN_PRICE_BLINDING)`.
Outsiders see an unbrute-forceable hash; link holders recompute and verify it
against the sealed price (the Portal refuses to render a listing whose
commitment does not match); a buyer proves in-circuit that the escrowed
amount opens the commitment. The contract verifies correctness without ever
learning the number.

**Pseudonymous roles.** `vendor_id = derive_marketplace_identity(user_secret,
marketplace_id)` (M1 primitive). Registration is a private function: it
derives the identity, pushes the registration nullifier (one registration per
secret per market), optionally escrows the deposit, and enqueues an internal
public write of the pseudonymous vendor record. Listing creation is likewise
private-entry: the circuit proves knowledge of `user_secret` for an
authorized `vendor_id`, and the enqueued public write is made by the
*contract*, so no wallet address is ever the visible caller. Buyers (M5) get
one-time order pseudonyms; a vendor learns only what the buyer chooses to put
in the encrypted order note.

**Custody.**
- *Order funds (M5):* private notes owned by the marketplace contract
  (Escrow-contract pattern). Note preimages are shared with buyer and vendor
  in their encrypted order notes; contract rules decide which spend is valid
  (vendor payout on completion, buyer refund on timeout, arbiter outcomes in
  the dispute window). Payouts use partial notes, so recipients stay hidden.
- *Vendor deposits (M4):* held in the marketplace's PUBLIC token balance.
  Deposit amounts are already public in `MarketConfig`, and public custody
  keeps slashing enforceable even against an uncooperative vendor (private
  custody would let a vendor withhold note preimages from the arbiter).
  Deposit ingress hides the vendor (`transfer_to_public` from a private
  balance); egress pays out through a partial note prepared privately, so
  the withdrawing vendor's account is never revealed either. Withdrawal
  requires a prior request plus a delay of `dispute_window` seconds and a
  zero active-order count; no admin function can move deposits.

**Residual leaks (accepted, documented).**
1. The fee payer of every tx is public — mitigated by shared-FPC fee payment
   (AD-1 fee gate).
2. Vendor registrations and listing writes have public components tied to the
   marketplace address (public state must be written); what leaks is timing
   and pseudonym activity, never wallet identity.
3. Timing correlation between related private txs is behavioral, not
   protocol-solvable.

**Sequencing.** M4 = vendor system + price commitments + fee gate. M5 =
private orders/escrow (order funding must have NO public component). Slashing
moves to M6 with disputes, where its conditions exist.

## AD-5: Fully private orders — escrow keys and settlement (2026-07-11)

> **PARTLY SUPERSEDED BY AD-9 (2026-07-26).** Parts 1 and 3 below — the pooled
> escrow under link-holder keys, and funds moving into the marketplace's own
> private balance — no longer describe the system. A viewing key every link
> holder can derive means every link holder can read the pool, so a pooled
> escrow can never be private per order. Order funds now sit at a per-order
> address with a per-order secret, and the marketplace holds no order funds at
> all. Parts 2 and 4 still stand.

**Decision.** `place_order` has NO public component: an outside observer of a
purchase sees only opaque nullifiers, note commitments, and encrypted logs.
The design rests on four mechanisms.

**1. Link-holder escrow keys.** The Marketplace contract is deployed with
public keys derived from `escrow_secret = poseidon2([access_secret,
DOMAIN_ESCROW_KEYS])`. Every link holder can derive the secret and register
it in their PXE, which lets them (a) decrypt the marketplace's own token
notes — the escrow pool — and (b) generate proofs that SPEND those notes.
Spending is still safe: a token note can only be nullified by the Token
contract itself (nullifiers are siloed per emitting contract), and the Token
only moves marketplace funds when `msg_sender` IS the marketplace — i.e.
inside marketplace settlement functions, which enforce the order rules.
Knowing the escrow key grants visibility of the pool (to link holders only)
and the ability to *execute* legitimate settlements, never to steal.

**2. Historical public reads instead of public calls.** `place_order` must
check the listing (status, price commitment) and config (payment asset, fee,
timeout) — public storage that private functions cannot read directly.
Instead of enqueueing a public call (which would leak the marketplace
address, listing and timing per order), the circuit proves the values against
the anchor block header (`public_storage_historical_read`), entirely inside
the private proof. The buyer proves "at a recent block, listing L was active
with commitment C, and my payment opens C" — nothing is revealed. The read
is near-current (the tx anchors on a recent block); the vendor additionally
verifies `amount == current price x quantity` before accepting, which makes
stale-read games pointless.

**3. Funds flow (all private).** `place_order` moves `price x quantity` from
the buyer's private balance into the marketplace's private balance
(`Token::transfer_in_private` under a one-time authwit). The marketplace's
PUBLIC token balance never changes — verified in tests. Settlement spends
pool notes via `Token::transfer` with the marketplace as `msg_sender`:
payout to the vendor's inbox address, fee to the fee recipient, refund to
the buyer — all as private notes, amounts and recipients hidden.

**4. Serialization of conflicting settlements.**
- A single **settlement nullifier** `poseidon2([order_id,
  DOMAIN_ORDER_SETTLEMENT])` is pushed by every terminal path (confirm,
  cancel, timeout claim). The protocol's global nullifier uniqueness makes
  double-settlement impossible by construction.
- **Acceptance** writes an anonymous public flag `accepted[order_id] = true`
  (the only public byte in the whole order lifecycle; order_id is an opaque
  hash, so an observer learns just "some order on some market was accepted").
- **Cancellation** (buyer, only before acceptance) refunds privately and
  enqueues a public assert `accepted[order_id] == false`. Transaction
  atomicity resolves the race: if the vendor's acceptance lands first, the
  buyer's entire cancel tx — including its private refund — reverts.
- **Timeout claim** (vendor, after `timeout_at`) proves the deadline passed
  using a block header timestamp (headers only move forward, so
  `header.timestamp >= timeout_at` is sound) and that the order was accepted,
  via a historical read of the accept flag (monotonic: once true, always
  true).

**Order data.** An OrderNote (order_id, listing, payment asset, amount, fee,
buyer, vendor inbox, timeout) goes to both vendor and buyer; a MemoNote
carries up to 186 bytes of buyer-chosen delivery/contact text; StatusNotes
carry vendor fulfillment updates. Notes are end-to-end encrypted to their
recipients; private log capacity caps a packed note at 8 fields, which set
these sizes. The vendor inbox address comes from the sealed listing document
— visible to link holders, never on-chain in the clear; vendors are advised
to use a dedicated account per market.

**Buyer protection ordering (M5).** Buyer may cancel any time before
acceptance; buyer may confirm any time; vendor may claim after timeout only
if they accepted. Vendor-favoring timeout is interim — M6 disputes add the
dispute window and arbitration outcomes on top of the same nullifier
machinery.

**Residual leaks (accepted, documented).** Per order: one anonymous public
write at acceptance, one anonymous public assert on cancellation, plus the
fee-payment metadata every Aztec tx has (mitigated by shared FPC, AD-1).
Vendor deposit tracking of active orders is deferred (a public per-vendor
counter would leak order->vendor links); the withdrawal delay covers M5.

## AD-6: Off-chain messaging over SimpleX (2026-07-12)

**Decision.** Rich buyer-vendor (and party-arbiter) communication happens
off-chain over SimpleX Chat; the chain carries only what the protocol needs.
SimpleX is the recommended transport because its threat model matches ours:
no user identifiers of any kind, pairwise relay queues, double-ratchet E2E
encryption, self-hostable relays, Tor-friendly.

**Mechanics.**
1. A listing document may carry an optional `simplexAddress` (the vendor's
   SimpleX contact address, ideally created per market). It is sealed with
   the rest of the document -- visible to link holders only.
2. The **order_id doubles as the chat credential**: it is an opaque hash
   known only to an order's two parties, so a buyer opening a SimpleX chat
   proves they are the real buyer by sending it. No extra cryptography.
3. Dispute evidence beyond the on-chain evidence notes (photos, message
   exports) flows over SimpleX to the arbiter; only the resolution touches
   the chain.

**What may leave the chain and what never does.** Aztec supports
`MessageDelivery.OFFCHAIN` (app-transported note delivery; the injected
`offchain_receive`/`sync_state` functions already exist in our deployed
contracts). Status notes and memos are CANDIDATES for off-chain delivery in
a later milestone (less on-chain metadata, cheaper txs; costs: transport
reliability, no chain backup, inbox TTL semantics to verify). The ORDER NOTE
and everything escrow-related stay `ONCHAIN_CONSTRAINED` forever: on-chain
delivery is the proof of payment and must survive an offline counterparty.

**Leak note.** SimpleX relays see queue-level traffic timing (not content or
identities). Use Tor and diverse public relays; do not use a relay hosted by
the market operator for buyer-vendor chats. Listing images remain out of
scope: XFTP file transfer is transient (fine for per-order photos), not
persistent hosting.

## AD-7: Self-arbitration mechanics (2026-07-12)

**Decision.** Disputes are resolved by the market's superadmin (the arbiter)
under the outcome set fixed in `MarketConfig.allowed_outcomes`, on top of the
M5 nullifier machinery. Buyer confirmation stays fully private and always
available -- a buyer who confirms receipt moots any dispute by construction.

**Mechanics.**
1. **Opening (buyer or vendor, private entry).** The opener proves they hold
   the order note; the arbiter receives a COPY of the order note (that is how
   the arbiter learns the order's terms -- nothing new becomes public), the
   counterparty gets a status note, and an enqueued public part asserts the
   order was accepted, not yet disputed, and that the dispute deadline
   (`timeout_at + dispute_window`, passed from the note) has not passed --
   upper time bounds cannot be proven from historical headers, so the check
   uses public time. It then sets the anonymous `disputed[order_id]` flag.
2. **Pausing.** `claim_timeout_settlement` gains an enqueued public assert:
   not disputed, or the dispute was resolved as REJECT. `confirm_completion`
   is deliberately NOT gated (buyer releasing funds is always legitimate);
   arbiter resolutions and buyer confirmations serialize against each other
   through the settlement nullifier -- whoever lands second reverts.
3. **Evidence.** `submit_evidence` (either party, proving order-note
   ownership) delivers small encrypted EvidenceNotes to the superadmin; bulk
   evidence goes over SimpleX (AD-6).
4. **Resolution (superadmin, private entry).** The arbiter proves they are
   the superadmin via a historical read, takes the order terms from their
   own note copy, and pushes the DISPUTE FINALIZATION nullifier (one
   resolution per order, ever). Fund-moving outcomes (full release / full
   refund / split / refund+slash) additionally push the settlement nullifier
   and pay out of the escrow pool privately. REJECT finalizes without
   settling: the order resumes (vendor may claim after timeout). The
   enqueued public part asserts the outcome is in the live
   `allowed_outcomes` bitmask and records it in `dispute_outcomes[order_id]`.
5. **Slashing.** REFUND_AND_SLASH refunds the buyer from escrow and deducts
   `min(requested, deposit)` from the vendor's public deposit, crediting it
   to `slashed_claims[order_id]`. The buyer withdraws the credit later via a
   privately prepared partial note (`claim_slashed_deposit`), so the
   compensation reveals no recipient.

**Leaks (accepted, documented).** Per dispute: the anonymous disputed flag,
the recorded outcome code, and the dispute deadline in the opening's public
part (approximate order timing, already inferable from the acceptance
beacon). A slash resolution additionally links the order_id to the vendor's
pseudonymous vendor_id in public calldata (the pseudonym-listing link was
already public). Timeout claims now carry an anonymous public assert like
cancellations. Liveness: a dispute blocks the vendor's timeout claim until
the arbiter acts -- self-arbitration assumes the market operates its own
arbitration, per the spec.

**AD-7 amendment (2026-07-12): moderator arbiters + live authority.**
Moderators holding PERM_RESOLVE_DISPUTES may now rule alongside the
superadmin. Because moderators are pseudonyms (not addresses), a party hands
them the order's terms via `share_order_with_arbiter` -- sharing one's own
order data is the sharer's prerogative, and delivery to a non-arbiter is
harmless since resolution requires proving live authority. On-chain evidence
notes still flow to the superadmin; moderator arbiters receive bulk evidence
over SimpleX (AD-6), authenticated by the order_id. Resolution authority is
asserted LIVE in the enqueued public part (`_finalize_resolution` receives
the resolver and re-checks the role at inclusion time): a transaction may
anchor on a block up to ~a day old, so the previous historical-only check
would have let an ex-superadmin or revoked moderator keep ruling until their
stale anchor expired. Cost of the fix: a ruling publicly reveals WHO ruled --
the superadmin's (already public) address, or the moderator's pseudonym
(the same accountability disclosure as the M4 moderation paths).

> Superseded in part by **AD-8**: the superadmin is no longer an address, so
> rulings now reveal only the owner PSEUDONYM, and the owner receives disputes
> through the same `share_order_with_arbiter` inbox flow as moderators (there is
> no auto-delivery). The live-authority check now compares identities.

## AD-8: Pseudonymous marketplace ownership (2026-07-13)

**Decision.** The market owner (superadmin) is a pseudonymous IDENTITY, never a
wallet address. It is derived exactly like vendors and moderators --
`superadmin_identity = derive_marketplace_identity(owner_secret, marketplace_id)`
-- and stored on-chain as that single field. Knowing `owner_secret` (the "owner
key") is what authorizes every admin action; no owner wallet ever appears in
marketplace state or calldata.

**Why.** Previously the superadmin was `PublicMutable<AztecAddress>`, checked in
public entrypoints as `msg_sender == superadmin`. That made the creator's wallet
public and linked every admin/moderation/dispute action to it -- the one actor
in the system who was NOT pseudonymous, unlike the vendors and moderators around
them (AD-4, AD-7). AD-8 makes the owner derive their role "just like everyone
else."

**How.**
1. **Owner = top-tier identity.** Storage holds `superadmin_identity: Field`.
   Every admin action is a PRIVATE entry that derives the caller's identity from
   `user_secret` and, in an `#[only_self]` public writer, asserts it equals
   `superadmin_identity`. The owner-exclusive actions (config, metadata,
   moderator management, ownership transfer) use this directly; the shared
   actions (vendor status, listing moderation, dispute resolution) treat the
   owner as holding EVERY permission, so one identity-checked path serves both
   the owner and permissioned moderators. This is the same private-entry +
   `only_self` shape the moderator paths already used.
2. **Disputes unify onto the moderator inbox flow.** With no owner address,
   `open_dispute`/`submit_evidence` can no longer auto-deliver to the arbiter.
   A party hands the order (and evidence) to a chosen arbiter inbox via
   `share_order_with_arbiter`; the owner arbitrates from that inbox authorized
   by `owner_secret`, exactly as a moderator does. Rulings record the arbiter
   PSEUDONYM (owner or moderator), never an address. The live-authority check in
   `_finalize_resolution` compares the resolver identity to `superadmin_identity`
   or a `PERM_RESOLVE_DISPUTES` moderator.
3. **Constructor takes the derived identity, not the secret.** Constructor args
   are public, so the client derives `superadmin_identity` from `owner_secret`
   (both `marketplace_id` inputs are known before deploy) and passes only the
   identity. The owner key is shown once, like the market access secret.
4. **Deploy-time anonymity.** Markets are deployed from a FRESH throwaway
   account whose keys are never persisted and whose fees are paid by the
   sponsored FPC (AD-1), so the creator is unlinkable even at deploy time. The
   throwaway is discarded; ongoing admin runs privately from any account.

**Cost / caveats.** Admin actions become private proofs (costlier than public
calls -- the tradeoff moderators already accept). The owner must publish an
arbiter inbox to receive disputes (a pseudonymous account, not their wallet).
Storage layout changed, so existing markets must be redeployed. The owner key,
like the access secret, cannot be recovered if lost.

## AD-9: Per-order escrow, and the marketplace out of the money path (2026-07-26)

**Supersedes AD-5 parts 1 and 3.** Everything else in AD-5 stands: `place_order`
still has no public component, still proves the listing and config against the
anchor block header, and the order still exists only as encrypted notes.

**The problem with AD-5.** Link-holder escrow keys were load-bearing: every link
holder could derive them, which is exactly what let a buyer or vendor prove a
settlement. But it also let every link holder DECRYPT the pool. A pooled escrow
whose viewing key is shared by everyone who can see the market cannot be private
per order — the amounts, the timing, and the correlation between deposits and
payouts are all readable by anyone with the link. There is no fix inside the
pooled model: the key that authorizes settlement is the key that reveals.

**Decision.** Each order gets its OWN escrow contract instance, at an address
derived from a per-order secret the buyer hands the vendor inside the order
note. A leaked secret exposes exactly one order. The marketplace holds no order
funds at all.

**1. Nobody deploys it, and nobody publishes its class.** The instance is only
ever an address the two parties compute locally. The private kernel proves the
called function belongs to the class and that the address derives from
`(class_id, salted_initialization_hash, public_keys)`; it never checks that the
instance was deployed. Class publication is not needed either — it exists so a
sequencer can fetch PUBLIC bytecode and so strangers can fetch the artifact, and
this contract has neither public functions nor strangers. Both are asserted
live: the orders suite checks the node has neither the class nor the instance
while the escrow moves real cUSDC. So there is NO deployment step of any kind —
not per order, not once at setup, and no fee juice.

**2. Private functions only, therefore no storage and no serialization.** An
undeployed contract has no bytecode a sequencer can run. Terms cannot live in
storage, so they are the initializer arguments — the address already commits to
them — and `open` publishes a siloed nullifier over them that every later call
proves against. More consequentially, the escrow cannot enqueue a public assert,
so it cannot serialize itself against a concurrent transaction. It can only read
a historical block.

**3. So the marketplace decides and the escrow follows.** Reading the live order
state from a stale anchor block would reopen two races the marketplace closes
with enqueued asserts: a buyer cancelling against the vendor accepting, and a
vendor timeout-claiming against the buyer disputing. Instead the marketplace —
which CAN serialize, in public — writes one of three terminal states
(`CANCELLED`, `COMPLETED`, `SETTLED_VENDOR`), and each authorizes exactly one
escrow payout. Reading a terminal state late is harmless: nothing leaves one.
Every settlement is therefore two transactions, marketplace first.

**4. Why neither party can steal, though both hold the keys.** Sharing the
escrow secret with the vendor is deliberate — it is how they settle. (They do
not need it to know the order is paid; see "Proof of payment" below.) Holding
the nullifier key lets a
PXE compute a nullifier for the escrow's token notes, but emitting one requires
the Token contract to accept the spend, and it requires `from == msg_sender`.
Only the escrow's own code can be `msg_sender` for its own address. THE ESCROW
MUST THEREFORE NEVER IMPLEMENT `verify_private_authwit` AND MUST NEVER BE AN
ACCOUNT CONTRACT: either party could then sign as the escrow and drain it
straight through the Token. This is the single most important invariant in the
design. The two payouts that pay their CALLER (the buyer's release and refund)
are additionally gated on a preimage only the buyer holds; the vendor's claim
pays only bound addresses and is therefore permissionless, which is what lets a
vendor account holding no fee juice be settled for by whoever can pay.

**5. Proof of payment: the marketplace OPENS the escrow.** Moving the money out
of the marketplace created a hole worth naming, because the first version of
this design had it: if the buyer funds their own escrow directly, what stops
them writing an order note and funding nothing? The marketplace cannot check by
looking. An escrow's address is a hash of its class, its keys and its
initializer arguments; a circuit cannot compute one, and a historical read of
the escrow's balance would be both stale and, since the escrow has no public
state, impossible.

So `place_order` does not check the escrow. It **opens** it. The terms are built
inside `place_order`, from values it derived itself — the amount from the proven
price table, the fee and collateral from the config it just read, the vendor
from the order, the treasury and `order_states_slot` from its own storage — and
then it calls `open(terms)` on the address the buyer supplied, followed by the
token transfer into that same address. The buyer supplies the address because a
circuit cannot derive one, but they cannot supply a *different* one: the private
kernel's `validate_contract_address` admits the call only if the address equals
the hash of the class, keys and *these* initializer arguments. Naming an escrow
opened for a cheaper order, a friendlier vendor, a smaller collateral or another
market's order id is naming a different address, and the call simply cannot be
made.

The binding is therefore the protocol's address rule, not a check anyone wrote,
and it costs one extra private call. Two consequences follow:

- An order note cannot exist without the money behind it, in the same
  transaction. **The vendor does not need to verify funding before shipping**;
  earlier drafts of these docs said they did, from before this existed.
- The client must NOT open the escrow itself. `prepareEscrowFunding` deliberately
  returns only the address and the payer's authwit: opening from out here would
  make the terms a client assertion instead of a protocol proof, and would
  consume the initializer so the real `place_order` failed.

`payer` is a separate argument because the account holding the buyer's cUSDC
(typically their L1-facing universal account) need not be the one placing the
order; the order note is still owned by `msg_sender`, so the payer is never
revealed to the vendor.

**The marketplace is now deployed with NO encryption keys at all.** Removing
the pool removed the only thing its link-derived keys ever decrypted, so the
derivation went too: `DOMAIN_ESCROW_KEYS` is retired and reserved, nothing
derives from it, and `PublicKeys.default()` is passed at deployment. Holding a
market link therefore confers no ability to decrypt anything about the
marketplace contract.

Leaving the keys in place would have been defensible — with the pool gone they
decrypted nothing, since vendor deposits sit in the contract's PUBLIC balance
and a withdrawal's private note belongs to the recipient. But that is a property
someone has to keep remembering: the first private note anyone later adds to
this contract would be readable by every link holder, silently. Deleting the
keys makes it structural instead. If a future feature genuinely needs this
contract to receive notes, it should use a fresh secret held by the owner —
never the market link, which by design is known to every visitor.

This also removed the key-registration step in `resolveMarketplace`, which was
described as an authenticity check but never was one: registering under a
market's lookup key already requires the access secret, so anyone who could
squat the registry entry could equally deploy with the matching keys. The
class-id allowlist is the actual trust anchor, and always was.

BREAKING: public keys are part of an Aztec address, so every marketplace address
changes.

**Cost / caveats.** Both parties' PXEs register and sync an account per OPEN
order: local CPU, node queries and storage, no fee juice. The live set tracks
open orders, not lifetime orders, since a settled escrow is dead. A refund
ruling leaves the order `settled: false`, because the buyer pulls from the
escrow and the marketplace cannot observe that — the escrow's own balance is
what distinguishes collected from uncollected. The buyer's escrow secret appears
in no note and must be persisted device-locally; losing it means that order's
funds can only ever reach the vendor.
