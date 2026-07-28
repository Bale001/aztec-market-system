// Per-order escrow (AD-5). Each order's funds sit at their OWN OrderEscrow
// instance, which NOBODY EVER DEPLOYS -- it is only an address the two parties
// derive locally, and the private kernel is satisfied by the derivation alone
// (see contracts/order-escrow/src/main.nr for why that is sound rather than a
// trick). Everything in this module is therefore local computation plus
// ordinary private calls: there is no deployment transaction and no fee juice
// spent on bringing an escrow into existence.
//
// WHAT AUTHORIZES A PAYOUT. Not this module, and not the escrow. The escrow has
// no public functions, so it cannot enqueue a public assert and cannot
// serialize against a concurrent transaction -- it can only read a historical
// block. So the MARKETPLACE decides, in public where transactions serialize,
// and writes one of three TERMINAL order states; each escrow entry point below
// simply follows one of them. That is why every settlement here is two
// transactions: marketplace first, escrow second.
//
// WHY THE VENDOR HOLDING THE ESCROW SECRET IS SAFE. It gives them the escrow's
// viewing/nullifying keys -- which is the point, they need them to settle the
// order -- but spending the escrow's
// cUSDC needs cUSDC's own circuit to accept the spend, and that requires
// `from == msg_sender`. Only the escrow's code can be msg_sender for its own
// address. The buyer's `buyer_secret` never leaves the buyer: `release` and
// `claim_refund` pay their CALLER, so the preimage is the only thing standing
// between the vendor and the collateral.

import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { AztecAddress as AztecAddressClass } from '@aztec/aztec.js/addresses';
import {
  getContractInstanceFromInstantiationParams,
  type ContractFunctionInteraction,
  type ContractInstanceWithAddress,
} from '@aztec/aztec.js/contracts';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { deriveKeys } from '@aztec/aztec.js/keys';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { poseidon2Hash } from '@aztec/foundation/crypto/poseidon';
import type { PXE } from '@aztec/pxe/server';
import { computePartialAddress } from '@aztec/stdlib/contract';
import { MarketplaceContract, OrderEscrowContract } from '@market/contract-bindings';
import { DOMAIN_ORDER_ESCROW_SALT } from '@market/shared-types';

import { asFr } from './deploy.js';
import type { RegistersContracts } from './register.js';

/**
 * One escrow's terms. FIELD ORDER IS LOAD-BEARING: these are `open`'s
 * initializer arguments, and an Aztec address commits to them, so a struct
 * that does not match contracts/order-escrow/src/terms.nr byte for byte
 * derives a different address and finds no funds there.
 */
export interface EscrowTerms {
  asset: AztecAddress;
  marketplace: AztecAddress;
  order_states_slot: Fr;
  order_id: Fr;
  vendor: AztecAddress;
  treasury: AztecAddress;
  amount: bigint;
  fee: bigint;
  collateral: bigint;
  buyer_auth: Fr;
}

/**
 * The escrow's authorization value: poseidon2([buyer_secret]). Matches the
 * contract's single-element hash exactly -- no domain separator, because the
 * preimage is a fresh random per order and never reused elsewhere.
 */
export async function deriveBuyerAuth(buyerSecret: Fr): Promise<Fr> {
  return poseidon2Hash([buyerSecret]);
}

/**
 * The instance salt. Derived rather than random so that the escrow note's
 * single `escrow_secret` field is enough to rebuild the address -- the note is
 * at a premium, and a separate salt field would cost one for nothing.
 */
export async function deriveEscrowSalt(escrowSecret: Fr): Promise<Fr> {
  return poseidon2Hash([escrowSecret, new Fr(DOMAIN_ORDER_ESCROW_SALT)]);
}

/** The storage slot of the marketplace's `order_states` map, which the escrow reads. */
export function orderStatesSlot(): Fr {
  return asFr(MarketplaceContract.storage.order_states.slot, 'order_states.slot');
}

/**
 * Derives an order's escrow instance from its per-order secret and terms.
 * Pure local computation -- nothing is sent, nothing is published.
 */
