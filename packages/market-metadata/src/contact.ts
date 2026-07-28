// Attested contact addresses (AD-6): the sealed SimpleX address an identity
// publishes on-chain via set_contact_address. The chain stores opaque
// ciphertext in the identity's bucket (byte length at key 0, 31-byte chunks
// from key 1), so only link holders can read WHO can be reached and where;
// the contract's identity auth is what binds the address to the pseudonym.
//
// Contact blobs are semi-trusted on read: only the identity's secret holder
// can write them, but nothing stops a hostile participant publishing
// garbage. openContactAddress therefore throws on anything malformed -- the
// caller decides whether that identity's contact is simply unusable.

import type { Fr } from '@aztec/foundation/curves/bn254';

import { canonicalBytes } from './canonical.js';
import { CONTACT_KEY_INFO, decryptMetadataBytes, encryptMetadataBytes } from './encryption.js';
import { requireExactKeys, requireObject, requireString } from './validation.js';

export const CONTACT_SCHEMA_VERSION = 1;

/** Must match the contract's CONTACT_MAX_FIELDS (32 fields = 992 bytes). */
export const CONTACT_MAX_FIELDS = 32;
export const CONTACT_MAX_SEALED_BYTES = CONTACT_MAX_FIELDS * 31; // 992

/**
 * Address length cap, sized so the sealed blob (29 bytes AEAD overhead +
 * the canonical JSON wrapper) always fits the on-chain 992-byte budget.
 * Full-length SimpleX contact links are ~400-500 characters.
 */
export const MAX_CONTACT_ADDRESS_CHARS = 850;

interface ContactDocument {
  schemaVersion: typeof CONTACT_SCHEMA_VERSION;
  /** The SimpleX contact/business address link. */
  address: string;
}

function validateContactDocument(value: unknown): ContactDocument {
  const doc = requireObject(value, 'contact');
  requireExactKeys(doc, 'contact', ['schemaVersion', 'address']);
  if (doc.schemaVersion !== CONTACT_SCHEMA_VERSION) {
    throw new Error(
      `contact.schemaVersion must be ${CONTACT_SCHEMA_VERSION}, got ${String(doc.schemaVersion)}`,
    );
  }
  requireString(doc.address, 'contact.address', { min: 1, max: MAX_CONTACT_ADDRESS_CHARS });
  return doc as unknown as ContactDocument;
}

/** Seals a contact address for set_contact_address; throws if it cannot fit. */
export async function sealContactAddress(address: string, accessSecret: Fr): Promise<Uint8Array> {
  const doc = validateContactDocument({
    schemaVersion: CONTACT_SCHEMA_VERSION,
    address: address.trim(),
  });
  const sealed = await encryptMetadataBytes(canonicalBytes(doc), accessSecret, CONTACT_KEY_INFO);
  if (sealed.length > CONTACT_MAX_SEALED_BYTES) {
    throw new Error(
      `sealed contact address is ${sealed.length} bytes; the on-chain cap is ${CONTACT_MAX_SEALED_BYTES}`,
    );
  }
  return sealed;
}

/**
 * Opens a sealed contact blob read from the chain. Throws on a wrong secret,
 * tampering, or a malformed document.
 */
export async function openContactAddress(sealed: Uint8Array, accessSecret: Fr): Promise<string> {
  const plaintext = await decryptMetadataBytes(sealed, accessSecret, CONTACT_KEY_INFO);
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  const doc = validateContactDocument(parsed);
  const recanonicalized = canonicalBytes(doc);
  if (Buffer.compare(Buffer.from(recanonicalized), Buffer.from(plaintext)) !== 0) {
    throw new Error('sealed contact plaintext is not in canonical form');
  }
  return doc.address;
}
