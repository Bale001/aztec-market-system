// Owner/moderator Disputes tab (AD-6, phase 3), rendered as a MESSAGING-STYLE
// inbox: dispute rooms already ARE conversations (see ./messages.tsx), so this
// panel presents them the same way -- a case list on the left, the room's
// thread on the right -- and hangs the case tools off that thread instead of a
// stack of forms:
//
//   * the buyer's opening statement shows as a quoted system bubble;
//   * verification (the security-critical step) runs inline -- automatically if
//     the proof package is in the room, otherwise via a compact paste box --
//     and shows as a badge on the case plus a verdict note in the thread;
//   * ruling (refund buyer / pay vendor) is an action bar under the thread, with
//     the order id already lifted from the conversation;
//   * owners can pull a moderator into the selected room by username;
//   * everyone with a role can reply in the room from the composer.
//
// Channel/contact publication -- the one-time setup -- collapses into a header
// so it does not dominate the day-to-day view. Verification stays fully offline
// from the messaging layer and never learns the buyer's identity.

import { Fr } from '@aztec/aztec.js/fields';
import { resolveDispute, resolveUsername } from '@market/deployment';
import { DisputeOutcome, PERM_RESOLVE_DISPUTES } from '@market/shared-types';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  inviteModerator,
  parseDisputeEnvelope,
  publishDisputeIntake,
  publishPersonalContact,
  resolveDisputeIntake,
  summarizeDisputeEnvelope,
  verifyDisputeEnvelope,
  type DisputeEnvelope,
  type DisputeVerdict,
} from './disputes.js';
import type { Role } from './identity.js';
import { marketAction, type Session, type TransactionalSession } from './session.js';
import {
  ensureMarketProfile,
  loadStoredMarketProfile,
  parseChatItems,
  simplex,
  simplexAvailable,
  type ChatMessage,
} from './simplex.js';
import { runWithSpendContext } from './spend.js';
import { message, type OpenedMarket } from './ui.js';

/** A dispute room: a group on one of the profiles this device can see (the
 * operator's dispute-desk profile, and/or a moderator's own market profile). */
interface DisputeCase {
  userId: number;
  groupId: number;
  /** Order-derived label when known, else the raw group name. */
  label: string;
  /** Order id lifted from the room's opening message, if parseable. */
  orderId: string | null;
}

/** Shortens a 0x order id for a compact label. */
function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** What we can learn about a dispute from its room's messages, offline: the
 * order id, the buyer's statement, and -- if the buyer pasted the full proof
 * package into the room -- the verifiable envelope itself. */
function deriveCase(msgs: ChatMessage[]): {
  orderId: string | null;
  statement: string | null;
  envelope: DisputeEnvelope | null;
} {
  let orderId: string | null = null;
  let statement: string | null = null;
  let envelope: DisputeEnvelope | null = null;
  for (const m of msgs) {
    const env = parseDisputeEnvelope(m.text.trim());
    if (env !== null) {
      // The auth envelope is authoritative: it carries the order id, the
      // complaint, and the secret that authenticates the buyer.
      envelope = env;
      orderId = env.orderId;
      statement = env.statement;
      continue;
    }
    // Opening announcement: "Dispute opened for order 0x...\n\nStatement: ...".
    if (orderId === null) {
      const idMatch = m.text.match(/order\s+(0x[0-9a-fA-F]+)/i);
      if (idMatch?.[1] !== undefined) orderId = idMatch[1];
    }
    if (statement === null) {
      const stMatch = m.text.match(/Statement:\s*([\s\S]+)/i);
      if (stMatch?.[1] !== undefined) statement = stMatch[1].trim();
    }
  }
  return { orderId, statement, envelope };
}