export async function deriveOrderEscrow(
  escrowSecret: Fr,
  terms: EscrowTerms,
): Promise<ContractInstanceWithAddress> {
  const { publicKeys } = await deriveKeys(escrowSecret);
  return getContractInstanceFromInstantiationParams(OrderEscrowContract.artifact, {
    constructorArgs: [terms],
    constructorArtifact: 'open',
    salt: await deriveEscrowSalt(escrowSecret),
    publicKeys,
    // Undeployed instances have no deployer; a nonzero one would change the
    // address without anything ever consuming it.
    deployer: AztecAddressClass.ZERO,
  });
}

/**
 * Teaches this session's PXE about an order's escrow: the contract instance
 * (so it can execute the escrow's functions) and the escrow's keys (so it can
 * see the escrow's own token notes). Both are LOCAL operations -- no
 * transaction, no fee, nothing published -- and both are idempotent.
 *
 * Returns the escrow address.
 *
 * The PXE handle is a protected member of the wallet SDK's BaseWallet; there is
 * no public key-registration API on the wallet yet, so this reaches past it
 * deliberately, exactly as escrow.ts does for the marketplace's own keys.
 */
export async function registerOrderEscrow(
  wallet: Wallet & RegistersContracts,
  escrowSecret: Fr,
  terms: EscrowTerms,
): Promise<AztecAddress> {
  const instance = await deriveOrderEscrow(escrowSecret, terms);
  await wallet.registerContract(instance, OrderEscrowContract.artifact);

  const derived = await deriveKeys(escrowSecret);
  const pxe = (wallet as unknown as { pxe: PXE }).pxe;
  if (pxe === undefined || typeof pxe.registerAccount !== 'function') {
    throw new Error(
      'wallet does not expose a PXE with registerAccount; cannot set up order escrow keys',
    );
  }
  const complete = await pxe.registerAccount(
    {
      masterNullifierHidingSecretKey: derived.masterNullifierHidingSecretKey,
      masterIncomingViewingSecretKey: derived.masterIncomingViewingSecretKey,
      masterOutgoingViewingSecretKey: derived.masterOutgoingViewingSecretKey,
      masterTaggingSecretKey: derived.masterTaggingSecretKey,
      masterMessageSigningPublicKey: derived.masterMessageSigningPublicKey,
      masterFallbackPublicKey: derived.masterFallbackPublicKey,
    },
    await computePartialAddress(instance),
  );
  if (!complete.address.equals(instance.address)) {
    throw new Error(
      'derived escrow keys do not match the escrow address -- the terms or the ' +
        'escrow secret do not match the order',
    );
  }
  return instance.address;
}

interface EscrowCallOptions {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  /** The party making the call: the buyer's or the vendor's per-market account. */
  from: AztecAddress;
  fee?: { paymentMethod: FeePaymentMethod };
  escrowSecret: Fr;
  terms: EscrowTerms;
  txTimeoutSeconds?: number;
}

async function escrowAt(options: EscrowCallOptions) {
  const address = await registerOrderEscrow(options.wallet, options.escrowSecret, options.terms);
  return { escrow: await OrderEscrowContract.at(address, options.wallet), address };
}

/**
 * Sends an escrow call. `additionalScopes: [escrowAddress]` is REQUIRED on
 * every one of them: the caller is the buyer or the vendor, but the notes being
 * spent belong to the escrow, and without the scope the proof cannot see them.
 */
async function sendEscrowCall(
  options: EscrowCallOptions,
  build: (
    escrow: Awaited<ReturnType<typeof OrderEscrowContract.at>>,
  ) => { send(opts: object): Promise<{ receipt: { txHash: { toString(): string } } }> },
): Promise<{ txHash: string }> {
  const { escrow, address } = await escrowAt(options);
  const { receipt } = await build(escrow).send({
    from: options.from,
    ...(options.fee ? { fee: options.fee } : {}),
    additionalScopes: [address],
    wait: { timeout: options.txTimeoutSeconds ?? 180 },
  });
  return { txHash: receipt.txHash.toString() };
}

