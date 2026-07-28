// Shared presentational helpers and small components for the storefront.

import { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Fr } from '@aztec/aztec.js/fields';
import { Contract } from '@aztec/aztec.js/contracts';
import {
  ensureContractRegistered,
  getCusdcTokenArtifact,
  type CategoryPage,
  type ListingIndexEntry,
  type OrderView,
  type ResolvedMarketplace,
} from '@market/deployment';
import {
  LISTING_SCHEMA_VERSION,
  type ListingDocument,
  type ListingImage,
  type MarketplaceMetadata,
} from '@market/market-metadata';
import { DisputeOutcome, OrderStatus } from '@market/shared-types';
import { useState } from 'react';

import { roleLabel, type Role } from './identity.js';
import type { TransactionalSession } from './session.js';

// Just the verified market. Listings are NOT loaded on open -- buyers browse a
// category at a time (loadCategory), and the vendor/admin tabs load the full
// index on demand (loadAllListings). So opening a market touches no listing
// data at all, and browsing one category never scans the whole market.
export interface OpenedMarket {
  market: ResolvedMarketplace;
}

/** Lazily fetches + verifies one listing's full document from its index entry. */
export type ContentLoader = (entry: ListingIndexEntry) => Promise<ListingDocument>;

/**
 * Reads ONE page of a category's per-category on-chain index (the ACTIVE
 * listings on it + whether more pages follow). The shop fetches pages
 * incrementally as the user paginates, so browsing never scans a whole
 * category up front.
 */
/** Reads one page of a category in display order; `cursor` null starts at the top. */
export type CategoryLoader = (categoryTag: Fr, cursor: Fr | null) => Promise<CategoryPage>;

/**
 * Reads ONE vendor's listings (all statuses, records only) via the per-vendor
 * on-chain index -- for the vendor tab, admin moderation, and the public
 * "this vendor's listings" view (which filters to Active).
 */
export type VendorListingsLoader = (vendorId: Fr) => Promise<ListingIndexEntry[]>;

/**
 * Every ACTIVE listing in one category, in the order shoppers see them. Backs
 * the admin's Arrange page, which reorders exactly that sequence.
 */
export type CategoryListingsLoader = (categoryTag: Fr) => Promise<ListingIndexEntry[]>;

/** An index entry paired with its loaded document (for detail/grid rendering). */
export type ActiveListing = ListingIndexEntry & {
  listing: ListingDocument;
};

/**
 * Verifies a listing's "Sold by: <username>": true iff the creator committed
 * that exact handle on-chain (hash(username, accessSecret) == the creator's
 * on-chain username hash). A cheap simulation, no transaction.
 */
export type VendorVerifier = (creator: Fr, username: string) => Promise<boolean>;

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Units. Two different-precision quantities flow through the app and must not be
// conflated:
//   - the marketplace currency (cUSDC): 6 decimals, like Ethereum USDC.
//   - fee juice (network gas): 18 decimals, like ETH/wei -- a protocol constant.
// The SDK, contracts, and metadata all speak BASE UNITS. The UI speaks whole
// tokens and converts at the edges with these helpers -- never store or send a
// whole-token number. Token helpers default to cUSDC; fee juice has its own.
// ---------------------------------------------------------------------------

/** cUSDC decimals (the marketplace currency). */
export const TOKEN_DECIMALS = 6;
/** Fee juice decimals (network gas). Fixed by the protocol. */
export const FEE_JUICE_DECIMALS = 18;
/** One whole cUSDC in base units. */
export const TOKEN_UNIT = 10n ** BigInt(TOKEN_DECIMALS);

// Truncated formatter: whole part + up to `maxDp` fractional places (… if cut).
function formatWith(amount: bigint, decimals: number, maxDp: number): string {
  const unit = 10n ** BigInt(decimals);
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const whole = abs / unit;
  const frac = abs % unit;
  let out = whole.toString();
  if (frac !== 0n) {
    const fracTrim = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    out += '.' + (fracTrim.length > maxDp ? fracTrim.slice(0, maxDp) + '…' : fracTrim);
  }
  return (neg ? '-' : '') + out;
}

