// Listing pipeline (M3, AD-3, M4/AD-4): seal -> store on-chain through the
// vendor's PRIVATE entry, and the Portal's enumeration + verified opening
// path. Everything lives in the Marketplace contract's storage; there is no
// off-chain publisher. Every listing carries a public price commitment
// (AD-4) that link holders verify against the sealed price and that buyers
// will open in-circuit when funding orders (M5). Follows the same
// verify-everything rules as deploy.ts; throws on the first inconsistency.

import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { MarketplaceContract } from '@market/contract-bindings';
import { deriveCategoryTag, derivePriceBlinding, derivePriceCommitment } from '@market/identity';
import {
  bytesToFields,
  fieldsToBytes,
  openArweavePointer,
  openListing,
  POINTER_SEALED_BYTES,
  sealArweavePointer,
  sealListing,
  type ListingDocument,
} from '@market/market-metadata';
import { ListingStatus } from '@market/shared-types';

import { asBigInt } from './deploy.js';
import { sendActingAs } from './act.js';
import { ensureContractRegistered, type RegistersContracts } from './register.js';

/**
 * Uploads sealed listing bytes to permanent off-chain storage and returns the
 * 43-char storage id. Injected by the caller so this package stays free of the
 * Arweave SDK (kept out of the browser wallet bundle).
 */
export type UploadPayload = (sealed: Uint8Array) => Promise<string>;

/** Fetches the sealed bytes previously stored under `storageId`. */
export type FetchPayload = (storageId: string) => Promise<Uint8Array>;

interface OnchainListingRecord {
  creator: bigint;
  status: bigint;
  price_commitment: Fr | bigint;
  pointer_0: Fr | bigint;
  pointer_1: Fr | bigint;
  category_tag: Fr | bigint;
}

function asFr(value: Fr | bigint): Fr {
  return value instanceof Fr ? value : new Fr(value);
}

/** Packs the record's two pointer fields back into the 61-byte sealed pointer. */
function pointerBytes(record: OnchainListingRecord): Uint8Array {
  const p0 = record.pointer_0 instanceof Fr ? record.pointer_0 : new Fr(record.pointer_0);
  const p1 = record.pointer_1 instanceof Fr ? record.pointer_1 : new Fr(record.pointer_1);
  return fieldsToBytes([p0, p1], POINTER_SEALED_BYTES);
}

/** Packs a 61-byte sealed pointer into the contract's [Field; 2] argument. */
function toPointerFields(pointer: Uint8Array): [bigint, bigint] {
  const fields = bytesToFields(pointer);
  if (fields.length !== 2) {
    throw new Error(`sealed pointer packed into ${fields.length} fields, expected 2`);
  }
  return [fields[0]!.toBigInt(), fields[1]!.toBigInt()];
}

function commitmentFr(record: OnchainListingRecord): Fr {
  return record.price_commitment instanceof Fr
    ? record.price_commitment
    : new Fr(record.price_commitment);
}

/**
 * The price TABLE a commitment binds: every variant price, then every shipping
 * price, in document order. Order is load-bearing -- an order records the
 * buyer's choice as an index into these lists.
 */
export function priceTable(listing: ListingDocument): {
  optionPrices: Fr[];
  shippingPrices: Fr[];
} {
  return {
    optionPrices: listing.options.map(o => new Fr(BigInt(o.price))),
    shippingPrices: listing.shipping.map(o => new Fr(BigInt(o.price))),
  };
}

/** The commitment for a listing's whole price table, under its blinding. */
export async function listingPriceCommitment(
  listing: ListingDocument,
  blinding: Fr,
): Promise<Fr> {
  const { optionPrices, shippingPrices } = priceTable(listing);
  return derivePriceCommitment(optionPrices, shippingPrices, blinding);
}

