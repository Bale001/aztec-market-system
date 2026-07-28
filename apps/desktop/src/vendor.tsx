// Vendor dashboard: register, manage listings, deposits, and the order inbox.

import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { Contract } from '@aztec/aztec.js/contracts';
import {
  cusdcBalanceOf,
  createListing,
  ensureContractRegistered,
  executeDepositWithdrawal,
  getCusdcTokenArtifact,
  getUsernameHash,
  getVendorRecord,
  registerVendor,
  requestDepositWithdrawal,
  setListingStatusAsVendor,
  updateListing,
  verifyVendorUsername,
  type VendorRecord,
} from '@market/deployment';
import { ListingPolicy, ListingStatus, VendorPolicy, VendorStatus } from '@market/shared-types';
import { useEffect, useState } from 'react';

import { getActiveIdentity, setIdentityUsername } from './identity.js';
import { VendorOrders } from './orders.js';
import { ensurePersonalAddress } from './simplex.js';
import { marketAction, type TransactionalSession } from './session.js';
import { runWithSpendContext } from './spend.js';
import {
  EMPTY_LISTING_FORM,
  fileToListingImage,
  formatUnits,
  formatUnitsExact,
  formToListingDocument,
  imageDataUrl,
  message,
  type VendorListingsLoader,
  type ContentLoader,
  type ListingFormState,
  type PriceRowForm,
  type OpenedMarket,
} from './ui.js';
import {
  MAX_LISTING_IMAGES,
  MAX_PRICE_OPTIONS,
  MAX_SHIPPING_OPTIONS,
  MAX_USERNAME_BYTES,
  type ListingDocument,
} from '@market/market-metadata';
import type { ListingIndexEntry } from '@market/deployment';

import { makeArweavePayloadIO } from './arweave.js';

const POLICY_LABELS: Record<VendorPolicy, string> = {
  [VendorPolicy.Open]: 'open registration — anyone can become a vendor instantly',
  [VendorPolicy.Approval]: 'registration requires the operator’s approval',
  [VendorPolicy.Deposit]: 'registration requires escrowing a deposit',
  [VendorPolicy.Both]: 'registration requires a deposit AND the operator’s approval',
};

/**
 * Editor for a listing's priced rows (variants, or shipping methods).
 *
 * ROW ORDER IS SIGNIFICANT: the on-chain price commitment binds the prices in
 * this order and an order stores the buyer's choice as an index, so reordering
 * rows on an existing listing re-points orders already placed against it. There
 * is deliberately no drag-to-reorder for that reason.
 */
