// Wallet-tab card for the embedded SimpleX messaging core (AD-6): shows
// whether the core is running and which per-market profiles exist. Profiles
// and addresses are created lazily by market flows (dispute intake, contact
// publication), not here.

import React, { useEffect, useState } from 'react';

import { ensureSimplexRunning, simplex, simplexAvailable, type SimplexUserInfo } from './simplex.js';
import { message } from './ui.js';

export function SimplexCard() {
  const [available] = useState(simplexAvailable());
  const [started, setStarted] = useState(false);
  const [users, setUsers] = useState<SimplexUserInfo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!available) {
      return;
    }
    // Cheap probe only -- do not create the database just by opening the tab.
    void simplex()
      .status()
      .then(s => {
        setStarted(s.started);
        if (s.initialized) {
          setUsers(s.users);
        }
      })
      .catch(err => setError(message(err)));
  }, [available]);

  async function onStart() {
    setBusy('Starting the messaging core…');
    setError(null);
    try {
      const result = await ensureSimplexRunning();
      setUsers(result.users);
      setStarted(result.started);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2>Secure messaging</h2>
      <p>
        Buyer questions, vendor replies, and disputes all happen in-app — end-to-end encrypted,
        with no phone number or account. The messaging core runs inside the app; each market gets
        its own messaging profile, so your activity on different markets stays unlinkable.
      </p>
      {!available ? (
        <p className="hint">Messaging is available only in the desktop app.</p>
      ) : (
        <>
          <dl className="summary">
            <dt>Core</dt>
            <dd>{started ? 'running' : users === null ? 'not initialized' : 'stopped'}</dd>
            <dt>Market profiles</dt>
            <dd>
              {users === null || users.length === 0
                ? 'none yet — created automatically when a market flow first needs one'
                : users.map(u => u.user.localDisplayName).join(', ')}
            </dd>
          </dl>
          {!started && (
            <div className="actions">
              <button onClick={() => void onStart()} disabled={busy !== null}>
                Start messaging core
              </button>
            </div>
          )}
        </>
      )}
      {busy !== null && <p className="log">{busy}</p>}
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}
