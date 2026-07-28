// Customize: the superadmin's presentation editor. Everything sealed in the
// market's metadata document -- name, description, categories, appearance,
// policy texts, custom pages -- is edited here after deploy and replaced
// on-chain via the owner-secret-authed set_metadata. The on-chain MarketConfig
// (fees, vendor policy, arbitration) is NOT edited here: the existing
// `onchain` mirror is carried over unchanged.

import type { Fr } from '@aztec/aztec.js/fields';
import { setMarketplaceMetadata } from '@market/deployment';
import {
  MAX_PAGE_BODY_CHARS,
  openPageBody,
  sealPageBody,
  validateMarketplaceMetadata,
  type MarketplaceMetadata,
  type MarketplacePage,
} from '@market/market-metadata';
import { useEffect, useState } from 'react';

import { makeArweavePayloadIO } from './arweave.js';
import { marketAction, type TransactionalSession } from './session.js';
import { runWithSpendContext } from './spend.js';
import { message, type OpenedMarket } from './ui.js';

// A page under edit. Bodies live on Arweave (sealed under the market link):
// existing pages fetch theirs on mount, and on save only pages whose body
// changed (or was never uploaded) are re-uploaded.
interface PageDraft {
  title: string;
  body: string;
  /** Existing upload backing `savedBody`; null for a new page. */
  storageId: string | null;
  /** The body currently stored at storageId; null until fetched. */
  savedBody: string | null;
  loading: boolean;
  loadError: string | null;
}

interface Draft {
  name: string;
  shortDescription: string;
  categories: string;
  contact: string;
  theme: 'light' | 'dark' | 'system';
  accentColor: string;
  layout: 'grid' | 'list';
  feeExplanation: string;
  vendorRequirements: string;
  disputeRules: string;
  pages: PageDraft[];
}

function fromMetadata(metadata: MarketplaceMetadata): Draft {
  return {
    name: metadata.name,
    shortDescription: metadata.shortDescription,
    categories: metadata.categories.join(', '),
    contact: metadata.contact ?? '',
    theme: metadata.appearance.theme,
    accentColor: metadata.appearance.accentColor ?? '',
    layout: metadata.appearance.layout,
    feeExplanation: metadata.policies.feeExplanation ?? '',
    vendorRequirements: metadata.policies.vendorRequirements ?? '',
    disputeRules: metadata.policies.disputeRules ?? '',
    pages: metadata.pages.map(p => ({
      title: p.title,
      body: '',
      storageId: p.storageId,
      savedBody: null,
      loading: true,
      loadError: null,
    })),
  };
}

/**
 * The full replacement document: edited presentation over the untouched rest.
 * `pages` are the refs produced by the save-time uploads (title + storage id
 * only -- bodies never go on-chain).
 */
function toMetadata(
  draft: Draft,
  current: MarketplaceMetadata,
  pages: MarketplacePage[],
): MarketplaceMetadata {
  return {
    schemaVersion: current.schemaVersion,
    name: draft.name,
    shortDescription: draft.shortDescription,
    logoRef: current.logoRef,
    categories: draft.categories.split(',').map(c => c.trim()).filter(c => c.length > 0),
    contact: draft.contact.trim() === '' ? null : draft.contact.trim(),
    appearance: {
      theme: draft.theme,
      accentColor: draft.accentColor.trim() === '' ? null : draft.accentColor.trim(),
      layout: draft.layout,
    },
    policies: {
      feeExplanation: draft.feeExplanation.trim() === '' ? null : draft.feeExplanation.trim(),
      vendorRequirements: draft.vendorRequirements.trim() === '' ? null : draft.vendorRequirements.trim(),
      disputeRules: draft.disputeRules.trim() === '' ? null : draft.disputeRules.trim(),
    },
    pages,
    onchain: current.onchain,
  };
}

