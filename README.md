# Aztec Market System (Alpha)

A framework for running private marketplaces on [Aztec](https://aztec.network), pinned to
**v5.0.1**.

A market is invisible unless you hold its link. Listings are encrypted and stored off-chain
behind an encrypted pointer. Orders, payments, and escrow are private: the chain verifies
that a buyer paid the listed price without learning the price, the item, or who bought it.
Vendors trade under a per-market pseudonym that is never linked to the wallet they fund it
from.

Everything runs from one desktop app: browsing, selling, moderating, and deploying a new
market.

See [`docs/Aztec-Market-System-Explained.pdf`](docs/Aztec-Market-System-Explained.pdf) to learn how this framework works. 

THIS PROJECT IS UNDER ACTIVE DEVELOPMENT AND IS NOT READY FOR PRODUCTION.

## Layout

| Path | What it is |
| --- | --- |
| `contracts/marketplace` | The market contract: config, vendors, listings, orders, moderation. Holds vendor deposits, but never order funds |
| `contracts/order-escrow` | One instance per order, never deployed by anyone. Holds that order's funds and pays out against a terminal order state the market contract wrote |
| `contracts/marketplace-registry` | The global lookup table. Every market is registered here, under an opaque key derived from its access secret, so a market is findable only by someone who already holds its link |
| `contracts/market-protocol` | Shared Noir library: domain constants and Poseidon2 derivations |
| `packages/identity` | TypeScript mirror of those derivations (ids, tags, commitments) |
| `packages/market-metadata` | Document schemas plus the sealing/opening of every encrypted blob |
| `packages/deployment` | Typed wrappers over every contract call, and market deployment |
| `packages/contract-bindings` | Generated contract bindings (`yarn codegen`) |
| `packages/arweave-store` | Uploads and fetches sealed listing payloads |
| `apps/desktop` | The Electron app, and the only user-facing application |
| `tests` | Integration tests against a running network |


## Further reading
- [`docs/DECISIONS.md`](docs/DECISIONS.md): the reasoning behind the significant choices