// Lossless formatter: whole part + every non-zero fractional place.
function formatExactWith(amount: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const neg = amount < 0n;
  const abs = neg ? -amount : amount;
  const whole = abs / unit;
  const frac = abs % unit;
  const sign = neg ? '-' : '';
  if (frac === 0n) {
    return sign + whole.toString();
  }
  return `${sign}${whole.toString()}.${frac.toString().padStart(decimals, '0').replace(/0+$/, '')}`;
}

// Parses a whole-token string ("1.5") into base units at `decimals`. Throws.
function parseWith(text: string, decimals: number, what: string): bigint {
  const unit = 10n ** BigInt(decimals);
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  const whole = match?.[1];
  if (match === null || whole === undefined) {
    throw new Error(`${what} must be a token amount like "1.5", got "${text}"`);
  }
  const frac = match[2] ?? '';
  if (frac.length > decimals) {
    throw new Error(`${what} has more than ${decimals} decimal places`);
  }
  return BigInt(whole) * unit + BigInt(frac.padEnd(decimals, '0') || '0');
}

/** Formats cUSDC base units as whole tokens, truncated to `maxDp` places. */
export function formatUnits(amount: bigint, maxDp = TOKEN_DECIMALS): string {
  return formatWith(amount, TOKEN_DECIMALS, maxDp);
}

/** Lossless whole-cUSDC string (trailing zeros stripped). */
export function formatUnitsExact(amount: bigint): string {
  return formatExactWith(amount, TOKEN_DECIMALS);
}

/** Parses a whole-cUSDC string ("1.5") into base units. Throws on bad input. */
export function parseUnits(text: string, what = 'amount'): bigint {
  return parseWith(text, TOKEN_DECIMALS, what);
}

/** Formats fee-juice base units (18 decimals), truncated to `maxDp` places. */
export function formatFeeJuice(amount: bigint, maxDp = 6): string {
  return formatWith(amount, FEE_JUICE_DECIMALS, maxDp);
}

/** Lossless fee-juice string (18 decimals) -- used by the spend gate. */
export function formatFeeJuiceExact(amount: bigint): string {
  return formatExactWith(amount, FEE_JUICE_DECIMALS);
}

// A colored pill for the active identity's role on a market.
export function RoleBadge({ role }: { role: Role }) {
  const label = roleLabel(role);
  const kind = role.isOwner
    ? 'owner'
    : role.moderatorPerms !== 0n
      ? 'moderator'
      : label.startsWith('Vendor')
        ? 'vendor'
        : 'buyer';
  return <span className={`role-badge role-${kind}`}>{label}</span>;
}

