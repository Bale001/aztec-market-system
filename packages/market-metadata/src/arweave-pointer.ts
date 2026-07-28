// The encrypted Arweave pointer: the ONLY on-chain trace of a listing's
// content. An Arweave transaction id is 32 bytes (43 base64url chars); sealed
// under the market link key it becomes exactly 61 bytes
// (version(1) || iv(12) || GCM(ct 32 + tag 16)), which packs into two fields.
// Only link holders can decrypt the pointer, and the Arweave tx id is itself a
// hash of the content, so the pointer doubles as an integrity commitment: the
// bytes fetched under that id ARE the bytes the vendor sealed.

import type { Fr } from '@aztec/foundation/curves/bn254';

import { decryptMetadataBytes, encryptMetadataBytes } from './encryption.js';

/** Key-derivation context for listing pointer blobs (domain-separated). */
export const LISTING_POINTER_KEY_INFO = 'aztec-market/listing-ptr-enc/v1';

/** Sealed pointer size: version(1) + iv(12) + txid(32) + gcm tag(16). */
export const POINTER_SEALED_BYTES = 61;
/** Packed into 31-byte field chunks: ceil(61/31) = 2 fields. */
export const POINTER_FIELDS = 2;

const TX_ID_BYTES = 32;
const TX_ID_CHARS = 43;

// Manual base64url conversion: the browser Buffer polyfill does not reliably
// support the 'base64url' encoding name, so convert via plain base64.
function txIdToBytes(txId: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(txId)) {
    throw new Error(`not an Arweave transaction id: "${txId}"`);
  }
  const base64 = txId.replace(/-/g, '+').replace(/_/g, '/') + '=';
  const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
  if (bytes.length !== TX_ID_BYTES) {
    throw new Error(`Arweave tx id decoded to ${bytes.length} bytes, expected ${TX_ID_BYTES}`);
  }
  return bytes;
}

function bytesToTxId(bytes: Uint8Array): string {
  if (bytes.length !== TX_ID_BYTES) {
    throw new Error(`Arweave tx id must be ${TX_ID_BYTES} bytes, got ${bytes.length}`);
  }
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, TX_ID_CHARS);
}

/** Seals an Arweave tx id under the market link key: exactly 61 bytes. */
export async function sealArweavePointer(txId: string, accessSecret: Fr): Promise<Uint8Array> {
  const sealed = await encryptMetadataBytes(
    txIdToBytes(txId),
    accessSecret,
    LISTING_POINTER_KEY_INFO,
  );
  if (sealed.length !== POINTER_SEALED_BYTES) {
    throw new Error(`sealed pointer is ${sealed.length} bytes, expected ${POINTER_SEALED_BYTES}`);
  }
  return sealed;
}

/**
 * Opens a sealed pointer back into the Arweave tx id. Throws on the wrong
 * access secret or a tampered pointer (GCM authentication).
 */
export async function openArweavePointer(sealed: Uint8Array, accessSecret: Fr): Promise<string> {
  if (sealed.length !== POINTER_SEALED_BYTES) {
    throw new Error(
      `sealed pointer must be ${POINTER_SEALED_BYTES} bytes, got ${sealed.length} — ` +
        'not an Arweave listing pointer',
    );
  }
  return bytesToTxId(await decryptMetadataBytes(sealed, accessSecret, LISTING_POINTER_KEY_INFO));
}
