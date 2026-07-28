// Canonical listing document, sealed like marketplace metadata (AD-2) and
// stored in the Marketplace contract's public storage (AD-3).
//
// Listing content never exists in plaintext outside clients holding the
// market link: the chain stores the sealed blob plus a status flag. The seal
// key is derived from the same market access secret as the metadata key but
// with a different derivation context, so the two blob families are
// domain-separated.
//
// Prices are decimal strings in base units of the payment asset; the order
// flow binds them cryptographically via price commitments (AD-4/AD-5). A
// listing prices two independent choices -- which variant, and which shipping
// method -- and ONE on-chain commitment covers the whole table, so every price
// a buyer could pay is bound by it. The
// document also carries the vendor's ORDER INBOX address: buyers direct
// their encrypted order notes there. It is visible to link holders only
// (the document is sealed); vendors are advised to use a dedicated account
// per market rather than their main wallet.

import type { Fr } from '@aztec/foundation/curves/bn254';

import { canonicalBytes } from './canonical.js';
import {
  LISTING_KEY_INFO,
  decryptMetadataBytes,
  encryptMetadataBytes,
} from './encryption.js';
import {
  DECIMAL,
  FIELD_HEX,
  requireExactKeys,
  requireObject,
  requirePattern,
  requireString,
  requireStringOrNull,
} from './validation.js';

export const LISTING_SCHEMA_VERSION = 5;

/** Max username length (bytes); mirrors @market/identity MAX_USERNAME_BYTES. */
export const MAX_USERNAME_BYTES = 20;

/** An inline listing image, carried inside the sealed document. */
export interface ListingImage {
  /** image/png, image/jpeg, image/webp, or image/gif. */
  mime: string;
  /** Raw image bytes, base64 (not a data URL). */
  dataBase64: string;
}

const IMAGE_MIME = /^image\/(png|jpeg|webp|gif)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** Per-image cap on base64 chars (~6 MB of image bytes). */
export const MAX_IMAGE_BASE64_CHARS = 8_000_000;
export const MAX_LISTING_IMAGES = 6;
/**
 * Sanity cap on a sealed listing blob (Arweave has no meaningful limit at our
 * sizes; this catches runaway documents before an accidental huge upload).
 */
export const MAX_ARWEAVE_LISTING_BYTES = 25 * 1024 * 1024;

/**
 * One priced row: a variant of the item, or a shipping method.
 *
 * `price` is u128 base units of the payment asset as a decimal string, like
 * every other amount in these documents.
 */
export interface ListingPriceOption {
  /** Shown to buyers ('Large', 'Express'). May be '' for a sole unnamed row. */
  label: string;
  price: string;
}

export interface ListingDocument {
  schemaVersion: typeof LISTING_SCHEMA_VERSION;
  title: string;
  description: string;
  /**
   * What the listing sells, priced per variant. At least one row; a listing
   * with a single unnamed row is an ordinary single-price listing.
   *
   * ORDER MATTERS. The on-chain price commitment binds these prices IN THIS
   * ORDER, and an order records the buyer's choice as an index into this list,
   * so reordering or removing a row re-points existing orders. Editing a
   * listing re-commits, which is what keeps the two in step.
   */
  options: ListingPriceOption[];
  /**
   * How it can be shipped, priced per method. At least one row; use a single
   * row priced '0' for free shipping. Charged ONCE per order -- only the item
   * scales with quantity. Same ordering rule as `options`.
   */
  shipping: ListingPriceOption[];
  /**
   * The listing's single category. Should be one of the market's declared
   * categories (metadata.categories) so its on-chain tag matches the filter;
   * '' means uncategorized. Kept in the sealed doc for display; the on-chain
   * record stores only the salted tag.
   */
  category: string;
  /**
   * The vendor's public handle, shown as "Sold by: <username>". Sealed with the
   * document like everything else, so only link holders see it. It is bound to
   * the market: a buyer verifies it by recomputing hash(username, accessSecret)
   * and comparing to the creator's on-chain username hash (get_username_hash) --
   * so a listing cannot claim a handle its creator did not register on-chain.
   */
  username: string;
  /** Inline images; the whole document lives off-chain (Arweave), so size is free. */
  images: ListingImage[];
  /**
   * The vendor's order inbox: the Aztec address buyers send their encrypted
   * order notes to (AD-5). Sealed with the rest of the document, so only
   * link holders ever see it.
   */
  vendorInbox: string;
  /**
   * Optional SimpleX Chat address for contacting the vendor (AD-6). Sealed;
   * buyers authenticate in the chat by sending their order_id, which only
   * the order's two parties know. Vendors should create one address per
   * market.
   */
  simplexAddress: string | null;
}

/**
 * The caps mirror the circuit: `place_order` proves the whole price table
 * against a fixed-size preimage, so a document that exceeds them could be
 * sealed but never bought.
 */
export const MAX_PRICE_OPTIONS = 8;
export const MAX_SHIPPING_OPTIONS = 4;

function validatePriceRows(value: unknown, where: string, max: number): void {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) {
    throw new Error(`${where} must be an array of 1..${max} priced rows`);
  }
  for (let i = 0; i < value.length; i++) {
    const row = requireObject(value[i], `${where}[${i}]`);
    requireExactKeys(row, `${where}[${i}]`, ['label', 'price']);
    requireString(row.label, `${where}[${i}].label`, { min: 0, max: 64 });
    requirePattern(row.price, `${where}[${i}].price`, DECIMAL, 'decimal string');
  }
}

