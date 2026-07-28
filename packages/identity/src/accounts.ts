// Per-market account derivation (account-model migration).
//
// A user has ONE universal seed. Every account they use on a market is an
// initializerless Aztec account whose keys are derived deterministically from
// that seed + the market address (+ an index, so a user can hold several
// accounts on one market -- e.g. an auto-created "anonymous" account at index
// 0 plus named accounts). Because the derivation is deterministic, all of a
// user's per-market accounts are recoverable from the single seed on any
// device; nothing per-account needs to be backed up.
//
// These keys are PURELY client-side: per-market accounts are identified
// on-chain by their address (msg_sender), never by a derived Field, so there
// is no Noir mirror of this derivation. Domain separators are local.

import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';

import { toFr, type FieldLike } from './index.js';

// Distinct domain separators so the three key materials derived from the same
// (seed, marketKey, index) preimage never collide.
const DOMAIN_ACCOUNT_SECRET = new Fr(0x6d61726b65745f6163636f756e745f736563726574n); // "market_account_secret"
const DOMAIN_ACCOUNT_SALT = new Fr(0x6d61726b65745f6163636f756e745f73616c74n); // "market_account_salt"
const DOMAIN_ACCOUNT_SIGNING = new Fr(0x6d61726b65745f6163636f756e745f7369676e696e67n); // "market_account_signing"
// Username commitment domain (client-only; the contract stores the opaque hash).
const DOMAIN_USERNAME = new Fr(0x6d61726b65745f757365726e616d65n); // "market_username"

/** Max username length in bytes (fits one field; mirrors the contract's <=20). */
export const MAX_USERNAME_BYTES = 20;

export interface MarketAccountKeys {
  /** Privacy secret (derives nullifier/viewing keys) for createSchnorrInitializerlessAccount. */
  secret: Fr;
  /** Contract instantiation salt. */
  salt: Fr;
  /** Schnorr signing key (Grumpkin scalar). */
  signingKey: GrumpkinScalar;
}

/**
 * Deterministically derives the keys for a user's per-market account at
 * `index` on the market identified by `marketKey` (the market access secret --
 * known before the market is even deployed and to every client that holds the
 * link), from their universal `seed`. Same inputs always yield the same account
 * (hence the same address), so accounts are recoverable from the seed alone.
 * Different market or index -> an independent account with no shared key
 * material. The seed is per-USER, so different users get different accounts on
 * the same market.
 */
export async function deriveMarketAccountKeys(
  seed: FieldLike,
  marketKey: FieldLike,
  index: number = 0,
): Promise<MarketAccountKeys> {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`account index must be a non-negative integer, got ${index}`);
  }
  const s = toFr(seed, 'seed');
  const m = toFr(marketKey, 'marketKey');
  const i = new Fr(BigInt(index));

  const secret = await poseidon2Hash([s, m, i, DOMAIN_ACCOUNT_SECRET]);
  const salt = await poseidon2Hash([s, m, i, DOMAIN_ACCOUNT_SALT]);
  // Reduce a full field hash into the Grumpkin scalar field for the signing key.
  const signingField = await poseidon2Hash([s, m, i, DOMAIN_ACCOUNT_SIGNING]);
  const signingKey = GrumpkinScalar.fromBufferReduce(signingField.toBuffer());

  return { secret, salt, signingKey };
}

/** Packs a username string (<= MAX_USERNAME_BYTES UTF-8 bytes) into one field. */
export function usernameToField(username: string): Fr {
  const bytes = new TextEncoder().encode(username.trim());
  if (bytes.length === 0) {
    throw new Error('username must not be empty');
  }
  if (bytes.length > MAX_USERNAME_BYTES) {
    throw new Error(`username exceeds ${MAX_USERNAME_BYTES} bytes`);
  }
  const buf = Buffer.alloc(32);
  Buffer.from(bytes).copy(buf, 32 - bytes.length);
  return Fr.fromBufferReduce(buf);
}

/**
 * The on-chain commitment to a username on a market:
 * poseidon2([usernameField, accessSecret, DOMAIN_USERNAME]). Binding the market
 * access secret means the same username commits to different hashes on
 * different markets (no cross-market linkage of handles), and lets a buyer
 * verify a listing's "Sold by: <username>" by recomputing it and comparing to
 * the creator's on-chain username hash (get_username_hash). The plaintext
 * username is never stored on-chain.
 */
export async function deriveUsernameHash(
  username: string,
  accessSecret: FieldLike,
): Promise<Fr> {
  return poseidon2Hash([usernameToField(username), toFr(accessSecret, 'accessSecret'), DOMAIN_USERNAME]);
}
