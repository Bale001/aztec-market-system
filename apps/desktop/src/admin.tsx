// Admin dashboard: superadmin (vendors, moderators, listing moderation) and
// the pseudonymous moderator view. Disputes are OFF-CHAIN: buyers, vendors,
// and the operator resolve them over SimpleX (AD-6); the contract holds no
// dispute state and this panel arbitrates nothing.

import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import {
  assignModerator,
  listMarketListings,
  listVendors,
  moveListing,
  removeModerator,
  resolveUsername,
  setListingStatusAsAdmin,
  setVendorStatus,
  type ListingIndexEntry,
  type VendorRecord,
} from '@market/deployment';
import { deriveCategoryTag } from '@market/identity';
import {
  ListingPolicy,
  ListingStatus,
  PERM_MANAGE_VENDORS,
  PERM_MODERATE_LISTINGS,
  PERM_RESOLVE_DISPUTES,
  VendorStatus,
} from '@market/shared-types';
import { listingFromPrice } from '@market/market-metadata';
import type { ListingDocument } from '@market/market-metadata';
import { useEffect, useState } from 'react';

import type { Role } from './identity.js';
import { marketAction, type TransactionalSession } from './session.js';
import { runWithSpendContext } from './spend.js';
import {
  formatUnits,
  imageDataUrl,
  message,
  Thumb,
  type CategoryListingsLoader,
  type ContentLoader,
  type OpenedMarket,
  type VendorListingsLoader,
} from './ui.js';

