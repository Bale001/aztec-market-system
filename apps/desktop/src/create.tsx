// Create-a-market wizard: configure -> review -> deploy. The deploying
// account becomes the market's superadmin; its keys are shown so the operator
// can administer the market from the Admin tab (or another device).

import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { deployMarketplace, marketAccountAddress, type DeployedMarketplace } from '@market/deployment';
import {
  encodeMarketLink,
  generateMarketAccessSecret,
  makeVanityMarketSecret,
  vanityPrefixError,
} from '@market/identity';
import {
  MAX_USERNAME_BYTES,
  METADATA_SCHEMA_VERSION,
  validateMarketplaceMetadata,
  type MarketplaceMetadata,
} from '@market/market-metadata';
import { ListingPolicy, VendorPolicy } from '@market/shared-types';
import { useEffect, useState } from 'react';

import { defaultCusdcAddress } from './cusdc.js';
import { ensureOwnerIdentity } from './identity.js';
import {
  connectUniversal,
  deployRegistry,
  loadOrCreateAccountKeys,
  type UniversalSession,
} from './session.js';

// The derivation index of the owner's per-market account (the superadmin).
// Distinct from the anonymous account (index 0).
const OWNER_ACCOUNT_INDEX = 1;
import { runWithSpendContext } from './spend.js';
import { message, parseUnits } from './ui.js';

// Setup covers only what the contract needs at deploy time. Presentation --
// theme, accent, layout, custom pages, policy texts -- starts at defaults and
// is edited afterwards in the market's Customize tab (superadmin-only).
interface Draft {
  name: string;
  shortDescription: string;
  categories: string;
  contact: string;
  /**
   * The handle for the creator's Owner account, registered on-chain right
   * after the deploy. Not part of the metadata document -- usernames are
   * per-account (on-chain as a hash, locally as plaintext).
   */
  ownerUsername: string;
  vendorPolicy: VendorPolicy;
  vendorDeposit: string;
  listingPolicy: ListingPolicy;
  feeBps: string;
  paymentAsset: string;
  finalizationCollateral: string;
  orderTimeoutSeconds: string;
}

function initialDraft(nodeUrl: string): Draft {
  return {
    name: '', shortDescription: '', categories: '', contact: '',
    ownerUsername: '',
    vendorPolicy: VendorPolicy.Approval, vendorDeposit: '0',
    listingPolicy: ListingPolicy.Open,
    feeBps: '250', paymentAsset: defaultCusdcAddress(nodeUrl),
    finalizationCollateral: '5',
    orderTimeoutSeconds: '604800',
  };
}

