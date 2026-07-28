// Storefront: the product "Market" view (category sidebar + product rows +
// pagination), the listing detail + buy flow, and operator custom pages.

import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import {
  cusdcBalanceOf,
  ORDER_MEMO_MAX_BYTES,
  placeOrder,
  type ListingFeedback,
  type ListingIndexEntry,
  type ResolvedMarketplace,
} from '@market/deployment';
import { deriveCategoryTag } from '@market/identity';
import { ListingStatus } from '@market/shared-types';
import { listingFromPrice } from '@market/market-metadata';
import type { ListingDocument, MarketplaceMetadata, MarketplacePage } from '@market/market-metadata';
import React, { useEffect, useRef, useState } from 'react';

import { saveEscrowBuyerSecret, saveOrderNonce } from './orderCredentials.js';
import type { TransactionalSession } from './session.js';
import { runWithSpendContext } from './spend.js';
import {
  formatUnits,
  imageDataUrl,
  message,
  paymentToken,
  Thumb,
  type CategoryLoader,
  type ContentLoader,
  type OpenedMarket,
  type VendorListingsLoader,
  type VendorVerifier,
} from './ui.js';

const PAGE_SIZE = 6;

// The incrementally fetched state of one category's on-chain index: the
// ACTIVE entries accumulated so far, the next index page to read, and whether
// the index has more pages. Kept in a ref (not state) so the fill loop can
// append across awaits without re-render races; the component mirrors
// `entries`/`hasMore` into state when a fill finishes.
interface CategoryFeed {
  category: string;
  tag: Fr;
  entries: ListingIndexEntry[];
  seen: Set<string>;
  /** Where the next read resumes; null means "start at the top". */
  cursor: Fr | null;
  hasMore: boolean;
}