export interface CreateListingOptions {
  wallet: Wallet & RegistersContracts;
  /** Node the wallet is connected to; used to register contract instances. */
  node: AztecNode;
  from: AztecAddress;
  /** Who sends and pays (defaults to `from`); see sendActingAs. */
  sender?: AztecAddress;
  fee?: { paymentMethod: FeePaymentMethod };
  marketplaceAddress: AztecAddress;
  /** Full listing document (unknown until validated). */
  listing: unknown;
  /** The market access secret; seals the payload and blinds the price. */
  accessSecret: Fr;
  /** Uploads the sealed listing bytes to Arweave; returns the storage id. */
  uploadPayload: UploadPayload;
  txTimeoutSeconds?: number;
}

export interface CreatedListing {
  listingId: bigint;
  txHash: string;
}

export async function createListing(options: CreateListingOptions): Promise<CreatedListing> {
  const { wallet, node, from, marketplaceAddress, listing, accessSecret } = options;

  await ensureContractRegistered(
    wallet,
    node,
    marketplaceAddress,
    MarketplaceContract.artifact,
    'marketplace',
  );

  // Seal the full document (incl. images) and upload it off-chain; on-chain we
  // store only the encrypted pointer to it. Commit to the price under a
  // blinding bound to the id this listing is expected to get; the contract
  // rejects the tx if a concurrent creation shifted the id.
  const sealed = await sealListing(listing, accessSecret);
  const storageId = await options.uploadPayload(sealed.sealed);
  const pointer = await sealArweavePointer(storageId, accessSecret);
  const pointerFields = toPointerFields(pointer);
  const categoryTag = await deriveCategoryTag(accessSecret, sealed.listing.category);

  const marketplace = await MarketplaceContract.at(marketplaceAddress, wallet);
  // Listing ids are 1-based (0 is the null terminator of the ordering chain),
  // so the next id is the count plus one.
  const expectedId =
    asBigInt(
      (await marketplace.methods.get_listing_count().simulate({ from })).result,
      'get_listing_count',
    ) + 1n;
  const blinding = await derivePriceBlinding(accessSecret, expectedId);
  const commitment = await listingPriceCommitment(sealed.listing, blinding);

  const { txHash } = await sendActingAs(options, (account, nonce) =>
    marketplace.methods.create_listing(
      expectedId,
      pointerFields,
      commitment,
      categoryTag,
      account,
      nonce,
    ),
  );

  // Read the record back and require the pointer decodes to OUR storage id and
  // the price commitment is ours.
  const record = (await marketplace.methods.get_listing(new Fr(expectedId)).simulate({ from }))
    .result as OnchainListingRecord;
  const storedId = await openArweavePointer(pointerBytes(record), accessSecret);
  if (storedId !== storageId || !commitmentFr(record).equals(commitment)) {
    throw new Error(
      `listing ${expectedId} does not hold our pointer and price commitment -- ` +
        're-read the listing index',
    );
  }

  return { listingId: expectedId, txHash };
}

export interface UpdateListingOptions extends CreateListingOptions {
  listingId: bigint;
}

/** Replaces a listing's off-chain payload (re-uploaded) + price commitment (creator only). */
export async function updateListing(options: UpdateListingOptions): Promise<{ txHash: string }> {
  const { wallet, node, marketplaceAddress, listing, accessSecret } = options;

  await ensureContractRegistered(
    wallet,
    node,
    marketplaceAddress,
    MarketplaceContract.artifact,
    'marketplace',
  );

  const sealed = await sealListing(listing, accessSecret);
  const storageId = await options.uploadPayload(sealed.sealed);
  const pointerFields = toPointerFields(await sealArweavePointer(storageId, accessSecret));
  const categoryTag = await deriveCategoryTag(accessSecret, sealed.listing.category);
  const blinding = await derivePriceBlinding(accessSecret, options.listingId);
  const commitment = await listingPriceCommitment(sealed.listing, blinding);

  const marketplace = await MarketplaceContract.at(marketplaceAddress, wallet);
  return sendActingAs(options, (account, nonce) =>
    marketplace.methods.update_listing_payload(
      new Fr(options.listingId),
      pointerFields,
      commitment,
      categoryTag,
      account,
      nonce,
    ),
  );
}

