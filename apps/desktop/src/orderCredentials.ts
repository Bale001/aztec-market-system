// Buyer-only order credentials (AD-6). place_order draws a random
// order_nonce that appears in NO note -- knowing it is what distinguishes
// the buyer from everyone else (vendor included). It is stored device-locally,
// which is the same durability class as the PXE database the order notes
// already live in: losing this store means losing the order anyway.
//
// Disputes also store a per-order `dispute_secret` here: its poseidon2
// commitment is published on-chain when the buyer opens a dispute (only the
// buyer can, since dispute_order spends their order note), and revealing the
// secret in the dispute room proves buyer-ship to a moderator with a single
// hash -- no ZK proof. It must survive retries, hence the same local store.

import { Fr } from '@aztec/aztec.js/fields';

const KEY_PREFIX = 'market.orderNonce.v1.';
const DISPUTE_KEY_PREFIX = 'market.disputeSecret.v1.';
const BUYER_SECRET_PREFIX = 'market.escrowBuyerSecret.v1.';

export function saveOrderNonce(orderId: string, orderNonce: string): void {
  localStorage.setItem(KEY_PREFIX + orderId, orderNonce);
}

/**
 * The nonce for an order this device placed. Throws when absent: without it
 * a dispute proof cannot be generated, and pretending otherwise would fail
 * later and less clearly.
 */
export function loadOrderNonce(orderId: string): string {
  const nonce = localStorage.getItem(KEY_PREFIX + orderId);
  if (nonce === null) {
    throw new Error(
      `no order credential stored for order ${orderId}: only the device that placed ` +
        'an order can prove buyer-ship in a dispute',
    );
  }
  return nonce;
}

/** Whether this device holds the credential (gates the dispute UI). */
export function hasOrderNonce(orderId: string): boolean {
  return localStorage.getItem(KEY_PREFIX + orderId) !== null;
}

/**
 * The buyer's escrow secret for an order: the preimage of `buyer_auth`, which
 * lives in NO note. It is the only thing keeping the VENDOR -- who holds every
 * other key to that order's escrow, by design -- out of the two payout paths
 * that pay their caller. Losing it means the buyer can neither release the
 * order nor pull a refund, and the funds can only ever reach the vendor.
 */
export function saveEscrowBuyerSecret(orderId: string, buyerSecret: string): void {
  localStorage.setItem(BUYER_SECRET_PREFIX + orderId, buyerSecret);
}

export function loadEscrowBuyerSecret(orderId: string): string {
  const secret = localStorage.getItem(BUYER_SECRET_PREFIX + orderId);
  if (secret === null) {
    throw new Error(
      `no escrow secret stored for order ${orderId}: only the device that placed ` +
        'the order can release it or pull its refund',
    );
  }
  return secret;
}

/** Whether this device can settle the order's escrow (gates the buyer actions). */
export function hasEscrowBuyerSecret(orderId: string): boolean {
  return localStorage.getItem(BUYER_SECRET_PREFIX + orderId) !== null;
}

/**
 * This device's dispute secret for an order, minting and persisting a fresh
 * random one on first use. Stable across retries so the revealed secret always
 * matches the commitment published on-chain at the first dispute_order call.
 */
export function getOrCreateDisputeSecret(orderId: string): string {
  const existing = localStorage.getItem(DISPUTE_KEY_PREFIX + orderId);
  if (existing !== null) {
    return existing;
  }
  const secret = Fr.random().toString();
  localStorage.setItem(DISPUTE_KEY_PREFIX + orderId, secret);
  return secret;
}
