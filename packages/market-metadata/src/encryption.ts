// Sealed (encrypted) metadata for hidden markets.
//
// Every market is hidden: the canonical metadata document never exists in
// plaintext outside the client. It is sealed with AES-256-GCM under a key
// derived from the market access secret, and the sealed bytes are stored
// directly in the Marketplace contract's public storage (AD-3):
//
//   enc_key = sha256("aztec-market/metadata-enc/v1" || secret_be32)
//   sealed  = 0x01 || iv(12 bytes, random) || AES-256-GCM(canonical bytes)
//
// GCM authentication doubles as proof-of-knowledge: a registry entry whose
// market does not decrypt under the shared secret was not created by anyone
// who knew that secret, so squatted lookup keys are detected at resolution.
//
// Uses WebCrypto (globalThis.crypto.subtle), available in Node >= 20 and all
// browsers -- no node: imports, safe for browser bundles.

import { sha256 } from '@aztec/foundation/crypto/sha256';
import { Fr } from '@aztec/foundation/curves/bn254';

import { canonicalBytes } from './canonical.js';
import { MAX_SEALED_BLOB_BYTES } from './fields.js';
import { validateMarketplaceMetadata, type MarketplaceMetadata } from './schema.js';

/** Version byte prefixed to every sealed blob for future format changes. */
export const SEALED_FORMAT_VERSION = 0x01;

const IV_LENGTH = 12;
/** Key-derivation context for marketplace metadata blobs. */
export const METADATA_KEY_INFO = 'aztec-market/metadata-enc/v1';
/** Key-derivation context for listing payload blobs (domain-separated). */
export const LISTING_KEY_INFO = 'aztec-market/listing-enc/v1';
/** Key-derivation context for custom-page body blobs (domain-separated). */
export const PAGE_KEY_INFO = 'aztec-market/page-enc/v1';
/** Key-derivation context for buyer-feedback blobs (domain-separated). */
export const FEEDBACK_KEY_INFO = 'aztec-market/feedback-enc/v1';
/** Key-derivation context for attested contact-address blobs (AD-6). */
export const CONTACT_KEY_INFO = 'aztec-market/contact-enc/v1';

async function deriveEncryptionKey(
  accessSecret: Fr,
  usage: KeyUsage,
  keyInfo: string,
): Promise<CryptoKey> {
  if (accessSecret.isZero()) {
    throw new Error('access secret must not be zero');
  }
  // Copy into fresh Uint8Arrays: WebCrypto's BufferSource requires views over
  // a plain ArrayBuffer, which Buffer/subarray views don't guarantee to TS.
  const keyBytes = new Uint8Array(
    sha256(Buffer.concat([Buffer.from(keyInfo, 'utf8'), accessSecret.toBuffer()])),
  );
  return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, [usage]);
}

export async function encryptMetadataBytes(
  plaintext: Uint8Array,
  accessSecret: Fr,
  keyInfo: string = METADATA_KEY_INFO,
): Promise<Uint8Array> {
  const key = await deriveEncryptionKey(accessSecret, 'encrypt', keyInfo);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new Uint8Array(plaintext)),
  );
  const sealed = new Uint8Array(1 + IV_LENGTH + ciphertext.length);
  sealed[0] = SEALED_FORMAT_VERSION;
  sealed.set(iv, 1);
  sealed.set(ciphertext, 1 + IV_LENGTH);
  return sealed;
}

export async function decryptMetadataBytes(
  sealed: Uint8Array,
  accessSecret: Fr,
  keyInfo: string = METADATA_KEY_INFO,
): Promise<Uint8Array> {
  if (sealed.length < 1 + IV_LENGTH + 16) {
    throw new Error(`sealed blob too short: ${sealed.length} bytes`);
  }
  if (sealed[0] !== SEALED_FORMAT_VERSION) {
    throw new Error(`unknown sealed format version ${sealed[0]}`);
  }
  const key = await deriveEncryptionKey(accessSecret, 'decrypt', keyInfo);
  const iv = new Uint8Array(sealed.subarray(1, 1 + IV_LENGTH));
  const ciphertext = new Uint8Array(sealed.subarray(1 + IV_LENGTH));
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext));
  } catch {
    // WebCrypto throws an empty OperationError; rethrow with a diagnosis.
    throw new Error(
      'metadata decryption failed: wrong access secret or tampered blob (GCM authentication failed)',
    );
  }
}

export interface SealedMetadata {
  metadata: MarketplaceMetadata;
  /** Canonical plaintext bytes (never leave the client). */
  canonical: Uint8Array;
  /** Encrypted blob -- exactly what gets stored on-chain. */
  sealed: Uint8Array;
}

/**
 * Validates, canonicalizes, and encrypts a metadata document. This is the
 * only path the Creator should use to produce on-chain bytes. The sealed
 * blob is randomized per call via the GCM IV -- two markets with identical
 * documents are unlinkable. Throws if the sealed blob exceeds the on-chain
 * size cap.
 */
export async function sealMetadata(value: unknown, accessSecret: Fr): Promise<SealedMetadata> {
  const metadata = validateMarketplaceMetadata(value);
  const canonical = canonicalBytes(metadata);
  const sealed = await encryptMetadataBytes(canonical, accessSecret);
  if (sealed.length > MAX_SEALED_BLOB_BYTES) {
    throw new Error(
      `sealed metadata is ${sealed.length} bytes, over the ${MAX_SEALED_BLOB_BYTES}-byte ` +
        'on-chain cap -- shorten the text fields',
    );
  }
  return { metadata, canonical, sealed };
}

/**
 * The Portal's opening path: decrypt, parse, validate, and require that the
 * plaintext was exactly the canonical serialization of the document. Throws
 * on wrong secret, tampering, malformed documents, or non-canonical bytes.
 */
export async function openMetadata(
  sealed: Uint8Array,
  accessSecret: Fr,
): Promise<MarketplaceMetadata> {
  const plaintext = await decryptMetadataBytes(sealed, accessSecret);
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  const metadata = validateMarketplaceMetadata(parsed);
  const recanonicalized = canonicalBytes(metadata);
  if (Buffer.compare(Buffer.from(recanonicalized), Buffer.from(plaintext)) !== 0) {
    throw new Error('sealed metadata plaintext is not in canonical form');
  }
  return metadata;
}
