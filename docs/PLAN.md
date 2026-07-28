# Aztec Market System — Build Plan

Plan for implementing the system described in `Aztec Market Specification.md`.
Grounded against Aztec **v4.2.0** (current supported release: aztec-nr `v4.2.0`,
`@aztec/aztec.js` 4.2.0, TXE-based `aztec test`, sandbox via Docker).

---

## Phase 0 — Environment & Scaffold (prerequisite)

The machine currently has Node v24 but no Aztec toolchain.

1. Install prerequisites: Docker Desktop (WSL2 backend on Windows), then the
   Aztec toolchain (`aztec`, `aztec-nargo`, `aztec-wallet`) pinned to v4.2.0.
   Note: the Aztec sandbox and CLI are Linux-native; on Windows all
   compile/test/sandbox work runs inside WSL2.
2. Verify: `aztec start --sandbox` runs, `aztec compile` works on a hello-world
   contract, `aztec test` passes on the starter's TXE tests.
3. Scaffold the monorepo (yarn workspaces, layout per spec §48):

```
aztec-market-system/
├── apps/market-portal/          # React + Vite, buyers/vendors/admins
├── apps/market-creator/         # React + Vite, marketplace owners
├── contracts/marketplace-registry/
├── contracts/marketplace/       # roles, vendors, listings, orders, escrow, disputes
├── contracts/test-contracts/    # test token, helpers
├── packages/contract-bindings/  # output of `aztec codegen`
├── packages/market-metadata/    # schema + deterministic serialization
├── packages/identity/           # marketplace identity & nullifier derivation
├── packages/shared-types/
├── packages/test-utils/
├── services/metadata-publisher/ # content-addressed storage upload + hash
├── tests/                       # jest integration & e2e vs sandbox
└── docs/
```

4. Toolchain conventions (already in CLAUDE.md): `aztec compile` / `aztec test`
   only, never bare `nargo`; Poseidon2 for all hashing; no silent error
   fallbacks anywhere in TS code.

---

## Architecture Decisions (made up front, before Milestone 1)

### D1. Contract boundaries — two contracts for the MVP

- **`MarketplaceRegistry`** (one global instance): maps `marketplace_id` →
  `(contract_address, metadata_commitment, status, listed_flag)`. Public state
  only. Enforces uniqueness of identifiers.
- **`Marketplace`** (one instance per marketplace): roles, vendor registration
  + deposits, listings, orders, escrow, self-arbitration, fees — combined, as
  the spec explicitly permits (§2), to minimize cross-contract call complexity,
  which is the dominant cost/risk on Aztec. Escrow is internal state of the
  Marketplace contract, not a separate contract, so settlement invariants
  (no double-withdraw, no settle-while-disputed) live in one place.

Payments use a standard aztec-nr **Token** contract (test token locally;
configurable asset address per marketplace). Escrow holds tokens via
private-to-public transfer into the Marketplace contract's balance, released by
authorized settlement functions.

### D2. Identifiers, identities, nullifiers (all Poseidon2)

- `marketplace_id = poseidon2_hash([creator_address, deployment_nonce, config_commitment])`
  — computed at deploy, registered in the registry, immutable.
- `marketplace_identity = poseidon2_hash([user_secret, marketplace_id, DOMAIN_IDENTITY])`
  — derived client-side in `packages/identity`; the wallet address never
  appears in marketplace state.
- Action nullifiers: `poseidon2_hash([user_secret, marketplace_id, domain, subject])`
  e.g. vendor registration (`subject = 0`), order settlement
  (`subject = order_id`). Domain constants defined once in a shared Noir/TS
  constants module so both sides derive identically.

### D3. Public vs private state split

Public (Marketplace contract):
- config: fee bps, fee recipient, vendor policy (approval/deposit/both),
  deposit amount, timeout durations, allowed dispute outcomes, arbiter policy
- `metadata_commitment` (hash of the canonical metadata document)
- listings map: `listing_id → {vendor_identity, price, asset, status, content_hash, availability}`
- vendor authorization map: `vendor_identity → {status, deposit_amount}`
- escrow map: `order_id → {listing_id, amount, state, deadline_timestamps, dispute_flag}`
  — order_id is a commitment; no buyer identity in public state
- moderator permission bitmaps: `moderator_identity → permissions`

Private (notes, encrypted to recipient):
- **OrderNote** (buyer + vendor copies): order_id, listing_id, quantity,
  delivery payload hash + off-chain pointer, buyer marketplace identity
- **StatusNote**: fulfillment status updates, vendor → buyer
- **EvidenceNote**: dispute evidence commitment + encrypted pointer, shared to
  the assigned arbiter only when a dispute is opened (scoped disclosure, §15)
- delivery details themselves: encrypted off-chain blob; only its hash goes in
  the note (keeps note size small, satisfies §37 for evidence too)

### D4. Timeouts

Private functions cannot read current time; all deadline enforcement lives in
**public** functions comparing against stored deadline timestamps set at order
creation (public part of the order flow). Timeout settlement (`claim_timeout_*`)
is callable by anyone but pays out only per the fixed rules.

### D5. Metadata