export function AdminPanel({
  opened,
  secret,
  role,
  session,
  ensureSession,
  loadVendorListings,
  loadCategoryListings,
  loadContent,
  onRefresh,
}: {
  opened: OpenedMarket;
  /** The market access secret; moderator usernames are resolved through it. */
  secret: Fr;
  role: Role | null;
  session: TransactionalSession | null;
  ensureSession: () => Promise<TransactionalSession>;
  loadVendorListings: VendorListingsLoader;
  loadCategoryListings: CategoryListingsLoader;
  loadContent: ContentLoader;
  onRefresh: () => Promise<void>;
}) {
  const marketplaceAddress = opened.market.marketplaceAddress;
  const approvalMarket = opened.market.metadata.onchain.listingPolicy === ListingPolicy.Approval;
  const isSuperadmin = role?.isOwner ?? false;
  const mayModerateListings =
    isSuperadmin ||
    (role !== null && (role.moderatorPerms & PERM_MODERATE_LISTINGS) === PERM_MODERATE_LISTINGS);
  const mayManageVendors =
    isSuperadmin ||
    (role !== null && (role.moderatorPerms & PERM_MANAGE_VENDORS) === PERM_MANAGE_VENDORS);
  const isAdmin = isSuperadmin || mayModerateListings || mayManageVendors;
  // Which dashboard subpage is showing. Only tabs the admin has access to are
  // shown; default to the approval queue when this admin moderates one.
  const [subpage, setSubpage] = useState<'approvals' | 'arrange' | 'vendors' | 'moderators'>(
    () => (approvalMarket && mayModerateListings ? 'approvals' : 'vendors'),
  );
  const [loaded, setLoaded] = useState(false);
  const [vendors, setVendors] = useState<VendorRecord[] | null>(null);
  // Vendor-centric moderation: click a vendor to load THEIR listings via the
  // per-vendor on-chain index (no whole-market scan; every listing has a
  // registered creator, so browsing vendors covers everything).
  const [openVendor, setOpenVendor] = useState<Fr | null>(null);
  const [vendorItems, setVendorItems] = useState<ListingIndexEntry[] | null>(null);
  const [modUsername, setModUsername] = useState('');
  const [modPerms, setModPerms] = useState({ listings: true, vendors: false, disputes: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Approval queue: all Pending listings across the market + their content.
  const [pending, setPending] = useState<ListingIndexEntry[] | null>(null);
  const [pendingDocs, setPendingDocs] = useState<Map<string, ListingDocument | 'error'>>(new Map());
  // Arrange: one category's ACTIVE listings in the order shoppers see them.
  const categories = opened.market.metadata.categories;
  const [arrangeCategory, setArrangeCategory] = useState<string | null>(null);
  const [arrangeItems, setArrangeItems] = useState<ListingIndexEntry[] | null>(null);
  const [arrangeDocs, setArrangeDocs] = useState<Map<string, ListingDocument | 'error'>>(new Map());

  async function openVendorListings(vendorId: Fr) {
    setOpenVendor(vendorId);
    setVendorItems(null);
    try {
      setVendorItems(await loadVendorListings(vendorId));
    } catch (err) {
      setError(message(err));
      setVendorItems([]);
    }
  }

  async function run(label: string, action: () => Promise<void>) {
    setError(null);
    setBusy(label);
    try {
      // Any spend inside (network fee, upload) prompts under this label.
      await runWithSpendContext({ title: label }, action);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function refreshVendors(s: TransactionalSession) {
    setVendors(await listVendors({ wallet: s.wallet, node: s.node, from: s.from, marketplaceAddress }));
  }

  // The approval queue: scan the whole listing index for Pending records
  // (approval markets only) and lazily load each one's sealed content so the
  // moderator can actually review it before approving.
  async function refreshPending(s: TransactionalSession) {
    if (!approvalMarket || !mayModerateListings) {
      return;
    }
    const all = await listMarketListings({ wallet: s.wallet, node: s.node, from: s.from, marketplaceAddress });
    const queue = all.filter(e => e.status === ListingStatus.Pending);
    setPending(queue);
    for (const entry of queue) {
      const key = entry.listingId.toString();
      loadContent(entry)
        .then(doc => setPendingDocs(m => new Map(m).set(key, doc)))
        .catch(() => setPendingDocs(m => new Map(m).set(key, 'error')));
    }
  }

  // Loads a category's display order and lazily fetches each listing's content
  // so the admin arranges titles and pictures rather than opaque ids.
  async function openCategory(category: string) {
    setArrangeCategory(category);
    setArrangeItems(null);
    setArrangeDocs(new Map());
    const tag = await deriveCategoryTag(secret, category);
    const items = await loadCategoryListings(tag);
    setArrangeItems(items);
    for (const entry of items) {
      const key = entry.listingId.toString();
      loadContent(entry)
        .then(doc => setArrangeDocs(m => new Map(m).set(key, doc)))
        .catch(() => setArrangeDocs(m => new Map(m).set(key, 'error')));
    }
  }

  /**
   * Moves the listing at `index` one place up, one place down, or to the top.
   *
   * The move is anchored on a NEIGHBOURING LISTING, never on a position: we
   * name the listing that should end up directly above it. Paused or removed
   * listings are hidden from this view but still occupy the on-chain order, so
   * anchoring this way keeps the visible result correct regardless of what is
   * sitting between two rows.
   */
  const onArrange = (index: number, to: 'up' | 'down' | 'top') =>
    run('Reordering the listing…', async () => {
      if (session === null) throw new Error('connect first');
      if (arrangeCategory === null) throw new Error('no category is open');
      const items = arrangeItems;
      if (items === null) throw new Error('the category order has not loaded yet');
      const entry = items[index];
      if (entry === undefined) {
        throw new Error('that listing is no longer part of this category');
      }
      // 'up' lands it directly before the row above, which means placing it
      // after the row TWO above (or at the very top when there is none).
      const anchorIndex = to === 'top' ? -1 : to === 'up' ? index - 2 : index + 1;
      // A negative anchor means "nothing should be above it" -- the top.
      let afterListingId: bigint | null = null;
      if (anchorIndex >= 0) {
        const anchor = items[anchorIndex];
        if (anchor === undefined) {
          throw new Error('the listing is already at the end of this category');
        }
        afterListingId = anchor.listingId;
      }
      await moveListing({
        wallet: session.wallet, node: session.node, from: session.from,
        ...marketAction(session), marketplaceAddress,
        categoryTag: await deriveCategoryTag(secret, arrangeCategory),
        listingId: entry.listingId,
        afterListingId,
      });
      await openCategory(arrangeCategory);
    });

  const onModerateListing = (
    listingId: bigint,
    status: ListingStatus.Active | ListingStatus.Removed,
    label: string,
  ) =>
    run(label, async () => {
      if (session === null) throw new Error('connect first');
      await setListingStatusAsAdmin({
        wallet: session.wallet, node: session.node, from: session.from,
        ...marketAction(session), marketplaceAddress,
        listingId, status,
      });
      await refreshPending(session);
      await onRefresh();
    });

  async function loadAdminData(s: TransactionalSession) {
    // Every admin gets the vendor list: it is the entry point to per-vendor
    // listing moderation (and public data in any case).
    await refreshVendors(s);
    await refreshPending(s);
    setLoaded(true);
  }

  // Auto-load once we both have a session and the role grants admin access
  // (covers connecting here, connecting in another tab, and importing keys).
  useEffect(() => {
    if (session !== null && !loaded && isAdmin) {
      void loadAdminData(session).catch(err => setError(message(err)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, loaded, isAdmin]);

  // The Admin tab is only rendered for identities whose role grants admin
  // access (owner or moderator), so open the session automatically -- no
  // manual "connect" step.
  useEffect(() => {
    if (session === null && isAdmin) {
      void run('Opening the admin session…', async () => {
        await ensureSession();
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  // Moderators are appointed by USERNAME: the person registers on the market
  // (Register tab), tells the operator their handle, and the client resolves
  // it to their account address on-chain (users_forward). An unclaimed
  // username throws before anything is sent.
  const onAssignModerator = () =>
    run('Assigning the moderator…', async () => {
      if (session === null) throw new Error('connect first');
      const common = {
        wallet: session.wallet, node: session.node, from: session.from, marketplaceAddress,
      };
      const permissions =
        (modPerms.listings ? PERM_MODERATE_LISTINGS : 0n) |
        (modPerms.vendors ? PERM_MANAGE_VENDORS : 0n) |
        (modPerms.disputes ? PERM_RESOLVE_DISPUTES : 0n);
      const moderator = await resolveUsername({
        ...common, username: modUsername.trim(), accessSecret: secret,
      });
      await assignModerator({
        ...common, ...marketAction(session), moderator, permissions,
      });
      setModUsername('');
    });

  const onRemoveModerator = () =>
    run('Removing the moderator…', async () => {
      if (session === null) throw new Error('connect first');
      const common = {
        wallet: session.wallet, node: session.node, from: session.from, marketplaceAddress,
      };
      const moderator = await resolveUsername({
        ...common, username: modUsername.trim(), accessSecret: secret,
      });
      await removeModerator({
        ...common, ...marketAction(session), moderator,
      });
      setModUsername('');
    });

  const onVendorStatus = (vendorId: Fr, status: VendorStatus.Active | VendorStatus.Suspended) =>
    run('Updating the vendor…', async () => {
      if (session === null) throw new Error('connect first');
      await setVendorStatus({
        wallet: session.wallet, node: session.node, from: session.from,
        ...marketAction(session), marketplaceAddress,
        vendor: AztecAddress.fromFieldUnsafe(vendorId), status,
      });
      await refreshVendors(session);
    });

  const onModerate = (
    listingId: bigint,
    status: ListingStatus.Active | ListingStatus.Paused | ListingStatus.Removed,
  ) =>
    run('Moderating the listing…', async () => {
      if (session === null) throw new Error('connect first');
      await setListingStatusAsAdmin({
        wallet: session.wallet, node: session.node, from: session.from,
        ...marketAction(session), marketplaceAddress,
        listingId, status,
      });
      if (openVendor !== null) {
        await openVendorListings(openVendor);
      }
      await onRefresh();
    });

  return (
    <div className="panel">
      <h2>Admin dashboard</h2>
      {role === null ? (
        <p>Checking your role on this market…</p>
      ) : !isAdmin ? (
        <p>
          Administration requires this market's <strong>Owner</strong> identity or moderator
          rights. Switch to (or import) the right identity in the bar above.
        </p>
      ) : !loaded ? (
        <p className="log">
          ✓ {isSuperadmin ? "you are this market's superadmin (Owner)" : 'you are a moderator (pseudonymous)'}
          {' — opening the admin session…'}
        </p>
      ) : (
        <>
          <p className="verified">
            ✓ connected as {isSuperadmin ? 'the superadmin' : 'a moderator (pseudonymous)'}
          </p>
          <p className="hint">
            Disputes are handled off-chain: order parties contact each other (and you) through the
            app's private messages, using the order id as the shared credential. Nothing to
            arbitrate here.
          </p>

          <nav className="subnav">
            {approvalMarket && mayModerateListings && (
              <button className={subpage === 'approvals' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setSubpage('approvals')}>
                Approvals{pending !== null && pending.length > 0 ? ` · ${pending.length}` : ''}
              </button>
            )}
            {mayModerateListings && (
              <button className={subpage === 'arrange' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setSubpage('arrange')}>
                Arrange
              </button>
            )}
            <button className={subpage === 'vendors' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setSubpage('vendors')}>Vendors</button>
            {isSuperadmin && (
              <button className={subpage === 'moderators' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setSubpage('moderators')}>Moderators</button>
            )}
          </nav>

          {subpage === 'approvals' && (
            <>
              <h3>
                Listings awaiting approval
                {pending !== null && pending.length > 0 && <> · {pending.length}</>}
              </h3>
              <p className="hint">
                This market holds new and edited listings until a moderator approves them. Buyers
                can't see or order a listing until it's approved.
              </p>
              {pending === null ? (
                <p className="log">Loading the approval queue…</p>
              ) : pending.length === 0 ? (
                <p>Nothing awaiting approval.</p>
              ) : (
                <div className="products">
                  {pending.map(entry => {
                    const key = entry.listingId.toString();
                    const doc = pendingDocs.get(key);
                    return (
                      <div className="product" key={key}>
                        {doc === undefined ? (
                          <span className="product-desc">Loading #{key}…</span>
                        ) : doc === 'error' ? (
                          <span className="error">#{key} could not be loaded from storage.</span>
                        ) : (
                          <>
                            {doc.images.length > 0 ? (
                              <img className="product-thumb" src={imageDataUrl(doc.images[0]!)} alt={doc.title} />
                            ) : (
                              <Thumb title={doc.title} />
                            )}
                            <div className="product-main">
                              <strong>{doc.title} <small>· by {doc.username}</small></strong>
                              <span className="product-desc">{doc.description}</span>
                              <span className="product-desc">{formatUnits(listingFromPrice(doc))} cUSDC · #{key}</span>
                            </div>
                          </>
                        )}
                        <div className="row-actions">
                          <button
                            disabled={busy !== null}
                            onClick={() => void onModerateListing(entry.listingId, ListingStatus.Active, 'Approving the listing…')}
                          >
                            Approve
                          </button>
                          <button
                            className="secondary"
                            disabled={busy !== null}
                            onClick={() => void onModerateListing(entry.listingId, ListingStatus.Removed, 'Rejecting the listing…')}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {subpage === 'arrange' && (
            <>
              <h3>Arrange listings</h3>
              <p className="hint">
                Sets the order shoppers browse a category in. Order is stored per category, so a
                listing's position here is exactly where buyers will see it. Paused and removed
                listings keep their place but are hidden from this list and from buyers.
              </p>
              {categories.length === 0 ? (
                <p className="hint">This market has no categories to arrange.</p>
              ) : (
                <>
                  <div className="row-actions">
                    {categories.map(category => (
                      <button
                        key={category}
                        className={arrangeCategory === category ? 'subnav-btn active' : 'subnav-btn'}
                        disabled={busy !== null}
                        onClick={() => void run('Loading the category…', () => openCategory(category))}
                      >
                        {category}
                      </button>
                    ))}
                  </div>
                  {arrangeCategory === null ? (
                    <p className="hint">Pick a category to arrange.</p>
                  ) : arrangeItems === null ? (
                    <p className="log">Loading “{arrangeCategory}”…</p>
                  ) : arrangeItems.length === 0 ? (
                    <p>No active listings in “{arrangeCategory}”.</p>
                  ) : (
                    <div className="products">
                      {arrangeItems.map((entry, index) => {
                        const key = entry.listingId.toString();
                        const doc = arrangeDocs.get(key);
                        return (
                          <div className="product" key={key}>
                            <strong className="product-desc">{index + 1}</strong>
                            {doc === undefined ? (
                              <span className="product-desc">Loading #{key}…</span>
                            ) : doc === 'error' ? (
                              <span className="error">#{key} could not be loaded from storage.</span>
                            ) : (
                              <>
                                {doc.images.length > 0 ? (
                                  <img className="product-thumb" src={imageDataUrl(doc.images[0]!)} alt={doc.title} />
                                ) : (
                                  <Thumb title={doc.title} />
                                )}
                                <div className="product-main">
                                  <strong>{doc.title} <small>· by {doc.username}</small></strong>
                                  <span className="product-desc">
                                    {formatUnits(listingFromPrice(doc))} cUSDC · #{key}
                                  </span>
                                </div>
                              </>
                            )}
                            <div className="row-actions">
                              <button
                                className="secondary"
                                disabled={busy !== null || index === 0}
                                title="Move to the top of this category"
                                onClick={() => void onArrange(index, 'top')}
                              >
                                Top
                              </button>
                              <button
                                className="secondary"
                                disabled={busy !== null || index === 0}
                                title="Move up one place"
                                onClick={() => void onArrange(index, 'up')}
                              >
                                ↑
                              </button>
                              <button
                                className="secondary"
                                disabled={busy !== null || index === arrangeItems.length - 1}
                                title="Move down one place"
                                onClick={() => void onArrange(index, 'down')}
                              >
                                ↓
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {subpage === 'vendors' && (<>
          <h3>Vendors</h3>
          <p className="hint">
            Moderation is vendor-centric: every listing has a registered creator, so browsing
            vendors covers the whole market. Click “Listings” to moderate a vendor's items.
          </p>
          {vendors === null || vendors.length === 0 ? (
            <p>No vendors are registered yet.</p>
          ) : (
            <table className="table">
              <thead><tr><th>Identity</th><th>Status</th><th>Deposit</th><th>Actions</th></tr></thead>
              <tbody>
                {vendors.map(v => (
                  <tr key={v.vendorId.toString()}>
                    <td className="mono">{v.vendorId.toString().slice(0, 18)}…</td>
                    <td><span className="pill">{VendorStatus[v.status]}</span></td>
                    <td title={`${v.deposit.toString()} base units`}>{formatUnits(v.deposit)} cUSDC</td>
                    <td className="row-actions">
                      <button
                        className="secondary"
                        disabled={busy !== null}
                        onClick={() => void openVendorListings(v.vendorId)}
                      >
                        Listings
                      </button>
                      {mayManageVendors && v.status === VendorStatus.Pending && (
                        <button disabled={busy !== null} onClick={() => void onVendorStatus(v.vendorId, VendorStatus.Active)}>Approve</button>
                      )}
                      {mayManageVendors && v.status === VendorStatus.Active && (
                        <button className="secondary" disabled={busy !== null} onClick={() => void onVendorStatus(v.vendorId, VendorStatus.Suspended)}>Suspend</button>
                      )}
                      {mayManageVendors && v.status === VendorStatus.Suspended && (
                        <button className="secondary" disabled={busy !== null} onClick={() => void onVendorStatus(v.vendorId, VendorStatus.Active)}>Reinstate</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {openVendor !== null && (
            <>
              <h3>
                Listings of <span className="mono">{openVendor.toString().slice(0, 18)}…</span>
              </h3>
              {vendorItems === null ? (
                <p className="log">Loading this vendor's listings…</p>
              ) : vendorItems.length === 0 ? (
                <p>This vendor has no listings.</p>
              ) : (
                <table className="table">
                  <thead><tr><th>#</th><th>Status</th><th>Actions</th></tr></thead>
                  <tbody>
                    {vendorItems.map(l => (
                      <tr key={l.listingId.toString()}>
                        <td>{l.listingId.toString()}</td>
                        <td><span className="pill">{ListingStatus[l.status]}</span></td>
                        <td className="row-actions">
                          {mayModerateListings && l.status !== ListingStatus.Removed && (
                            <button className="secondary" disabled={busy !== null} onClick={() => void onModerate(l.listingId, ListingStatus.Removed)}>Remove</button>
                          )}
                          {mayModerateListings && l.status === ListingStatus.Removed && (
                            <button className="secondary" disabled={busy !== null} onClick={() => void onModerate(l.listingId, ListingStatus.Active)}>Restore</button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
          </>)}

          {subpage === 'moderators' && (
            <>
              <h3>Moderators</h3>
              <p className="hint">
                Moderators are appointed by username: the person registers on this market
                (Register tab) and tells you their exact handle. It is resolved to their
                on-chain account — an unregistered name is rejected.
              </p>
              <label>Moderator username</label>
              <input type="text" value={modUsername} onChange={e => setModUsername(e.target.value)} placeholder="e.g. keebmaker" />
              <div className="row-actions">
                <label className="check">
                  <input type="checkbox" checked={modPerms.listings} onChange={e => setModPerms({ ...modPerms, listings: e.target.checked })} />
                  moderate listings
                </label>
                <label className="check">
                  <input type="checkbox" checked={modPerms.vendors} onChange={e => setModPerms({ ...modPerms, vendors: e.target.checked })} />
                  manage vendors
                </label>
                <label className="check">
                  <input type="checkbox" checked={modPerms.disputes} onChange={e => setModPerms({ ...modPerms, disputes: e.target.checked })} />
                  resolve disputes
                </label>
              </div>
              <div className="actions">
                <button disabled={busy !== null || modUsername.trim() === ''} onClick={() => void onAssignModerator()}>
                  Assign / update moderator
                </button>
                <button className="secondary" disabled={busy !== null || modUsername.trim() === ''} onClick={() => void onRemoveModerator()}>
                  Remove moderator
                </button>
              </div>
            </>
          )}

        </>
      )}

      {busy !== null && <p className="log">{busy}</p>}
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}