/** Vendor self-service status change (active <-> paused, or removed). */
export async function setListingStatusAsVendor(options: {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  /** Who sends and pays (defaults to `from`); see sendActingAs. */
  sender?: AztecAddress;
  fee?: { paymentMethod: FeePaymentMethod };
  marketplaceAddress: AztecAddress;
  listingId: bigint;
  status: ListingStatus.Active | ListingStatus.Paused | ListingStatus.Removed;
  txTimeoutSeconds?: number;
}): Promise<{ txHash: string }> {
  const { wallet, node, marketplaceAddress, listingId, status } = options;
  await ensureContractRegistered(
    wallet,
    node,
    marketplaceAddress,
    MarketplaceContract.artifact,
    'marketplace',
  );
  const marketplace = await MarketplaceContract.at(marketplaceAddress, wallet);
  return sendActingAs(options, (account, nonce) =>
    marketplace.methods.set_listing_status_as_vendor(new Fr(listingId), status, account, nonce),
  );
}

/**
 * A cheap listing index entry: everything readable straight from the on-chain
 * record, WITHOUT an Arweave fetch. Enough to enumerate, category-filter, and
 * paginate thousands of listings; the content is fetched lazily per page with
 * {@link resolveListingContent}. `pointer` is kept so the content fetch does
 * not re-read the record.
 */
export interface ListingIndexEntry {
  listingId: bigint;
  status: ListingStatus;
  /** Pseudonymous creator identity (never a wallet address). */
  creator: Fr;
  /** Salted category tag; match against deriveCategoryTag(accessSecret, name). */
  categoryTag: Fr;
  /** The record's encrypted Arweave pointer (61 bytes), for lazy content fetch. */
  pointer: Uint8Array;
  /** The record's on-chain price commitment (verified when content loads). */
  priceCommitment: Fr;
}

const LISTING_PAGE = 20; // must match get_listings' array size in the contract

/**
 * Reads the whole listing index cheaply -- on-chain records only, in bulk
 * pages (LISTING_PAGE per simulation), no Arweave fetch. O(count/page) cheap
 * simulations regardless of how large the market is. The client filters by
 * category (match `categoryTag`) and paginates over this, then fetches the
 * content only for the page it shows.
 */
export async function listMarketListings(options: {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  marketplaceAddress: AztecAddress;
}): Promise<ListingIndexEntry[]> {
  const { wallet, node, from, marketplaceAddress } = options;
  await ensureContractRegistered(
    wallet,
    node,
    marketplaceAddress,
    MarketplaceContract.artifact,
    'marketplace',
  );
  const marketplace = await MarketplaceContract.at(marketplaceAddress, wallet);

  const entries: ListingIndexEntry[] = [];
  for (let page = 0n; ; page++) {
    const { result } = await marketplace.methods.get_listings(page).simulate({ from });
    const [records, count] = result as [OnchainListingRecord[], bigint];
    for (let i = 0; i < Number(count); i++) {
      const record = records[i];
      if (record === undefined) {
        throw new Error('get_listings returned fewer records than its count');
      }
      // Ids are 1-based.
      const listingId = page * BigInt(LISTING_PAGE) + BigInt(i) + 1n;
      const status = Number(record.status) as ListingStatus;
      if (status === ListingStatus.None) {
        throw new Error(`listing ${listingId} is inside listing_count but has status None`);
      }
      entries.push(toIndexEntry(record, listingId));
    }
    if (Number(count) < LISTING_PAGE) {
      break;
    }
  }
  return entries;
}

function toIndexEntry(record: OnchainListingRecord, listingId: bigint): ListingIndexEntry {
  return {
    listingId,
    status: Number(record.status) as ListingStatus,
    creator: new Fr(record.creator),
    categoryTag: asFr(record.category_tag),
    pointer: pointerBytes(record),
    priceCommitment: commitmentFr(record),
  };
}

