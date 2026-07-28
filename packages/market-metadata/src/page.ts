// Custom-page bodies, sealed like listings and stored on Arweave.
//
// The market's sealed metadata document keeps only each page's title and the
// Arweave storage id of its body (schema v2). The body itself is public bytes
// on Arweave, so it is AEAD-sealed under the market access secret with its
// own key-derivation domain (PAGE_KEY_INFO) -- readable only by link holders,
// and domain-separated from the metadata and listing blob families.

import type { Fr } from '@aztec/foundation/curves/bn254';

import { canonicalBytes } from './canonical.js';
import { PAGE_KEY_INFO, decryptMetadataBytes, encryptMetadataBytes } from './encryption.js';
import { requireExactKeys, requireObject, requireString } from './validation.js';

export const PAGE_SCHEMA_VERSION = 1;

/** Body size cap: generous, since the body lives off-chain. */
export const MAX_PAGE_BODY_CHARS = 100_000;

interface PageDocument {
  schemaVersion: typeof PAGE_SCHEMA_VERSION;
  /** Plain-text body (newlines preserved when rendered). */
  body: string;
}

function validatePageDocument(value: unknown): PageDocument {
  const doc = requireObject(value, 'page');
  requireExactKeys(doc, 'page', ['schemaVersion', 'body']);
  if (doc.schemaVersion !== PAGE_SCHEMA_VERSION) {
    throw new Error(
      `page.schemaVersion must be ${PAGE_SCHEMA_VERSION}, got ${String(doc.schemaVersion)}`,
    );
  }
  requireString(doc.body, 'page.body', { min: 1, max: MAX_PAGE_BODY_CHARS });
  return doc as unknown as PageDocument;
}

/** Seals a page body for upload; the returned bytes are what goes to Arweave. */
export async function sealPageBody(body: string, accessSecret: Fr): Promise<Uint8Array> {
  const doc = validatePageDocument({ schemaVersion: PAGE_SCHEMA_VERSION, body });
  return encryptMetadataBytes(canonicalBytes(doc), accessSecret, PAGE_KEY_INFO);
}

/**
 * Opens a sealed page body fetched from Arweave: decrypt, parse, validate,
 * and require canonical plaintext. Throws on a wrong secret, tampering, or a
 * malformed document.
 */
export async function openPageBody(sealed: Uint8Array, accessSecret: Fr): Promise<string> {
  const plaintext = await decryptMetadataBytes(sealed, accessSecret, PAGE_KEY_INFO);
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  const doc = validatePageDocument(parsed);
  const recanonicalized = canonicalBytes(doc);
  if (Buffer.compare(Buffer.from(recanonicalized), Buffer.from(plaintext)) !== 0) {
    throw new Error('sealed page plaintext is not in canonical form');
  }
  return doc.body;
}