function PriceRows({
  legend,
  hint,
  rows,
  max,
  onChange,
}: {
  legend: string;
  hint: string;
  rows: PriceRowForm[];
  max: number;
  onChange: (rows: PriceRowForm[]) => void;
}) {
  const set = (i: number, patch: Partial<PriceRowForm>) =>
    onChange(rows.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  return (
    <>
      <label>{legend}</label>
      <p className="hint">{hint}</p>
      {rows.map((row, i) => (
        <div className="row" key={i}>
          <input
            type="text"
            value={row.label}
            placeholder={rows.length === 1 ? 'Label (optional)' : `Label, e.g. ${legend === 'Shipping' ? 'Express' : 'Large'}`}
            onChange={e => set(i, { label: e.target.value })}
          />
          <input
            type="text"
            value={row.price}
            placeholder="e.g. 1.50"
            onChange={e => set(i, { price: e.target.value })}
          />
          {rows.length > 1 && (
            <button
              type="button"
              className="secondary small"
              onClick={() => onChange(rows.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          )}
        </div>
      ))}
      {rows.length < max && (
        <button
          type="button"
          className="secondary small"
          onClick={() => onChange([...rows, { label: '', price: '' }])}
        >
          Add {legend.toLowerCase().replace(/s$/, '')}
        </button>
      )}
    </>
  );
}

export function VendorPanel({
  opened,
  secret,
  session,
  ensureSession,
  loadVendorListings,
  loadContent,
  onRefresh,
  onRoleChange,
  onClaimUsername,
}: {
  opened: OpenedMarket;
  secret: Fr;
  session: TransactionalSession | null;
  ensureSession: () => Promise<TransactionalSession>;
  loadVendorListings: VendorListingsLoader;
  loadContent: ContentLoader;
  onRefresh: () => Promise<void>;
  onRoleChange: () => Promise<void>;
  /**
   * Claims a username on this market. This is what CREATES the per-market
   * account (the anonymous one stays anonymous); returns the session for the
   * account the handle landed on.
   */
  onClaimUsername: (username: string) => Promise<TransactionalSession>;
}) {
  const metadata = opened.market.metadata;
  const marketplaceAddress = opened.market.marketplaceAddress;
  const marketAddr = marketplaceAddress.toString();
  const policy = metadata.onchain.vendorPolicy;
  const requiresDeposit = policy === VendorPolicy.Deposit || policy === VendorPolicy.Both;

  const [vendorId, setVendorId] = useState<Fr | null>(null);
  const [vendor, setVendor] = useState<VendorRecord | null>(null);
  // The account's public handle ("Sold by"), from the local account store.
  // null for a REGISTERED vendor means it was claimed on another device (or a
  // prior build): the panel then asks to confirm it -- verified against the
  // on-chain commitment -- before listings can be published.
  const [username, setUsername] = useState<string | null>(
    () => getActiveIdentity(marketAddr)?.username ?? null,
  );
  // Shared by the registration form (choose a handle) and the confirm card
  // (re-enter an existing one); the two are never shown at the same time.
  const [usernameInput, setUsernameInput] = useState('');
  // Whether this account claimed a username ON-CHAIN (users_reverse != 0).
  // Decides the panel's stage: claim a username (A), become a vendor (B), or
  // the vendor dashboard (C). Read fresh in refreshVendor, so it is always a
  // boolean once `loaded` is true.
  const [onchainRegistered, setOnchainRegistered] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<ListingFormState>(EMPTY_LISTING_FORM);
  const [editingId, setEditingId] = useState<bigint | null>(null);
  // Which dashboard subpage is showing (active vendors only).
  const [subpage, setSubpage] = useState<'overview' | 'new' | 'mylistings' | 'orders'>('overview');

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

  async function refreshVendor(s: TransactionalSession) {
    const common = { wallet: s.wallet, node: s.node, from: s.from, marketplaceAddress };
    // Account model: the vendor's identity is this per-market account's address.
    const id = s.from.toField();
    setVendorId(id);
    setVendor(await getVendorRecord({ ...common, vendorId: id }));
    setOnchainRegistered(!(await getUsernameHash({ ...common, account: id })).isZero());
    setLoaded(true);
  }

  // The session opens automatically -- this tab is only shown to registered
  // vendors (or reached deliberately via "Become a vendor"), so there is no
  // manual connect step.
  useEffect(() => {
    void run('Opening your vendor session…', async () => {
      const s = await ensureSession();
      await refreshVendor(s);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stage A: claim a username. This CREATES this market's account for you (the
  // anonymous browsing account stays anonymous) and registers the handle
  // on-chain, which is what makes the account addressable by name (vendor
  // "Sold by", moderator appointment by name). It does NOT make you a vendor.
  // The account creation, session switch, and local handle are all handled by
  // onClaimUsername, which rolls the account back if the transaction fails.
  const onRegisterUsername = () =>
    run('Creating your account on this market…', async () => {
      const chosen = usernameInput.trim();
      if (chosen === '') throw new Error('enter a username');
      const claimed = await onClaimUsername(chosen);
      setUsername(chosen);
      setUsernameInput('');
      await refreshVendor(claimed);
      await onRoleChange();
    });

  // Stage B: promote the (already registered) account to a vendor. No new
  // account or identity is created -- the same address gains vendor status.
  const onBecomeVendor = () =>
    run('Registering as a vendor…', async () => {
      if (session === null) throw new Error('connect first');
      const common = {
        wallet: session.wallet, node: session.node, from: session.from,
        ...marketAction(session), marketplaceAddress,
      };
      if (requiresDeposit) {
        const tokenAddress = AztecAddress.fromStringUnsafe(metadata.onchain.paymentAsset);
        const tokenArtifact = await getCusdcTokenArtifact();
        await ensureContractRegistered(session.wallet, session.node, tokenAddress, tokenArtifact, 'cUSDC (payment asset)');
        const token = Contract.at(tokenAddress, tokenArtifact, session.wallet);
        const depositAmount = BigInt(metadata.onchain.vendorDeposit);
        // The deposit is funded DIRECTLY by the universal wallet (the deposit
        // `payer`); the vendor identity stays this per-market account. No
        // per-market top-up hop.
        const have = await cusdcBalanceOf({
          wallet: session.wallet, node: session.node, from: session.universal,
          tokenAddress, owner: session.universal,
        });
        if (have < depositAmount) {
          throw new Error(
            `not enough cUSDC: the vendor deposit is ${formatUnits(depositAmount)} cUSDC but your ` +
              `wallet holds only ${formatUnits(have)} — add funds in the Wallet tab first`,
          );
        }
        // The registration tx escrows the vendor deposit; declare it so it
        // appears in the same confirmation prompt as the fee.
        await runWithSpendContext(
          {
            title: 'Register as a vendor',
            description:
              'Promotes this account to a vendor and escrows the required deposit. ' +
              'The deposit is returned if you leave in good standing.',
            lines: [
              { label: 'Vendor deposit (cUSDC, escrowed)', amount: `${formatUnits(depositAmount)} cUSDC` },
            ],
          },
          async () =>
            registerVendor({
              ...common,
              deposit: {
                tokenAddress,
                amount: depositAmount,
                payer: session.universal,
                createTransferInteraction: (owner, to, amount, nonce) =>
                  Promise.resolve(token.methods.transfer_private_to_public!(owner, to, amount, nonce)),
              },
            }),
        );
      } else {
        await registerVendor(common);
      }
      await refreshVendor(session);
      await onRoleChange();
    });

  const onSubmitListing = () =>
    run(editingId === null ? 'Creating the listing…' : 'Updating the listing…', async () => {
      if (session === null) throw new Error('connect first');
      // Every listing carries the vendor's public handle ("Sold by: <username>").
      // The listing form is only rendered once the handle is known (a vendor
      // whose handle is missing locally sees the confirm card instead), so this
      // is a genuine bug if it fires.
      if (username === null) throw new Error('confirm your vendor username before publishing a listing');
      // The vendor's messaging contact address, created (or reused) by the
      // embedded messaging core and sealed into the listing. Buyers' "Message
      // the vendor" connects to it; the vendor never handles messaging
      // addresses by hand.
      const contactAddress = await ensurePersonalAddress(marketAddr, username);
      const doc = formToListingDocument(form, session.from.toString(), username, contactAddress);
      const { uploadPayload } = await makeArweavePayloadIO();
      const common = {
        wallet: session.wallet, node: session.node, from: session.from,
        ...marketAction(session), marketplaceAddress,
        listing: doc, accessSecret: secret, uploadPayload,
      };
      if (editingId === null) {
        await createListing(common);
      } else {
        await updateListing({ ...common, listingId: editingId });
      }
      setForm(EMPTY_LISTING_FORM);
      setEditingId(null);
      setSubpage('mylistings');
      await reloadMine();
      await onRefresh();
    });

  // Recovers a handle that exists on-chain but not in this device's account
  // store: verify the entered name against the on-chain commitment before
  // trusting it -- never persist (or embed in listings) an unverifiable handle.
  const onConfirmUsername = () =>
    run('Verifying your username against the on-chain commitment…', async () => {
      if (session === null) throw new Error('connect first');
      const entered = usernameInput.trim();
      if (entered === '') throw new Error('enter your vendor username');
      const matches = await verifyVendorUsername({
        wallet: session.wallet, node: session.node, from: session.from, marketplaceAddress,
        account: session.from.toField(), username: entered, accessSecret: secret,
      });
      if (!matches) throw new Error('that username does not match the one registered on-chain for this account');
      const activeAccount = getActiveIdentity(marketAddr);
      if (activeAccount !== null) setIdentityUsername(marketAddr, activeAccount.id, entered);
      setUsername(entered);
      setUsernameInput('');
    });

  const onAddImages = (files: FileList | null) =>
    run('Reading images…', async () => {
      if (files === null || files.length === 0) return;
      const room = MAX_LISTING_IMAGES - form.images.length;
      const picked = Array.from(files).slice(0, Math.max(0, room));
      const added = await Promise.all(picked.map(fileToListingImage));
      setForm(f => ({ ...f, images: [...f.images, ...added] }));
    });

  const onSetStatus = (
    listingId: bigint,
    status: ListingStatus.Active | ListingStatus.Paused | ListingStatus.Removed,
  ) =>
    run('Changing the listing status…', async () => {
      if (session === null) throw new Error('connect first');
      await setListingStatusAsVendor({
        wallet: session.wallet, node: session.node, from: session.from,
        ...marketAction(session), marketplaceAddress,
        listingId, status,
      });
      await reloadMine();
      await onRefresh();
    });

  // Load a listing's content into the form for editing (shared by Active and
  // Pending rows).
  function beginEdit(listingId: bigint, doc: ListingDocument) {
    setEditingId(listingId);
    setForm({
      title: doc.title,
      description: doc.description,
      // The form is whole cUSDC; the stored listing is base units.
      options: doc.options.map(o => ({ label: o.label, price: formatUnitsExact(BigInt(o.price)) })),
      shipping: doc.shipping.map(o => ({
        label: o.label,
        price: formatUnitsExact(BigInt(o.price)),
      })),
      category: doc.category,
      images: doc.images,
    });
    setSubpage('new');
  }

  const onRequestWithdrawal = () =>
    run('Requesting the deposit withdrawal…', async () => {
      if (session === null) throw new Error('connect first');
      await requestDepositWithdrawal({
        wallet: session.wallet, node: session.node, from: session.from,
        ...marketAction(session), marketplaceAddress,
      });
      await refreshVendor(session);
    });

  const onExecuteWithdrawal = () =>
    run('Withdrawing the deposit to your private balance…', async () => {
      if (session === null) throw new Error('connect first');
      await executeDepositWithdrawal({
        wallet: session.wallet, node: session.node, from: session.from,
        ...marketAction(session), marketplaceAddress,
        tokenAddress: AztecAddress.fromStringUnsafe(metadata.onchain.paymentAsset),
        // Return the deposit to the universal wallet (where it was funded from).
        recipient: session.universal,
      });
      await refreshVendor(session);
    });

  // Load only THIS vendor's listings via the per-vendor on-chain index --
  // O(own listings), never a scan of the whole market. Reloaded after every
  // listing mutation.
  const [mine, setMine] = useState<ListingIndexEntry[]>([]);
  async function reloadMine(id: Fr | null = vendorId) {
    if (id !== null) {
      setMine(await loadVendorListings(id));
    }
  }
  useEffect(() => {
    if (vendorId === null) return;
    let live = true;
    void loadVendorListings(vendorId).then(idx => { if (live) setMine(idx); }).catch(() => {});
    return () => { live = false; };
  }, [vendorId, loadVendorListings]);

  // Lazily load the content of the vendor's OWN listings (bounded set) so the
  // table can show titles and Edit can prefill the form.
  const [myContent, setMyContent] = useState<Map<string, ListingDocument>>(new Map());
  useEffect(() => {
    let live = true;
    for (const l of mine) {
      const key = l.listingId.toString();
      if (myContent.has(key)) continue;
      void loadContent(l)
        .then(d => { if (live) setMyContent(m => new Map(m).set(key, d)); })
        .catch(() => {});
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.map(l => l.listingId.toString()).join(','), loadContent]);

  const isVendorish = vendor !== null && vendor.status !== VendorStatus.None;
  return (
    <div className="panel">
      <h2>
        {!loaded
          ? 'Your market account'
          : isVendorish
            ? 'Vendor dashboard'
            : onchainRegistered === true
              ? 'Become a vendor'
              : 'Register on this market'}
      </h2>
      <p className="hint">
        You act through this market's own account — your universal wallet address never appears in
        marketplace state. This market's vendor policy: {POLICY_LABELS[policy]}.
      </p>

      {!loaded || session === null ? (
        <p className="log">{error === null ? 'Opening your vendor session…' : ''}</p>
      ) : vendor === null || vendor.status === VendorStatus.None ? (
        onchainRegistered !== true ? (
          <>
            {/* Stage A: claiming a username creates this market's account. */}
            <p>
              You don't have a named account on this market yet. Claiming a username creates one
              and registers it on-chain — the prerequisite for becoming a vendor, and what lets
              the operator appoint you as a moderator by name. Your anonymous browsing account
              stays anonymous.
            </p>
            <label>Username (unique on this market, max {MAX_USERNAME_BYTES} bytes)</label>
            <input
              type="text"
              value={usernameInput}
              maxLength={MAX_USERNAME_BYTES}
              onChange={e => setUsernameInput(e.target.value)}
              placeholder="e.g. keebmaker"
            />
            <p className="hint">
              Only the username's hash goes on-chain — buyers with the market link see the name;
              outsiders see nothing.
            </p>
            <div className="actions">
              <button onClick={() => void onRegisterUsername()} disabled={busy !== null || usernameInput.trim() === ''}>
                Create my account
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Stage B: a registered account promotes ITSELF to a vendor -- no
                new account or identity is created. */}
            <p>
              You are registered on this market{username !== null && (
                <> as <strong>{username}</strong></>
              )}. Becoming a vendor promotes this account — your username becomes your public
              “Sold by” handle.
            </p>
            {requiresDeposit && (
              <p>
                Registering will escrow a deposit of {formatUnits(BigInt(metadata.onchain.vendorDeposit))} cUSDC of{' '}
                {metadata.onchain.paymentAsset} from your private balance.
              </p>
            )}
            <div className="actions">
              <button onClick={() => void onBecomeVendor()} disabled={busy !== null}>
                Register as a vendor
              </button>
            </div>
          </>
        )
      ) : vendor.status === VendorStatus.Pending ? (
        <>
          <p>Your registration is <strong>awaiting the operator's approval</strong>. Check back later.</p>
          <div className="actions">
            <button className="secondary" onClick={() => void run('Checking…', () => refreshVendor(session))} disabled={busy !== null}>
              Check status
            </button>
          </div>
        </>
      ) : vendor.status === VendorStatus.Suspended ? (
        <p className="error">Your vendor identity is suspended on this market. Contact the operator.</p>
      ) : (
        <>
          <nav className="subnav">
            <button className={subpage === 'overview' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setSubpage('overview')}>Overview</button>
            <button className={subpage === 'new' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setSubpage('new')}>{editingId === null ? 'New listing' : 'Edit listing'}</button>
            <button className={subpage === 'mylistings' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setSubpage('mylistings')}>My listings</button>
            <button className={subpage === 'orders' ? 'subnav-btn active' : 'subnav-btn'} onClick={() => setSubpage('orders')}>Orders</button>
          </nav>

          {subpage === 'overview' && (<>
          <dl className="summary">
            <dt>Vendor identity</dt>
            <dd className="mono">{vendorId?.toString()}</dd>
            <dt>Public username (“Sold by”)</dt>
            <dd>{username ?? 'not confirmed on this device'}</dd>
            <dt>Status</dt>
            <dd>Active</dd>
            {vendor.deposit > 0n && (
              <>
                <dt>Deposit</dt>
                <dd title={`${vendor.deposit.toString()} base units`}>
                  {formatUnits(vendor.deposit)} cUSDC
                  {vendor.withdrawalRequestedAt > 0n && ' (withdrawal requested)'}
                </dd>
              </>
            )}
          </dl>
          {vendor.deposit > 0n && (
            <div className="actions">
              {vendor.withdrawalRequestedAt === 0n ? (
                <button className="secondary" onClick={() => void onRequestWithdrawal()} disabled={busy !== null}>
                  Request deposit withdrawal
                </button>
              ) : (
                <button className="secondary" onClick={() => void onExecuteWithdrawal()} disabled={busy !== null}>
                  Withdraw deposit (after the {metadata.onchain.orderTimeoutSeconds}s delay)
                </button>
              )}
            </div>
          )}
          </>)}

          {subpage === 'orders' && (
            <VendorOrders market={opened.market} secret={secret} session={session} onError={setError} />
          )}

          {subpage === 'new' && (username === null ? (
            <>
              {/* The handle was registered elsewhere (or by an earlier build):
                  listings embed it, so recover it -- verified on-chain -- before
                  showing the listing form. */}
              <h3>Confirm your username</h3>
              <p className="hint">
                This vendor account's public handle isn't stored on this device. Enter it once to
                publish listings — it is checked against the on-chain commitment, so a wrong name
                is rejected.
              </p>
              <label>Vendor username</label>
              <input
                type="text"
                value={usernameInput}
                maxLength={MAX_USERNAME_BYTES}
                onChange={e => setUsernameInput(e.target.value)}
              />
              <div className="actions">
                <button
                  onClick={() => void onConfirmUsername()}
                  disabled={busy !== null || usernameInput.trim() === ''}
                >
                  Confirm username
                </button>
              </div>
            </>
          ) : (
            <>
              <h3>{editingId === null ? 'New listing' : `Edit listing #${editingId}`}</h3>
              <label>Title</label>
              <input type="text" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} />
              <label>Description</label>
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
              <PriceRows
                legend="Options"
                hint="One row is an ordinary single-price listing. Add rows to offer variants at different prices — buyers pick one when ordering."
                rows={form.options}
                max={MAX_PRICE_OPTIONS}
                onChange={rows => setForm({ ...form, options: rows })}
              />
              <PriceRows
                legend="Shipping"
                hint="Charged once per order, not per item. Price a row 0 for free shipping."
                rows={form.shipping}
                max={MAX_SHIPPING_OPTIONS}
                onChange={rows => setForm({ ...form, shipping: rows })}
              />
              <label>Category{editingId !== null && ' (fixed after creation)'}</label>
              <select
                value={form.category}
                disabled={editingId !== null}
                onChange={e => setForm({ ...form, category: e.target.value })}
              >
                <option value="">(uncategorized)</option>
                {metadata.categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <label>Images (up to {MAX_LISTING_IMAGES}; stored on Arweave, encrypted)</label>
              {form.images.length > 0 && (
                <div className="row-actions">
                  {form.images.map((img, i) => (
                    <span key={i} className="thumb-wrap">
                      <img className="listing-thumb" src={imageDataUrl(img)} alt={`image ${i + 1}`} />
                      <button
                        className="secondary small"
                        onClick={() => setForm({ ...form, images: form.images.filter((_, j) => j !== i) })}
                      >
                        Remove
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                disabled={busy !== null || form.images.length >= MAX_LISTING_IMAGES}
                onChange={e => void onAddImages(e.target.files)}
              />
              <p className="hint">
                Buyers can message you about this listing — the private contact channel is created
                automatically and sealed into the listing (only market members ever see it).
              </p>
              {metadata.onchain.listingPolicy === ListingPolicy.Approval && (
                <p className="hint">
                  This market reviews listings: your {editingId === null ? 'new listing' : 'edit'} will
                  be held for a moderator to approve before buyers can see or order it.
                </p>
              )}
              <div className="actions">
                <button onClick={() => void onSubmitListing()} disabled={busy !== null}>
                  {editingId === null ? 'Create listing' : 'Save changes'}
                </button>
                {editingId !== null && (
                  <button
                    className="secondary"
                    onClick={() => { setEditingId(null); setForm(EMPTY_LISTING_FORM); setSubpage('mylistings'); }}
                  >
                    Cancel edit
                  </button>
                )}
              </div>
            </>
          ))}

          {subpage === 'mylistings' && (<>
          <h3>My listings</h3>
          {mine.length === 0 ? (
            <p>You have no listings yet.</p>
          ) : (
            <table className="table">
              <thead><tr><th>#</th><th>Title</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {mine.map(l => {
                  const doc = myContent.get(l.listingId.toString());
                  return (
                  <tr key={l.listingId.toString()}>
                    <td>{l.listingId.toString()}</td>
                    <td>{doc?.title ?? '…'}</td>
                    <td><span className="pill">{ListingStatus[l.status]}</span></td>
                    <td className="row-actions">
                      {l.status === ListingStatus.Active && (
                        <>
                          <button
                            className="secondary"
                            disabled={busy !== null || doc === undefined}
                            onClick={() => doc !== undefined && beginEdit(l.listingId, doc)}
                          >
                            Edit
                          </button>
                          <button className="secondary" disabled={busy !== null} onClick={() => void onSetStatus(l.listingId, ListingStatus.Paused)}>
                            Pause
                          </button>
                        </>
                      )}
                      {l.status === ListingStatus.Paused && (
                        <button className="secondary" disabled={busy !== null} onClick={() => void onSetStatus(l.listingId, ListingStatus.Active)}>
                          Activate
                        </button>
                      )}
                      {/* Pending (approval markets): the vendor may edit or
                          withdraw, but not self-activate. */}
                      {l.status === ListingStatus.Pending && (
                        <button
                          className="secondary"
                          disabled={busy !== null || doc === undefined}
                          onClick={() => doc !== undefined && beginEdit(l.listingId, doc)}
                        >
                          Edit
                        </button>
                      )}
                      {(l.status === ListingStatus.Active
                        || l.status === ListingStatus.Paused
                        || l.status === ListingStatus.Pending) && (
                        <button className="secondary" disabled={busy !== null} onClick={() => void onSetStatus(l.listingId, ListingStatus.Removed)}>
                          {l.status === ListingStatus.Pending ? 'Withdraw' : 'Remove'}
                        </button>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          </>)}
        </>
      )}

      {busy !== null && <p className="log">{busy}</p>}
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}