/** One fetched page of a category's on-chain order. */
export interface CategoryPage {
  /** The ACTIVE listings found on this page (after status filtering). */
  entries: ListingIndexEntry[];
  /**
   * Where the next page resumes, or null when the category is exhausted.
   * Feed it straight back into {@link listCategoryPage}.
   */
  nextCursor: Fr | null;
}

/**
 * Reads ONE page (up to LISTING_PAGE entries) of a category's listings IN
 * DISPLAY ORDER -- the incremental unit for browsing a large category without
 * scanning it all up front.
 *
 * Order is a linked list, so paging is CURSOR-based: pass no cursor to start
 * at the top of the category, then feed each returned `nextCursor` back in.
 * There is no way to jump to the n-th page without walking the ones before it,
 * which is why this takes a cursor rather than a page number.
 *
 * A listing appears exactly once (category is immutable); the tag is still
 * re-checked defensively and non-active (paused/removed) entries are dropped,
 * so a page may yield fewer than LISTING_PAGE entries -- or none -- while
 * `nextCursor` is still set. Content is fetched lazily per displayed listing
 * with resolveListingContent.
 */
export async function listCategoryPage(options: {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  marketplaceAddress: AztecAddress;
  categoryTag: Fr;
  /** Where to resume; omit (or null) to start at the top of the category. */
  cursor?: Fr | null;
}): Promise<CategoryPage> {
  const { wallet, node, from, marketplaceAddress, categoryTag } = options;
  await ensureContractRegistered(
    wallet,
    node,
    marketplaceAddress,
    MarketplaceContract.artifact,
    'marketplace',
  );
  const marketplace = await MarketplaceContract.at(marketplaceAddress, wallet);

  const cursor = options.cursor ?? Fr.ZERO;
  const { result } = await marketplace.methods
    .get_category_listings(categoryTag.toBigInt(), cursor.toBigInt())
    .simulate({ from });
  const [records, ids, rawNext, count] = result as [
    OnchainListingRecord[],
    (bigint | Fr)[],
    bigint | Fr,
    bigint,
  ];

  const entries: ListingIndexEntry[] = [];
  for (let i = 0; i < Number(count); i++) {
    const record = records[i];
    const rawId = ids[i];
    if (record === undefined || rawId === undefined) {
      throw new Error('get_category_listings returned fewer entries than its count');
    }
    const listingId = asFr(rawId).toBigInt();
    // The chain is per-category and category is immutable, so this should
    // always hold; skip anything that doesn't rather than trust it.
    if (!asFr(record.category_tag).equals(categoryTag)) continue;
    if (Number(record.status) !== ListingStatus.Active) continue;
    entries.push(toIndexEntry(record, listingId));
  }
  const next = asFr(rawNext);
  return { entries, nextCursor: next.isZero() ? null : next };
}

/**
 * Reads the ACTIVE listings in ONE category via the per-category on-chain
 * index -- touching only that category's entries, never the whole market
 * (O(entries in this category), not O(market)). Loads every index page;
 * paginating UIs should use listCategoryPage instead and stop at the page
 * they display.
 */
export async function listCategoryListings(options: {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  marketplaceAddress: AztecAddress;
  categoryTag: Fr;
}): Promise<ListingIndexEntry[]> {
  const seen = new Set<string>();
  const entries: ListingIndexEntry[] = [];
  let cursor: Fr | null = null;
  for (;;) {
    const batch: CategoryPage = await listCategoryPage({ ...options, cursor });
    for (const entry of batch.entries) {
      const key = entry.listingId.toString();
      if (seen.has(key)) continue; // defensive dedupe across pages
      seen.add(key);
      entries.push(entry);
    }
    if (batch.nextCursor === null) {
      break;
    }
    // A cursor that revisits a page we already walked means the on-chain chain
    // has a cycle; stop rather than spin forever.
    if (seen.has(`cursor:${batch.nextCursor.toString()}`)) {
      throw new Error(
        `category listing order contains a cycle at ${batch.nextCursor.toString()}`,
      );
    }
    seen.add(`cursor:${batch.nextCursor.toString()}`);
    cursor = batch.nextCursor;
  }
  return entries;
}