// A deterministic placeholder image derived from the item title. Real listing
// images are deferred (AD-3): this keeps the storefront looking like a
// storefront until off-chain image storage lands.
export function Thumb({ title, size = 72 }: { title: string; size?: number }) {
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash * 31 + title.charCodeAt(i)) | 0;
  }
  const hue = ((hash % 360) + 360) % 360;
  const initials = title
    .split(/\s+/)
    .slice(0, 2)
    .map(w => w[0] ?? '')
    .join('')
    .toUpperCase();
  return (
    <div
      className="thumb"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${hue} 55% 62%), hsl(${(hue + 40) % 360} 55% 48%))`,
      }}
      aria-hidden
    >
      <span>{initials}</span>
    </div>
  );
}

export function describeOrder(o: OrderView): string {
  if (o.settled) {
    // A settled order is a refund iff its final state was REFUND_BUYER
    // (derived from public state; both close with the same nullifier).
    return o.statuses.includes(OrderStatus.Refunded) ? 'Refunded' : 'Settled';
  }
  // REFUND_BUYER (from a vendor offer or an arbiter ruling) means the buyer can
  // now claim; PAY_VENDOR means the vendor can settle.
  if (o.disputeOutcome === DisputeOutcome.RefundBuyer) return 'Refund available';
  if (o.disputeOutcome === DisputeOutcome.PayVendor) return 'Ruled: pay vendor';
  if (o.disputed) return 'Disputed';
  return o.accepted ? 'Accepted' : 'Awaiting vendor';
}

export function PolicyBlock({ label, text }: { label: string; text: string | null }) {
  if (text === null) {
    return null;
  }
  return (
    <div className="policy">
      <h4>{label}</h4>
      <p>{text}</p>
    </div>
  );
}

// Registers the payment token (cUSDC = the aztec-standards Token) with the
// session's PXE and returns a generic binding to it (its methods are
// transfer_private_to_private, transfer_private_to_public, balance_of_private,
// ...). Callers build escrow/deposit interactions off this.
export async function paymentToken(session: TransactionalSession, metadata: MarketplaceMetadata) {
  const tokenAddress = AztecAddress.fromStringUnsafe(metadata.onchain.paymentAsset);
  const artifact = await getCusdcTokenArtifact();
  await ensureContractRegistered(
    session.wallet,
    session.node,
    tokenAddress,
    artifact,
    'cUSDC (payment asset)',
  );
  return Contract.at(tokenAddress, artifact, session.wallet);
}

/** One priced row in the form, with the price still as typed (whole cUSDC). */
export interface PriceRowForm {
  label: string;
  price: string;
}

export interface ListingFormState {
  title: string;
  description: string;
  /**
   * Variants, priced. Always at least one row -- a listing with a single
   * unnamed row is an ordinary single-price listing, which is what the form
   * starts as.
   */
  options: PriceRowForm[];
  /** Shipping methods, priced. At least one row; price '0' for free. */
  shipping: PriceRowForm[];
  /** The listing's single category (from the market's category list, or ''). */
  category: string;
  /** Inline images (stored full-size in the sealed doc, uploaded to Arweave). */
  images: ListingImage[];
}

// Starts as a plain single-price listing: one unnamed variant, one free
// shipping method. Adding rows is what turns it into a multi-option listing.
export const EMPTY_LISTING_FORM: ListingFormState = {
  title: '',
  description: '',
  options: [{ label: '', price: '' }],
  shipping: [{ label: 'Standard', price: '0' }],
  category: '',
  images: [],
};

/** Loads an existing listing back into the form for editing. */
export function listingToForm(doc: ListingDocument): ListingFormState {
  return {
    title: doc.title,
    description: doc.description,
    options: doc.options.map(o => ({ label: o.label, price: formatUnits(BigInt(o.price)) })),
    shipping: doc.shipping.map(o => ({ label: o.label, price: formatUnits(BigInt(o.price)) })),
    category: doc.category,
    images: doc.images,
  };
}

export function formToListingDocument(
  form: ListingFormState,
  vendorInbox: string,
  username: string,
  contactAddress: string,
): ListingDocument {
  return {
    schemaVersion: LISTING_SCHEMA_VERSION,
    title: form.title,
    description: form.description,
    // The form is whole cUSDC; the listing document stores base units.
    //
    // ROW ORDER IS PRESERVED and matters: the on-chain commitment binds these
    // prices in this order, and an order records the buyer's choice as an index
    // into these lists.
    options: form.options.map((row, i) => ({
      label: row.label.trim(),
      price: parseUnits(row.price, `options[${i}].price`).toString(),
    })),
    shipping: form.shipping.map((row, i) => ({
      label: row.label.trim(),
      price: parseUnits(row.price, `shipping[${i}].price`).toString(),
    })),
    category: form.category.trim(),
    // The vendor's public handle, verified against the on-chain commitment when
    // buyers view the listing ("Sold by: <username>").
    username,
    images: form.images,
    vendorInbox,
    // The vendor's messaging contact address, created automatically by the
    // app's embedded messaging core -- what "Message the vendor" connects to.
    // Sealed with the document, so only link holders ever see it.
    simplexAddress: contactAddress,
  };
}

/** Reads a File into a ListingImage (base64, no data-URL prefix). */
export async function fileToListingImage(file: File): Promise<ListingImage> {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    throw new Error(`${file.name}: only PNG, JPEG, WebP, or GIF images are allowed`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return { mime: file.type, dataBase64: btoa(binary) };
}

/** A ListingImage as a data URL for <img src>. */
export function imageDataUrl(image: ListingImage): string {
  return `data:${image.mime};base64,${image.dataBase64}`;
}