/**
 * Prepares (does NOT send) what `place_order` needs to fund this order's
 * escrow: the address, and the payer's authorization for the marketplace to
 * pull amount + collateral into it.
 *
 * NOTE THAT `open` IS NOT HERE. The marketplace calls the initializer itself,
 * inside place_order, and that is the proof of payment: a contract's address
 * commits to its initializer arguments, so the private kernel admits the call
 * only if this address really is the one these terms produce. Opening the
 * escrow from out here would give that away -- the client would be asserting
 * the terms rather than the protocol proving them -- and would also consume the
 * initializer, making the real place_order fail.
 *
 * `funder` is whichever account holds the buyer's cUSDC (typically their
 * L1-facing universal account) and need not be the account placing the order --
 * the escrow only cares how much arrived, never from where. Its notes must be
 * in the proving scope, hence `scopes` in the return value.
 */
export async function prepareEscrowFunding(
  options: Omit<EscrowCallOptions, 'from' | 'fee' | 'txTimeoutSeconds'> & {
    funder: AztecAddress;
    /** The marketplace, which is the caller the authwit must authorize. */
    marketplaceAddress: AztecAddress;
    /** Token binding's transfer_private_to_private interaction builder. */
    createTransferInteraction: (
      from: AztecAddress,
      to: AztecAddress,
      amount: bigint,
      authwitNonce: Fr,
    ) => Promise<ContractFunctionInteraction>;
  },
): Promise<{
  escrowAddress: AztecAddress;
  authwitNonce: Fr;
  authWitness: Awaited<ReturnType<Wallet['createAuthWit']>>;
  scopes: AztecAddress[];
}> {
  const address = await registerOrderEscrow(options.wallet, options.escrowSecret, options.terms);
  const total = options.terms.amount + options.terms.collateral;

  // The marketplace is msg_sender at the token, not the funder, so this pull
  // needs an authwit for exactly it: this amount, into this address.
  const authwitNonce = Fr.random();
  const transfer = await options.createTransferInteraction(
    options.funder,
    address,
    total,
    authwitNonce,
  );
  const payload = await transfer.request();
  const call = payload.calls[0];
  if (call === undefined) {
    throw new Error('escrow transfer interaction produced no calls');
  }
  const authWitness = await options.wallet.createAuthWit(options.funder, {
    caller: options.marketplaceAddress,
    call: call as never,
  });

  return { escrowAddress: address, authwitNonce, authWitness, scopes: [address, options.funder] };
}

/**
 * Buyer collects a COMPLETED order: the vendor is paid, the treasury takes the
 * fee, and the collateral returns to the caller. Call the marketplace's
 * confirmCompletion FIRST -- this reads the state it writes.
 */
export function releaseOrderEscrow(
  options: EscrowCallOptions & { buyerSecret: Fr },
): Promise<{ txHash: string }> {
  return sendEscrowCall(options, e => e.methods.release(options.terms, options.buyerSecret));
}

/**
 * Vendor claims a SETTLED_VENDOR order: paid in full plus the buyer's
 * forfeited collateral. Call the marketplace's claimTimeoutSettlement FIRST.
 */
export function claimOrderEscrow(options: EscrowCallOptions): Promise<{ txHash: string }> {
  return sendEscrowCall(options, e => e.methods.claim(options.terms));
}

/**
 * Buyer pulls back a CANCELLED or REFUND_BUYER order: the full escrow,
 * collateral included, to the caller. No fee is earned on an order that did not
 * complete. Call the marketplace's cancelOrder (or have the vendor/a moderator
 * rule a refund) FIRST.
 */
export function claimOrderEscrowRefund(
  options: EscrowCallOptions & { buyerSecret: Fr },
): Promise<{ txHash: string }> {
  return sendEscrowCall(options, e => e.methods.claim_refund(options.terms, options.buyerSecret));
}

/**
 * The escrow's current balance. The vendor's pre-shipping check: an order is
 * only real once its own address actually holds amount + collateral.
 */
export async function getOrderEscrowBalance(
  options: EscrowCallOptions & {
    /** Token binding's balance_of_private interaction builder. */
    createBalanceInteraction: (owner: AztecAddress) => Promise<ContractFunctionInteraction>;
  },
): Promise<bigint> {
  const address = await registerOrderEscrow(options.wallet, options.escrowSecret, options.terms);
  const interaction = await options.createBalanceInteraction(address);
  const { result } = await interaction.simulate({
    from: options.from,
    additionalScopes: [address],
  });
  if (typeof result !== 'bigint') {
    throw new Error(`balance_of_private returned ${typeof result}, expected bigint`);
  }
  return result;
}