/**
 * The price a listing is advertised at: its cheapest variant, shipping
 * excluded. What a browsing buyer sees before choosing anything.
 */
export function listingFromPrice(listing: ListingDocument): bigint {
  return listing.options.reduce(
    (low, o) => (BigInt(o.price) < low ? BigInt(o.price) : low),
    BigInt(listing.options[0]!.price),
  );
}

/** True when there is nothing for the buyer to choose between. */
export function listingHasChoices(listing: ListingDocument): boolean {
  return listing.options.length > 1 || listing.shipping.length > 1;
}

export function validateListingDocument(value: unknown): ListingDocument {
  const doc = requireObject(value, 'listing');

  requireExactKeys(doc, 'listing', [
    'schemaVersion',
    'title',
    'description',
    'options',
    'shipping',
    'category',
    'username',
    'images',
    'vendorInbox',
    'simplexAddress',
  ]);

  if (doc.schemaVersion !== LISTING_SCHEMA_VERSION) {
    throw new Error(
      `listing.schemaVersion must be ${LISTING_SCHEMA_VERSION}, got ${String(doc.schemaVersion)}`,
    );
  }

  requireString(doc.title, 'listing.title', { min: 1, max: 96 });
  requireString(doc.description, 'listing.description', { min: 0, max: 4000 });
  validatePriceRows(doc.options, 'listing.options', MAX_PRICE_OPTIONS);
  validatePriceRows(doc.shipping, 'listing.shipping', MAX_SHIPPING_OPTIONS);
  requireString(doc.category, 'listing.category', { min: 0, max: 64 });
  requireString(doc.username, 'listing.username', { min: 1, max: MAX_USERNAME_BYTES });
  if (!Array.isArray(doc.images) || doc.images.length > MAX_LISTING_IMAGES) {
    throw new Error(`listing.images must be an array of at most ${MAX_LISTING_IMAGES} images`);
  }
  for (let i = 0; i < doc.images.length; i++) {
    const image = requireObject(doc.images[i], `listing.images[${i}]`);
    requireExactKeys(image, `listing.images[${i}]`, ['mime', 'dataBase64']);
    requirePattern(image.mime, `listing.images[${i}].mime`, IMAGE_MIME, 'image MIME type');
    requireString(image.dataBase64, `listing.images[${i}].dataBase64`, {
      min: 1,
      max: MAX_IMAGE_BASE64_CHARS,
    });
    requirePattern(
      image.dataBase64,
      `listing.images[${i}].dataBase64`,
      BASE64,
      'base64 (no data-URL prefix)',
    );
  }
  requirePattern(doc.vendorInbox, 'listing.vendorInbox', FIELD_HEX, '0x-hex field element');
  requireStringOrNull(doc.simplexAddress, 'listing.simplexAddress', { min: 1, max: 1024 });

  return doc as unknown as ListingDocument;
}

export interface SealedListing {
  listing: ListingDocument;
  /** Canonical plaintext bytes (never leave the client). */
  canonical: Uint8Array;
  /** Encrypted blob -- exactly what gets uploaded to Arweave. */
  sealed: Uint8Array;
}

/**
 * Validates, canonicalizes, and encrypts a listing document. The blob lives
 * on Arweave (not on-chain), so there is no hard size cap -- only a sanity
 * limit against runaway documents.
 */
export async function sealListing(value: unknown, accessSecret: Fr): Promise<SealedListing> {
  const listing = validateListingDocument(value);
  const canonical = canonicalBytes(listing);
  const sealed = await encryptMetadataBytes(canonical, accessSecret, LISTING_KEY_INFO);
  if (sealed.length > MAX_ARWEAVE_LISTING_BYTES) {
    throw new Error(
      `sealed listing is ${sealed.length} bytes, over the ${MAX_ARWEAVE_LISTING_BYTES}-byte ` +
        'sanity cap -- reduce image sizes',
    );
  }
  return { listing, canonical, sealed };
}

/**
 * The Portal's opening path for listings: decrypt, parse, validate, and
 * require canonical plaintext. Throws on wrong secret, tampering, malformed
 * documents, or non-canonical bytes.
 */
export async function openListing(sealed: Uint8Array, accessSecret: Fr): Promise<ListingDocument> {
  const plaintext = await decryptMetadataBytes(sealed, accessSecret, LISTING_KEY_INFO);
  const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  const listing = validateListingDocument(parsed);
  const recanonicalized = canonicalBytes(listing);
  if (Buffer.compare(Buffer.from(recanonicalized), Buffer.from(plaintext)) !== 0) {
    throw new Error('sealed listing plaintext is not in canonical form');
  }
  return listing;
}

export function sampleListingDocument(): ListingDocument {
  return {
    schemaVersion: LISTING_SCHEMA_VERSION,
    title: 'Mechanical keyboard, 65%',
    description: 'Hot-swappable switches, aluminium case. Ships worldwide.',
    options: [
      { label: 'Tactile switches', price: '125000000' },
      { label: 'Linear switches', price: '132000000' },
    ],
    shipping: [
      { label: 'Standard', price: '0' },
      { label: 'Tracked express', price: '8000000' },
    ],
    category: 'electronics',
    username: 'keebmaker',
    images: [],
    vendorInbox: '0x1e4d0b',
    simplexAddress: null,
  };
}