function parseStrictInt(value: string, label: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${label} must be a whole number, got "${value}"`);
  }
  return Number(value.trim());
}

function draftToMetadata(draft: Draft): MarketplaceMetadata {
  return {
    schemaVersion: METADATA_SCHEMA_VERSION,
    name: draft.name,
    shortDescription: draft.shortDescription,
    logoRef: null,
    categories: draft.categories.split(',').map(c => c.trim()).filter(c => c.length > 0),
    contact: draft.contact.trim() === '' ? null : draft.contact.trim(),
    // Presentation defaults; the owner edits these post-deploy in Customize.
    appearance: { theme: 'system', accentColor: null, layout: 'list' },
    policies: { feeExplanation: null, vendorRequirements: null, disputeRules: null },
    pages: [],
    onchain: {
      paymentAsset: draft.paymentAsset.trim(),
      feeBps: parseStrictInt(draft.feeBps, 'Service fee (bps)'),
      vendorPolicy: draft.vendorPolicy,
      listingPolicy: draft.listingPolicy,
      // The form is whole cUSDC; the on-chain mirror stores base units.
      vendorDeposit: parseUnits(draft.vendorDeposit, 'Vendor deposit').toString(),
      finalizationCollateral: parseUnits(
        draft.finalizationCollateral,
        'Finalization collateral',
      ).toString(),
      orderTimeoutSeconds: parseStrictInt(draft.orderTimeoutSeconds, 'Order timeout'),
    },
  };
}

type Step = 'configure' | 'review' | 'deploy';

export function CreateMarket({ nodeUrl }: { nodeUrl: string }) {
  const [step, setStep] = useState<Step>('configure');
  const [draft, setDraft] = useState<Draft>(() => initialDraft(nodeUrl));
  const [doc, setDoc] = useState<MarketplaceMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft(d => ({ ...d, [key]: value }));

  function goToReview() {
    setError(null);
    try {
      // The owner's handle is registered on-chain straight after the deploy, so
      // validate it here rather than failing between the two transactions.
      // Uniqueness needs no check: the market does not exist yet, so nothing
      // can have claimed a name on it.
      const username = draft.ownerUsername.trim();
      if (username === '') {
        throw new Error('choose your username — it is your handle as the market owner');
      }
      if (new TextEncoder().encode(username).length > MAX_USERNAME_BYTES) {
        throw new Error(`username must be at most ${MAX_USERNAME_BYTES} bytes`);
      }
      setDoc(validateMarketplaceMetadata(draftToMetadata(draft)));
      setStep('review');
    } catch (err) {
      setError(message(err));
    }
  }

  return (
    <div className="panel create">
      <h2>Create a market</h2>
      {step === 'configure' && (
        <>
          <WizardForm draft={draft} set={set} />
          {error !== null && <p className="error">{error}</p>}
          <div className="actions">
            <button onClick={goToReview}>Review &amp; continue</button>
          </div>
        </>
      )}
      {step === 'review' && doc !== null && (
        <Review
          doc={doc}
          ownerUsername={draft.ownerUsername.trim()}
          onBack={() => setStep('configure')}
          onApprove={() => setStep('deploy')}
        />
      )}
      {step === 'deploy' && doc !== null && (
        <DeployPanel
          doc={doc}
          ownerUsername={draft.ownerUsername.trim()}
          nodeUrl={nodeUrl}
          onBack={() => setStep('review')}
        />
      )}
    </div>
  );
}

function WizardForm({ draft, set }: { draft: Draft; set: <K extends keyof Draft>(key: K, value: Draft[K]) => void }) {
  return (
    <form onSubmit={e => e.preventDefault()}>
      <fieldset>
        <legend>Basic information</legend>
        <label>Marketplace name</label>
        <input type="text" value={draft.name} onChange={e => set('name', e.target.value)} maxLength={64} />
        <label>Short description</label>
        <textarea value={draft.shortDescription} onChange={e => set('shortDescription', e.target.value)} maxLength={512} />
        <div className="row">
          <div>
            <label>Categories (comma-separated; vendors pick one per listing)</label>
            <input type="text" value={draft.categories} onChange={e => set('categories', e.target.value)} placeholder="electronics, tools, apparel" />
          </div>
          <div>
            <label>Contact / support (optional)</label>
            <input type="text" value={draft.contact} onChange={e => set('contact', e.target.value)} />
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Your owner identity</legend>
        <label>Username (unique on this market, max {MAX_USERNAME_BYTES} bytes)</label>
        <input
          type="text"
          value={draft.ownerUsername}
          maxLength={MAX_USERNAME_BYTES}
          onChange={e => set('ownerUsername', e.target.value)}
          placeholder="e.g. thecurator"
        />
        <p className="hint">
          Your handle as the market's owner, registered on-chain right after the deploy so people
          can address you by name. Only its hash goes on-chain — buyers with the market link see
          the name, outsiders see nothing. Your Owner account is also this market's treasury,
          where fees collect.
        </p>
      </fieldset>

      <fieldset>
        <legend>Customization</legend>
        <p className="hint">
          Theme, accent color, layout, custom pages, and policy texts are edited after deploy: open
          your market as the owner and use the Customize tab. Changes there are one on-chain
          transaction each time you save.
        </p>
      </fieldset>

      <fieldset>
        <legend>Vendor policy</legend>
        <label>Registration model</label>
        <select value={draft.vendorPolicy} onChange={e => set('vendorPolicy', Number(e.target.value) as VendorPolicy)}>
          <option value={VendorPolicy.Open}>Open registration</option>
          <option value={VendorPolicy.Approval}>Admin approval required</option>
          <option value={VendorPolicy.Deposit}>Deposit required</option>
          <option value={VendorPolicy.Both}>Approval + deposit</option>
        </select>
        <label>Vendor deposit (cUSDC)</label>
        <input type="text" value={draft.vendorDeposit} onChange={e => set('vendorDeposit', e.target.value)} />
      </fieldset>

      <fieldset>
        <legend>Listing policy</legend>
        <label>New listings</label>
        <select value={draft.listingPolicy} onChange={e => set('listingPolicy', Number(e.target.value) as ListingPolicy)}>
          <option value={ListingPolicy.Open}>Go live immediately</option>
          <option value={ListingPolicy.Approval}>Require moderator approval</option>
        </select>
        <p className="hint">
          With approval on, every new (and edited) listing is held for a moderator to approve
          before buyers can see or order it — a moderator with the “moderate listings” permission,
          or you as owner. Editing an approved listing sends it back for re-approval.
        </p>
      </fieldset>

      <fieldset>
        <legend>Fees</legend>
        <label>Service fee (basis points, 100 = 1%)</label>
        <input type="text" value={draft.feeBps} onChange={e => set('feeBps', e.target.value)} />
        <p className="hint">
          Fees are paid to your <strong>owner account</strong> on this market — it is the treasury.
          Earnings collect there and you withdraw them to your wallet from the market's “My
          account” tab. If you transfer ownership, the treasury moves with it.
        </p>
        <label>Payment asset — cUSDC (the marketplace standard currency)</label>
        <input type="text" value={draft.paymentAsset} onChange={e => set('paymentAsset', e.target.value)} placeholder="0x… (cUSDC token address)" />
        <p className="hint">
          Markets use cUSDC. On testnet/mainnet this is pre-filled with the standard cUSDC token;
          on the local sandbox it uses the mock cUSDC you deploy in the Wallet tab. Only change it
          if you deliberately want a different asset.
        </p>
      </fieldset>

      <fieldset>
        <legend>Finalization collateral</legend>
        <label>Collateral per order (cUSDC)</label>
        <input type="text" value={draft.finalizationCollateral} onChange={e => set('finalizationCollateral', e.target.value)} />
        <p className="hint">
          Every order escrows this extra amount from the buyer. They get it back in full when they
          finalize the order (confirm receipt + leave a review); if they go silent and the vendor
          has to settle by timeout, the vendor keeps it. Set 0 to disable.
        </p>
      </fieldset>

      <fieldset>
        <legend>Order settlement</legend>
        <label>Order timeout (seconds)</label>
        <input type="text" value={draft.orderTimeoutSeconds} onChange={e => set('orderTimeoutSeconds', e.target.value)} />
        <p className="hint">
          After this long, a vendor may settle an accepted order the buyer never confirmed (and
          keeps the finalization collateral). It is also the vendor deposit withdrawal delay.
          Disputes are handled off-chain: order parties talk to each other and to you through the
          app's private messages, using the order id as the shared credential.
        </p>
      </fieldset>

      <fieldset>
        <legend>Privacy</legend>
        <p className="hint">
          Every market is hidden. At deployment a random access secret is generated: the market
          link. The metadata above is encrypted under it, and the on-chain registry entry is
          meaningless without it. Only people you share the link with can find or read this market.
        </p>
      </fieldset>
    </form>
  );
}

function Review({
  doc,
  ownerUsername,
  onBack,
  onApprove,
}: {
  doc: MarketplaceMetadata;
  ownerUsername: string;
  onBack: () => void;
  onApprove: () => void;
}) {
  return (
    <>
      <h3>Review canonical metadata</h3>
      <p>
        This document will be encrypted under your market's access secret and stored on-chain as
        ciphertext inside your marketplace contract. Nobody without the market link can read it.
      </p>
      <p className="hint">
        Your owner username <strong>{ownerUsername}</strong> is registered by the same transaction
        that deploys the market. It is a per-account handle, so it is not part of the document
        below — only its hash goes on-chain.
      </p>
      <pre className="doc">{JSON.stringify(doc, null, 2)}</pre>
      <div className="actions">
        <button className="secondary" onClick={onBack}>Back</button>
        <button onClick={onApprove}>Approve &amp; continue</button>
      </div>
    </>
  );
}

function DeployPanel({
  doc,
  ownerUsername,
  nodeUrl,
  onBack,
}: {
  doc: MarketplaceMetadata;
  /** Handle to register on-chain for the Owner account, right after the deploy. */
  ownerUsername: string;
  nodeUrl: string;
  onBack: () => void;
}) {
  const [registryAddress, setRegistryAddress] = useState(() => localStorage.getItem('registryAddress') ?? '');
  const [session, setSession] = useState<UniversalSession | null>(null);
  // AD-8: the owner is a pseudonym derived from this secret -- the "owner key"
  // the creator saves, stored on-chain only as a derived identity, never as an
  // address. The market is deployed from the wallet account, paying via the
  // shared PrivateFPC so the on-chain fee payer is anonymous. (Residual: the
  // deploy tx's sender is the wallet account; full deployer anonymity via a
  // throwaway deployer is a deferred follow-up.)
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DeployedMarketplace | null>(null);
  // Optional onion-style vanity prefix for the market link. Empty => a plain
  // random secret. The prefix bits are placed directly into the secret at
  // deploy time (no brute force).
  const [vanity, setVanity] = useState('');

  useEffect(() => { localStorage.setItem('registryAddress', registryAddress); }, [registryAddress]);

  const append = (line: string) => setLog(l => [...l, line]);

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    setError(null);
    setBusy(label);
    append(`> ${label}...`);
    try {
      // Any spend inside (network fee per transaction) prompts under this label.
      const value = await runWithSpendContext({ title: label }, fn);
      append('  done');
      return value;
    } catch (err) {
      setError(message(err));
      append(`  FAILED: ${message(err)}`);
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function onConnect() {
    const s = await run('Opening your wallet (pays deploy fees via your private FPC)', () =>
      connectUniversal(nodeUrl),
    );
    if (s !== null) {
      setSession(s);
      append(`  wallet account: ${s.from.toString()}`);
      append('  fees paid via your shared PrivateFPC -- fund it in the Wallet tab if a deploy fails');
    }
  }

  async function onDeployRegistry() {
    if (session === null) throw new Error('connect first');
    const addr = await run('Deploying local registry', () => deployRegistry(session));
    if (addr !== null) setRegistryAddress(addr.toString());
  }

  async function onDeploy() {
    if (session === null) throw new Error('connect first');

    // The access secret must be fixed before deploy, because the owner's
    // per-market account (the superadmin) is derived from it. Vanity prefixes
    // bake bits into the secret; otherwise pick a fresh random one.
    let accessSecret: Fr;
    const prefix = vanity.trim().toLowerCase();
    if (prefix !== '') {
      try {
        accessSecret = makeVanityMarketSecret(prefix);
      } catch (err) {
        setError(message(err));
        return;
      }
    } else {
      accessSecret = generateMarketAccessSecret();
    }

    // Derive the owner's per-market account address; it becomes the superadmin.
    const seed = Fr.fromString(loadOrCreateAccountKeys().secretKey);
    const superadmin = await marketAccountAddress(
      session.wallet,
      seed,
      accessSecret,
      OWNER_ACCOUNT_INDEX,
    );

    const deployed = await run('Sealing metadata + deploying marketplace', () =>
      deployMarketplace({
        wallet: session.wallet, node: session.node, from: session.from,
        superadmin,
        // Registered to the owner account by the constructor, in this same
        // transaction -- so this wallet pays for it (the owner's per-market
        // account is brand new and holds nothing).
        ownerUsername,
        accessSecret,
        fee: { paymentMethod: session.paymentMethod },
        registryAddress: AztecAddress.fromStringUnsafe(registryAddress),
        metadata: doc, deploymentNonce: Fr.random().toBigInt(),
      }),
    );
    if (deployed !== null) {
      setResult(deployed);
      // Seed the Owner account (at the owner index) so the creator opens the
      // market already acting as the superadmin. The handle is already live
      // on-chain (the constructor wrote it), so record it locally too.
      ensureOwnerIdentity(deployed.marketplaceAddress.toString(), OWNER_ACCOUNT_INDEX, ownerUsername);
      append(`  owner username registered: ${ownerUsername}`);
    }
  }

  if (result !== null) {
    return (
      <>
        <h3 className="verified">Marketplace deployed 🎉</h3>
        <p className="error">
          SAVE THE MARKET LINK NOW. It is the access secret — the only way anyone, including you,
          can find or decrypt this market. It is stored nowhere else and cannot be recovered if lost.
        </p>
        <dl className="summary">
          <dt>Market link (the access secret — share only with people you trust)</dt>
          <dd className="mono" title={`raw secret: ${result.accessSecret.toString()}`}>
            {encodeMarketLink(result.accessSecret)}
          </dd>
          <dt>Registry address (buyers need this too)</dt>
          <dd className="mono">{registryAddress}</dd>
          <dt>Contract address</dt>
          <dd className="mono">{result.marketplaceAddress.toString()}</dd>
          <dt>Owner account (your superadmin — also this market's treasury)</dt>
          <dd className="mono">
            {result.superadminIdentity.toString()}
            <br />
            <span>registered as <strong>{ownerUsername}</strong></span>
          </dd>
        </dl>
        <p>
          To shop this market, open it from the home screen with the market link above and the
          registry address. Ownership is administered by your <strong>Owner account</strong>, which
          is derived from your universal wallet seed + this market link — on this device it is
          already created and active. To administer from another device, restore your wallet seed
          (Wallet tab) and open the market with the same link; the Owner account is re-derived
          automatically. Keep the market link and your seed backup safe — neither can be recovered if
          lost.
        </p>
      </>
    );
  }

  return (
    <>
      <h3>Deploy</h3>
      <fieldset>
        <legend>Registry</legend>
        <label>Registry address</label>
        <input type="text" value={registryAddress} onChange={e => setRegistryAddress(e.target.value)} placeholder="0x... (or deploy one below)" />
      </fieldset>
      <fieldset>
        <legend>Vanity link (optional)</legend>
        <label>Custom start for your market link, onion-style</label>
        <div className="row-actions">
          <input
            type="text"
            value={vanity}
            onChange={e => setVanity(e.target.value.toLowerCase().replace(/[^a-z2-7]/g, ''))}
            placeholder="e.g. cafe"
            disabled={busy !== null}
          />
          <span className="mono">…….aztec</span>
        </div>
        <p className={vanityPrefixError(vanity) !== null ? 'error' : 'hint'}>
          {vanityPrefixError(vanity) ??
            (vanity.trim() === ''
              ? 'Leave blank for a random link. The prefix is written straight into the secret — instant, no mining. Must start with a-g.'
              : `Your link will start with "${vanity.trim()}…" and stay unguessable.`)}
        </p>
      </fieldset>
      <div className="actions">
        <button className="secondary" onClick={onBack} disabled={busy !== null}>Back</button>
        <button onClick={() => void onConnect()} disabled={busy !== null || session !== null}>
          {session === null ? 'Connect wallet' : 'Connected ✓'}
        </button>
        <button className="secondary" onClick={() => void onDeployRegistry()} disabled={busy !== null || session === null}>
          Deploy local registry
        </button>
        <button onClick={() => void onDeploy()} disabled={busy !== null || session === null || registryAddress.trim() === ''}>
          Deploy marketplace
        </button>
      </div>
      {error !== null && <p className="error">{error}</p>}
      {log.length > 0 && <p className="log">{log.join('\n')}</p>}
    </>
  );
}
