// Buyer "My Orders" view and the vendor order inbox.

// Disputes are OFF-CHAIN: an unhappy party contacts the vendor/operator over
// SimpleX (the order id is the shared credential); the contract knows nothing
// about them.

import { Fr } from '@aztec/aztec.js/fields';
import {
  acceptOrder,
  cancelOrder,
  claimTimeoutSettlement,
  confirmCompletion,
  getOrderEscrowBalance,
  refundOrder,
  resolveOrderEscrowTerms,
  resolveOrders,
  updateOrderStatus,
  type OrderView,
  type ResolvedMarketplace,
} from '@market/deployment';
import { MAX_FEEDBACK_TEXT_CHARS } from '@market/market-metadata';
import { DisputeOutcome, OrderStatus } from '@market/shared-types';
import { useState } from 'react';

import { openDispute, orderIsDisputable } from './disputes.js';
import { claimEscrowForVendor, refundFromEscrow, releaseEscrow } from './orderEscrow.js';
import { hasEscrowBuyerSecret, hasOrderNonce } from './orderCredentials.js';
import { marketAction, type TransactionalSession } from './session.js';
import { runWithSpendContext } from './spend.js';
import { describeOrder, formatUnits, message, paymentToken } from './ui.js';

export function BuyerOrders({
  market,
  secret,
  session,
  ensureSession,
  onOpenMessages,
}: {
  market: ResolvedMarketplace;
  secret: Fr;
  session: TransactionalSession | null;
  ensureSession: () => Promise<TransactionalSession>;
  /** Jump to the Messages tab, where the dispute room appears. */
  onOpenMessages: () => void;
}) {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  /** Order ids whose refund is authorized AND still unclaimed in the escrow. */
  const [uncollected, setUncollected] = useState<Set<string>>(new Set());
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

  async function refresh(s: TransactionalSession) {
    const loaded = await resolveOrders({
      wallet: s.wallet,
      node: s.node,
      // Buyer = the universal account: orders are owned by it.
      from: s.universal,
      marketplaceAddress: market.marketplaceAddress,
      accessSecret: secret,
    });
    setOrders(loaded);

    // Which refunds are still SITTING THERE. A refund ruling is terminal on the
    // marketplace, but collecting it is a call to the order's own escrow, and
    // the marketplace cannot observe that -- so `settled` stays false whether or
    // not the buyer has taken the money, and the button would otherwise never
    // go away. The escrow's own balance is the only authority, so ask it.
    // Only refund-pending orders are checked, which is a rare state.
    const pending = loaded.filter(
      o => !o.settled && o.disputeOutcome === DisputeOutcome.RefundBuyer,
    );
    if (pending.length === 0) {
      setUncollected(new Set());
      return;
    }
    const token = await paymentToken(s, market.metadata);
    const still = new Set<string>();
    for (const o of pending) {
      const { terms, escrowSecret } = await resolveOrderEscrowTerms({
        wallet: s.wallet,
        node: s.node,
        from: s.universal,
        marketplaceAddress: market.marketplaceAddress,
        orderId: o.orderId,
      });
      const balance = await getOrderEscrowBalance({
        wallet: s.wallet,
        node: s.node,
        from: s.universal,
        escrowSecret,
        terms,
        createBalanceInteraction: owner =>
          Promise.resolve(token.methods.balance_of_private!(owner)),
      });
      if (balance > 0n) {
        still.add(o.orderId.toString());
      }
    }
    setUncollected(still);
  }

  const onConnect = () =>
    run('Opening your buyer session…', async () => {
      const s = await ensureSession();
      await refresh(s);
    });

  // Two transactions, always in this order: the marketplace records the
  // terminal state (in public, where it is serialized against everything else
  // that could race it), and only then can the escrow read that state and pay.
  // `then` is the escrow half; it can be retried safely if it fails, because
  // the terminal state is permanent.
  const settle = (
    label: string,
    fn: typeof cancelOrder,
    orderId: Fr,
    then?: (s: TransactionalSession) => Promise<void>,
  ) =>
    run(label, async () => {
      if (session === null) throw new Error('connect first');
      await fn({
        wallet: session.wallet,
        node: session.node,
        from: session.universal,
        fee: { paymentMethod: session.universalPaymentMethod },
        marketplaceAddress: market.marketplaceAddress,
        accessSecret: secret,
        orderId,
      });
      if (then !== undefined) {
        await then(session);
      }
      await refresh(session);
    });

  if (orders === null) {
    return (
      <div className="panel">
        <p>Your orders on this market are private to your account. Load them to view.</p>
        <div className="actions">
          <button onClick={() => void onConnect()} disabled={busy !== null}>
            Show my orders
          </button>
        </div>
        {busy !== null && <p className="log">{busy}</p>}
        {error !== null && <p className="error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="panel">
      {orders.length === 0 ? (
        <p>No orders from this account yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Order</th><th>Amount</th><th>State</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {orders.map(o => (
              <tr key={o.orderId.toString()}>
                <td className="mono">{o.orderId.toString().slice(0, 14)}…</td>
                <td title={`${o.amount.toString()} base units`}>{formatUnits(o.amount)} cUSDC</td>
                <td><span className="pill">{describeOrder(o)}</span></td>
                <td className="row-actions">
                  {!o.settled && !o.accepted && (
                    <button
                      className="secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        void settle('Cancelling (private refund)…', cancelOrder, o.orderId, s =>
                          refundFromEscrow(s, market, o.orderId),
                        )
                      }
                    >
                      Cancel
                    </button>
                  )}
                  {!o.settled && (
                    <ConfirmReceipt
                      order={o}
                      busy={busy !== null}
                      onConfirm={(rating, text) =>
                        void run('Confirming receipt (pays the vendor, returns your collateral)…', async () => {
                          if (session === null) throw new Error('connect first');
                          await confirmCompletion({
                            wallet: session.wallet,
                            node: session.node,
                            from: session.universal,
                            fee: { paymentMethod: session.universalPaymentMethod },
                            marketplaceAddress: market.marketplaceAddress,
                            accessSecret: secret,
                            orderId: o.orderId,
                            rating,
                            feedbackText: text,
                          });
                          // The order is now COMPLETED; collect from its escrow.
                          await releaseEscrow(session, market, o.orderId);
                          await refresh(session);
                        })
                      }
                    />
                  )}
                  {orderIsDisputable(o) && hasOrderNonce(o.orderId.toString()) && !o.disputed && (
                    <OpenDispute
                      busy={busy !== null}
                      onOpen={statement =>
                        void run('Opening a dispute (private)…', async () => {
                          if (session === null) throw new Error('connect first');
                          await openDispute(session, market, secret, o, statement);
                          await refresh(session);
                          // The dispute is argued in a SimpleX room, so land the
                          // buyer where it will appear rather than leaving them
                          // on an order list that now shows nothing to do. The
                          // room may take a moment to show up: the operator's
                          // client opens the group when it next comes online.
                          onOpenMessages();
                        })
                      }
                    />
                  )}
                  {/* Refund available (a vendor goodwill/escape refund or an
                      arbiter's REFUND_BUYER ruling): REFUND_BUYER is already
                      terminal, so the buyer pulls straight from the escrow --
                      no second marketplace call, and no vendor cooperation.
                      Gated on the escrow still HOLDING the money, because the
                      marketplace's own state cannot tell us whether it was
                      already collected (see refresh). */}
                  {!o.settled &&
                    o.disputeOutcome === DisputeOutcome.RefundBuyer &&
                    uncollected.has(o.orderId.toString()) && (
                    <button
                      disabled={busy !== null || !hasEscrowBuyerSecret(o.orderId.toString())}
                      title={
                        hasEscrowBuyerSecret(o.orderId.toString())
                          ? undefined
                          : 'Only the device that placed this order holds the secret that releases its escrow'
                      }
                      onClick={() =>
                        void run('Claiming your refund…', async () => {
                          if (session === null) throw new Error('connect first');
                          await refundFromEscrow(session, market, o.orderId);
                          await refresh(session);
                        })
                      }
                    >
                      Claim your refund
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {busy !== null && <p className="log">{busy}</p>}
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}

export function VendorOrders({
  market,
  secret,
  session,
  onError,
}: {
  market: ResolvedMarketplace;
  secret: Fr;
  session: TransactionalSession;
  onError: (msg: string | null) => void;
}) {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const common = {
    wallet: session.wallet,
    node: session.node,
    from: session.from,
    marketplaceAddress: market.marketplaceAddress,
  };

  async function run(label: string, action: () => Promise<void>) {
    onError(null);
    setBusy(label);
    try {
      // Any spend inside (network fee, upload) prompts under this label.
      await runWithSpendContext({ title: label }, action);
    } catch (err) {
      onError(message(err));
    } finally {
      setBusy(null);
    }
  }

  const refresh = () =>
    run('Loading your order inbox…', async () => {
      setOrders(await resolveOrders({ ...common, accessSecret: secret }));
    });

  // Vendor-side order actions: the per-market account is the identity, the
  // universal wallet sends and pays.
  const feeOpt = marketAction(session);

  return (
    <div className="panel">
      <h3>Order inbox</h3>
      {orders === null ? (
        <div className="actions">
          <button className="secondary" onClick={() => void refresh()} disabled={busy !== null}>
            Load orders
          </button>
        </div>
      ) : orders.length === 0 ? (
        <p>No orders yet.</p>
      ) : (
        <table className="table">
          <thead>
            <tr><th>Order</th><th>Amount</th><th>Delivery info</th><th>State</th><th>Actions</th></tr>
          </thead>
          <tbody>
            {orders.map(o => (
              <tr key={o.orderId.toString()}>
                <td className="mono">{o.orderId.toString().slice(0, 14)}…</td>
                <td title={`${o.amount.toString()} base units (fee ${o.fee.toString()})`}>
                  {formatUnits(o.amount)} cUSDC <small>(fee {formatUnits(o.fee)})</small>
                </td>
                <td className="memo">{o.deliveryMemo === '' ? '—' : o.deliveryMemo}</td>
                <td><span className="pill">{describeOrder(o)}</span></td>
                <td className="row-actions">
                  {!o.settled && !o.accepted && (
                    <button
                      disabled={busy !== null}
                      onClick={() =>
                        void run('Accepting the order…', async () => {
                          await acceptOrder({ ...common, ...feeOpt, orderId: o.orderId });
                          setOrders(await resolveOrders({ ...common, accessSecret: secret }));
                        })
                      }
                    >
                      Accept
                    </button>
                  )}
                  {!o.settled && o.accepted && !o.statuses.includes(OrderStatus.Shipped) && (
                    <button
                      className="secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        void run('Sending the shipping update…', async () => {
                          await updateOrderStatus({ ...common, ...feeOpt, orderId: o.orderId, status: OrderStatus.Shipped });
                          setOrders(await resolveOrders({ ...common, accessSecret: secret }));
                        })
                      }
                    >
                      Mark shipped
                    </button>
                  )}
                  {/* Claimable when the deadline passed undisputed, or
                      immediately once an arbiter ruled PAY_VENDOR. */}
                  {!o.settled && o.accepted &&
                    ((!o.disputed && BigInt(Math.floor(Date.now() / 1000)) >= o.timeoutAt) ||
                      o.disputeOutcome === DisputeOutcome.PayVendor) && (
                    <button
                      className="secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        void run('Claiming the order settlement…', async () => {
                          if (session === null) throw new Error('connect first');
                          // Marketplace first (it proves the deadline and the
                          // absence of a dispute in public), then the escrow
                          // pays against the state it wrote.
                          await claimTimeoutSettlement({ ...common, ...feeOpt, accessSecret: secret, orderId: o.orderId });
                          await claimEscrowForVendor(session, market, o.orderId, o.vendorInbox);
                          setOrders(await resolveOrders({ ...common, accessSecret: secret }));
                        })
                      }
                    >
                      {o.disputeOutcome === DisputeOutcome.PayVendor
                        ? 'Claim (ruled in your favor)'
                        : 'Claim (timeout)'}
                    </button>
                  )}
                  {/* The dispute escape valve (also a goodwill refund): offers
                      a full refund incl. the buyer's collateral, which the
                      buyer then claims. Hidden once a refund/ruling is already
                      in effect. A disputed order can ONLY end this way or by the
                      buyer confirming -- the timeout claim is blocked. */}
                  {!o.settled && o.accepted && o.disputeOutcome === DisputeOutcome.None && (
                    <button
                      className="secondary"
                      disabled={busy !== null}
                      onClick={() =>
                        void run('Offering a full refund…', async () => {
                          await refundOrder({ ...common, ...feeOpt, accessSecret: secret, orderId: o.orderId });
                          setOrders(await resolveOrders({ ...common, accessSecret: secret }));
                        })
                      }
                    >
                      Refund{o.disputed ? ' (disputed)' : ''}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {busy !== null && <p className="log">{busy}</p>}
    </div>
  );
}

// The buyer's finalize control: confirming receipt REQUIRES a review (a 1-5
// star rating + optional short text) -- the finalization collateral refund is
// what pays the buyer to do it. Expands in place; the confirmation itself is
// one private transaction.
function ConfirmReceipt({
  order,
  busy,
  onConfirm,
}: {
  order: OrderView;
  busy: boolean;
  onConfirm: (rating: number, text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');

  if (!open) {
    return (
      <button disabled={busy} onClick={() => setOpen(true)}>
        Confirm received
      </button>
    );
  }
  return (
    <div className="confirm-receipt">
      <label>Rate this product</label>
      <div className="stars">
        {[1, 2, 3, 4, 5].map(n => (
          <button
            key={n}
            type="button"
            className={n <= rating ? 'star active' : 'star'}
            onClick={() => setRating(n)}
            aria-label={`${n} star${n > 1 ? 's' : ''}`}
          >
            ★
          </button>
        ))}
      </div>
      <textarea
        value={text}
        maxLength={MAX_FEEDBACK_TEXT_CHARS}
        placeholder="Short review (optional, sealed — visible to link holders only)"
        onChange={e => setText(e.target.value)}
      />
      {order.collateral > 0n && (
        <p className="hint">
          Confirming pays the vendor and returns your {formatUnits(order.collateral)} cUSDC
          finalization collateral.
        </p>
      )}
      <div className="row-actions">
        <button disabled={busy || rating === 0} onClick={() => onConfirm(rating, text.trim())}>
          Confirm &amp; review
        </button>
        <button className="secondary" disabled={busy} onClick={() => setOpen(false)}>
          Back
        </button>
      </div>
    </div>
  );
}

// The buyer's "Open dispute" control (AD-6): available on an accepted, unsettled
// order this device can prove it placed. Generates a zero-knowledge proof of
// buyer-ship (never revealing the buyer's address) and delivers it to the
// operator's SimpleX dispute channel. Expands in place.
function OpenDispute({ busy, onOpen }: { busy: boolean; onOpen: (statement: string) => void }) {
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState('');

  if (!open) {
    return (
      <button className="secondary" disabled={busy} onClick={() => setOpen(true)}>
        Open dispute
      </button>
    );
  }
  return (
    <div className="confirm-receipt">
      <label>Describe the problem</label>
      <textarea
        value={statement}
        maxLength={240}
        placeholder="e.g. Vendor accepted 12 days ago; item never arrived and no shipping update."
        onChange={e => setStatement(e.target.value)}
      />
      <p className="hint">
        Your app proves you placed this order without revealing your wallet address, and sends the
        proof to the market's dispute channel. The conversation appears in your Messages tab;
        moderators can verify the proof but never learn who you are.
      </p>
      <div className="row-actions">
        <button
          disabled={busy || statement.trim().length === 0}
          onClick={() => onOpen(statement.trim())}
        >
          Prove &amp; send dispute
        </button>
        <button className="secondary" disabled={busy} onClick={() => setOpen(false)}>
          Back
        </button>
      </div>
    </div>
  );
}
