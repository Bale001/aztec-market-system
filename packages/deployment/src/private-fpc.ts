// PrivateFPC -- a shared, fully-private Fee Payment Contract. Every user funds
// a private, per-user fee-juice credit inside ONE shared FPC instance: the FPC
// is the public fee payer for everyone (a large anonymity set, AD-1), while a
// private BalanceSet note hides WHICH user actually paid. Credit is funded by
// bridging fee juice from L1 with a claimer-bound secret, then proving that
// bridge claim in-circuit via `mint`; fees are then paid with `pay_fee()`,
// which debits the caller's private credit.
//
// The contract and its fee-payment methods are Wonderland's STANDARD PrivateFPC
// (@alejoamiras/aztec-fee-payment), not a local fork -- so we share the
// canonical instance, and with it the anonymity set of every other project
// using the standard. This module is the thin layer around it: the canonical
// deployment constants, the bridge-secret derivation the funding flow needs,
// and a credit read.
//
// This is the LIGHT half -- everything the connect path needs. The heavy
// L1-bridge funding lives in ./fpc-funding so it stays off the wallet-open
// bundle and is dynamically imported only when a user tops up.

import { FPCFeePaymentMethod, PrivateFPCContract, registerPrivateContract } from '@alejoamiras/aztec-fee-payment';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { poseidon2HashWithSeparator } from '@aztec/foundation/crypto/poseidon';
import { Fr } from '@aztec/foundation/curves/bn254';

export { FPCFeePaymentMethod, PrivateFPCContract };

/**
 * The CANONICAL PrivateFPC deployment (from the package's
 * canonical-deployment.json). Using it -- rather than an instance under our own
 * salt -- is the whole point of a shared FPC: the anonymity set is every user of
 * the standard contract, not just this marketplace's.
 *
 * DANGER: the address is derived from the compiled bytecode + salt, so it is
 * valid ONLY for the Aztec version below. After an Aztec upgrade these constants
 * must be refreshed from the package -- fee juice bridged to a stale address is
 * unrecoverable.
 */
export const CANONICAL_FPC_AZTEC_VERSION = '5.0.1';
export const CANONICAL_FPC_SALT = new Fr(1n);
export const CANONICAL_FPC_ADDRESS =
  '0x1a6d21ce5fd80137df0e99632a4ca17e58a42dc8f6c08191a96ca8ae907a1bc0';

/**
 * Domain separator for the FPC bridge secret. MUST equal the Noir constant
 * `DOM_SEP__FPC_BRIDGE_SECRET` in the PrivateFPC contract
 * (= poseidon2_hash_bytes("az_dom_sep__fpc_bridge_secret") as u32).
 */
export const DOM_SEP__FPC_BRIDGE_SECRET = 3952304070;

/**
 * Derives the claimer-bound bridge secret, mirroring `derive_bridge_secret` in
 * the contract: poseidon2([salt, claimer], DOM_SEP__FPC_BRIDGE_SECRET). Only the
 * claimer can reconstruct it, which is what binds a bridge deposit to them.
 */
export function deriveBridgeSecret(salt: Fr, claimer: AztecAddress): Promise<Fr> {
  return poseidon2HashWithSeparator([salt, claimer], DOM_SEP__FPC_BRIDGE_SECRET);
}

/**
 * Registers the shared PrivateFPC with the wallet's PXE at a salt-derived
 * address, WITHOUT sending a deploy transaction (it is fully private: no public
 * functions, no initializer, so the protocol lets us interact with it as soon as
 * it is registered). Pass {@link CANONICAL_FPC_SALT} for the canonical instance.
 */
export function registerPrivateFpc(wallet: Wallet, salt: Fr): Promise<PrivateFPCContract> {
  return registerPrivateContract(wallet, salt);
}

/** Reads an account's private fee-juice credit inside the FPC (free utility sim). */
export async function fpcCreditOf(options: {
  wallet: Wallet;
  fpcAddress: AztecAddress;
  account: AztecAddress;
}): Promise<bigint> {
  const fpc = await PrivateFPCContract.at(options.fpcAddress, options.wallet);
  return (
    await fpc.methods.balance_of(options.account).simulate({ from: options.account })
  ).result as bigint;
}

/** The L2 claim material returned by a claimer-bound FPC bridge deposit. */
export interface FpcBridgeClaim {
  /** The claimer-bound secret (= deriveBridgeSecret(salt, claimer)). */
  secret: Fr;
  /** The exact amount bridged. */
  claimAmount: bigint;
  /** The L1->L2 message leaf index. */
  leafIndex: Fr;
}
