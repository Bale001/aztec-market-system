// The "Store on Arweave" chooser (shown at every upload). Two paths, both
// resolving to the Arweave transaction id the caller stores on-chain:
//
//   * Built-in storage wallet -- pays AR from this device's storage key and
//     uploads directly (the original flow, with the cost shown up front).
//   * Download & upload it yourself -- hands the user the sealed (encrypted)
//     blob to download, they upload it via any 3rd-party Arweave service, and
//     paste the resulting tx id back. The app best-effort verifies the id
//     resolves to the exact bytes before it is used.
//
// An Arweave tx id is the hash of the SIGNED transaction, so it only exists
// after upload -- hence the download-then-paste-back shape; there is no way to
// know the id in advance.
//
// Mounted once at the app root (like SpendConfirmHost) and driven through the
// promise-based `runArweaveUpload`, which every upload site reaches via
// arweave.ts `uploadPayload`.

import { useEffect, useState } from 'react';

import {
  arweaveAddress,
  formatAr,
  getArweaveGateway,
  isLocalGateway,
  loadStoredArweaveKey,
} from './arweave.js';
import { message } from './ui.js';

/** Remembered method, so the next upload defaults to the last choice. */
const LAST_METHOD_KEY = 'market.arweaveUploadMethod.v1';
type Method = 'wallet' | 'self';

function lastMethod(): Method {
  return localStorage.getItem(LAST_METHOD_KEY) === 'self' ? 'self' : 'wallet';
}

// ---------------------------------------------------------------------------
// Presenter plumbing (mirrors spend.tsx): serialize prompts so two uploads
// never race for the one modal.
// ---------------------------------------------------------------------------

type Presenter = (sealed: Uint8Array) => Promise<string>;
let presenter: Presenter | null = null;
let queue: Promise<unknown> = Promise.resolve();

/**
 * Presents the Arweave upload chooser for `sealed` and resolves with the tx id
 * to store on-chain. Rejects if the user cancels (nothing is uploaded/stored).
 */
export function runArweaveUpload(sealed: Uint8Array): Promise<string> {
  const show = () => {
    if (presenter === null) {
      throw new Error('the Arweave upload UI is not mounted; refusing to upload unprompted');
    }
    return presenter(sealed);
  };
  const turn = queue.then(show);
  queue = turn.catch(() => {});
  return turn as Promise<string>;
}

