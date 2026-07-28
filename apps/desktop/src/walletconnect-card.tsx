// "Connect an external wallet" card (Wallet tab). Hosts the wallet end of the
// @aztec/wallet-sdk connection protocol so a third-party dApp -- notably the
// Shield (human.tech) bridge -- can drive this app's universal account as its
// Aztec wallet. The user pastes the shown "web wallet URL" into the dApp's
// wallet-connect field; the dApp then loads it as a relay iframe and speaks the
// encrypted protocol to the handler running here (see walletconnect.ts).
//
// The approval prompt and the emoji verification render in THIS app, natively —
// the relay iframe is a keyless pass-through. Approve a connection you started,
// then confirm the 3x3 emoji grid matches the one the dApp shows before signing
// anything: matching emojis prove there is no machine-in-the-middle.

import { hashToEmoji } from '@aztec/wallet-sdk/crypto';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { useEffect, useRef, useState } from 'react';

import type { UniversalSession } from './session.js';
import { message } from './ui.js';
import {
  WalletConnectHandler,
  walletConnectAvailable,
  walletConnectBridge,
  type ActiveSession,
  type PendingSession,
} from './walletconnect.js';

/** A short, human-readable origin ("shield.human.tech") from a full URL. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host || origin;
  } catch {
    return origin;
  }
}

function EmojiGrid({ hash }: { hash: string }) {
  const emojis = Array.from(hashToEmoji(hash));
  return (
    <div className="wc-emoji-grid" aria-label="verification emojis">
      {emojis.map((e, i) => (
        <span key={i} className="wc-emoji">{e}</span>
      ))}
    </div>
  );
}

export function WalletConnectCard({ session }: { session: UniversalSession | null }) {
  const available = walletConnectAvailable();
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState<PendingSession[]>([]);
  const [active, setActive] = useState<ActiveSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const handlerRef = useRef<WalletConnectHandler | null>(null);
  // Keep getWallet pointing at the latest connected session without tearing the
  // handler down when the session object is replaced (e.g. after a reconnect).
  const sessionRef = useRef<UniversalSession | null>(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Tear the relay down on unmount if it was left running.
  useEffect(() => {
    return () => {
      if (handlerRef.current !== null) {
        handlerRef.current.stop();
        handlerRef.current = null;
        if (available) {
          void walletConnectBridge().stop();
        }
      }
    };
  }, [available]);

  async function enable() {
    setError(null);
    try {
      const bridge = walletConnectBridge();
      const handler = new WalletConnectHandler(
        {
          walletId: 'aztec-market',
          walletName: 'Aztec Market Wallet',
          walletVersion: '0.1.0',
        },
        {
          onPendingDiscovery: s => setPending(p => [...p.filter(x => x.requestId !== s.requestId), s]),
          onSessionEstablished: s => {
            setActive(a => [...a.filter(x => x.sessionId !== s.sessionId), s]);
            setPending(p => p.filter(x => x.requestId !== s.sessionId));
          },
          onSessionTerminated: id => {
            setActive(a => a.filter(x => x.sessionId !== id));
            setPending(p => p.filter(x => x.requestId !== id));
          },
          getWallet: () => {
            const s = sessionRef.current;
            if (s === null) {
              throw new Error('open your wallet before connecting an external app');
            }
            return Promise.resolve(s.wallet as unknown as Wallet);
          },
        },
        bridge,
      );
      const { url: relayUrl } = await bridge.start();
      handler.start();
      handlerRef.current = handler;
      setUrl(relayUrl);
      setEnabled(true);
    } catch (err) {
      setError(message(err));
    }
  }

  async function disable() {
    setError(null);
    for (const s of active) {
      handlerRef.current?.terminateSession(s.sessionId);
    }
    handlerRef.current?.stop();
    handlerRef.current = null;
    try {
      await walletConnectBridge().stop();
    } catch (err) {
      setError(message(err));
    }
    setEnabled(false);
    setUrl(null);
    setPending([]);
    setActive([]);
  }

  if (!available) {
    return null;
  }

  return (
    <div className="card">
      <h2>Connect an external wallet</h2>
      <p>
        Let a third-party app — such as the <strong>Shield</strong> bridge — use this wallet as its
        Aztec wallet, so you can bridge funds in without leaving your keys with anyone. Turn this on,
        copy the URL below, and paste it into the app's <em>web wallet URL</em> field. You approve
        every connection here, in this app.
      </p>

      {!enabled ? (
        <div className="actions">
          <button onClick={() => void enable()} disabled={session === null}>
            Enable external connection
          </button>
          {session === null && <span className="hint">Open your wallet first.</span>}
        </div>
      ) : (
        <>
          <label>Web wallet URL (paste this into the external app)</label>
          <div className="row-actions">
            <input type="text" readOnly value={url ?? ''} spellCheck={false} />
            <button
              className="secondary"
              onClick={() => {
                if (url === null) return;
                void navigator.clipboard.writeText(url).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
            <button className="secondary" onClick={() => void disable()}>Turn off</button>
          </div>

          {pending.map(p => (
            <div className="box wc-pending" key={p.requestId}>
              <h4>Connection request</h4>
              <p>
                <strong>{hostOf(p.origin)}</strong> wants to connect to your wallet.
              </p>
              <p className="hint">Only approve this if you just started a connection from that app.</p>
              <div className="row-actions">
                <button onClick={() => handlerRef.current?.approveDiscovery(p.requestId)}>Approve</button>
                <button
                  className="secondary"
                  onClick={() => {
                    handlerRef.current?.rejectDiscovery(p.requestId);
                    setPending(list => list.filter(x => x.requestId !== p.requestId));
                  }}
                >
                  Reject
                </button>
              </div>
            </div>
          ))}

          {active.map(s => (
            <div className="box wc-active" key={s.sessionId}>
              <h4>Connected — {hostOf(s.origin)}</h4>
              <p className="hint">
                Confirm these emojis are identical to the ones shown in {hostOf(s.origin)}. If they
                differ, disconnect immediately — the connection is being tampered with.
              </p>
              <EmojiGrid hash={s.verificationHash} />
              <p className="hint">
                If the emojis look blank, your system has no color-emoji font — compare this code
                instead (it maps to the same emojis):
              </p>
              <p className="mono">{s.verificationHash}</p>
              <div className="actions">
                <button className="secondary" onClick={() => handlerRef.current?.terminateSession(s.sessionId)}>
                  Disconnect
                </button>
              </div>
            </div>
          ))}

          {pending.length === 0 && active.length === 0 && (
            <p className="hint">Waiting for the external app to connect…</p>
          )}
        </>
      )}

      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}
