// The money half of every order settlement.
//
// The marketplace no longer holds order funds: each order's money sits at its
// own escrow address (see packages/deployment/src/orderEscrow.ts). The
// marketplace decides -- in public, where transactions serialize -- which
// terminal state an order reaches; the escrow then pays out against it. So each
// settlement button in the orders view runs TWO transactions, marketplace first.
//
// They are separate transactions rather than one because the escrow reads the
// order state from a HISTORICAL block: the state has to be settled before the
// escrow can see it, so the payout necessarily lands in a later block. Leaving
// the second half undone is safe -- the terminal state is permanent, so the
// payout can always be retried, and nobody else can take it.

import { Fr } from '@aztec/aztec.js/fields';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import {
  claimOrderEscrow,
  claimOrderEscrowRefund,
  releaseOrderEscrow,
  resolveOrderEscrowTerms,
  type ResolvedMarketplace,
} from '@market/deployment';

import { loadEscrowBuyerSecret } from './orderCredentials.js';
import type { TransactionalSession } from './session.js';

/**
 * Rebuilds an order's escrow from the notes `owner` holds and returns the
 * arguments every escrow call needs. `owner` is whichever account can see the
 * order -- the buyer's account, or the vendor's inbox.
 */
async function escrowCall(
  session: TransactionalSession,
  market: ResolvedMarketplace,
  orderId: Fr,
  owner: AztecAddress,
) {
  const { terms, escrowSecret } = await resolveOrderEscrowTerms({
    wallet: session.wallet,
    node: session.node,
    from: owner,
    marketplaceAddress: market.marketplaceAddress,
    orderId,
  });
  return {
    wallet: session.wallet,
    node: session.node,
    marketplaceAddress: market.marketplaceAddress,
    fee: { paymentMethod: session.universalPaymentMethod },
    terms,
    escrowSecret,
  };
}

/**
 * Buyer collects a COMPLETED order: the vendor is paid, the treasury takes the
 * fee, and the collateral comes back. Sent from the buyer's own account because
 * the collateral goes to msg_sender -- the escrow holds no buyer address.
 */
export async function releaseEscrow(
  session: TransactionalSession,
  market: ResolvedMarketplace,
  orderId: Fr,
): Promise<void> {
  await releaseOrderEscrow({
    ...(await escrowCall(session, market, orderId, session.universal)),
    from: session.universal,
    buyerSecret: Fr.fromHexString(loadEscrowBuyerSecret(orderId.toString())),
  });
}

/**
 * Buyer pulls back a CANCELLED or REFUND_BUYER order -- the full escrow,
 * collateral included. Same msg_sender reasoning as releaseEscrow.
 */
export async function refundFromEscrow(
  session: TransactionalSession,
  market: ResolvedMarketplace,
  orderId: Fr,
): Promise<void> {
  await claimOrderEscrowRefund({
    ...(await escrowCall(session, market, orderId, session.universal)),
    from: session.universal,
    buyerSecret: Fr.fromHexString(loadEscrowBuyerSecret(orderId.toString())),
  });
}

/**
 * Pays out a SETTLED_VENDOR order. Read as the vendor's inbox (that is who
 * holds the notes) but SENT from the universal account, which is what makes it
 * work at all: the per-market inbox holds no fee juice and the escrow has no
 * authwit path, so this claim is permissionless. It takes no address from the
 * caller and pays them nothing, so it can only push the money to the vendor and
 * the treasury -- both bound into the escrow's address.
 */
export async function claimEscrowForVendor(
  session: TransactionalSession,
  market: ResolvedMarketplace,
  orderId: Fr,
  vendorInbox: AztecAddress,
): Promise<void> {
  await claimOrderEscrow({
    ...(await escrowCall(session, market, orderId, vendorInbox)),
    from: session.universal,
  });
}
