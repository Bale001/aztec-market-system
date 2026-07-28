// The Messages tab: every conversation of this market's messaging profile --
// buyer questions, vendor replies, dispute rooms -- rendered natively in the
// app. Messaging runs entirely inside the app (the embedded core talks to
// relay servers directly); users never handle an external messenger.
//
// One messaging profile per market (see ./simplex.ts): conversations here are
// market-scoped, so activity on different markets stays unlinkable.

import { useCallback, useEffect, useRef, useState } from 'react';

import { summarizeDisputeEnvelope } from './disputes.js';
import {
  ensureMarketProfile,
  loadStoredMarketProfile,
  parseChatItems,
  simplex,
  simplexAvailable,
  type ChatMessage,
  type Conversation,
} from './simplex.js';
import { message } from './ui.js';

/** A conversation plus the profile (userId) it belongs to: the Messages tab
 * aggregates the MAIN market profile and, for operators, the dispute-desk
 * profile (whose business address owns the per-dispute rooms). */
interface ConvoEntry extends Conversation {
  userId: number;
}

export function MessagesPanel({
  marketAddr,
  profileName,
  accountKey,
}: {
  marketAddr: string;
  profileName: string;
  /**
   * Identifies the active per-market account. Messaging profiles are per
   * account, so this has to be a dependency of the load effect -- `profileName`
   * cannot stand in for it, since two accounts may carry the same label and the
   * panel would then keep showing the previous account's conversations.
   */
  accountKey: string;
}) {
  const [userIds, setUserIds] = useState<number[] | null>(null);
  const [convos, setConvos] = useState<ConvoEntry[] | null>(null);
  const [selected, setSelected] = useState<ConvoEntry | null>(null);
  const [thread, setThread] = useState<ChatMessage[] | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Refs so the (debounced) event handler always sees the current selection.
  const userIdsRef = useRef<number[] | null>(null);
  userIdsRef.current = userIds;
  const selectedRef = useRef<ConvoEntry | null>(null);
  selectedRef.current = selected;
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  const refreshConvos = useCallback(async (uids: number[]) => {
    const bridge = simplex();
    const list: ConvoEntry[] = [];
    for (const uid of uids) {
      const [contacts, groups] = await Promise.all([
        bridge.listContacts(uid),
        bridge.listGroups(uid),
      ]);
      // Joined groups first (dispute rooms), then direct conversations.
      list.push(
        ...groups
          .filter(g => g.membership?.memberStatus !== 'invited')
          .map(g => ({ kind: 'group' as const, id: g.groupId, name: g.localDisplayName, userId: uid })),
        ...contacts.map(c => ({ kind: 'direct' as const, id: c.contactId, name: c.localDisplayName, userId: uid })),
      );
    }
    setConvos(list);
  }, []);

  const refreshThread = useCallback(async (convo: ConvoEntry) => {
    setThread(parseChatItems(await simplex().getChat(convo.userId, convo.kind, convo.id, 60)));
  }, []);

  // Open (or create) this market's messaging profile and load conversations
  // (plus the dispute-desk profile's rooms, if this device operates one).
  useEffect(() => {
    let live = true;
    void (async () => {
      const profile = await ensureMarketProfile(marketAddr, profileName);
      const disputeDesk = await loadStoredMarketProfile(marketAddr, 'dispute');
      // Idempotent: makes sure the messaging loop is running this app session.
      await simplex().start();
      if (!live) return;
      const uids = [profile.userId, ...(disputeDesk !== null ? [disputeDesk.userId] : [])];
      setUserIds(uids);
      await refreshConvos(uids);
    })().catch(err => {
      if (live) setError(message(err));
    });
    return () => {
      live = false;
    };
  }, [marketAddr, profileName, accountKey, refreshConvos]);

  // Live updates: any core event may mean a new message, contact, or group;
  // refresh (debounced) while the tab is mounted.
  useEffect(() => {
    if (!simplexAvailable()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = simplex().onEvent(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        const uids = userIdsRef.current;
        if (uids === null) return;
        void refreshConvos(uids).catch(err => setError(message(err)));
        const sel = selectedRef.current;
        if (sel !== null) {
          void refreshThread(sel).catch(err => setError(message(err)));
        }
      }, 600);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [refreshConvos, refreshThread]);

  // Keep the newest message in view.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' });
  }, [thread]);

  const onSelect = (convo: ConvoEntry) => {
    setSelected(convo);
    setThread(null);
    setError(null);
    void refreshThread(convo).catch(err => setError(message(err)));
  };

  const onSend = () => {
    const text = draft.trim();
    if (selected === null || text === '') return;
    setBusy(true);
    setError(null);
    void simplex()
      .sendText(selected.userId, selected.kind, selected.id, text)
      .then(() => {
        setDraft('');
        return refreshThread(selected);
      })
      .catch(err => setError(message(err)))
      .finally(() => setBusy(false));
  };

  if (!simplexAvailable()) {
    return (
      <div className="panel">
        <h2>Messages</h2>
        <p className="error">The messaging core is only available in the desktop app.</p>
      </div>
    );
  }

  return (
    <div className="panel">
      <h2>Messages</h2>
      <p className="hint">
        End-to-end encrypted, in-app, and market-scoped: buyers, vendors, and dispute rooms for
        this market all live here. No phone number, no account — conversations on different
        markets are unlinkable.
      </p>

      {error !== null && <p className="error">{error}</p>}

      {convos === null ? (
        <p className="log">Opening your conversations…</p>
      ) : convos.length === 0 ? (
        <p>
          No conversations yet. Message a vendor from a listing, or wait here — new conversations
          appear on their own.
        </p>
      ) : (
        <div className="messages">
          <aside className="convo-list">
            {convos.map(c => (
              <button
                key={`${c.userId}:${c.kind}:${c.id}`}
                className={
                  selected !== null &&
                  selected.userId === c.userId &&
                  selected.kind === c.kind &&
                  selected.id === c.id
                    ? 'convo active'
                    : 'convo'
                }
                onClick={() => onSelect(c)}
              >
                {c.kind === 'group' ? '👥 ' : ''}
                {c.name}
              </button>
            ))}
          </aside>
          <section className="thread-pane">
            {selected === null ? (
              <p className="hint">Select a conversation.</p>
            ) : (
              <>
                <div className="thread">
                  {thread === null ? (
                    <p className="log">Loading…</p>
                  ) : thread.length === 0 ? (
                    <p className="hint">No messages yet — say hello.</p>
                  ) : (
                    thread.map(m => {
                      // A dispute room's auth envelope is machine data; show a
                      // readable line instead of its raw JSON.
                      const dispute = summarizeDisputeEnvelope(m.text);
                      return (
                        <div key={m.id} className={m.mine ? 'msg mine' : 'msg'}>
                          {!m.mine && m.author !== '' && <div className="msg-author">{m.author}</div>}
                          <div>
                            {dispute === null ? m.text : `🔒 Dispute opened — “${dispute.statement}”`}
                          </div>
                          {m.sentAt !== '' && (
                            <div className="msg-time">{new Date(m.sentAt).toLocaleString()}</div>
                          )}
                        </div>
                      );
                    })
                  )}
                  <div ref={threadEndRef} />
                </div>
                <div className="composer">
                  <input
                    type="text"
                    value={draft}
                    placeholder="Write a message…"
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') onSend();
                    }}
                  />
                  <button onClick={onSend} disabled={busy || draft.trim() === ''}>
                    Send
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