export function DisputesPanel({
  viewer,
  opened,
  secret,
  role,
  ensureSession,
}: {
  viewer: Session;
  opened: OpenedMarket;
  secret: Fr;
  role: Role | null;
  session: TransactionalSession | null;
  ensureSession: () => Promise<TransactionalSession>;
}) {
  const market = opened.market;
  const marketAddr = market.marketplaceAddress.toString();
  const isOwner = role?.isOwner ?? false;
  const isModerator = role !== null && role.moderatorPerms !== 0n;
  const mayRule =
    isOwner ||
    (role !== null && (role.moderatorPerms & PERM_RESOLVE_DISPUTES) === PERM_RESOLVE_DISPUTES);

  // Inbox state.
  const [cases, setCases] = useState<DisputeCase[] | null>(null);
  const [selected, setSelected] = useState<DisputeCase | null>(null);
  const [thread, setThread] = useState<ChatMessage[] | null>(null);
  const [statement, setStatement] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // Per-case verification.
  const [verifying, setVerifying] = useState(false);
  const [verdict, setVerdict] = useState<DisputeVerdict | null>(null);
  const [paste, setPaste] = useState('');

  // Per-case tools.
  const [modName, setModName] = useState('');
  const [inviteNote, setInviteNote] = useState<string | null>(null);
  const [ruleNote, setRuleNote] = useState<string | null>(null);

  // Setup header (publish channel / contact).
  const [setupOpen, setSetupOpen] = useState(false);
  const [intake, setIntake] = useState<string | null>(null);
  const [personal, setPersonal] = useState<string | null>(null);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Refs so the debounced live-refresh handler always sees the latest selection.
  const selectedRef = useRef<DisputeCase | null>(null);
  selectedRef.current = selected;
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  // The SimpleX profiles whose groups are dispute rooms for THIS device:
  // owners see the dedicated dispute-desk profile; moderators see their own
  // market profile (the rooms they were pulled into and auto-joined).
  const disputeProfileIds = useCallback(async (): Promise<number[]> => {
    const ids: number[] = [];
    if (isOwner) {
      // Do NOT create the desk just by opening the tab -- it exists once the
      // owner has published the channel below.
      const desk = await loadStoredMarketProfile(marketAddr, 'dispute');
      if (desk !== null) ids.push(desk.userId);
    }
    if (isModerator) {
      const mod = await ensureMarketProfile(marketAddr, 'Moderator');
      ids.push(mod.userId);
    }
    return ids;
  }, [isOwner, isModerator, marketAddr]);

  const refreshCases = useCallback(async () => {
    const ids = await disputeProfileIds();
    const bridge = simplex();
    const list: DisputeCase[] = [];
    for (const uid of ids) {
      const groups = await bridge.listGroups(uid);
      for (const g of groups) {
        if (g.membership?.memberStatus === 'invited') continue; // not joined yet
        // A cheap peek at the room extracts the order id for the label.
        const derived = deriveCase(parseChatItems(await bridge.getChat(uid, 'group', g.groupId, 12)));
        list.push({
          userId: uid,
          groupId: g.groupId,
          orderId: derived.orderId,
          label: derived.orderId !== null ? `Order ${shortId(derived.orderId)}` : g.localDisplayName,
        });
      }
    }
    setCases(list);
  }, [disputeProfileIds]);

  // Load a room's full thread, lift the statement/order id, and auto-verify if
  // the proof package happens to be in the room. Applied only if this case is
  // still the selected one (a later selection must win).
  const refreshThread = useCallback(
    async (c: DisputeCase) => {
      const msgs = parseChatItems(await simplex().getChat(c.userId, 'group', c.groupId, 60));
      if (selectedRef.current?.groupId !== c.groupId || selectedRef.current.userId !== c.userId) {
        return;
      }
      const derived = deriveCase(msgs);
      setThread(msgs);
      setStatement(derived.statement);
      setOrderId(derived.orderId);
      if (derived.envelope !== null) {
        setVerifying(true);
        const v = await verifyDisputeEnvelope(viewer, market, derived.envelope);
        if (selectedRef.current?.groupId === c.groupId && selectedRef.current.userId === c.userId) {
          setVerdict(v);
          setVerifying(false);
        }
      }
    },
    [viewer, market],
  );

  // Open the inbox: load the case list.
  //
  // Dispute-room auto-join is NOT here. It runs in App for as long as the
  // market is open, so an invitation lands whether or not the moderator has
  // thought to visit this tab -- which is the whole point of it being
  // automatic. Doing it here as well would subscribe twice.
  useEffect(() => {
    let live = true;
    void refreshCases().catch(err => {
      if (live) setError(message(err));
    });
    return () => {
      live = false;
    };
  }, [refreshCases]);

  // Live updates: any core event may be a new room or a new message; refresh
  // the case list and the open thread (debounced) while mounted.
  useEffect(() => {
    if (!simplexAvailable()) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = simplex().onEvent(() => {
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void refreshCases().catch(err => setError(message(err)));
        const sel = selectedRef.current;
        if (sel !== null) void refreshThread(sel).catch(err => setError(message(err)));
      }, 600);
    });
    return () => {
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
    };
  }, [refreshCases, refreshThread]);

  // Keep the newest message in view.
  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ block: 'end' });
  }, [thread]);

  const onSelect = (c: DisputeCase) => {
    setSelected(c);
    setThread(null);
    setStatement(null);
    setOrderId(c.orderId);
    setVerdict(null);
    setVerifying(false);
    setPaste('');
    setInviteNote(null);
    setRuleNote(null);
    setError(null);
    void refreshThread(c).catch(err => setError(message(err)));
  };

  // Spend-aware wrapper for user-initiated actions (some enqueue a tx).
  async function run(label: string, action: () => Promise<void>) {
    setError(null);
    setBusy(label);
    try {
      await runWithSpendContext({ title: label }, action);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(null);
    }
  }

  // --- setup: publish the dispute channel (owner) / contact (moderator) ---
  const onPublishIntake = () =>
    run('Publishing the dispute channel…', async () => {
      const s = await ensureSession();
      setIntake(await publishDisputeIntake(s, market, secret));
      await refreshCases();
    });

  const onLoadIntake = () =>
    run('Looking up the dispute channel…', async () => {
      setIntake((await resolveDisputeIntake(viewer, market, secret)) ?? '(none published yet)');
    });

  const onPublishPersonal = () =>
    run('Publishing your contact address…', async () => {
      const s = await ensureSession();
      setPersonal(await publishPersonalContact(s, market, secret, 'Moderator'));
    });

  // --- selected case: verify, rule, add a moderator, reply ---
  const onVerify = () =>
    run('Verifying the dispute…', async () => {
      const envelope = parseDisputeEnvelope(paste.trim());
      if (envelope === null) throw new Error('that text is not a dispute verification message');
      setStatement(envelope.statement);
      setOrderId(envelope.orderId);
      setVerdict(await verifyDisputeEnvelope(viewer, market, envelope));
      setPaste('');
    });

  const onRule = (outcome: DisputeOutcome.RefundBuyer | DisputeOutcome.PayVendor) =>
    run(
      outcome === DisputeOutcome.RefundBuyer ? 'Ruling: refund the buyer…' : 'Ruling: pay the vendor…',
      async () => {
        if (orderId === null) throw new Error('no order id for this dispute yet');
        setRuleNote(null);
        const s = await ensureSession();
        await resolveDispute({
          wallet: s.wallet, node: s.node, from: s.from,
          ...marketAction(s),
          marketplaceAddress: market.marketplaceAddress,
          orderId: Fr.fromString(orderId),
          outcome,
        });
        setRuleNote(
          outcome === DisputeOutcome.RefundBuyer
            ? '✓ ruled: the buyer can now claim their refund from My Orders'
            : '✓ ruled: the vendor can now settle immediately from their order inbox',
        );
      },
    );

  const onInviteModerator = () =>
    run('Inviting the moderator to the room…', async () => {
      if (selected === null) return;
      setInviteNote(null);
      const moderator = await resolveUsername({
        wallet: viewer.wallet, node: viewer.node, from: viewer.from,
        marketplaceAddress: market.marketplaceAddress,
        username: modName.trim(), accessSecret: secret,
      });
      const result = await inviteModerator(viewer, market, secret, {
        ownerUserId: selected.userId, // owner cases live on the dispute-desk profile
        groupId: selected.groupId,
        moderatorIdentity: moderator.toField(),
      });
      setInviteNote(result.added ? '✓ moderator added to the room' : result.reason ?? null);
    });

  // A room reply is pure messaging (no chain spend), so send it directly rather
  // than through the spend-confirmation wrapper.
  const onSend = () => {
    const text = draft.trim();
    if (selected === null || text === '') return;
    const c = selected;
    setBusy('Sending…');
    setError(null);
    void simplex()
      .sendText(c.userId, 'group', c.groupId, text)
      .then(() => {
        setDraft('');
        return refreshThread(c);
      })
      .catch(err => setError(message(err)))
      .finally(() => setBusy(null));
  };

  if (!simplexAvailable()) {
    return (
      <div className="panel">
        <h2>Disputes</h2>
        <p className="error">The messaging core is only available in the desktop app.</p>
      </div>
    );
  }

  const verdictBadge =
    verifying ? <span className="vendor-badge checking">checking…</span>
    : verdict === null ? <span className="vendor-badge checking">unverified</span>
    : verdict.ok ? <span className="vendor-badge verified">✓ verified</span>
    : <span className="vendor-badge unverified">✗ not valid</span>;

  return (
    <div className="panel">
      <h2>Disputes</h2>
      <p className="hint">
        Every dispute is a private, end-to-end-encrypted room (no user identifiers). Pick a case to
        read it, talk it through, and rule — all in one place. The buyer is verified automatically
        against the market's chain state, and their identity is never revealed.
      </p>

      {/* One-time setup, tucked out of the way. */}
      <details className="setup" open={setupOpen} onToggle={e => setSetupOpen((e.target as HTMLDetailsElement).open)}>
        <summary>Setup — dispute channel &amp; contact</summary>
        <div className="setup-body">
          {isOwner && (
            <>
              <p className="hint">
                Publish this market's dispute channel (attested on-chain under your Owner identity)
                so buyers can find it. Each buyer who opens a dispute lands in their own room here.
              </p>
              <div className="row-actions">
                <button disabled={busy !== null} onClick={() => void onPublishIntake()}>
                  Publish / refresh dispute channel
                </button>
                <button className="secondary" disabled={busy !== null} onClick={() => void onLoadIntake()}>
                  Show current channel
                </button>
              </div>
              {intake !== null && <p className="mono breakable">{intake}</p>}
            </>
          )}
          {isModerator && (
            <>
              <p className="hint">
                Publish your contact address (attested under your moderator identity) so the operator
                can pull you into dispute rooms — they then appear here and in Messages.
              </p>
              <div className="actions">
                <button disabled={busy !== null} onClick={() => void onPublishPersonal()}>
                  Publish my contact address
                </button>
              </div>
              {personal !== null && <p className="mono breakable">{personal}</p>}
              {isModerator && (
                <p className="hint">
                  ✓ dispute-room invitations are accepted automatically whenever you have this
                  market open — you do not need to be on this tab.
                </p>
              )}
            </>
          )}
        </div>
      </details>

      {error !== null && <p className="error">{error}</p>}

      {cases === null ? (
        <p className="log">Opening your dispute rooms…</p>
      ) : cases.length === 0 ? (
        <p>
          No disputes yet. {isOwner ? 'Publish the dispute channel above so buyers can reach you; ' : ''}
          rooms appear here on their own when a buyer opens one.
        </p>
      ) : (
        <div className="messages">
          <aside className="convo-list">
            {cases.map(c => (
              <button
                key={`${c.userId}:${c.groupId}`}
                className={
                  selected !== null && selected.userId === c.userId && selected.groupId === c.groupId
                    ? 'convo active'
                    : 'convo'
                }
                onClick={() => onSelect(c)}
              >
                ⚖ {c.label}
              </button>
            ))}
          </aside>

          <section className="thread-pane">
            {selected === null ? (
              <p className="hint">Select a dispute to review it.</p>
            ) : (
              <>
                <div className="case-head">
                  <div className="case-title">
                    <strong>{selected.label}</strong>
                    {orderId !== null && <span className="mono">{shortId(orderId)}</span>}
                  </div>
                  {verdictBadge}
                </div>

                <div className="thread">
                  {statement !== null && (
                    <blockquote className="dispute-statement">“{statement}”</blockquote>
                  )}
                  {thread === null ? (
                    <p className="log">Loading…</p>
                  ) : (
                    // The auth envelope renders as the statement blockquote above
                    // and the verdict below, so skip its raw JSON message here.
                    thread
                      .filter(m => summarizeDisputeEnvelope(m.text) === null)
                      .map(m => (
                        <div key={m.id} className={m.mine ? 'msg mine' : 'msg'}>
                          {!m.mine && m.author !== '' && <div className="msg-author">{m.author}</div>}
                          <div>{m.text}</div>
                          {m.sentAt !== '' && (
                            <div className="msg-time">{new Date(m.sentAt).toLocaleString()}</div>
                          )}
                        </div>
                      ))
                  )}

                  {/* Verdict / verification note, centered in the thread like a
                      system line. When the proof package isn't in the room, a
                      compact paste box appears so a moderator can verify it. */}
                  {verifying ? (
                    <p className="thread-note">Checking the proof…</p>
                  ) : verdict !== null ? (
                    <p className={verdict.ok ? 'thread-note verified' : 'thread-note error'}>
                      {verdict.ok ? '✓ ' : '✗ '}
                      {verdict.summary}
                    </p>
                  ) : (
                    <div className="case-verify">
                      <p className="thread-note">
                        Verification message not in this room yet — the buyer's app posts it
                        automatically; paste it here to verify manually if needed.
                      </p>
                      <textarea
                        value={paste}
                        placeholder="Paste the dispute verification message (JSON) here…"
                        onChange={e => setPaste(e.target.value)}
                        rows={3}
                      />
                      <div className="actions">
                        <button
                          disabled={busy !== null || paste.trim().length === 0}
                          onClick={() => void onVerify()}
                        >
                          Verify
                        </button>
                      </div>
                    </div>
                  )}
                  <div ref={threadEndRef} />
                </div>

                {/* Ruling: bounded arbitration, anonymous on-chain flag only. */}
                {mayRule && (
                  <div className="case-actions">
                    <span className="hint">
                      Ruling is final and anonymous — you never touch the funds. The winning party
                      settles themselves.
                    </span>
                    <div className="actions">
                      <button
                        disabled={busy !== null || orderId === null}
                        onClick={() => void onRule(DisputeOutcome.RefundBuyer)}
                      >
                        Refund buyer
                      </button>
                      <button
                        className="secondary"
                        disabled={busy !== null || orderId === null}
                        onClick={() => void onRule(DisputeOutcome.PayVendor)}
                      >
                        Pay vendor
                      </button>
                    </div>
                    {orderId === null && (
                      <p className="hint">No order id found in this room yet — verify the package to lift it.</p>
                    )}
                    {ruleNote !== null && <p className="verified">{ruleNote}</p>}
                  </div>
                )}

                {/* Owner: pull a moderator into THIS room by username. */}
                {isOwner && (
                  <div className="case-actions">
                    <label>Add a moderator by username</label>
                    <div className="row-actions">
                      <input
                        type="text"
                        value={modName}
                        onChange={e => setModName(e.target.value)}
                        placeholder="e.g. keebmaker"
                      />
                      <button
                        disabled={busy !== null || modName.trim() === ''}
                        onClick={() => void onInviteModerator()}
                      >
                        Add moderator
                      </button>
                    </div>
                    {inviteNote !== null && <p className="log">{inviteNote}</p>}
                  </div>
                )}

                <div className="composer">
                  <input
                    type="text"
                    value={draft}
                    placeholder="Reply in this dispute room…"
                    onChange={e => setDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') onSend();
                    }}
                  />
                  <button onClick={onSend} disabled={busy !== null || draft.trim() === ''}>
                    Send
                  </button>
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {busy !== null && <p className="log">{busy}</p>}
    </div>
  );
}
