// The account switcher shown at the top of an opened market: which per-market
// account you are acting as, your role, and controls to switch/rename.
// Per-market accounts are derived from your universal seed (recover them by
// restoring the seed on the Wallet tab), so there is no per-account key to
// import or export here -- only the account's ADDRESS, which you share to be
// appointed a moderator.
//
// Accounts are NOT created here: claiming a username on the market creates one
// (see App's claimUsername). Everyone starts with the anonymous account, which
// stays anonymous.

import { MAX_USERNAME_BYTES } from '@market/market-metadata';
import { useState } from 'react';

import type { Role, StoredIdentity } from './identity.js';
import { message, RoleBadge } from './ui.js';

export function IdentityBar({
  identities,
  active,
  role,
  roleLoading,
  onSwitch,
  onRename,
  onAddAccount,
}: {
  identities: StoredIdentity[];
  active: StoredIdentity;
  role: Role | null;
  roleLoading: boolean;
  onSwitch: (id: string) => void;
  onRename: (id: string, label: string) => void;
  /**
   * Creates ANOTHER account on this market by claiming a username for it. Every
   * account is born with a handle (there are no blank ones), so adding one is
   * exactly a claim -- it derives a fresh wallet and registers the name to it.
   */
  onAddAccount: (username: string) => Promise<void>;
}) {
  const [mode, setMode] = useState<'idle' | 'rename' | 'add'>('idle');
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = (next: 'rename' | 'add') => {
    setDraft(next === 'rename' ? active.label : '');
    setError(null);
    setMode(next);
  };
  const close = () => {
    setMode('idle');
    setDraft('');
    setError(null);
  };
  const submit = () => {
    if (mode === 'rename') {
      onRename(active.id, draft);
      close();
      return;
    }
    // Creating an account claims its username on-chain, so it can fail (name
    // taken, transaction rejected). Keep the input open and show why.
    setError(null);
    setBusy(true);
    void onAddAccount(draft)
      .then(close)
      .catch(err => setError(message(err)))
      .finally(() => setBusy(false));
  };

  // The account's on-chain address -- safe to share (e.g. give it to the owner
  // to be appointed a moderator).
  const copyAddress = () => {
    if (role === null) return;
    void navigator.clipboard.writeText(role.address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // A named account's label IS its username by default, so show "@handle"
  // rather than repeating it; a renamed one shows both.
  const accountLabel = (a: StoredIdentity) => {
    if (a.kind === 'owner') {
      return a.username ? `👑 ${a.label} (@${a.username})` : `👑 ${a.label}`;
    }
    if (a.username === null) {
      return a.label;
    }
    return a.username === a.label ? `@${a.username}` : `${a.label} (@${a.username})`;
  };

  return (
    <div className="identity-bar">
      <div className="identity-current">
        <span className="identity-lead">Acting as</span>
        <select
          className="identity-switch"
          value={active.id}
          onChange={e => onSwitch(e.target.value)}
        >
          {identities.map(i => (
            <option key={i.id} value={i.id}>
              {accountLabel(i)}
            </option>
          ))}
        </select>
        {role !== null ? (
          <RoleBadge role={role} />
        ) : (
          <span className="role-badge role-buyer">{roleLoading ? '…' : '—'}</span>
        )}
      </div>

      <div className="identity-actions">
        {mode === 'idle' ? (
          <>
            <button
              className="secondary small"
              onClick={() => start('rename')}
              disabled={active.kind === 'owner'}
              title={active.kind === 'owner' ? 'the Owner account keeps its name' : undefined}
            >
              Rename
            </button>
            <button
              className="secondary small"
              onClick={() => start('add')}
              title="Create another account on this market by claiming a username for it"
            >
              + New account
            </button>
            <button
              className="secondary small"
              onClick={copyAddress}
              disabled={role === null}
              title="This account's address on this market — safe to share (e.g. give it to the owner to be made a moderator)"
            >
              {copied ? 'Copied ✓' : 'Copy address'}
            </button>
          </>
        ) : (
          <>
            <input
              autoFocus
              type="text"
              value={draft}
              disabled={busy}
              {...(mode === 'add' ? { maxLength: MAX_USERNAME_BYTES } : {})}
              placeholder={mode === 'add' ? 'Username for the new account' : 'New name'}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') submit();
                if (e.key === 'Escape' && !busy) close();
              }}
            />
            <button className="secondary small" onClick={submit} disabled={busy || draft.trim() === ''}>
              {mode === 'add' ? (busy ? 'Creating…' : 'Create') : 'Save'}
            </button>
            <button className="secondary small" onClick={close} disabled={busy}>
              Cancel
            </button>
          </>
        )}
      </div>
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}