export function ArweaveUploadHost() {
  const [pending, setPending] = useState<{
    sealed: Uint8Array;
    resolve: (txId: string) => void;
    reject: (err: Error) => void;
  } | null>(null);

  useEffect(() => {
    presenter = sealed =>
      new Promise<string>((resolve, reject) => setPending({ sealed, resolve, reject }));
    return () => {
      presenter = null;
    };
  }, []);

  if (pending === null) {
    return null;
  }
  return (
    <UploadModal
      sealed={pending.sealed}
      onDone={txId => {
        setPending(null);
        pending.resolve(txId);
      }}
      onCancel={() => {
        setPending(null);
        pending.reject(new Error('Cancelled — nothing was uploaded or stored.'));
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Triggers a browser download of raw bytes (works in the Electron renderer). */
function downloadBytes(bytes: Uint8Array, filename: string): void {
  // Copy into a fresh ArrayBuffer so the Blob part is not a (possibly shared)
  // buffer view, which the DOM lib types reject.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const blob = new Blob([copy.buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

const TX_ID_RE = /^[A-Za-z0-9_-]{43}$/;

/** Best-effort verification: try to fetch the id and byte-compare to `sealed`. */
async function verifyUpload(
  gateway: string,
  txId: string,
  sealed: Uint8Array,
): Promise<'match' | 'mismatch' | 'unavailable'> {
  const store = await import('@market/arweave-store');
  let fetched: Uint8Array;
  try {
    fetched = await store.fetchBlob(gateway, txId);
  } catch {
    // Not retrievable yet (still propagating) OR the id is wrong -- the caller
    // cannot tell these apart, so it warns and lets the user decide.
    return 'unavailable';
  }
  return bytesEqual(fetched, sealed) ? 'match' : 'mismatch';
}

// ---------------------------------------------------------------------------
// The modal
// ---------------------------------------------------------------------------

function UploadModal({
  sealed,
  onDone,
  onCancel,
}: {
  sealed: Uint8Array;
  onDone: (txId: string) => void;
  onCancel: () => void;
}) {
  const gateway = getArweaveGateway();
  const isLocal = isLocalGateway(gateway);
  const [hasWallet] = useState(() => loadStoredArweaveKey() !== null);
  const [method, setMethod] = useState<Method>(() => (hasWallet ? lastMethod() : 'self'));

  const [cost, setCost] = useState<bigint | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ up: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Self-upload sub-state.
  const [phase, setPhase] = useState<'choose' | 'self'>('choose');
  const [downloaded, setDownloaded] = useState(false);
  const [txId, setTxId] = useState('');
  const [warnUnverified, setWarnUnverified] = useState(false);

  // Quote the storage cost for the wallet option once, on open.
  useEffect(() => {
    if (!hasWallet) {
      return;
    }
    let live = true;
    void (async () => {
      const store = await import('@market/arweave-store');
      const price = await store.uploadPrice(gateway, sealed.length);
      if (live) setCost(price);
    })().catch(err => {
      if (live) setError(message(err));
    });
    return () => {
      live = false;
    };
  }, [hasWallet, gateway, sealed.length]);

  const remember = (m: Method) => localStorage.setItem(LAST_METHOD_KEY, m);

  // --- wallet path: pay AR and upload directly ---
  const uploadWithWallet = () =>
    void (async () => {
      setError(null);
      setBusy('Uploading to Arweave…');
      try {
        const jwk = loadStoredArweaveKey();
        if (jwk === null) {
          throw new Error('no Arweave storage wallet on this device');
        }
        const store = await import('@market/arweave-store');
        const price = cost ?? (await store.uploadPrice(gateway, sealed.length));
        if (isLocal) {
          // Dev: fund + mine so the upload is immediately fetchable.
          await store.arlocalMint(gateway, await arweaveAddress(jwk), price * 2n);
        }
        const id = await store.uploadBlob({
          gatewayUrl: gateway,
          jwk,
          data: sealed,
          onProgress: (up, total) => setProgress({ up, total }),
        });
        if (isLocal) {
          await store.arlocalMine(gateway);
        }
        remember('wallet');
        onDone(id);
      } catch (err) {
        setError(message(err));
        setBusy(null);
        setProgress(null);
      }
    })();

  // --- self path: verify the pasted id, then use it ---
  const useSelfUpload = () =>
    void (async () => {
      setError(null);
      setWarnUnverified(false);
      const id = txId.trim();
      if (!TX_ID_RE.test(id)) {
        setError('That is not an Arweave transaction id (expected 43 URL-safe base64 characters).');
        return;
      }
      setBusy('Verifying the upload…');
      try {
        const result = await verifyUpload(gateway, id, sealed);
        if (result === 'mismatch') {
          setError(
            'The data at that id does not match this blob — did you upload the exact downloaded file?',
          );
          setBusy(null);
          return;
        }
        if (result === 'unavailable') {
          // Best-effort: cannot confirm yet. Let the user store it anyway.
          setWarnUnverified(true);
          setBusy(null);
          return;
        }
        remember('self');
        onDone(id);
      } catch (err) {
        setError(message(err));
        setBusy(null);
      }
    })();

  const storeUnverified = () => {
    remember('self');
    onDone(txId.trim());
  };

  const busyLocked = busy !== null;

  return (
    <div className="modal-backdrop">
      <div className="modal card">
        <h3>Store on Arweave</h3>
        <p className="hint">
          {sealed.length.toLocaleString()} bytes of encrypted data. It is stored permanently and
          publicly, but only holders of this market&apos;s link can decrypt it.
        </p>

        {phase === 'choose' && (
          <>
            <label className={`up-option${method === 'wallet' ? ' active' : ''}${hasWallet ? '' : ' disabled'}`}>
              <input
                type="radio"
                checked={method === 'wallet'}
                disabled={!hasWallet || busyLocked}
                onChange={() => setMethod('wallet')}
              />
              <div>
                <strong>Use built-in storage wallet</strong>
                <div className="hint">
                  {!hasWallet
                    ? 'No storage wallet on this device — create one in the Wallet tab, or upload it yourself.'
                    : isLocal
                      ? `Pays test AR on the local gateway${cost !== null ? ` (${formatAr(cost)} AR)` : ''}.`
                      : cost !== null
                        ? `Cost: ${formatAr(cost)} AR, paid from your storage wallet.`
                        : 'Quoting cost…'}
                </div>
              </div>
            </label>

            <label className={`up-option${method === 'self' ? ' active' : ''}`}>
              <input
                type="radio"
                checked={method === 'self'}
                disabled={busyLocked}
                onChange={() => setMethod('self')}
              />
              <div>
                <strong>Download &amp; upload it myself</strong>
                <div className="hint">
                  Download the encrypted blob and upload it with any Arweave service, then paste the
                  transaction id back. No storage wallet needed.
                </div>
              </div>
            </label>

            {busy !== null && (
              <p className="log">
                {busy}
                {progress !== null && ` (${progress.up}/${progress.total} chunks)`}
              </p>
            )}
            {error !== null && <p className="error">{error}</p>}

            <div className="actions">
              <button className="secondary" onClick={onCancel} disabled={busyLocked}>
                Cancel
              </button>
              <button
                onClick={() => (method === 'wallet' ? uploadWithWallet() : setPhase('self'))}
                disabled={busyLocked || (method === 'wallet' && !hasWallet)}
              >
                Continue
              </button>
            </div>
          </>
        )}

        {phase === 'self' && (
          <>
            <ol className="up-steps">
              <li>
                Download the encrypted blob.
                <div className="actions">
                  <button
                    className="secondary"
                    disabled={busyLocked}
                    onClick={() => {
                      downloadBytes(sealed, 'aztec-market-blob.bin');
                      setDownloaded(true);
                    }}
                  >
                    {downloaded ? 'Re-download blob' : 'Download blob'}
                  </button>
                </div>
              </li>
              <li>
                Upload that file to Arweave with any service, e.g.{' '}
                <span className="mono">arweave.app</span>, <span className="mono">ardrive.io</span>,
                or <span className="mono">turbo.ardrive.io</span> (open in your browser). Any service
                that returns an Arweave transaction id works.
              </li>
              <li>
                Paste the resulting transaction id:
                <input
                  type="text"
                  value={txId}
                  placeholder="43-character Arweave tx id"
                  spellCheck={false}
                  disabled={busyLocked}
                  onChange={e => {
                    setTxId(e.target.value);
                    setWarnUnverified(false);
                    setError(null);
                  }}
                />
              </li>
            </ol>

            {busy !== null && <p className="log">{busy}</p>}
            {error !== null && <p className="error">{error}</p>}
            {warnUnverified && (
              <p className="hint warn">
                ⚠ Couldn&apos;t retrieve the data at that id yet. On mainnet it can take several
                minutes to propagate — or the id may be wrong. Double-check it, or store it anyway.
              </p>
            )}

            <div className="actions">
              <button className="secondary" onClick={() => setPhase('choose')} disabled={busyLocked}>
                Back
              </button>
              {warnUnverified ? (
                <button onClick={storeUnverified} disabled={busyLocked}>
                  Store anyway
                </button>
              ) : (
                <button onClick={useSelfUpload} disabled={busyLocked || txId.trim() === ''}>
                  Verify &amp; continue
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
