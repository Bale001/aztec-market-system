# Account-Model Migration Plan

Replace the derived-pseudonym identity system with **real per-market Aztec
accounts identified by `msg_sender`**, so that the address a vendor/buyer/mod
exposes on a market is a fresh, single-market account that never touches L1 and
cannot be linked to the user's Ethereum identity.

## Goal & principles

- **Universal account**: one per install (initializerless, free), the only
  account that ever bridges from L1 / holds the main azDai + fee-juice credit.
  It NEVER registers on any market.
- **Per-market accounts**: derived from the universal seed (HD), initializerless
  (free to create), single-market. These are what register, vend, moderate,
  own, and receive refunds. They hold no funds of their own by default —
  escrow is funded from the universal account, and gas is paid from the
  universal account's shared-FPC credit via the **delegated payer**
  (`pay_fee_from`, already prototyped & verified).
- **Roles by `msg_sender`**, not derived secrets. The marketplace stores a
  `users` map and checks the acting account's address.
- **Usernames** are the human handle: committed on-chain as
  `hash(username, market_secret)`, never stored in plaintext, shown as
  "Sold by: <username>" with on-chain verification.

### The three funding/anonymity primitives (all verified)
- **Initializerless accounts**: send private txs with no deployment tx.
- **Delegated fee payment** (`pay_fee_from(payer, authwit_nonce)` on the ONE
  shared FPC): a per-market account pays a tx fee from the universal account's
  single shared-FPC credit, authorized by a single-use authwit; the shared FPC
  stays the public fee payer (anonymity set), no public link. Client passes
  `additionalScopes: [universal]` so the payer's credit notes are in scope.
- **Escrow via authwit**: the buyer's per-market account acts; the escrow
  azDai is pulled from the universal account via a `transfer_in_private`
  authwit. Universal never appears as `msg_sender` or in any note.

## Buyer flow (the refinement)

The buyer's per-market account is the actor for ALL order operations
(place/cancel/confirm), so `OrderNote.buyer = msg_sender = per-market address`
— the ONLY address the vendor ever sees. The universal account funds two
things behind the scenes, never appearing:
- **escrow** (the azDai): `transfer_in_private(universal, marketplace, amount+
  collateral, nonce)` authorized by an authwit from the universal account;
- **gas**: delegated `pay_fee_from(universal, …)`.

Refunds (cancel / confirm) go to `note.buyer` = the per-market account, and
cancel/confirm authority is `msg_sender == note.buyer` = per-market. Buyers do
NOT register a username on-chain; their per-market account is auto-created,
unnamed, and unregistered (created transparently on first order). After a
refund the per-market account holds azDai, which the wallet can sweep back to
the universal account via a private transfer.

## On-chain identity model

