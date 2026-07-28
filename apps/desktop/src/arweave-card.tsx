// The Arweave storage-wallet card shown in the Wallet tab. Independent of the
// Aztec session: it manages the local RSA keyfile, shows the AR balance from
// the configured gateway, and offers keyfile import/export (with the same
// danger treatment as identity private keys).

import { useEffect, useState } from 'react';

import {
  ARWEAVE_KEY_STORAGE_KEY,
  arweaveAddress,
  arweaveBalance,
  createArweaveWallet,
  DEFAULT_ARWEAVE_GATEWAY,
  formatAr,
  getArweaveGateway,
  importArweaveKey,
  isLocalGateway,
  loadStoredArweaveKey,
  mintTestAr,
  setArweaveGateway,
} from './arweave.js';
import { runWithSpendContext } from './spend.js';
import { message } from './ui.js';

const MINT_AMOUNT_AR = 10n;

export function ArweaveWalletCard() {
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [gateway, setGateway] = useState(() => getArweaveGateway());
  // Whether the SAVED gateway (not the input draft) is a local arlocal one.
  const [local, setLocal] = useState(() => isLocalGateway());
  const [importing, setImporting] = useState(false);
  const [importDraft, setImportDraft] = useState('');
  const [exported, setExported] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  async function refreshBalance(addr: string) {
    setBalance(await arweaveBalance(addr));
  }

  // On mount: if a key is stored, derive its address; balance is fetched on
  // demand (the gateway may be unreachable, which must not break the tab).
  useEffect(() => {
    void run('Loading your Arweave wallet…', async () => {
      const jwk = loadStoredArweaveKey();
      if (jwk === null) {
        return;
      }
      const addr = await arweaveAddress(jwk);
      setAddress(addr);
      await refreshBalance(addr);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onCreate = () =>
    run('Generating an RSA-4096 keypair (a few seconds)…', async () => {
      const { address: addr } = await createArweaveWallet();
      setAddress(addr);
      await refreshBalance(addr);
    });

  const onImport = () =>
    run('Importing the keyfile…', async () => {
      const { address: addr } = await importArweaveKey(importDraft);
      setAddress(addr);
      setImporting(false);
      setImportDraft('');
      await refreshBalance(addr);
    });

  const onMint = () =>
    run(`Minting ${MINT_AMOUNT_AR} test AR…`, async () => {
      if (address === null) throw new Error('create an Arweave wallet first');
      await mintTestAr(address, MINT_AMOUNT_AR);
      await refreshBalance(address);
    });

  const onExport = () => {
    if (
      !window.confirm(
        'This copies your Arweave PRIVATE keyfile.\n\n' +
          'Anyone who gets it controls this wallet and its AR from any device. Only paste it ' +
          'into your own device or a trusted Arweave tool. Copy anyway?',
      )
    ) {
      return;
    }
    const raw = localStorage.getItem(ARWEAVE_KEY_STORAGE_KEY);
    if (raw === null) {
      setError('no Arweave key is stored on this device');
      return;
    }
    void navigator.clipboard.writeText(raw).then(() => {
      setExported(true);
      setTimeout(() => setExported(false), 1500);
    });
  };

  const onSaveGateway = () =>
    run('Checking the gateway…', async () => {
      setArweaveGateway(gateway);
      setLocal(isLocalGateway(gateway));
      if (address !== null) {
        await refreshBalance(address);
      }
    });

  return (
    <div className="card">
      <h2>Arweave storage wallet</h2>
      <p>
        Large files (images, documents) are stored permanently on Arweave. You can pay in AR from
        this self-custodial wallet, or — at upload time — choose “Download &amp; upload it myself”
        and use any Arweave service instead. The keyfile lives only on this device and is part of
        your wallet backup.
      </p>

      {address === null ? (
        <>
          <div className="actions">
            <button onClick={() => void onCreate()} disabled={busy !== null}>
              Create Arweave wallet
            </button>
            <button className="secondary" onClick={() => setImporting(!importing)} disabled={busy !== null}>
              Import keyfile
            </button>
          </div>
          {importing && (
            <>
              <label>Arweave keyfile (JWK JSON)</label>
              <textarea
                value={importDraft}
                onChange={e => setImportDraft(e.target.value)}
                placeholder='{"kty":"RSA", …}'
                rows={4}
              />
              <div className="actions">
                <button onClick={() => void onImport()} disabled={busy !== null || importDraft.trim() === ''}>
                  Import
                </button>
              </div>
            </>
          )}
          <p className="hint">
            A storage wallet is optional — when you upload, you can instead pick “Download &amp;
            upload it myself” and use any Arweave service.
          </p>
        </>
      ) : (
        <>
          <dl className="summary">
            <dt>Address</dt>
            <dd className="mono">{address}</dd>
            <dt>Balance</dt>
            <dd>
              {balance === null ? '—' : `${formatAr(balance)} AR`}{' '}
              <button
                className="secondary small"
                onClick={() => void run('Refreshing…', () => refreshBalance(address))}
                disabled={busy !== null}
              >
                Refresh
              </button>
              {local && (
                <button className="secondary small" onClick={() => void onMint()} disabled={busy !== null}>
                  Mint {MINT_AMOUNT_AR.toString()} test AR
                </button>
              )}
            </dd>
          </dl>
          {local && (
            <p className="hint">
              You're on a local arlocal gateway, so AR is free — mint some to cover test uploads.
            </p>
          )}
          <div className="actions">
            <button className="secondary danger" onClick={onExport}>
              {exported ? 'Copied ✓' : 'Export keyfile'}
            </button>
          </div>
        </>
      )}

      <h3>Gateway</h3>
      <div className="row-actions">
        <input type="text" value={gateway} onChange={e => setGateway(e.target.value)} placeholder={DEFAULT_ARWEAVE_GATEWAY} />
        <button className="secondary" onClick={() => void onSaveGateway()} disabled={busy !== null || gateway.trim() === ''}>
          Save
        </button>
      </div>
      <p className="hint">
        {DEFAULT_ARWEAVE_GATEWAY} is the main network. For local testing run arlocal and use
        http://localhost:1984 (its faucet can mint test AR).
      </p>

      {busy !== null && <p className="log">{busy}</p>}
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}
