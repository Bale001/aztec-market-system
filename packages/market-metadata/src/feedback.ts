// Buyer feedback (a 1-5 star rating + a short statement), sealed under the
// market access secret and stored on-chain per listing when the buyer
// finalizes an order (confirm_completion). On-chain each entry is exactly
// FEEDBACK_FIELDS field chunks holding [2-byte length header || sealed
// bytes], so the chain never stores a separate length column and outsiders
// see only opaque ciphertext.
//
// Feedback bytes are ADVERSARIAL input on read: any buyer can submit
// arbitrary chunks through confirm_completion. Readers must treat an entry
// that fails to unpack/decrypt/validate as invalid and skip it (that is a
// hostile writer, not a data error) -- see openFeedbackBlob's throw cases.

import { Fr } from '@aztec/foundation/curves/bn254';

import { canonicalBytes } from './canonical.js';
import { FEEDBACK_KEY_INFO, decryptMetadataBytes, encryptMetadataBytes } from './encryption.js';
import { bytesToFields, fieldsToBytes } from './fields.js';
import { requireExactKeys, requireInt, requireObject, requireString } from './validation.js';

export const FEEDBACK_SCHEMA_VERSION = 1;

/** Must match the contract's FEEDBACK_FIELDS (12 fields = 372 bytes). */
export const FEEDBACK_FIELDS = 12;
const FEEDBACK_FIELD_BYTES = 31;
const FEEDBACK_BLOB_BYTES = FEEDBACK_FIELDS * FEEDBACK_FIELD_BYTES; // 372
/** Sealed bytes budget: the blob minus its 2-byte length header. */
export const FEEDBACK_MAX_SEALED_BYTES = FEEDBACK_BLOB_BYTES - 2; // 370
/** Short by design: the statement must fit the on-chain blob. */
export const MAX_FEEDBACK_TEXT_CHARS = 240;

export interface FeedbackDocument {
  schemaVersion: typeof FEEDBACK_SCHEMA_VERSION;
  /** 1..5 stars. */
  rating: number;
  /** Short statement; '' for a rating-only review. */
  text: string;
}

export function validateFeedbackDocument(value: unknown): FeedbackDocument {
  const doc = requireObject(value, 'feedback');
  requireExactKeys(doc, 'feedback', ['schemaVersion', 'rating', 'text']);
  if (doc.schemaVersion !== FEEDBACK_SCHEMA_VERSION) {
    throw new Error(
      `feedback.schemaVersion must be ${FEEDBACK_SCHEMA_VERSION}, got ${String(doc.schemaVersion)}`,
    );
  }
  requireInt(doc.rating, 'feedback.rating', { min: 1, max: 5 });
  requireString(doc.text, 'feedback.text', { min: 0, max: MAX_FEEDBACK_TEXT_CHARS });
  return doc as unknown as FeedbackDocument;
}

/**
 * Validates, seals, and packs feedback into the contract's fixed
 * FEEDBACK_FIELDS-chunk blob: [len_be16 || sealed], zero-padded. The first
 * chunk is always nonzero (the contract requires that as its non-empty
 * check).
 */
export async function sealFeedbackBlob(
  feedback: { rating: number; text: string },
  accessSecret: Fr,
): Promise<Fr[]> {
  const doc = validateFeedbackDocument({
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    rating: feedback.rating,
    text: feedback.text,
  });
  const sealed = await encryptMetadataBytes(canonicalBytes(doc), accessSecret, FEEDBACK_KEY_INFO);
  if (sealed.length > FEEDBACK_MAX_SEALED_BYTES) {
    throw new Error(
      `sealed feedback is ${sealed.length} bytes, over the ${FEEDBACK_MAX_SEALED_BYTES}-byte cap`,
    );
  }
  const blob = new Uint8Array(2 + sealed.length);
  blob[0] = sealed.length >> 8;
  blob[1] = sealed.length & 0xff;
  blob.set(sealed, 2);
  const fields = bytesToFields(blob);
  if (fields.length > FEEDBACK_FIELDS) {
    throw new Error(`feedback packed into ${fields.length} fields, over ${FEEDBACK_FIELDS}`);
  }
  // Fixed width: the contract stores exactly FEEDBACK_FIELDS chunks.
  while (fields.length < FEEDBACK_FIELDS) {
    fields.push(new Fr(0n));
  }
  return fields;
}

/**
 * Unpacks + decrypts + validates one on-chain feedback entry. Throws on ANY
 * inconsistency (bad length header, wrong secret, tampered/garbage bytes,
 * out-of-range rating): callers reading listings must catch and SKIP such
 * entries -- they are hostile input from a buyer, and one griefer must not
 * blank out a listing's whole review section.
 */
export async function openFeedbackBlob(fields: Fr[], accessSecret: Fr): Promise<FeedbackDocument> {
  if (fields.length !== FEEDBACK_FIELDS) {
    throw new Error(`feedback entry has ${fields.length} fields, expected ${FEEDBACK_FIELDS}`);
  }
  const blob = fieldsToBytes(fields, FEEDBACK_BLOB_BYTES);
  const len = ((blob[0]! << 8) | blob[1]!) >>> 0;
  if (len === 0 || len > FEEDBACK_MAX_SEALED_BYTES) {
    throw new Error(`feedback length header ${len} is out of range`);
  }
  const sealed = blob.subarray(2, 2 + len);
  const plaintext = await decryptMetadataBytes(sealed, accessSecret, FEEDBACK_KEY_INFO);
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  const doc = validateFeedbackDocument(parsed);
  const recanonicalized = canonicalBytes(doc);
  if (Buffer.compare(Buffer.from(recanonicalized), Buffer.from(plaintext)) !== 0) {
    throw new Error('sealed feedback plaintext is not in canonical form');
  }
  return doc;
}