Canonical JSON with deterministic serialization (sorted keys, no floats) in
`packages/market-metadata`; commitment = Poseidon2 over the file hash.
Storage backend: start with a trivial local content-addressed store
(hash → file) behind an interface; IPFS later. Portal always verifies content
hash against the on-chain commitment before rendering (§12, §24).

### D6. Language & frontend stack

**All application code is TypeScript** (decided 2026-07-09): both apps, all
`packages/*`, and `services/*`. Contracts are Noir (the only option on Aztec).
React + Vite + TypeScript for both apps, sharing `packages/*`.
Wallet: `@aztec/wallet-sdk` (embedded/test accounts against sandbox for the
MVP; external wallet integration deferred). Contract bindings generated by
`aztec codegen` into `packages/contract-bindings`.

---

## Milestones

Mirrors spec §53–59; each milestone ends with its tests green.

### M1 — Protocol Foundation (contracts skeleton)
- Monorepo + CI script (`compile → codegen → test:nr → test:js`)
- `MarketplaceRegistry` contract: register, resolve, duplicate prevention
- `Marketplace` contract: constructor (config + superadmin), marketplace_id
  derivation, moderator assign/remove with permission bitmap
- `packages/identity` + matching Noir helpers; unit tests for domain separation
- TXE tests: creation, unique id, unauthorized config change rejected
- **Exit:** marketplace deploys locally, resolves via registry, non-admin
  mutations revert.

### M2 — Market Creator MVP
- Metadata schema + deterministic serializer + tests
- Creator app: config wizard (basic info, vendor policy, fees, arbitration,
  privacy sections per §23), validation, review screen
- Deploy pipeline: upload metadata → commit hash → deploy Marketplace →
  register in registry → show identifier + Portal link (§26)
- **Exit:** end-to-end local deploy from the UI; metadata verifies against
  on-chain commitment.

### M3 — Portal: Marketplace Viewing
(Amended by docs/DECISIONS.md AD-2: every market is hidden; and AD-3: all
market data lives on-chain — no publisher service.)
- Portal app: `#/m/{access-secret}` routing; resolution from the secret alone
  (lookup key -> registry -> sealed blobs read from contract storage -> AEAD
  decrypt + **verification, reject on any mismatch**), themed rendering
- Listing index + detail pages. Listing content must NOT be plaintext —
  payloads are sealed under keys derived from the market access secret and
  stored on-chain next to their status records.
- **Exit:** deployed marketplace opens from its market link; a wrong secret,
  a squatted lookup key, and corrupted/foreign sealed data are all rejected;
  active listings render for holders of the link.

### M4 — Vendor System (amended per AD-4)
- Contract: vendor registration as a PRIVATE function — pseudonymous
  `vendor_id` derived in-circuit, registration nullifier blocks duplicates,
  policy modes open/approval/deposit/both; deposits enter the marketplace's
  public token balance with the vendor hidden, and leave via privately
  prepared partial notes after a `dispute_window` delay with an active-order
  lock (superadmin cannot touch deposits, §28; slashing lands in M6 with
  dispute outcomes)
- Contract: listing create/update/pause via private entry with vendor auth
  proven in-circuit; public moderation path (superadmin/moderators) retained;
  listings gain a public `price_commitment` (blinding derived from the
  access secret) so M5 buyers can prove payment of the hidden price
- Portal: vendor registration flow + vendor dashboard (listings CRUD, deposit
  status); admin dashboard v1 (approve/suspend vendors, moderate listings);
  AD-1 fee gate for transactional sessions
- TXE tests: unauthorized listing ops, duplicate registration, deposit rules
- **Exit:** only authorized vendors can list; duplicates blocked; deposits
  follow configured rules; vendor wallet addresses never appear in
  marketplace state.

### M5 — Private Orders & Escrow (the core, amended per AD-4)
- Contract: `place_order` (private, NO public component): derive one-time
  buyer pseudonym, prove the escrowed amount opens the listing's
  price_commitment, move funds into contract-owned private notes, create
  buyer + vendor OrderNotes carrying the escrow-note preimages;
  `update_status` (vendor → StatusNote);
  `confirm_completion` (buyer, settles: fee split + vendor payout);
  `claim_timeout_settlement`; cancellation paths (§32–33)
- Settlement nullifier per order — double-settle impossible by construction
- Portal: buyer checkout (quantity, encrypted delivery info, fee/timeout
  disclosure before purchase §39), buyer dashboard, vendor order dashboard
  (note sync & recovery handled via PXE re-sync, §18)
- Privacy tests (§51): delivery info absent from public state; order
  unlinkable to wallet; unauthorized PXE cannot decrypt notes
- **Exit:** full private purchase on sandbox; double-withdraw impossible;
  unauthorized users see nothing.

### M6 — Self-Arbitration (amended per AD-6/AD-7)
- Contract: `open_dispute` (buyer or vendor, private entry; delivers the
  order-note copy to the arbiter, blocks the vendor's timeout claim via the
  anonymous disputed flag; buyer confirmation stays ungated), evidence
  submission (EvidenceNotes to the superadmin; bulk evidence over SimpleX per
  AD-6), `resolve_dispute` (superadmin; outcome ∈ configured allowed set:
  full release / full refund / split / refund+slash / reject §36; dispute
  finalization nullifier always, settlement nullifier on fund-moving
  outcomes), `claim_slashed_deposit` (buyer withdraws slash compensation via
  partial note)
