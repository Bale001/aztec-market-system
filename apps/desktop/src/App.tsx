// Unified desktop shell: a top mode switch (Shop / Create a market) and, once
// a market is opened, its storefront with tabs (Market, My Orders, Vendor,
// Admin, plus operator custom pages).

import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import {
  listCategoryListings,
  listCategoryPage,
  listListingFeedback,
  isUsernameTaken,
  listVendorListings,
  marketAccountAddress,
  registerUser,
  resolveListingContent,
  resolveMarketplace,
  verifyVendorUsername,
} from '@market/deployment';
import { decodeMarketLink, isMarketLink } from '@market/identity';
import { VendorStatus } from '@market/shared-types';
import { openPageBody, type ListingDocument } from '@market/market-metadata';
import { useCallback, useEffect, useRef, useState } from 'react';

import { isLocalNetwork } from './cusdc.js';
import { AccountPanel } from './account.js';
import { AdminPanel } from './admin.js';
import { makeArweavePayloadIO } from './arweave.js';
import { ArweaveUploadHost } from './arweave-upload.js';
import { CreateMarket } from './create.js';
import { CustomizePanel } from './customize.js';
import { DisputesPanel } from './disputes-panel.js';
import {
  createIdentity,
  deleteIdentity,
  ensureSeed,
  getActiveIdentity,
  listIdentities,
  renameIdentity,
  resolveRole,
  setActiveId,
  setIdentityUsername,
  type Role,
  type StoredIdentity,
} from './identity.js';
import { IdentityBar } from './identitybar.js';
import { MessagesPanel } from './messages.js';
import { BuyerOrders } from './orders.js';
import { moderatorAutoJoin } from './disputes.js';
import { connectToContactAddress, ensureSimplexRunning, simplexAvailable } from './simplex.js';
import { AboutBlocks, CustomPage, Market } from './shop.js';
import { SpendConfirmHost } from './spend.js';
import {
  connect,
  connectMarketAccount,
  loadOrCreateAccountKeys,
  marketAction,
  type Session,
  type TransactionalSession,
} from './session.js';
import {
  message,
  type CategoryListingsLoader,
  type CategoryLoader,
  type ContentLoader,
  type OpenedMarket,
  type VendorListingsLoader,
  type VendorVerifier,
} from './ui.js';
import { VendorPanel } from './vendor.js';
import { Wallet } from './wallet.js';

type Mode = 'shop' | 'create' | 'wallet';

const DEFAULT_NODE_URL = 'http://localhost:8080';
const TESTNET_NODE_URL = 'https://v5.testnet.rpc.aztec-labs.com';
const NODE_URL_STORAGE_KEY = 'market.nodeUrl.v1';

export function App() {
  const [mode, setMode] = useState<Mode>('shop');
  // One app-wide node URL: every tab (Shop, Create, Wallet) connects to the
  // same network. Persisted so it survives restarts.
  const [nodeUrl, setNodeUrl] = useState(
    () => localStorage.getItem(NODE_URL_STORAGE_KEY) ?? DEFAULT_NODE_URL,
  );
  useEffect(() => {
    localStorage.setItem(NODE_URL_STORAGE_KEY, nodeUrl);
  }, [nodeUrl]);
  return (
    <div className="app">
      <header className="app-bar">
        <div className="brand">Aztec Market</div>
        <nav className="app-nav">
          <button className={mode === 'shop' ? 'app-tab active' : 'app-tab'} onClick={() => setMode('shop')}>Shop</button>
          <button className={mode === 'create' ? 'app-tab active' : 'app-tab'} onClick={() => setMode('create')}>Create a market</button>
          <button className={mode === 'wallet' ? 'app-tab active' : 'app-tab'} onClick={() => setMode('wallet')}>Wallet</button>
        </nav>
        <div className="node-select">
          <input
            className="node-input"
            type="text"
            value={nodeUrl}
            spellCheck={false}
            title="Aztec node URL (applies to every tab)"
            onChange={e => setNodeUrl(e.target.value)}
          />
          <button className="secondary small" title="Local sandbox" onClick={() => setNodeUrl(DEFAULT_NODE_URL)}>Local</button>
          <button className="secondary small" title={TESTNET_NODE_URL} onClick={() => setNodeUrl(TESTNET_NODE_URL)}>Testnet</button>
        </div>
      </header>
      <div className="app-body">
        {mode === 'shop' && <Shopping nodeUrl={nodeUrl} />}
        {mode === 'create' && <CreateMarket nodeUrl={nodeUrl} />}
        {mode === 'wallet' && <Wallet nodeUrl={nodeUrl} />}
      </div>
      {/* The spend gate's confirmation modal: every fee-juice / cUSDC / AR
          spend anywhere in the app is approved through this. */}
      <SpendConfirmHost />
      {/* The "Store on Arweave" chooser: every Arweave upload picks the storage
          wallet or the download-and-upload-yourself flow through this. */}
      <ArweaveUploadHost />
    </div>
  );
}

