// "My account" -- the per-market account's own page.
//
// A per-market account is an INBOX: it receives vendor earnings (settlements pay
// `vendor_inbox`, which is this address) and nothing else. It never pays for
// products -- purchases and vendor deposits come straight from the universal
// wallet -- and it holds no fee-juice credit, so it cannot even pay for its own
// transaction. This page is how the money gets out: the UNIVERSAL wallet sends
// the withdrawal transaction and pays its fee, while this account authorizes the
// debit with a single-use authwit (see pullCusdc).

import { AztecAddress } from '@aztec/aztec.js/addresses';
import { cusdcBalanceOf, pullCusdc } from '@market/deployment';
import type { MarketplaceMetadata } from '@market/market-metadata';
import { useEffect, useState } from 'react';

import type { TransactionalSession } from './session.js';
import { runWithSpendContext } from './spend.js';
import { formatUnits, formatUnitsExact, message, parseUnits } from './ui.js';

export function AccountPanel({
  metadata,
  session,
  ensureSession,
}: {
  metadata: MarketplaceMetadata;
  session: TransactionalSession | null;
  ensureSession: () => Promise<TransactionalSession>;
}) {
  const [balance, setBalance] = useState<bigint | null>(null);
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const tokenAddress = AztecAddress.fromStringUnsafe(metadata.onchain.paymentAsset);

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

  async function refresh(s: TransactionalSession) {
    setBalance(
      await cusdcBalanceOf({
        wallet: s.wallet,
        node: s.node,
        from: s.from,
        tokenAddress,
        owner: s.from,
      }),
    );
  }

  // The session opens automatically: this page is only reachable for an account
  // that exists on this market.
  useEffect(() => {
    void run('Reading your market balance…', async () => {
      const s = await ensureSession();
      await refresh(s);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onWithdraw = () =>
    run('Sending to your wallet…', async () => {
      if (session === null) throw new Error('connect first');
      const value = parseUnits(amount || '0', 'amount');
      if (balance !== null && value > balance) {
        throw new Error(
          `you only have ${formatUnits(balance)} cUSDC in this market account`,
        );
      }
      await runWithSpendContext(
        {
          title: 'Withdraw to my wallet',
          description:
            'Moves your market earnings to your universal wallet. Your wallet sends this ' +
            'transaction and pays its fee; this market account only authorizes the transfer.',
          lines: [{ label: 'Withdrawn (cUSDC, private)', amount: `${formatUnits(value)} cUSDC` }],
        },
        async () => {
          await pullCusdc({
            wallet: session.wallet,
            node: session.node,
            // The universal wallet sends the tx and pays the fee...
            from: session.universal,
            fee: { paymentMethod: session.universalPaymentMethod },
            // ...pulling from this per-market account.
            source: session.from,
            tokenAddress,
            amount: value,
          });
        },
      );
      setAmount('');
      await refresh(session);
    });

  const empty = balance !== null && balance === 0n;

  return (
    <div className="panel">
      <h2>My account on this market</h2>
      <p>
        This is your identity on this market — it receives what you earn as a vendor. It is an
        inbox only: purchases and vendor deposits are paid straight from your universal wallet, so
        nothing is ever spent from here except by withdrawing below.
      </p>

      {session !== null && (
        <dl className="summary">
          <dt>Market account</dt>
          <dd className="mono">
            {session.from.toString()}{' '}
            <button
              className="secondary small"
              onClick={() => {
                void navigator.clipboard.writeText(session.from.toString()).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          </dd>
          <dt>Balance (earned here)</dt>
          <dd title={balance === null ? undefined : `${balance.toString()} base units`}>
            {balance === null ? '—' : `${formatUnits(balance)} cUSDC`}
          </dd>
        </dl>
      )}

      <h3>Send to my wallet</h3>
      <p className="hint">
        Moves your earnings to your universal wallet, where you can spend them on any market. Your
        wallet pays the network fee for this — this account holds no fee juice of its own.
      </p>
      <div className="row-actions">
        <input
          type="text"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          placeholder="amount (whole cUSDC)"
        />
        <button
          className="secondary"
          onClick={() => setAmount(balance === null ? '' : formatUnitsExact(balance))}
          disabled={balance === null || empty}
        >
          Max
        </button>
        <button
          onClick={() => void onWithdraw()}
          disabled={busy !== null || session === null || amount.trim() === '' || empty}
        >
          Send to my wallet
        </button>
      </div>
      {empty && <p className="hint">Nothing to withdraw yet — earnings from sales land here.</p>}

      <div className="row-actions">
        <button
          className="secondary"
          onClick={() => void run('Refreshing…', async () => refresh(await ensureSession()))}
          disabled={busy !== null}
        >
          Refresh balance
        </button>
      </div>

      {busy !== null && <p className="log">{busy}</p>}
      {error !== null && <p className="error">{error}</p>}
    </div>
  );
}