- Off-chain messaging (AD-6 tier 1): listings carry an optional sealed
  SimpleX address; order_id doubles as the chat credential
- Portal: dispute UI for buyer/vendor (open, submit evidence, SimpleX chat
  links), arbiter view in the Admin tab (order copies, evidence, outcome
  execution)
- TXE tests: unauthorized open/resolution, timeout-claim-while-disputed
  blocked, resume after REJECT, replay blocked (finalization nullifier),
  disallowed outcomes rejected; fund-moving payout paths in integration
- **Exit:** dispute lifecycle works end-to-end; evidence stays private;
  finalized disputes cannot re-settle.

### UI — Unified desktop app (2026-07-12)
- Replaced the two web apps (Creator + Portal) with a single Electron app
  (`apps/desktop`): storefront theme (category sidebar, product rows,
  pagination, single Buy), tabs Market / My Orders / Vendor / Admin + operator
  custom pages, and a Create-a-market mode. Renderer runs the embedded wallet
  as before; Electron main is a thin shell.
- Custom pages: `pages[]` (title/body) added to MarketplaceMetadata, sealed
  with the rest of the metadata (shares the ~3968-byte cap). Product images
  remain placeholders pending the off-chain image strategy (AD-3).

### M7 — Security & Hardening
- **DONE (AD-8): pseudonymous ownership.** The superadmin is now a derived
  identity, not a wallet address; admin actions are private, identity-authorized
  entries (owner = all permissions); disputes use the shared-inbox flow; markets
  deploy from a throwaway account so the creator is unlinkable even at deploy
  time. Contract + bindings + deployment + desktop + tests updated; 80 Noir TXE
  tests pass. See docs/DECISIONS.md AD-8.
- Fee strategy for real deployments (AD-1 follow-up): integrate a
  quote-based FPC (e.g. Nethermind aztec-fpc; operator-trusting, any-token)
  and/or a Wonderland-style PrivateFPC pattern (trustless, self-funded fee
  credit; would need reimplementing on our Aztec version) as user-selectable
  payment methods behind the fee gate
- Account UX: defer transactional account deployment until the first send
  (counterfactual accounts); evaluate recovery-capable account contracts for
  superadmin/vendor roles (marketplace code is address-agnostic already)
- Off-chain note delivery (AD-6 tier 2): status notes + memos over
  `MessageDelivery.OFFCHAIN` with SimpleX transport, after verifying inbox
  TTL/late-delivery semantics
- Invariant test suite: escrow conservation (funds in = payouts + refunds +
  fees + slashes), deposit conservation, nullifier coverage audit
- Permission matrix audit (every external fn × every role)
- Privacy review: metadata leakage, timing/linkability notes documented in
  `docs/privacy-assumptions.md`
- Malformed metadata handling, wallet/note recovery test, DoS review
  (unbounded loops, note spam)
- Testnet deployment + full e2e (happy path §52 + dispute path)
- **Exit:** invariants automated, privacy assumptions documented, flows work
  on Aztec testnet.

---

## Testing strategy (runs continuously, not a phase)

| Layer | Tool | Covers |
|---|---|---|
| Noir unit/contract | `aztec test` (TXE) | roles, deposits, escrow, disputes, nullifiers — the §50 list |
| TS unit | jest | metadata serialization, identity derivation, validation |
| Integration | jest + sandbox | codegen bindings, deploy, note delivery, multi-PXE privacy checks |
| E2E | jest + sandbox, later testnet | §52 happy path and dispute path across Creator + Portal |

Privacy tests use **two separate PXE instances** (buyer vs stranger) to assert
non-recipients cannot read order notes.

---

## Key risks / open questions

1. **Escrow token flow**: exact private→public token escrow pattern
   (authwit-based transfer into contract balance) must be validated against
   v4.2.0 aztec-nr Token early in M5 — prototype this in M1 spare time.
2. **Note discovery UX**: buyers recovering order history on a fresh device
   depends on PXE sync; keep order state reconstructible from notes alone.
3. **Scoped moderator disclosure** (§15): sharing evidence with an arbiter
   after dispute-open requires re-encrypting/emitting notes to the arbiter at
   dispute time — design in M6, verify no earlier leakage.
4. **Windows dev friction**: all Aztec tooling runs in WSL2; document the setup
   in `docs/dev-setup.md` during Phase 0.
5. **Version churn**: Aztec releases move fast; pin everything to v4.2.0 and
   upgrade deliberately between milestones, never mid-milestone.

## Deferred (per spec §60)
External arbitration, reputation systems, appeals, governance, multi-sig
arbitration, auctions, subscriptions, multi-asset settlement, on-chain images,
page builders, public ranking — plus (our additions) the optional indexer
until listing volume demands it, and external wallet integrations until the
wallet ecosystem stabilizes.