export function Market({
  opened,
  secret,
  session,
  ensureSession,
  loadCategory,
  loadContent,
  loadFeedback,
  loadVendorListings,
  verifyVendor,
  messageVendor,
  about,
}: {
  opened: OpenedMarket;
  secret: Fr;
  session: TransactionalSession | null;
  ensureSession: () => Promise<TransactionalSession>;
  loadCategory: CategoryLoader;
  loadContent: ContentLoader;
  loadFeedback: (listingId: bigint) => Promise<ListingFeedback>;
  loadVendorListings: VendorListingsLoader;
  verifyVendor: VendorVerifier;
  /** Opens an in-app conversation with a vendor's sealed contact address. */
  messageVendor: (contactAddress: string) => Promise<void>;
  about?: React.ReactNode;
}) {
  // The category vocabulary comes from the market metadata; the sidebar renders
  // without loading any listings. Browsing is category-at-a-time: there is no
  // "all items" view (that would scan the whole market).
  const vocab = opened.market.metadata.categories;
  const [category, setCategory] = useState<string | null>(vocab[0] ?? null);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ListingIndexEntry | null>(null);
  // A vendor's public storefront: set by clicking the creator identity on a
  // listing; shows that vendor's ACTIVE listings.
  const [vendorView, setVendorView] = useState<Fr | null>(null);

  // The selected category's ACTIVE listings, read INCREMENTALLY via the
  // per-category on-chain index: only enough index pages to cover the UI page
  // being viewed, never the whole category up front. Fetches resume from where
  // they left off when the user pages forward; a category change resets the
  // feed.
  const feedRef = useRef<CategoryFeed | null>(null);
  const [entries, setEntries] = useState<ListingIndexEntry[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    if (category === null) { feedRef.current = null; setEntries([]); setHasMore(false); return; }
    let live = true;
    void (async () => {
      try {
        let feed = feedRef.current;
        if (feed === null || feed.category !== category) {
          feed = {
            category,
            tag: await deriveCategoryTag(secret, category),
            entries: [],
            seen: new Set(),
            cursor: null,
            hasMore: true,
          };
          if (!live) return;
          feedRef.current = feed;
          setEntries(null);
          setHasMore(false);
          setLoadError(null);
        }
        // Fetch index pages until the viewed UI page is covered (or the index
        // is exhausted). A fetched page can yield fewer active entries than it
        // holds (paused/removed listings), so this may take several reads.
        const target = (page + 1) * PAGE_SIZE;
        if (feed.hasMore && feed.entries.length < target) setFetching(true);
        while (feed.hasMore && feed.entries.length < target) {
          const batch = await loadCategory(feed.tag, feed.cursor);
          if (!live || feedRef.current !== feed) return;
          for (const entry of batch.entries) {
            const key = entry.listingId.toString();
            if (feed.seen.has(key)) continue;
            feed.seen.add(key);
            feed.entries.push(entry);
          }
          feed.cursor = batch.nextCursor;
          feed.hasMore = batch.nextCursor !== null;
        }
        if (!live || feedRef.current !== feed) return;
        setEntries([...feed.entries]);
        setHasMore(feed.hasMore);
      } catch (err) {
        if (live) { setLoadError(message(err)); setEntries([]); setHasMore(false); }
      } finally {
        if (live) setFetching(false);
      }
    })();
    return () => { live = false; };
  }, [category, page, secret, loadCategory]);

  const list = entries ?? [];
  const pageCount = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  // `page` can point past the loaded entries while the next index pages are
  // still being fetched; clamp what we render meanwhile.
  const clampedPage = Math.min(page, pageCount - 1);
  const awaitingPage = fetching && page > pageCount - 1;
  const shown = list.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE);

  // Lazily load the Arweave content for just the listings on the visible page.
  const [content, setContent] = useState<Map<string, ListingDocument | 'error'>>(new Map());
  useEffect(() => {
    let live = true;
    for (const entry of shown) {
      const key = entry.listingId.toString();
      if (content.has(key)) continue;
      void loadContent(entry)
        .then(doc => { if (live) setContent(m => new Map(m).set(key, doc)); })
        .catch(() => { if (live) setContent(m => new Map(m).set(key, 'error')); });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown.map(e => e.listingId.toString()).join(','), loadContent]);

  if (vendorView !== null) {
    return (
      <VendorStorefront
        vendorId={vendorView}
        loadVendorListings={loadVendorListings}
        loadContent={loadContent}
        verifyVendor={verifyVendor}
        onSelect={entry => { setSelected(entry); setVendorView(null); }}
        onBack={() => setVendorView(null)}
      />
    );
  }

  if (selected !== null) {
    return (
      <ListingDetail
        entry={selected}
        market={opened.market}
        secret={secret}
        session={session}
        ensureSession={ensureSession}
        loadContent={loadContent}
        loadFeedback={loadFeedback}
        verifyVendor={verifyVendor}
        messageVendor={messageVendor}
        onVendorClick={vendorId => { setVendorView(vendorId); setSelected(null); }}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <div className="shop">
      <aside className="sidebar">
        <div className="card">
          <h3>Categories</h3>
          {vocab.length === 0 ? (
            <p className="hint">This market has no categories.</p>
          ) : (
            <ul className="cats">
              {vocab.map(c => (
                <li key={c}>
                  <button
                    className={category === c ? 'cat active' : 'cat'}
                    onClick={() => { setCategory(c); setPage(0); }}
                  >
                    {c}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <section className={opened.market.metadata.appearance.layout === 'grid' ? 'products grid' : 'products'}>
        {loadError !== null ? (
          <div className="card"><p className="error">{loadError}</p></div>
        ) : entries === null || awaitingPage ? (
          <div className="card empty">Loading {category}…</div>
        ) : shown.length === 0 ? (
          <div className="card empty">No items in {category ?? 'this market'}.</div>
        ) : (
          shown.map(entry => {
            const key = entry.listingId.toString();
            const doc = content.get(key);
            if (doc === undefined) {
              return <div className="product loading" key={key}><span className="product-desc">Loading…</span></div>;
            }
            if (doc === 'error') {
              return (
                <div className="product" key={key}>
                  <span className="error">Listing #{key} could not be loaded from storage.</span>
                </div>
              );
            }
            return (
              <div className="product" key={key}>
                {doc.images.length > 0 ? (
                  <img className="product-thumb" src={imageDataUrl(doc.images[0]!)} alt={doc.title} />
                ) : (
                  <Thumb title={doc.title} />
                )}
                <div className="product-main">
                  <strong>{doc.title}</strong>
                  <span className="product-desc">{doc.description}</span>
                </div>
                <div className="product-price">
                  {doc.options.length > 1 && <small>from </small>}
                  {formatUnits(listingFromPrice(doc))} cUSDC
                </div>
                <button className="buy" onClick={() => setSelected(entry)}>Buy</button>
              </div>
            );
          })
        )}

        {(pageCount > 1 || hasMore) && (
          <nav className="pager">
            <button className="page-btn" disabled={clampedPage === 0 || fetching} onClick={() => setPage(clampedPage - 1)}>‹</button>
            {Array.from({ length: pageCount }, (_, i) => (
              <button
                key={i}
                className={i === clampedPage ? 'page-btn num active' : 'page-btn num'}
                disabled={fetching}
                onClick={() => setPage(i)}
              >
                {i + 1}
              </button>
            ))}
            {/* More index pages exist on-chain; paging forward fetches them. */}
            {hasMore && <span className="page-btn num more">…</span>}
            <button
              className="page-btn"
              disabled={fetching || (clampedPage >= pageCount - 1 && !hasMore)}
              onClick={() => setPage(clampedPage + 1)}
            >
              ›
            </button>
          </nav>
        )}
        {about}
      </section>
    </div>
  );
}

function ListingDetail({
  entry,
  market,
  secret,
  session,
  ensureSession,
  loadContent,
  loadFeedback,
  verifyVendor,
  messageVendor,
  onVendorClick,
  onBack,
}: {
  entry: ListingIndexEntry;
  market: ResolvedMarketplace;
  secret: Fr;
  session: TransactionalSession | null;
  ensureSession: () => Promise<TransactionalSession>;
  loadContent: ContentLoader;
  loadFeedback: (listingId: bigint) => Promise<ListingFeedback>;
  verifyVendor: VendorVerifier;
  messageVendor: (contactAddress: string) => Promise<void>;
  onVendorClick: (vendorId: Fr) => void;
  onBack: () => void;
}) {
  const metadata = market.metadata;
  const [quantity, setQuantity] = useState(1);
  // Which priced rows the buyer picked. Indices, not prices: an order records
  // the choice as an index into the listing's committed table.
  const [optionIndex, setOptionIndex] = useState(0);
  const [shippingIndex, setShippingIndex] = useState(0);
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<string | null>(null);

  // Fetch this listing's Arweave content on open (cached by the parent loader).
  const [doc, setDoc] = useState<ListingDocument | 'error' | null>(null);
  useEffect(() => {
    let live = true;
    void loadContent(entry)
      .then(d => { if (live) setDoc(d); })
      .catch(() => { if (live) setDoc('error'); });
    return () => { live = false; };
  }, [entry, loadContent]);

  // Reviews: sealed feedback from finalized orders (cheap on-chain read).
  const [feedback, setFeedback] = useState<ListingFeedback | 'error' | null>(null);
  useEffect(() => {
    let live = true;
    void loadFeedback(entry.listingId)
      .then(f => { if (live) setFeedback(f); })
      .catch(() => { if (live) setFeedback('error'); });
    return () => { live = false; };
  }, [entry.listingId, loadFeedback]);

  // Does the "Sold by" handle match the creator's on-chain username commitment?
  // null = checking, true/false = verified/unverified.
  const [vendorVerified, setVendorVerified] = useState<boolean | null>(null);
  useEffect(() => {
    if (doc === null || doc === 'error') return;
    let live = true;
    setVendorVerified(null);
    void verifyVendor(entry.creator, doc.username)
      .then(v => { if (live) setVendorVerified(v); })
      .catch(() => { if (live) setVendorVerified(false); });
    return () => { live = false; };
  }, [doc, entry.creator, verifyVendor]);

  if (doc === null) {
    return (
      <div className="detail">
        <button className="secondary back" onClick={onBack}>← All items</button>
        <p className="log">Loading listing…</p>
      </div>
    );
  }
  if (doc === 'error') {
    return (
      <div className="detail">
        <button className="secondary back" onClick={onBack}>← All items</button>
        <p className="error">This listing could not be loaded from storage.</p>
      </div>
    );
  }

  // The buyer's choices. The circuit recomputes the amount from the listing's
  // committed price table, so what is shown here is a preview of a number the
  // contract will derive itself -- it cannot be talked into a different price.
  // Narrowed once here: the purchase callback below closes over it, and TS
  // does not carry the narrowing into the closure.
  const listingDoc: ListingDocument = doc;
  const option = doc.options[optionIndex] ?? doc.options[0]!;
  const ship = doc.shipping[shippingIndex] ?? doc.shipping[0]!;
  const price = BigInt(option.price);
  // Shipping is charged once per order; only the item scales with quantity.
  const amount = price * BigInt(Math.max(1, quantity)) + BigInt(ship.price);
  const fee = (amount * BigInt(metadata.onchain.feeBps)) / 10000n;
  // Display value from the metadata mirror; placeOrder reads the LIVE config
  // value for the actual escrow.
  const collateral = BigInt(metadata.onchain.finalizationCollateral);
  // Captured after the loading guard so the onBuy closure sees the narrowed type.
  const vendorInbox = doc.vendorInbox;
  const listingTitle = doc.title;
  const vendorContact = doc.simplexAddress;

  // Opens (or reopens) the private in-app conversation with this vendor.
  async function onMessageVendor() {
    if (vendorContact === null) return;
    setError(null);
    setBusy('Opening a private conversation with the vendor…');
    try {
      await messageVendor(vendorContact);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function onConnect() {
    setError(null);
    setBusy('Opening your buyer session (deploys your account if needed)…');
    try {
      await ensureSession();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function onBuy() {
    if (session === null) throw new Error('connect first');
    setError(null);
    setBusy('Placing your order — the amount, the item, and you stay private…');
    try {
      const token = await paymentToken(session, metadata);
      // The BUYER is the universal account: it places the order and pays escrow
      // directly. It never registers on the market and the OrderNote stores no
      // buyer, so the vendor never learns who bought; the only on-chain trace is
      // the universal<->marketplace escrow handshake (no L1 link -- bridging does
      // not reveal the L2 address). No per-market top-up hop.
      const tokenAddress = AztecAddress.fromStringUnsafe(metadata.onchain.paymentAsset);
      const total = amount + collateral;
      const have = await cusdcBalanceOf({
        wallet: session.wallet, node: session.node, from: session.universal, tokenAddress,
        owner: session.universal,
      });
      if (have < total) {
        throw new Error(
          `not enough cUSDC: this order escrows ${formatUnits(total)} cUSDC but your wallet ` +
            `holds only ${formatUnits(have)} — add funds in the Wallet tab first`,
        );
      }
      // Declare the cUSDC this order moves; it appears in the same
      // confirmation prompt as the transaction's network fee.
      const result = await runWithSpendContext(
        {
          title: `Buy: ${listingTitle}`,
          description:
            `Places a private order (quantity ${Math.max(1, quantity)}). The total is escrowed ` +
            `until you confirm delivery; the ${metadata.onchain.feeBps} bps marketplace fee is ` +
            'taken from it at settlement. The finalization collateral comes back to you when ' +
            'you confirm receipt and leave a review.',
          lines: [
            { label: 'Escrowed now (cUSDC)', amount: `${formatUnits(amount)} cUSDC` },
            ...(collateral > 0n
              ? [{
                  label: 'Finalization collateral (cUSDC, refundable)',
                  amount: `${formatUnits(collateral)} cUSDC`,
                }]
              : []),
          ],
        },
        async () =>
          placeOrder({
            wallet: session.wallet, node: session.node, from: session.universal,
            fee: { paymentMethod: session.universalPaymentMethod },
            marketplaceAddress: market.marketplaceAddress, accessSecret: secret,
            listingId: entry.listingId, listing: listingDoc,
            optionIndex, shippingIndex, quantity: Math.max(1, quantity),
            vendorInbox: AztecAddress.fromStringUnsafe(vendorInbox),
            deliveryMemo: memo,
            createEscrowTransferInteraction: (from, to, amt, nonce) =>
              Promise.resolve(token.methods.transfer_private_to_private!(from, to, amt, nonce)),
          }),
      );
      // Both buyer-only credentials, saved before anything else can fail --
      // neither is recoverable once dropped, and neither appears in any note.
      // The escrow secret is the more serious of the two: without it this
      // order's funds can only ever reach the vendor.
      saveEscrowBuyerSecret(result.orderId.toString(), result.buyerSecret.toString());
      saveOrderNonce(result.orderId.toString(), result.orderNonce.toString());
      setPlaced(result.orderId.toString());
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="detail">
      <button className="secondary back" onClick={onBack}>← All items</button>
      <div className="detail-head">
        {doc.images.length > 0 ? (
          <img
            className="listing-hero"
            src={imageDataUrl(doc.images[0]!)}
            alt={doc.title}
          />
        ) : (
          <Thumb title={doc.title} size={120} />
        )}
        <div>
          <h2>{doc.title}</h2>
          <p className="price">
            {doc.options.length > 1 && <small>from </small>}
            {formatUnits(listingFromPrice(doc))} <small>cUSDC</small>
          </p>
          {doc.category !== '' && (
            <p className="chips"><span className="chip">{doc.category}</span></p>
          )}
          <p className="vendor-line">
            Sold by{' '}
            <button
              className="vendor-link"
              title="View this vendor's other listings"
              onClick={() => onVendorClick(entry.creator)}
            >
              {doc.username}
            </button>{' '}
            {vendorVerified === null ? (
              <span className="vendor-badge checking" title="Checking the vendor's on-chain handle…">checking…</span>
            ) : vendorVerified ? (
              <span
                className="vendor-badge verified"
                title="This handle matches the seller's on-chain username commitment on this market."
              >
                ✓ verified
              </span>
            ) : (
              <span
                className="vendor-badge unverified"
                title="This handle does NOT match any username the seller registered on-chain — treat it with caution."
              >
                ⚠ unverified
              </span>
            )}
          </p>
        </div>
      </div>
      {doc.images.length > 1 && (
        <div className="listing-gallery">
          {doc.images.slice(1).map((img, i) => (
            <img key={i} src={imageDataUrl(img)} alt={`${doc.title} ${i + 2}`} />
          ))}
        </div>
      )}
      <p className="desc-full">{doc.description}</p>
      {vendorContact !== null && (
        <p className="simplex">
          <button className="secondary" disabled={busy !== null} onClick={() => void onMessageVendor()}>
            💬 Message the vendor
          </button>{' '}
          <span className="hint">
            private, end-to-end encrypted, in-app — the vendor sees a one-off anonymous identity
          </span>
        </p>
      )}

      <div className="reviews">
        {feedback === null ? (
          <p className="log">Loading reviews…</p>
        ) : feedback === 'error' ? (
          <p className="hint">Reviews could not be loaded right now.</p>
        ) : (
          <>
            <h3>
              Reviews
              {feedback.entries.length > 0 && (
                <>
                  {' '}· <span className="star-avg">★ {(
                    feedback.entries.reduce((sum, f) => sum + f.rating, 0) /
                    feedback.entries.length
                  ).toFixed(1)}</span>{' '}
                  ({feedback.entries.length})
                </>
              )}
            </h3>
            {feedback.entries.length === 0 ? (
              <p className="hint">
                No reviews yet. Every review here comes from a finalized order — buyers leave one
                when they confirm receipt.
              </p>
            ) : (
              <ul className="review-list">
                {feedback.entries.map((f, i) => (
                  <li key={i} className="review">
                    <span className="review-stars">{'★'.repeat(f.rating)}{'☆'.repeat(5 - f.rating)}</span>
                    {f.text !== '' && <span className="review-text">{f.text}</span>}
                  </li>
                ))}
              </ul>
            )}
            {feedback.invalid > 0 && (
              <p className="hint">{feedback.invalid} review(s) could not be decoded and were skipped.</p>
            )}
          </>
        )}
      </div>

      {placed !== null ? (
        <div className="card">
          <p className="verified">✓ Order placed. Your payment is escrowed privately.</p>
          <p>Order id (visible only to you and the vendor): <span className="mono">{placed}</span>. Track it under “My Orders”.</p>
        </div>
      ) : (
        <div className="card">
          <h3>Buy</h3>
          {/* Only shown when there is a choice to make: a plain listing has one
              unnamed variant and one shipping method, and asking about either
              would be noise. */}
          {doc.options.length > 1 && (
            <>
              <label>Option</label>
              <select value={optionIndex} onChange={e => setOptionIndex(Number(e.target.value))}>
                {doc.options.map((o, i) => (
                  <option key={i} value={i}>
                    {o.label === '' ? `Option ${i + 1}` : o.label} — {formatUnits(BigInt(o.price))} cUSDC
                  </option>
                ))}
              </select>
            </>
          )}
          {doc.shipping.length > 1 && (
            <>
              <label>Shipping</label>
              <select value={shippingIndex} onChange={e => setShippingIndex(Number(e.target.value))}>
                {doc.shipping.map((o, i) => (
                  <option key={i} value={i}>
                    {o.label === '' ? `Method ${i + 1}` : o.label}
                    {BigInt(o.price) === 0n ? ' — free' : ` — ${formatUnits(BigInt(o.price))} cUSDC`}
                  </option>
                ))}
              </select>
            </>
          )}
          <label>Quantity</label>
          <input type="text" value={String(quantity)} onChange={e => setQuantity(Number(e.target.value) || 1)} />
          <label>Delivery / contact details (encrypted to the vendor only, max {ORDER_MEMO_MAX_BYTES} bytes)</label>
          <textarea value={memo} onChange={e => setMemo(e.target.value)} />
          <dl className="summary">
            <dt>Total (escrowed until you confirm)</dt>
            <dd title={`${amount.toString()} base units`}>{formatUnits(amount)} cUSDC</dd>
            {collateral > 0n && (
              <>
                <dt>Finalization collateral (returned when you confirm &amp; review)</dt>
                <dd title={`${collateral.toString()} base units`}>{formatUnits(collateral)} cUSDC</dd>
                <dt>Escrowed now in total</dt>
                <dd title={`${(amount + collateral).toString()} base units`}>{formatUnits(amount + collateral)} cUSDC</dd>
              </>
            )}
            <dt>Marketplace fee (paid from the total on settlement)</dt>
            <dd title={`${fee.toString()} base units`}>{formatUnits(fee)} cUSDC ({metadata.onchain.feeBps} bps)</dd>
            <dt>Vendor may settle without confirmation after</dt>
            <dd>{metadata.onchain.orderTimeoutSeconds}s (if accepted)</dd>
          </dl>
          <p className="hint">
            Problems with an order are resolved directly with the vendor (or the market operator)
            in Messages — your order id is the shared credential that proves the order is yours.
          </p>
          <div className="actions">
            {session === null ? (
              <button onClick={() => void onConnect()} disabled={busy !== null}>Connect to buy</button>
            ) : (
              <button onClick={() => void onBuy()} disabled={busy !== null}>Place private order</button>
            )}
          </div>
        </div>
      )}
      {busy !== null && <p className="log">{busy}</p>}
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}

// The page body lives on Arweave (sealed under the market link; only the
// title is on-chain), so it is fetched on open -- cached by the parent loader.
// A vendor's public storefront: their ACTIVE listings, read via the
// per-vendor on-chain index (the creator pseudonym is public in every
// record, so this reveals nothing new). Content loads lazily per card.
function VendorStorefront({
  vendorId,
  loadVendorListings,
  loadContent,
  verifyVendor,
  onSelect,
  onBack,
}: {
  vendorId: Fr;
  loadVendorListings: VendorListingsLoader;
  loadContent: ContentLoader;
  verifyVendor: VendorVerifier;
  onSelect: (entry: ListingIndexEntry) => void;
  onBack: () => void;
}) {
  const [entries, setEntries] = useState<ListingIndexEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadVendorListings(vendorId)
      .then(list => {
        if (live) setEntries(list.filter(e => e.status === ListingStatus.Active));
      })
      .catch(err => { if (live) { setLoadError(message(err)); setEntries([]); } });
    return () => { live = false; };
  }, [vendorId, loadVendorListings]);

  const [content, setContent] = useState<Map<string, ListingDocument | 'error'>>(new Map());
  useEffect(() => {
    let live = true;
    for (const entry of entries ?? []) {
      const key = entry.listingId.toString();
      if (content.has(key)) continue;
      void loadContent(entry)
        .then(doc => { if (live) setContent(m => new Map(m).set(key, doc)); })
        .catch(() => { if (live) setContent(m => new Map(m).set(key, 'error')); });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(entries ?? []).map(e => e.listingId.toString()).join(','), loadContent]);

  // The vendor's handle is the same across all their listings; take it from the
  // first loaded document and verify it against their on-chain commitment.
  const username = [...content.values()].find(d => d !== 'error')?.username ?? null;
  const [verified, setVerified] = useState<boolean | null>(null);
  useEffect(() => {
    if (username === null) { setVerified(null); return; }
    let live = true;
    setVerified(null);
    void verifyVendor(vendorId, username)
      .then(v => { if (live) setVerified(v); })
      .catch(() => { if (live) setVerified(false); });
    return () => { live = false; };
  }, [username, vendorId, verifyVendor]);

  return (
    <div className="detail">
      <button className="secondary back" onClick={onBack}>← Back</button>
      <h2>
        Vendor{' '}
        {username === null ? (
          <span className="mono">{vendorId.toString().slice(0, 18)}…</span>
        ) : (
          <>
            {username}{' '}
            {verified === null ? (
              <span className="vendor-badge checking" title="Checking the vendor's on-chain handle…">checking…</span>
            ) : verified ? (
              <span className="vendor-badge verified" title="This handle matches the seller's on-chain username commitment on this market.">✓ verified</span>
            ) : (
              <span className="vendor-badge unverified" title="This handle does NOT match any username the seller registered on-chain.">⚠ unverified</span>
            )}
          </>
        )}
      </h2>
      <p className="hint">All current listings by this vendor.</p>
      {loadError !== null ? (
        <p className="error">{loadError}</p>
      ) : entries === null ? (
        <p className="log">Loading this vendor's listings…</p>
      ) : entries.length === 0 ? (
        <p>This vendor has no active listings.</p>
      ) : (
        <section className="products">
          {entries.map(entry => {
            const key = entry.listingId.toString();
            const doc = content.get(key);
            if (doc === undefined) {
              return <div className="product loading" key={key}><span className="product-desc">Loading…</span></div>;
            }
            if (doc === 'error') {
              return (
                <div className="product" key={key}>
                  <span className="error">Listing #{key} could not be loaded from storage.</span>
                </div>
              );
            }
            return (
              <div className="product" key={key}>
                {doc.images.length > 0 ? (
                  <img className="product-thumb" src={imageDataUrl(doc.images[0]!)} alt={doc.title} />
                ) : (
                  <Thumb title={doc.title} />
                )}
                <div className="product-main">
                  <strong>{doc.title}</strong>
                  <span className="product-desc">{doc.description}</span>
                </div>
                <div className="product-price">
                  {doc.options.length > 1 && <small>from </small>}
                  {formatUnits(listingFromPrice(doc))} cUSDC
                </div>
                <button className="buy" onClick={() => onSelect(entry)}>Buy</button>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

export function CustomPage({
  page,
  loadBody,
}: {
  page: MarketplacePage;
  loadBody: (storageId: string) => Promise<string>;
}) {
  const [body, setBody] = useState<string | 'error' | null>(null);
  useEffect(() => {
    let live = true;
    setBody(null);
    void loadBody(page.storageId)
      .then(b => { if (live) setBody(b); })
      .catch(() => { if (live) setBody('error'); });
    return () => { live = false; };
  }, [page.storageId, loadBody]);

  return (
    <div className="panel">
      <h2>{page.title}</h2>
      {body === null ? (
        <p className="log">Loading…</p>
      ) : body === 'error' ? (
        <p className="error">This page could not be loaded from storage.</p>
      ) : (
        <p className="page-body">{body}</p>
      )}
    </div>
  );
}

export function AboutBlocks({ metadata, market }: { metadata: MarketplaceMetadata; market: ResolvedMarketplace }) {
  return (
    <div className="panel">
      <h2>About this market</h2>
      <p>{metadata.shortDescription}</p>
      <dl className="summary">
        <dt>Service fee</dt>
        <dd>{metadata.onchain.feeBps} bps</dd>
        <dt>Payment asset</dt>
        <dd className="mono">{metadata.onchain.paymentAsset}</dd>
        <dt>Order timeout</dt>
        <dd>{metadata.onchain.orderTimeoutSeconds}s</dd>
        <dt>Marketplace contract</dt>
        <dd className="mono">{market.marketplaceAddress.toString()}</dd>
      </dl>
      {metadata.contact !== null && (
        <>
          <h3>Contact</h3>
          <p>{metadata.contact}</p>
        </>
      )}
    </div>
  );
}