function Shopping({ nodeUrl }: { nodeUrl: string }) {
  const [registryAddress, setRegistryAddress] = useState(() => localStorage.getItem('registryAddress') ?? '');
  const [link, setLink] = useState('');
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<Fr | null>(null);
  const [opened, setOpened] = useState<OpenedMarket | null>(null);

  useEffect(() => { localStorage.setItem('registryAddress', registryAddress); }, [registryAddress]);

  async function resolve(viewer: Session, s: Fr): Promise<OpenedMarket> {
    const market = await resolveMarketplace({
      wallet: viewer.wallet,
      node: viewer.node,
      from: viewer.from,
      accessSecret: s,
      registryAddress: AztecAddress.fromStringUnsafe(registryAddress),
      // The sandbox has no real cUSDC: each device deploys a mock at a fresh
      // address, which no fixed allowlist could contain. Bypassed ONLY there.
      // On testnet and mainnet the check stands, and a market priced in a token
      // this client does not recognize refuses to open.
      allowUnlistedPaymentAsset: isLocalNetwork(nodeUrl),
    });
    // No listings are loaded here: the storefront browses one category at a
    // time, and vendor/admin load the index on demand.
    return { market };
  }

  async function onOpen() {
    setError(null);
    // Market links are onion-style: <56 base32 chars>.aztec. Raw 0x… secrets
    // from before the link format are still accepted.
    let s: Fr;
    try {
      if (isMarketLink(link)) {
        s = decodeMarketLink(link);
      } else {
        const match = /0x[0-9a-fA-F]+/.exec(link);
        if (match === null) {
          throw new Error('paste a market link (…….aztec) or a legacy 0x… access secret');
        }
        s = Fr.fromString(match[0]);
      }
    } catch (err) {
      setError(`invalid market link: ${message(err)}`);
      return;
    }
    setBusy('Connecting and verifying the market…');
    try {
      const viewer = session ?? (await connect(nodeUrl));
      setSession(viewer);
      setSecret(s);
      setOpened(await resolve(viewer, s));
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function refresh() {
    if (session === null || secret === null) return;
    setOpened(await resolve(session, secret));
  }

  if (opened !== null && secret !== null && session !== null) {
    return (
      <MarketPage
        viewer={session}
        opened={opened}
        secret={secret}
        nodeUrl={nodeUrl}
        onRefresh={refresh}
        onClose={() => { setOpened(null); }}
      />
    );
  }

  return (
    <main className="home">
      <div className="card">
        <h2>Open a hidden market</h2>
        <p>
          Markets are hidden — there is no directory. Paste the market link (an access secret) and
          the registry address the operator gave you. The secret stays on this device; it is used
          locally to find and decrypt the market.
        </p>
        <label>Market link</label>
        <input type="text" value={link} onChange={e => setLink(e.target.value)} placeholder="xxxxxxxx….aztec" />
        <label>Registry address</label>
        <input type="text" value={registryAddress} onChange={e => setRegistryAddress(e.target.value)} placeholder="0x…" />
        <div className="actions">
          <button onClick={() => void onOpen()} disabled={busy !== null || registryAddress.trim() === '' || link.trim() === ''}>
            Open market
          </button>
        </div>
        {busy !== null && <p className="log">{busy}</p>}
        {error !== null && (
          <>
            <p className="error">This market could not be opened and verified:</p>
            <p className="error">{error}</p>
            <p className="hint">
              Nothing was rendered. A wrong link, a squatted registry entry, and tampered storage all
              fail here by design.
            </p>
          </>
        )}
      </div>
    </main>
  );
}

type MarketTab =
  | 'market'
  | 'orders'
  | 'account'
  | 'messages'
  | 'vendor'
  | 'admin'
  | 'disputes'
  | 'customize'
  | `page:${number}`;

function MarketPage({
  viewer,
  opened,
  secret,
  nodeUrl,
  onRefresh,
  onClose,
}: {
  viewer: Session;
  opened: OpenedMarket;
  secret: Fr;
  nodeUrl: string;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const metadata = opened.market.metadata;
  const marketplaceAddress = opened.market.marketplaceAddress;
  const marketAddr = marketplaceAddress.toString();
  const [tab, setTab] = useState<MarketTab>('market');

  // Per-market identities (AD-8: each is a pseudonym; ownership is proven by
  // holding the owner secret, not by any wallet address).
  const [identities, setIdentities] = useState<StoredIdentity[]>([]);
  const [activeId, setActiveIdState] = useState<string>('');
  const [role, setRole] = useState<Role | null>(null);
  const [roleLoading, setRoleLoading] = useState(false);

  // Transactional session shared by every tab; bound to the active identity's
  // pseudonym secret, so it is dropped (and reconnected on demand) on a switch.
  const [session, setSession] = useState<TransactionalSession | null>(null);
  const sessionRef = useRef<TransactionalSession | null>(null);

  const active = identities.find(i => i.id === activeId) ?? identities[0] ?? null;

  async function computeRole(identity: StoredIdentity) {
    setRoleLoading(true);
    try {
      // Derive this account's per-market address (read-only, no deploy) and
      // resolve its role by that address.
      const seed = Fr.fromString(loadOrCreateAccountKeys().secretKey);
      const address = await marketAccountAddress(viewer.wallet, seed, secret, identity.index);
      setRole(await resolveRole(viewer, marketplaceAddress, address));
    } finally {
      setRoleLoading(false);
    }
  }

  // Lazy, cached listing-content loader shared by every tab: fetches + verifies
  // a single listing's Arweave document on demand, so only the listings a tab
  // actually displays are fetched. Cached by id; a failed load is evicted so a
  // later view can retry.
  const contentCache = useRef(new Map<string, Promise<ListingDocument>>());
  const loadContent = useCallback<ContentLoader>(
    entry => {
      const key = entry.listingId.toString();
      const cache = contentCache.current;
      let promise = cache.get(key);
      if (promise === undefined) {
        promise = (async () => {
          const { fetchPayload } = await makeArweavePayloadIO();
          return resolveListingContent({ entry, accessSecret: secret, fetchPayload });
        })();
        promise.catch(() => cache.delete(key));
        cache.set(key, promise);
      }
      return promise;
    },
    [secret],
  );

  // Custom-page bodies live on Arweave sealed under the market link (only the
  // titles are on-chain); fetched on demand and cached by storage id, with
  // failures evicted so reopening the tab retries.
  const pageBodyCache = useRef(new Map<string, Promise<string>>());
  const loadPageBody = useCallback(
    (storageId: string) => {
      const cache = pageBodyCache.current;
      let promise = cache.get(storageId);
      if (promise === undefined) {
        promise = (async () => {
          const { fetchPayload } = await makeArweavePayloadIO();
          return openPageBody(await fetchPayload(storageId), secret);
        })();
        promise.catch(() => cache.delete(storageId));
        cache.set(storageId, promise);
      }
      return promise;
    },
    [secret],
  );

  // Cheap on-chain reads (no Arweave): one page of a category's index at a
  // time (the shop fetches more as the user paginates), and the whole index
  // for vendor/admin views.
  const loadCategory = useCallback<CategoryLoader>(
    (categoryTag, cursor) =>
      listCategoryPage({ wallet: viewer.wallet, node: viewer.node, from: viewer.from, marketplaceAddress, categoryTag, cursor }),
    [viewer, marketplaceAddress],
  );
  // One vendor's listings via the per-vendor index (vendor tab, admin
  // moderation, and the public "this vendor's listings" storefront view).
  const loadVendorListings = useCallback<VendorListingsLoader>(
    vendorId =>
      listVendorListings({ wallet: viewer.wallet, node: viewer.node, from: viewer.from, marketplaceAddress, vendorId }),
    [viewer, marketplaceAddress],
  );
  // One category end to end, in display order -- what the Arrange page reorders.
  const loadCategoryListings = useCallback<CategoryListingsLoader>(
    categoryTag =>
      listCategoryListings({ wallet: viewer.wallet, node: viewer.node, from: viewer.from, marketplaceAddress, categoryTag }),
    [viewer, marketplaceAddress],
  );
  // A listing's sealed reviews (decrypted with the market link; free reads).
  const loadFeedback = useCallback(
    (listingId: bigint) =>
      listListingFeedback({ wallet: viewer.wallet, node: viewer.node, from: viewer.from, marketplaceAddress, listingId, accessSecret: secret }),
    [viewer, marketplaceAddress, secret],
  );
  // This market's messaging profile name: what conversation partners see.
  // The registered username where there is one, else the account label.
  const profileName = active?.username ?? active?.label ?? 'User';

  // "Message the vendor" from a listing: connect the market's messaging
  // profile to the vendor's sealed contact address (incognito -- the
  // conversation shows a random one-off name, linking to nothing) and jump to
  // the Messages tab. Reconnecting to the same vendor reopens the existing
  // conversation.
  const messageVendor = useCallback(
    async (contactAddress: string) => {
      await connectToContactAddress(marketAddr, profileName, contactAddress, true);
      setTab('messages');
    },
    [marketAddr, profileName],
  );

  // Verifies a listing's "Sold by: <username>" against the creator's on-chain
  // username commitment (cheap simulation; no Arweave, no transaction).
  const verifyVendor = useCallback<VendorVerifier>(
    (creator, username) =>
      verifyVendorUsername({
        wallet: viewer.wallet, node: viewer.node, from: viewer.from, marketplaceAddress,
        account: creator, username, accessSecret: secret,
      }),
    [viewer, marketplaceAddress, secret],
  );

  // On entering the market: seed identities, load the active one, resolve its
  // role. Ownership is identity-based (the owner-secret identity resolves to
  // Owner), so there is no wallet-based owner detection.
  useEffect(() => {
    ensureSeed(marketAddr);
    const act = getActiveIdentity(marketAddr)!;
    setIdentities(listIdentities(marketAddr));
    setActiveIdState(act.id);
    void computeRole(act).catch(() => {
      // Role display is best-effort; write actions surface their own errors.
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketAddr, viewer]);

  // Messaging has to work from the moment the market is open, not from the
  // moment someone happens to visit a particular tab.
  //
  // Two things used to be gated on tabs, and both produced "why didn't this
  // arrive" bugs. Starting the core lived in the Messages tab, so a moderator
  // sitting on Shop never auto-accepted the operator's connection -- their core
  // was not running. Joining dispute rooms lived in the Disputes tab, so an
  // invitation sat unanswered until they thought to look there. Neither has
  // anything to do with which tab is showing.
  //
  // ensureSimplexRunning does NOT create a profile (it returns early when this
  // device has none), so merely browsing a market still creates nothing.
  useEffect(() => {
    if (!simplexAvailable()) {
      return;
    }
    let live = true;
    let unsub: (() => void) | null = null;
    void (async () => {
      await ensureSimplexRunning();
      // Moderators additionally join any dispute room they have been invited
      // to -- including invitations that arrived while the app was closed,
      // which moderatorAutoJoin sweeps up.
      if (!live || role === null || role.moderatorPerms === 0n) {
        return;
      }
      const { unsubscribe } = await moderatorAutoJoin(marketAddr, profileName);
      if (!live) {
        unsubscribe();
        return;
      }
      unsub = unsubscribe;
    })().catch(() => {
      // Best-effort: messaging failures surface in the Messages/Disputes tabs,
      // and must never block entering the market.
    });
    return () => {
      live = false;
      if (unsub !== null) unsub();
    };
  }, [marketAddr, role, profileName]);

  const dropSession = () => {
    sessionRef.current = null;
    setSession(null);
  };

  async function ensureSession(): Promise<TransactionalSession> {
    if (sessionRef.current !== null) return sessionRef.current;
    ensureSeed(marketAddr);
    const act = getActiveIdentity(marketAddr)!;
    // Act as the active per-market account (derived from the universal seed +
    // the access secret + the account's index).
    const s = await connectMarketAccount(nodeUrl, { accessSecret: secret, accountIndex: act.index });
    sessionRef.current = s;
    setSession(s);
    return s;
  }

  async function refreshRole() {
    if (active !== null) {
      await computeRole(active);
    }
  }

  const onSwitch = (id: string) => {
    setActiveId(marketAddr, id);
    setActiveIdState(id);
    dropSession();
    const act = listIdentities(marketAddr).find(i => i.id === id)!;
    void computeRole(act);
  };
  /**
   * Claiming a username is what CREATES a per-market account -- there is no
   * step that makes a blank one. The anonymous (index 0) account stays
   * anonymous forever: claiming from it derives a FRESH wallet at the next
   * index and registers the handle there, so browsing is never linked to a
   * public name. An account that has an identity of its own (the Owner
   * account, or a named one retrying a failed registration) registers IN PLACE,
   * so it keeps its role -- for the Owner that matters twice over, since the
   * superadmin address is both its powers AND the market's treasury.
   *
   * `forceNew` always derives a fresh wallet regardless of who is active: it
   * backs "+ New account" in the identity bar, so any user (an owner included)
   * can hold several identities on one market without first switching away.
   *
   * The local account is created before the transaction (its index is what the
   * session derives from) and rolled back if the registration fails, so a
   * failure never leaves a phantom account behind.
   */
  async function claimUsername(username: string, forceNew = false): Promise<TransactionalSession> {
    const chosen = username.trim();
    if (chosen === '') {
      throw new Error('enter a username');
    }
    // Check availability first (a free read): the name is unique per market, and
    // this turns the common "already taken" case into an instant message instead
    // of a doomed, fee-paying transaction. The contract's own assert is still
    // what guarantees uniqueness if two claims race.
    if (
      await isUsernameTaken({
        wallet: viewer.wallet,
        node: viewer.node,
        from: viewer.from,
        marketplaceAddress,
        username: chosen,
        accessSecret: secret,
      })
    ) {
      throw new Error(`the username "${chosen}" is already taken on this market — choose another`);
    }
    ensureSeed(marketAddr);
    const current = getActiveIdentity(marketAddr)!;
    const fresh = forceNew || current.kind === 'anonymous';
    // A fresh account is created named (kind 'named') so the rollback below can
    // remove it; the handle only becomes real once the transaction lands.
    const target = fresh ? createIdentity(marketAddr, chosen, chosen) : current;
    try {
      const s = await connectMarketAccount(nodeUrl, {
        accessSecret: secret,
        accountIndex: target.index,
      });
      await registerUser({
        wallet: s.wallet,
        node: s.node,
        from: s.from,
        ...marketAction(s),
        marketplaceAddress,
        accessSecret: secret,
        username: chosen,
      });
      setIdentityUsername(marketAddr, target.id, chosen);
      sessionRef.current = s;
      setSession(s);
      setIdentities(listIdentities(marketAddr));
      setActiveIdState(target.id);
      await computeRole(target);
      return s;
    } catch (err) {
      if (fresh) {
        deleteIdentity(marketAddr, target.id);
        setActiveId(marketAddr, current.id);
        setIdentities(listIdentities(marketAddr));
        setActiveIdState(current.id);
      }
      throw err;
    }
  }

  const onRename = (id: string, label: string) => {
    renameIdentity(marketAddr, id, label);
    setIdentities(listIdentities(marketAddr));
  };

  const accent = metadata.appearance.accentColor ?? '#2563eb';
  const theme = metadata.appearance.theme;

  const pageMatch = /^page:(\d+)$/.exec(tab);
  const pageIndex = pageMatch ? Number(pageMatch[1]) : null;

  // Role-based navigation: buyers see neither Vendor nor Admin. A registered
  // (or pending/suspended) vendor gets the Vendor tab; owners and moderators
  // get the Admin tab. Buyers keep a "Become a vendor" entry so registration
  // stays reachable -- it opens the same panel, which handles the unregistered
  // state. Sessions in those panels open automatically.
  // A real account on this market (created by claiming a username, or the Owner
  // account) -- as opposed to the anonymous browsing account, which is never an
  // inbox for anything.
  const hasMarketAccount = active !== null && active.kind !== 'anonymous';
  const isVendor = role !== null && role.vendorStatus !== VendorStatus.None;
  const isAdmin = role !== null && (role.isOwner || role.moderatorPerms !== 0n);
  // Customize is superadmin-only: moderators administer, only the owner
  // reshapes the market itself.
  const isOwner = role !== null && role.isOwner;

  // If an identity switch removes the right to the current tab, fall back.
  useEffect(() => {
    if (tab === 'account' && !hasMarketAccount) {
      setTab('market');
      return;
    }
    if (
      role !== null &&
      ((tab === 'admin' && !isAdmin) ||
        (tab === 'disputes' && !isAdmin) ||
        (tab === 'customize' && !isOwner))
    ) {
      setTab('market');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, isAdmin, isOwner, hasMarketAccount]);

  return (
    <div className="market" data-theme={theme} style={{ ['--accent' as string]: accent }}>
      <div className="market-title">
        <h1>{metadata.name}</h1>
        <button className="secondary small" onClick={onClose}>Close market</button>
      </div>

      {active !== null && (
        <IdentityBar
          identities={identities}
          active={active}
          role={role}
          roleLoading={roleLoading}
          onSwitch={onSwitch}
          onRename={onRename}
          onAddAccount={async username => {
            // Always a fresh wallet, whoever is active -- this is how an owner
            // (whose account must register in place) gains further identities.
            await claimUsername(username, true);
          }}
        />
      )}

      <nav className="tabs">
        <button className={tab === 'market' ? 'tab active' : 'tab'} onClick={() => setTab('market')}>Market</button>
        <button className={tab === 'orders' ? 'tab active' : 'tab'} onClick={() => setTab('orders')}>My Orders</button>
        {/* Only an account that actually exists on this market has an inbox to
            show; the anonymous browsing account never receives anything. */}
        {hasMarketAccount && (
          <button className={tab === 'account' ? 'tab active' : 'tab'} onClick={() => setTab('account')}>My account</button>
        )}
        {simplexAvailable() && (
          <button className={tab === 'messages' ? 'tab active' : 'tab'} onClick={() => setTab('messages')}>Messages</button>
        )}
        {isVendor && (
          <button className={tab === 'vendor' ? 'tab active' : 'tab'} onClick={() => setTab('vendor')}>Vendor</button>
        )}
        {isAdmin && (
          <button className={tab === 'admin' ? 'tab active' : 'tab'} onClick={() => setTab('admin')}>Admin</button>
        )}
        {isAdmin && (
          <button className={tab === 'disputes' ? 'tab active' : 'tab'} onClick={() => setTab('disputes')}>Disputes</button>
        )}
        {isOwner && (
          <button className={tab === 'customize' ? 'tab active' : 'tab'} onClick={() => setTab('customize')}>Customize</button>
        )}
        {metadata.pages.map((p, i) => (
          <button key={i} className={tab === `page:${i}` ? 'tab active' : 'tab'} onClick={() => setTab(`page:${i}`)}>
            {p.title}
          </button>
        ))}
        {/* Staged on-boarding: claiming a username CREATES this market's account
            ("Create account"); only such an account can then become a vendor. */}
        {role !== null && !isVendor && (
          <button
            className={tab === 'vendor' ? 'tab active' : 'tab'}
            onClick={() => setTab('vendor')}
            title={
              role.registered
                ? 'Promote this registered account to a vendor'
                : 'Claim a username to create your account on this market (needed to vend, or to be appointed a moderator)'
            }
          >
            {role.registered ? 'Become a vendor' : 'Create account'}
          </button>
        )}
      </nav>

      {/* Keyed by identity so switching resets each tab's loaded state. */}
      <div key={activeId}>
        {tab === 'market' && (
          <Market
            opened={opened}
            secret={secret}
            session={session}
            ensureSession={ensureSession}
            loadCategory={loadCategory}
            loadContent={loadContent}
            loadFeedback={loadFeedback}
            loadVendorListings={loadVendorListings}
            verifyVendor={verifyVendor}
            messageVendor={messageVendor}
            about={<AboutBlocks metadata={metadata} market={opened.market} />}
          />
        )}
        {tab === 'orders' && (
          <BuyerOrders
            market={opened.market}
            secret={secret}
            session={session}
            ensureSession={ensureSession}
            onOpenMessages={() => setTab('messages')}
          />
        )}
        {tab === 'account' && hasMarketAccount && (
          <AccountPanel metadata={metadata} session={session} ensureSession={ensureSession} />
        )}
        {tab === 'messages' && (
          <MessagesPanel
            marketAddr={marketAddr}
            profileName={profileName}
            accountKey={String(active?.index ?? 0)}
          />
        )}
        {tab === 'vendor' && (
          <VendorPanel
            opened={opened}
            secret={secret}
            session={session}
            ensureSession={ensureSession}
            loadVendorListings={loadVendorListings}
            loadContent={loadContent}
            onRefresh={onRefresh}
            onRoleChange={refreshRole}
            onClaimUsername={claimUsername}
          />
        )}
        {tab === 'admin' && (
          <AdminPanel
            opened={opened}
            secret={secret}
            role={role}
            session={session}
            ensureSession={ensureSession}
            loadVendorListings={loadVendorListings}
            loadCategoryListings={loadCategoryListings}
            loadContent={loadContent}
            onRefresh={onRefresh}
          />
        )}
        {tab === 'disputes' && isAdmin && (
          <DisputesPanel
            viewer={viewer}
            opened={opened}
            secret={secret}
            role={role}
            session={session}
            ensureSession={ensureSession}
          />
        )}
        {tab === 'customize' && isOwner && (
          <CustomizePanel
            opened={opened}
            secret={secret}
            session={session}
            ensureSession={ensureSession}
            onRefresh={onRefresh}
          />
        )}
        {pageIndex !== null && metadata.pages[pageIndex] !== undefined && (
          <CustomPage page={metadata.pages[pageIndex]!} loadBody={loadPageBody} />
        )}
      </div>
    </div>
  );
}