export function CustomizePanel({
  opened,
  secret,
  session,
  ensureSession,
  onRefresh,
}: {
  opened: OpenedMarket;
  secret: Fr;
  session: TransactionalSession | null;
  ensureSession: () => Promise<TransactionalSession>;
  onRefresh: () => Promise<void>;
}) {
  const current = opened.market.metadata;
  const [draft, setDraft] = useState<Draft>(() => fromMetadata(current));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setSaved(false);
    setDraft(d => ({ ...d, [key]: value }));
  };

  // The tab is only rendered for the owner, so open the session automatically.
  useEffect(() => {
    if (session === null) {
      setBusy('Opening your owner session…');
      void ensureSession()
        .catch(err => setError(message(err)))
        .finally(() => setBusy(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch existing page bodies from Arweave (sealed under the market link) so
  // they can be edited. Re-runs after Discard (`reset`). A page that fails to
  // load blocks saving -- otherwise a transient gateway failure would let a
  // save silently replace that page's body.
  const [reset, setReset] = useState(0);
  useEffect(() => {
    let live = true;
    const pending = draft.pages.filter(p => p.loading && p.storageId !== null);
    if (pending.length === 0) return;
    void (async () => {
      let io: Awaited<ReturnType<typeof makeArweavePayloadIO>> | null = null;
      for (const page of pending) {
        const sid = page.storageId!;
        const patch = (update: Partial<PageDraft>) =>
          setDraft(d => ({
            ...d,
            pages: d.pages.map(p => (p.storageId === sid && p.loading ? { ...p, ...update } : p)),
          }));
        try {
          io ??= await makeArweavePayloadIO();
          const body = await openPageBody(await io.fetchPayload(sid), secret);
          if (!live) return;
          patch({ body, savedBody: body, loading: false });
        } catch (err) {
          if (!live) return;
          patch({ loading: false, loadError: message(err) });
        }
      }
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reset]);

  const addPage = () =>
    set('pages', [
      ...draft.pages,
      { title: '', body: '', storageId: null, savedBody: null, loading: false, loadError: null },
    ]);
  const setPage = (i: number, patch: Partial<PageDraft>) =>
    set('pages', draft.pages.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const removePage = (i: number) => set('pages', draft.pages.filter((_, j) => j !== i));

  async function onSave() {
    setError(null);
    setSaved(false);

    const blocked = draft.pages.find(p => p.loading || p.loadError !== null);
    if (blocked !== undefined) {
      setError(
        blocked.loading
          ? 'page bodies are still loading from Arweave — wait a moment and retry'
          : `a page body failed to load from Arweave (${blocked.loadError}); fix the gateway or remove that page before saving`,
      );
      return;
    }

    // Pages with neither title nor body are leftover "Add a page" clicks and
    // are dropped; a half-filled page is an error, not a silent drop.
    const kept = draft.pages
      .map(p => ({ ...p, title: p.title.trim(), body: p.body.trim() }))
      .filter(p => p.title.length > 0 || p.body.length > 0);
    if (kept.some(p => p.title.length === 0 || p.body.length === 0)) {
      setError('every custom page needs both a title and a body');
      return;
    }

    // Pre-validate everything except the page refs so a bad field is caught
    // before any Arweave upload happens.
    try {
      validateMarketplaceMetadata(toMetadata(draft, current, []));
    } catch (err) {
      setError(message(err));
      return;
    }

    try {
      const refs = await runWithSpendContext(
        {
          title: 'Save market customization',
          description:
            'Uploads new or changed page content to Arweave, then replaces the sealed market ' +
            'metadata on-chain (one transaction).',
        },
        async () => {
          // Upload page bodies (sealed) -- only new pages and changed bodies;
          // unchanged pages keep their existing storage id.
          let uploaded: MarketplacePage[] = [];
          if (kept.length > 0) {
            setBusy('Uploading page bodies to Arweave (sealed under the market link)…');
            const { uploadPayload } = await makeArweavePayloadIO();
            uploaded = [];
            for (const p of kept) {
              const storageId =
                p.storageId !== null && p.body === p.savedBody
                  ? p.storageId
                  : await uploadPayload(await sealPageBody(p.body, secret));
              uploaded.push({ title: p.title, storageId });
            }
          }

          const doc = validateMarketplaceMetadata(toMetadata(draft, current, uploaded));

          setBusy('Sealing and saving the market metadata on-chain…');
          const s = session ?? (await ensureSession());
          await setMarketplaceMetadata({
            wallet: s.wallet, node: s.node, from: s.from,
            ...marketAction(s),
            marketplaceAddress: opened.market.marketplaceAddress,
            accessSecret: secret,
            metadata: doc,
          });
          return uploaded;
        },
      );
      await onRefresh(); // re-resolve so the storefront picks the changes up

      // Mark uploads as saved so an immediate second save re-uploads nothing.
      setDraft(d => ({
        ...d,
        pages: kept.map((p, i) => ({
          title: p.title,
          body: p.body,
          storageId: refs[i]!.storageId,
          savedBody: p.body,
          loading: false,
          loadError: null,
        })),
      }));
      setSaved(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="panel">
      <h2>Customize</h2>
      <p className="hint">
        Everything here is sealed into the market's encrypted metadata and visible only to link
        holders. Saving replaces the document on-chain (one transaction, owner-key authorized).
        Contract rules — fees, vendor policy, arbitration — are not edited here.
      </p>

      <form onSubmit={e => e.preventDefault()}>
        <fieldset>
          <legend>Basic information</legend>
          <label>Marketplace name</label>
          <input type="text" value={draft.name} onChange={e => set('name', e.target.value)} maxLength={64} />
          <label>Short description</label>
          <textarea value={draft.shortDescription} onChange={e => set('shortDescription', e.target.value)} maxLength={512} />
          <label>Contact / support (optional)</label>
          <input type="text" value={draft.contact} onChange={e => set('contact', e.target.value)} />
        </fieldset>

        <fieldset>
          <legend>Categories</legend>
          <label>Categories (comma-separated; vendors pick one per listing)</label>
          <input type="text" value={draft.categories} onChange={e => set('categories', e.target.value)} placeholder="electronics, tools, apparel" />
          <p className="hint">
            Renaming or removing a category does not move its listings: a listing's category is
            fixed at creation, so items in a category that is no longer listed here stop being
            browsable until the category is added back (or the listings are recreated).
          </p>
        </fieldset>

        <fieldset>
          <legend>Appearance</legend>
          <div className="row">
            <div>
              <label>Theme</label>
              <select value={draft.theme} onChange={e => set('theme', e.target.value as Draft['theme'])}>
                <option value="system">System</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </div>
            <div>
              <label>Accent color (#rrggbb, empty for default)</label>
              <input type="text" value={draft.accentColor} onChange={e => set('accentColor', e.target.value)} placeholder="#2563eb" />
            </div>
            <div>
              <label>Product layout</label>
              <select value={draft.layout} onChange={e => set('layout', e.target.value as Draft['layout'])}>
                <option value="list">List (rows)</option>
                <option value="grid">Grid (cards)</option>
              </select>
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend>Custom pages (shown as storefront tabs)</legend>
          <p className="hint">
            Operator-authored pages like About, Shipping, or Rules. Only the tab title is stored
            on-chain; the page content is sealed under the market link and stored on Arweave, so
            pages can be long. Saving uploads new or changed content (needs your Arweave storage
            wallet from the Wallet tab).
          </p>
          {draft.pages.map((p, i) => (
            <div className="page-editor" key={i}>
              <div className="row">
                <div>
                  <label>Page title</label>
                  <input type="text" value={p.title} maxLength={48} onChange={e => setPage(i, { title: e.target.value })} placeholder="About" />
                </div>
                <button className="secondary" type="button" onClick={() => removePage(i)}>Remove page</button>
              </div>
              <label>Page content</label>
              {p.loading ? (
                <p className="log">Loading this page's content from Arweave…</p>
              ) : p.loadError !== null ? (
                <p className="error">
                  This page's content could not be loaded: {p.loadError}. Saving is blocked so the
                  page is not overwritten — fix the Arweave gateway (Wallet tab) or remove the page.
                </p>
              ) : (
                <textarea value={p.body} maxLength={MAX_PAGE_BODY_CHARS} onChange={e => setPage(i, { body: e.target.value })} />
              )}
            </div>
          ))}
          <div className="actions">
            <button className="secondary" type="button" onClick={addPage} disabled={draft.pages.length >= 8}>Add a page</button>
          </div>
        </fieldset>

        <fieldset>
          <legend>Policy texts (informational)</legend>
          <label>Fee explanation</label>
          <textarea value={draft.feeExplanation} onChange={e => set('feeExplanation', e.target.value)} />
          <label>Vendor requirements (shown to prospective vendors)</label>
          <textarea value={draft.vendorRequirements} onChange={e => set('vendorRequirements', e.target.value)} />
          <label>Dispute rules (shown to buyers and vendors)</label>
          <textarea value={draft.disputeRules} onChange={e => set('disputeRules', e.target.value)} />
        </fieldset>
      </form>

      <div className="actions">
        <button
          className="secondary"
          onClick={() => { setDraft(fromMetadata(current)); setReset(r => r + 1); setError(null); setSaved(false); }}
          disabled={busy !== null}
        >
          Discard changes
        </button>
        <button onClick={() => void onSave()} disabled={busy !== null}>Save to chain</button>
      </div>
      {busy !== null && <p className="log">{busy}</p>}
      {error !== null && <p className="error">{error}</p>}
      {saved && <p className="verified">✓ Saved. The storefront now shows the updated market.</p>}
    </div>
  );
}
