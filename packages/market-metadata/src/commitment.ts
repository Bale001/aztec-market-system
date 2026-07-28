// Content hash + on-chain commitment for the canonical metadata document.
//
// contentHash = sha256(canonicalBytes(metadata))            (32 bytes)
// commitment  = poseidon2([hash_hi128, hash_lo128, DOMAIN_METADATA])
//
// The sha256 is split big-endian into two 128-bit halves so it fits into
// BN254 field elements. Mirrors market_protocol::derive_metadata_commitment
// (Noir); cross-language vectors are pinned in both test suites.

import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import { sha256 } from '@aztec/foundation/crypto/sha256';
import { Fr } from '@aztec/foundation/curves/bn254';
import { DOMAIN_METADATA } from '@market/shared-types';

import { canonicalBytes } from './canonical.js';
import { validateMarketplaceMetadata, type MarketplaceMetadata } from './schema.js';

export function computeContentHash(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(sha256(Buffer.from(bytes)));
}

export async function computeMetadataCommitment(contentHash: Uint8Array): Promise<Fr> {
  if (contentHash.length !== 32) {
    throw new Error(`content hash must be 32 bytes, got ${contentHash.length}`);
  }
  const hi = bytesToBigInt(contentHash.subarray(0, 16));
  const lo = bytesToBigInt(contentHash.subarray(16, 32));
  return poseidon2Hash([new Fr(hi), new Fr(lo), new Fr(DOMAIN_METADATA)]);
}

export interface CommittedMetadata {
  metadata: MarketplaceMetadata;
  /** Canonical serialized bytes — exactly what gets published and hashed. */
  canonical: Uint8Array;
  /** sha256 of the canonical bytes, lowercase hex without 0x. */
  contentHashHex: string;
  /** Field element stored on-chain. */
  commitment: Fr;
}

/**
 * Validates, canonicalizes, hashes, and commits a metadata document in one
 * step. This is the only path the Creator should use to produce the bytes it
 * publishes — anything else risks a commitment mismatch.
 */
export async function commitMetadata(value: unknown): Promise<CommittedMetadata> {
  const metadata = validateMarketplaceMetadata(value);
  const canonical = canonicalBytes(metadata);
  const contentHash = computeContentHash(canonical);
  const commitment = await computeMetadataCommitment(contentHash);
  return {
    metadata,
    canonical,
    contentHashHex: Buffer.from(contentHash).toString('hex'),
    commitment,
  };
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}