- `users` map (in the existing generic `buckets`, new domain tag):
  `username_hash = hash(username, market_secret)` → per-market address, AND the
  reverse `address → username_hash` (needed for `msg_sender` role checks and
  for buyers to verify a listing's "Sold by"). Optionally an
  `address → encrypted_username` entry (sealed under the market secret) so a
  client can display a handle for any known address.
- `register(username)` (private, msg_sender = the per-market account):
  computes `username_hash`, asserts it is unused (uniqueness), writes both
  directions keyed to `msg_sender`. Usernames ≤ 20 chars.
- **Superadmin** = the owner's per-market address, written at deploy. Owner
  actions check `msg_sender == superadmin`.
- **Moderators**: `moderators` map keyed by ADDRESS. The superadmin, knowing a
  mod's plaintext username, computes `username_hash`, looks up their address in
  `users`, and assigns. Mod actions check `msg_sender` in `moderators`.
- **Vendors**: a `vendors` map keyed by ADDRESS; registration requires the
  caller to be a registered user. A listing's `creator = msg_sender`; the
  vendor includes their username in the sealed Arweave listing doc, and buyers
  verify `hash(username, secret)` maps (via `users`) to `creator`. "Sold by:
  <username>".
- **Contact attestation (dispute AD-6)**: rekey `set_contact_address` /
  `get_contact_address` from derived identity to `msg_sender` / address.

## Phases (each independently landable + tested)

### Phase 0 — Account & fee foundations (no marketplace-contract change)
- HD derivation of per-market accounts from the universal seed
  (`packages/identity` or a new `accounts` module): `account_i =
  KDF(seed, market_address)` → deterministic, recoverable.
- Initializerless-account creation/registration helper in `packages/deployment`
  (create the account object, register its capsule; no deploy tx).
- Productionize the delegated fee path: keep `pay_fee_from` +
  `DelegatedFPCFeePaymentMethod`; DROP the prototype `transfer` (chosen model
  is delegated). Wire delegated payment + `additionalScopes` into a session
  helper so any per-market account can transact paid by the universal account.
- Desktop: introduce the universal account at first launch (initializerless),
  distinct from today's `market.account.v1`.
- Tests: extend `private-fpc.test.ts` (done); add an accounts-derivation unit
  test; a live "per-market account transacts, universal pays" e2e.

### Phase 1 — Marketplace contract: msg_sender roles + users/usernames
- Remove `derive_marketplace_identity` auth. Every `_x(caller_identity, …)`
  only_self check becomes `caller_address = self.msg_sender()` passed through.
- Add the `users` map (username_hash↔address) with `register(username)` +
  uniqueness; usernames ≤ 20 chars committed as `hash(username, market_secret)`.
- superadmin = address at deploy; moderators keyed by address; vendors keyed by
  address; listing `creator = msg_sender`.
- `place_order`: add `payer` param (universal) — escrow via
  `transfer_in_private(payer, …)` authwit; `buyer = msg_sender` (per-market).
- Rekey contact attestation to address.
- Recompile (`aztec compile`), TXE tests, `yarn codegen`. NOTE: breaking —
  new class id, existing test markets invalid (recreate).

### Phase 2 — Deployment layer
- Rewrite `vendors.ts`, `admin.ts`, `listings.ts`, `orders.ts`, `contacts.ts`,
  `deploy.ts` for the address/username model (drop `userSecret` plumbing; add
  account + username args; delegated fees; escrow-from-universal authwit).
- Username helpers (`deriveUsernameHash`, listing "Sold by" verification).
- Live integration: full vendor + order + admin + dispute lifecycles on the new
  model.

### Phase 3 — Desktop
- Remove the identity system (`identity.ts`, `identitybar.tsx`). Add the
  accounts model: universal account + per-market accounts (with usernames) in
  a "My wallet" view; "Create account" + "Register on-chain" buttons; an
  auto-created "anonymous" per-market account for browsing/ordering.
- Buyer ordering: pay escrow from universal (authwit) + gas delegated;
  per-market as refund/identity; a "sweep refunds to universal" action.
- Vendor / moderator / owner flows use per-market accounts + `msg_sender`;
  owner's per-market account created at market deploy = superadmin.
- Rekey the dispute UI (open-dispute, contact publication, verification) to the
  address model.

### Phase 4 — Dispute reconciliation & cleanup
- Confirm the buyer ZK proof still binds correctly (it proves an address —
  now the per-market buyer address; still hides it from mods).
- Contact attestation under addresses end-to-end.
- Remove dead derived-identity code paths; refresh docs/memory.

## Key decisions (defaults chosen; flag to change)
1. On-chain role identity = **account address** (msg_sender); username_hash is
   a lookup/verification layer on top, not the primary key. (Alternative:
   key everything by username_hash — rejected: breaks msg_sender simplicity.)
2. Buyers get an **auto-created, unregistered** per-market account (no
   username) — satisfies "buyers need no account" while giving a per-market
   refund/identity address. Escrow paid from universal via authwit.
3. **Delegated payer** for all per-market gas (not per-account credit / not a
   personal FPC — a personal FPC would fingerprint accounts via the public
   fee-payer field).
4. Username confidentiality is weak by design (shared secret + short handles →
   dictionary-attackable by link holders); acceptable since usernames are
   shown. Moderator handles are therefore discoverable by link holders — a
   conscious tradeoff.

## Risks
- Largest surface change in the project; breaking (new contract class id).
- Type-complexity cap: the `users` map(s) go into the shared `buckets` map
  (domain-tagged) — no new nested Storage field, so headroom is preserved.
- Authwit ergonomics for escrow-from-universal (per-tx authwit, same wallet →
  transparent).
- Recovery: per-market accounts + username↔account list must be in the wallet
  backup (HD-derived, so recoverable; initializerless capsules re-derived per
  device, no tx).