/**
 * Reads ONE vendor's listings via the per-vendor on-chain index -- touching
 * only that vendor's entries, never the whole market. Returns ALL statuses:
 * the vendor manages paused/removed items and admins moderate them; public
 * "this vendor's listings" views filter to Active client-side. The creator
 * pseudonym is public in every record, so this reveals nothing new.
 */
export async function listVendorListings(options: {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  marketplaceAddress: AztecAddress;
  vendorId: Fr;
}): Promise<ListingIndexEntry[]> {
  const { wallet, node, from, marketplaceAddress, vendorId } = options;
  await ensureContractRegistered(
    wallet,
    node,
    marketplaceAddress,
    MarketplaceContract.artifact,
    'marketplace',
  );
  const marketplace = await MarketplaceContract.at(marketplaceAddress, wallet);

  const seen = new Set<string>();
  const entries: ListingIndexEntry[] = [];
  for (let page = 0n; ; page++) {
    const { result } = await marketplace.methods
      .get_vendor_listings(vendorId.toBigInt(), page)
      .simulate({ from });
    const [records, ids, count] = result as [OnchainListingRecord[], (bigint | Fr)[], bigint];
    for (let i = 0; i < Number(count); i++) {
      const record = records[i];
      const rawId = ids[i];
      if (record === undefined || rawId === undefined) {
        throw new Error('get_vendor_listings returned fewer entries than its count');
      }
      const listingId = asFr(rawId).toBigInt();
      const key = listingId.toString();
      if (seen.has(key)) continue; // defensive dedupe
      seen.add(key);
      // The index buckets by creator and a listing's creator never changes;
      // skip anything that doesn't match rather than trust it.
      if (!new Fr(record.creator).equals(vendorId)) continue;
      entries.push(toIndexEntry(record, listingId));
    }
    if (Number(count) < LISTING_PAGE) {
      break;
    }
  }
  return entries;
}

/**
 * Every listing id in a category, in display order, INCLUDING paused/removed
 * ones. Reordering operates on the raw chain, so it must see the entries that
 * {@link listCategoryPage} filters out -- otherwise a hidden listing sitting
 * between two visible ones would be computed as the wrong neighbour.
 */
async function readCategoryChain(options: {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  marketplaceAddress: AztecAddress;
  categoryTag: Fr;
}): Promise<bigint[]> {
  const { wallet, node, from, marketplaceAddress, categoryTag } = options;
  await ensureContractRegistered(
    wallet,
    node,
    marketplaceAddress,
    MarketplaceContract.artifact,
    'marketplace',
  );
  const marketplace = await MarketplaceContract.at(marketplaceAddress, wallet);

  const order: bigint[] = [];
  const seen = new Set<string>();
  let cursor = Fr.ZERO;
  for (;;) {
    const { result } = await marketplace.methods
      .get_category_listings(categoryTag.toBigInt(), cursor.toBigInt())
      .simulate({ from });
    const [, ids, rawNext, count] = result as [
      OnchainListingRecord[],
      (bigint | Fr)[],
      bigint | Fr,
      bigint,
    ];
    for (let i = 0; i < Number(count); i++) {
      const rawId = ids[i];
      if (rawId === undefined) {
        throw new Error('get_category_listings returned fewer entries than its count');
      }
      const id = asFr(rawId).toBigInt();
      if (seen.has(id.toString())) {
        throw new Error(`category listing order contains a cycle at listing ${id}`);
      }
      seen.add(id.toString());
      order.push(id);
    }
    const next = asFr(rawNext);
    if (next.isZero()) {
      return order;
    }
    cursor = next;
  }
}

/**
 * Moves a listing within its category -- the owner's merchandising lever.
 * `afterListingId` is the listing it should sit directly behind, or null to
 * promote it to the top of the category.
 *
 * The chain walk happens HERE, client-side, and the resulting neighbours are
 * passed to the contract, which verifies them. Searching the chain on-chain
 * would cost an unbounded number of storage reads per move.
 */
