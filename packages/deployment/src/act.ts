// Acting as a per-market account, paid by someone else.
//
// A per-market account (vendor / moderator / owner) is the on-chain IDENTITY for
// market actions, but it is an inbox only: it holds no fee juice, so it cannot
// pay for its own transaction. The marketplace's private functions therefore take
// the acting `account` explicitly and verify it with `#[authorize_once]`, which
// lets a DIFFERENT account send (and pay for) the transaction.
//
// `from` is always the acting identity. `sender` is who sends and pays; when it
// is omitted (or equals `from`) this degrades to the self-send form, which
// `authorize_once` permits with nonce 0 and no authwit at all.

import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { ContractFunctionInteraction } from '@aztec/aztec.js/contracts';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import type { Wallet } from '@aztec/aztec.js/wallet';

/** What `wallet.createAuthWit` produces; kept structural to avoid a deep import. */
type AuthWit = Awaited<ReturnType<Wallet['createAuthWit']>>;

/** Extras a call site needs folded into the send, whichever branch is taken. */
export interface ActingExtras {
  /**
   * Further accounts whose private notes must be in the proving scope --
   * e.g. the marketplace's own escrow notes for settlement calls. The acting
   * account is added automatically when delegating.
   */
  scopes?: AztecAddress[];
  /**
   * Authwitnesses the call itself needs (a vendor deposit's token pull), as
   * opposed to the identity authwit this helper creates.
   */
  authWitnesses?: AuthWit[];
}

export interface ActingOptions {
  wallet: Wallet;
  /** The per-market account the action is performed AS (the on-chain identity). */
  from: AztecAddress;
  /**
   * Who sends the transaction and pays its fee. Defaults to `from` (self-send).
   * Pass the universal wallet so a per-market account -- which holds no fee
   * juice -- can act without a sponsored FPC.
   */
  sender?: AztecAddress;
  fee?: { paymentMethod: FeePaymentMethod };
  txTimeoutSeconds?: number;
}

/**
 * Sends an `#[authorize_once]` marketplace call as `from`, paid by `sender`.
 *
 * `build` receives the acting account and the nonce to pass as the call's last
 * two arguments. It is invoked twice when delegating -- once to hash the call
 * for the authwit, once to send -- so it must be free of side effects.
 */
export async function sendActingAs(
  options: ActingOptions,
  build: (account: AztecAddress, authwitNonce: Fr) => ContractFunctionInteraction,
  extras: ActingExtras = {},
): Promise<{ txHash: string }> {
  const { wallet, from, fee } = options;
  const sender = options.sender ?? from;
  const wait = { timeout: options.txTimeoutSeconds ?? 180 };
  const callWitnesses = extras.authWitnesses ?? [];

  if (sender.equals(from)) {
    // The acting account sends for itself: nonce 0, no authorization needed.
    const scopes = extras.scopes ?? [];
    let interaction = build(from, Fr.ZERO);
    if (callWitnesses.length > 0) {
      interaction = interaction.with({ authWitnesses: callWitnesses });
    }
    const { receipt } = await interaction.send({
      from,
      ...(fee ? { fee } : {}),
      ...(scopes.length > 0 ? { additionalScopes: scopes } : {}),
      wait,
    });
    return { txHash: receipt.txHash.toString() };
  }

  // Delegated: `from` authorizes THIS exact call by `sender`, single-use.
  const authwitNonce = Fr.random();
  const payload = await build(from, authwitNonce).request();
  const call = payload.calls[0];
  if (call === undefined) {
    throw new Error('marketplace interaction produced no calls');
  }
  const witness = await wallet.createAuthWit(from, { caller: sender, call: call as never });
  const { receipt } = await build(from, authwitNonce)
    .with({ authWitnesses: [...callWitnesses, witness] })
    .send({
      from: sender,
      ...(fee ? { fee } : {}),
      // The acting account's private notes (order notes, vendor records read in
      // private, ...) must be in the prover's scope even though it is not the
      // sender. Same wallet, client-side only -- nothing on-chain.
      additionalScopes: [from, ...(extras.scopes ?? [])],
      wait,
    });
  return { txHash: receipt.txHash.toString() };
}
