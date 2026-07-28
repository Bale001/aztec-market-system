// The spend gate: every action that spends the user's funds -- fee juice
// (network fees via the private FPC), cUSDC (escrow/deposits), AR (Arweave
// uploads) -- must be confirmed by the user first, with the exact amount and
// a description of what the transaction does.
//
// Fee juice is intercepted at the ONE point where the final fee is known:
// the DEEPEST sendTx on the wallet prototype chain (BaseWallet), which
// EmbeddedWallet's sendTx calls with the fully-estimated gas settings after
// simulation. The PrivateFPC's pay_fee() debits exactly the fee limit (max
// fee, no refund), so gasSettings.getFeeLimit() IS the amount spent -- not an
// estimate. The payment method itself is consumed into the execution payload
// before this point, so the payer is identified by payload.feePayer: only
// transactions whose fee payer is the user's PrivateFPC (set via
// setUserFeePayer) prompt; sponsored bootstrap transactions spend no user
// funds and pass through silently.
//
// AR is intercepted in the desktop's uploadPayload (arweave.ts) with the
// gateway's exact price. cUSDC amounts are part of the transaction being
// confirmed (escrow transfers ride inside it), so the UI action declares them
// as extra lines on its spend context and they appear in the same prompt.

import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { useEffect, useState } from 'react';

import { formatFeeJuiceExact } from './ui.js';

export interface SpendLine {
  label: string;
  amount: string;
}

export interface SpendPrompt {
  /** What the user is doing (the action label). */
  title: string;
  /** What the transaction does, in plain words. */
  description: string | null;
  /** The amounts about to be spent. */
  lines: SpendLine[];
}

interface SpendContext {
  title: string;
  description?: string;
  /** Extra spend lines the action knows about (escrow, deposits). */
  lines?: SpendLine[];
}

// The action currently running (module-level: UI actions are serialized by
// their busy states, so at most one spending action is in flight).
let currentContext: SpendContext | null = null;

/**
 * Runs an action under a spend context: any confirmation prompted from inside
 * it (network fee, Arweave upload) carries this title/description, plus the
 * declared extra amount lines. Nesting replaces the context for the inner span.
 */
export async function runWithSpendContext<T>(ctx: SpendContext, fn: () => Promise<T>): Promise<T> {
  const previous = currentContext;
  currentContext = ctx;
  try {
    return await fn();
  } finally {
    currentContext = previous;
  }
}

type Presenter = (prompt: SpendPrompt) => Promise<boolean>;
let presenter: Presenter | null = null;
// Prompts are serialized so two spends never race for the one modal.
let promptQueue: Promise<unknown> = Promise.resolve();

/**
 * Asks the user to confirm a spend; throws if they cancel (the action's own
 * error handling surfaces the message and nothing is sent/uploaded).
 */
export function confirmSpend(
  lines: SpendLine[],
  fallbackTitle: string,
  description?: string,
): Promise<void> {
  const show = async () => {
    if (presenter === null) {
      throw new Error('spend confirmation UI is not mounted; refusing to spend funds unprompted');
    }
    const ctx = currentContext;
    const approved = await presenter({
      title: ctx?.title ?? fallbackTitle,
      description: description ?? ctx?.description ?? null,
      lines: [...(ctx?.lines ?? []), ...lines],
    });
    if (!approved) {
      throw new Error('Cancelled — no funds were spent.');
    }
  };
  const turn = promptQueue.then(show);
  promptQueue = turn.catch(() => {});
  return turn;
}

/** The modal that presents spend prompts; mount exactly once at the app root. */
export function SpendConfirmHost() {
  const [pending, setPending] = useState<{
    prompt: SpendPrompt;
    resolve: (approved: boolean) => void;
  } | null>(null);

  useEffect(() => {
    presenter = prompt => new Promise<boolean>(resolve => setPending({ prompt, resolve }));
    return () => {
      presenter = null;
    };
  }, []);

  if (pending === null) {
    return null;
  }
  const done = (approved: boolean) => {
    setPending(null);
    pending.resolve(approved);
  };

  return (
    <div className="modal-backdrop">
      <div className="modal card">
        <h3>Confirm spending</h3>
        <p className="spend-title">{pending.prompt.title}</p>
        {pending.prompt.description !== null && (
          <p className="hint">{pending.prompt.description}</p>
        )}
        <dl className="summary">
          {pending.prompt.lines.map((line, i) => (
            <div key={i} className="spend-line">
              <dt>{line.label}</dt>
              <dd>{line.amount}</dd>
            </div>
          ))}
        </dl>
        <div className="actions">
          <button className="secondary" onClick={() => done(false)}>Cancel</button>
          <button onClick={() => done(true)}>Confirm &amp; pay</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fee-juice interception
// ---------------------------------------------------------------------------

interface SendTxPayload {
  feePayer?: { toString(): string };
}

interface SendTxOpts {
  fee?: {
    gasSettings?: { getFeeLimit?: () => { toBigInt(): bigint } };
  };
}

// The fee-payer address whose transactions spend USER funds: the shared
// PrivateFPC (this account's private fee-juice credit). Set on connect.
let userFeePayer: string | null = null;

export function setUserFeePayer(address: { toString(): string }): void {
  userFeePayer = address.toString();
}

let gateInstalled = false;

/**
 * Patches the DEEPEST sendTx on the wallet prototype chain (BaseWallet) --
 * the single funnel every real transaction passes through, AFTER gas
 * estimation -- to confirm the exact fee-juice debit whenever the user's
 * private FPC is the fee payer. Pinned to aztec.js 5.0.0 internals; verified
 * empirically (tests/.spend-gate-check probe): at this level
 * opts.fee.gasSettings is the final GasSettings instance, and the payment
 * method is already consumed into the payload, so payload.feePayer is what
 * identifies who pays. Throws rather than letting an FPC-paid transaction
 * move funds unprompted.
 */
export function installSpendGate(): void {
  if (gateInstalled) {
    return;
  }
  gateInstalled = true;

  let owner: object | null = null;
  for (
    let proto: object | null = EmbeddedWallet.prototype as object;
    proto !== null;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    if (Object.prototype.hasOwnProperty.call(proto, 'sendTx')) {
      owner = proto;
    }
  }
  if (owner === null) {
    throw new Error(
      'spend gate: no sendTx found on the wallet prototype chain (aztec.js internals changed)',
    );
  }

  const target = owner as { sendTx(...args: unknown[]): Promise<unknown> };
  const original = target.sendTx;
  target.sendTx = async function (this: unknown, ...args: unknown[]) {
    const feePayer = (args[0] as SendTxPayload | undefined)?.feePayer?.toString();
    if (userFeePayer !== null && feePayer === userFeePayer) {
      const gasSettings = (args[1] as SendTxOpts | undefined)?.fee?.gasSettings;
      if (typeof gasSettings?.getFeeLimit !== 'function') {
        throw new Error(
          'spend gate: an FPC-paid transaction reached sendTx without final gas settings',
        );
      }
      // pay_fee() debits the full fee limit with no refund, so this is the
      // exact fee-juice cost of the transaction, not an upper bound. Fees are
      // tiny on the local network; show them losslessly.
      const feeJuice = gasSettings.getFeeLimit().toBigInt();
      await confirmSpend(
        [{ label: 'Network fee (fee juice)', amount: `${formatFeeJuiceExact(feeJuice)} FJ` }],
        'Network transaction',
      );
    }
    return original.apply(this, args);
  };
}