export async function moveListing(
  options: {
    wallet: Wallet & RegistersContracts;
    node: AztecNode;
    from: AztecAddress;
    sender?: AztecAddress;
    fee?: { paymentMethod: FeePaymentMethod };
    marketplaceAddress: AztecAddress;
    categoryTag: Fr;
    listingId: bigint;
    /** Place it directly after this listing; null means "move to the top". */
    afterListingId: bigint | null;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const { listingId, afterListingId, marketplaceAddress, wallet } = options;
  if (afterListingId === listingId) {
    throw new Error('a listing cannot be moved after itself');
  }

  const order = await readCategoryChain(options);
  const at = order.indexOf(listingId);
  if (at === -1) {
    throw new Error(`listing ${listingId} is not in the order of the category it claims`);
  }
  if (afterListingId !== null && !order.includes(afterListingId)) {
    throw new Error(
      `listing ${afterListingId} is not in the same category, so it cannot be moved after`,
    );
  }
  // 0 is the contract's "no predecessor" sentinel on both sides.
  const currentPrev = at === 0 ? 0n : order[at - 1]!;
  const newPrev = afterListingId ?? 0n;

  const marketplace = await MarketplaceContract.at(marketplaceAddress, wallet);
  return sendActingAs(options, (account, nonce) =>
    marketplace.methods.move_listing(
      new Fr(listingId),
      new Fr(currentPrev),
      new Fr(newPrev),
      account,
      nonce,
    ),
  );
}

export interface ResolvedListing extends ListingIndexEntry {
  /** Decrypted, validated document; null for non-active listings. */
  listing: ListingDocument | null;
}

/**
 * Fetches + opens the content of ONE listing from its index entry: decrypt the
 * pointer, fetch the sealed blob from Arweave, open it, and verify the on-chain
 * price commitment against the sealed price (AD-4) -- a listing whose public
 * commitment does not match the price it displays must never render. Throws on
 * any inconsistency (the caller decides whether to skip that one listing).
 */
export async function resolveListingContent(options: {
  entry: ListingIndexEntry;
  accessSecret: Fr;
  fetchPayload: FetchPayload;
}): Promise<ListingDocument> {
  const { entry, accessSecret } = options;
  const storageId = await openArweavePointer(entry.pointer, accessSecret);
  const sealedBytes = await options.fetchPayload(storageId);
  const listing = await openListing(sealedBytes, accessSecret);

  const blinding = await derivePriceBlinding(accessSecret, entry.listingId);
  const expectedCommitment = await listingPriceCommitment(listing, blinding);
  if (!entry.priceCommitment.equals(expectedCommitment)) {
    throw new Error(
      `listing ${entry.listingId}: on-chain price commitment does not match the sealed price -- ` +
        'refusing to render (stale or tampered listing data)',
    );
  }
  return listing;
}

/**
 * Convenience "load everything" resolver (used by tests and small markets):
 * the cheap index plus the content of every ACTIVE listing. Throws on the
 * first active listing that fails to load or verify (wrong secret, tampered
 * data). Large markets / UIs should use listMarketListings +
 * resolveListingContent per displayed page instead, which fails per-listing
 * rather than blocking the whole market.
 */
export async function resolveListings(options: {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  marketplaceAddress: AztecAddress;
  accessSecret: Fr;
  fetchPayload: FetchPayload;
}): Promise<ResolvedListing[]> {
  const index = await listMarketListings(options);
  const out: ResolvedListing[] = [];
  for (const entry of index) {
    if (entry.status !== ListingStatus.Active) {
      out.push({ ...entry, listing: null });
      continue;
    }
    const listing = await resolveListingContent({
      entry,
      accessSecret: options.accessSecret,
      fetchPayload: options.fetchPayload,
    });
    out.push({ ...entry, listing });
  }
  return out;
}
