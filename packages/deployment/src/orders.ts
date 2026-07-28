// Order pipeline (M5, AD-5). Placing, accepting, settling, and reading
// orders. place_order and the settlement paths are FULLY private -- the
// public record of a purchase is nothing but opaque nullifiers, note
// commitments, and encrypted logs (acceptance adds one anonymous flag).
//
// THE MARKETPLACE HOLDS NO ORDER FUNDS. Each order's money sits at its own
// OrderEscrow address, which nobody deploys (see orderEscrow.ts). What this
// module drives on the marketplace is the ORDER and its public lifecycle word;
// the money follows separately.
//
// SO EVERY SETTLEMENT IS TWO TRANSACTIONS, IN THIS ORDER:
//   1. the marketplace, which decides in public -- where transactions
//      serialize -- and writes a TERMINAL order state;
//   2. the escrow, which reads that state from a historical block and pays.
// The escrow has no public functions and so cannot serialize against a
// concurrent transaction; step 1 is what makes step 2 race-free. The helpers
// here do step 1. Their escrow halves live in orderEscrow.ts and are named to
// match: confirmCompletion -> releaseOrderEscrow, cancelOrder /
// (refundOrder|resolveDispute) -> claimOrderEscrowRefund, and
// claimTimeoutSettlement -> claimOrderEscrow.
//
// NOTHING HERE REGISTERS KEYS FOR THE MARKETPLACE. It is deployed with no
// encryption keys at all, holds no private notes, and the market link therefore
// confers no ability to decrypt anything about it. Only an order's own escrow
// has keys, and only its two parties can derive them.

import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { AztecAddress as AztecAddressClass } from '@aztec/aztec.js/addresses';
import type { ContractFunctionInteraction } from '@aztec/aztec.js/contracts';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { MarketplaceContract } from '@market/contract-bindings';
import { deriveOrderId } from '@market/identity';
import {
  bytesToFields,
  fieldsToBytes,
  FEEDBACK_FIELDS,
  MAX_PRICE_OPTIONS,
  MAX_SHIPPING_OPTIONS,
  type ListingDocument,
  openFeedbackBlob,
  sealFeedbackBlob,
  type FeedbackDocument,
} from '@market/market-metadata';
import { DisputeOutcome, OrderStatus } from '@market/shared-types';

import { asBigInt, asFr } from './deploy.js';
import { priceTable } from './listings.js';
import {
  deriveBuyerAuth,
  orderStatesSlot,
  prepareEscrowFunding,
  type EscrowTerms,
} from './orderEscrow.js';
import { sendActingAs } from './act.js';
import { ensureContractRegistered, type RegistersContracts } from './register.js';

/** Max bytes of delivery/contact text an order memo can carry (6 fields x 31). */
export const ORDER_MEMO_MAX_BYTES = 186;

interface OrderSessionOptions {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  /** Who sends and pays (defaults to `from`); see sendActingAs. */
  sender?: AztecAddress;
  marketplaceAddress: AztecAddress;
}

async function marketplaceAt(options: OrderSessionOptions) {
  await ensureContractRegistered(
    options.wallet,
    options.node,
    options.marketplaceAddress,
    MarketplaceContract.artifact,
    'marketplace',
  );
  return MarketplaceContract.at(options.marketplaceAddress, options.wallet);
}

function memoToFields(memo: string): Fr[] {
  const bytes = new TextEncoder().encode(memo);
  if (bytes.length > ORDER_MEMO_MAX_BYTES) {
    throw new Error(
      `delivery memo is ${bytes.length} bytes; at most ${ORDER_MEMO_MAX_BYTES} fit in an order`,
    );
  }
  const fields = bytesToFields(bytes);
  while (fields.length < 6) {
    fields.push(Fr.ZERO);
  }
  return fields;
}

function fieldsToMemo(fields: Fr[]): string {
  // Memos are zero-padded; recover the byte length by trimming trailing zero
  // bytes after unpacking the full 186.
  const bytes = fieldsToBytes(fields, ORDER_MEMO_MAX_BYTES);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end--;
  }
  return new TextDecoder().decode(bytes.slice(0, end));
}

/**
 * The circuit takes fixed-size price arrays, so short tables are zero-padded.
 * Those zeros are part of the commitment, which is why the circuit also has to
 * reject an index at or past the real count -- see place_order.
 */
function padTable(prices: Fr[], size: number): Fr[] {
  return [...prices, ...Array<Fr>(size - prices.length).fill(Fr.ZERO)];
}

export interface PlaceOrderOptions extends OrderSessionOptions {
  fee?: { paymentMethod: FeePaymentMethod };
  /** The market link secret; proves the price against its commitment. */
  accessSecret: Fr;
  /**
   * The account whose cUSDC funds the escrow (the buyer's L1-facing universal
   * account). Defaults to `from`. The ORDER itself is owned by `from` (the
   * per-market account) -- that is the only address the vendor sees, and
   * refunds/collateral return there. No authwit is involved any more: the
   * funds go straight into the order's own escrow address, so nothing has to
   * be authorized to pull them on someone's behalf.
   */
  payer?: AztecAddress;
  listingId: bigint;
  /**
   * The listing document being bought. Its price table is passed to the
   * circuit and proven against the on-chain commitment, and the ORDER AMOUNT IS
   * COMPUTED THERE from the chosen rows -- callers do not supply a price, so
   * they cannot get it wrong or lie about it.
   */
  listing: ListingDocument;
  /** Which variant, as an index into `listing.options`. Defaults to the first. */
  optionIndex?: number;
  /** Which shipping method, as an index into `listing.shipping`. */
  shippingIndex?: number;
  quantity: number;
  /** The vendor's order inbox address, from the listing document. */
  vendorInbox: AztecAddress;
  /** Free-text delivery/contact info, encrypted to the vendor only. */
  deliveryMemo: string;
  /** Token binding's transfer_private_to_private interaction builder. */
  createEscrowTransferInteraction: (
    from: AztecAddress,
    to: AztecAddress,
    amount: bigint,
    authwitNonce: Fr,
  ) => Promise<ContractFunctionInteraction>;
  txTimeoutSeconds?: number;
}

export interface PlacedOrder {
  orderId: Fr;
  amount: bigint;
  /** Finalization collateral escrowed on top of `amount` (from live config). */
  collateral: bigint;
  txHash: string;
  /**
   * The buyer-only order credential (AD-6): the random nonce inside the
   * order id's preimage. It appears in NO note, so knowledge of it
   * distinguishes the buyer from everyone else -- including the vendor. The
   * caller MUST persist it (alongside the PXE database it already depends on)
   * to be able to prove buyer-ship in an off-chain dispute later.
   */
  orderNonce: Fr;
  /**
   * The address this order's funds are sitting at. Nobody deployed it and
   * nobody ever will; it exists because both parties can derive it.
   */
  escrowAddress: AztecAddress;
  /**
   * The order's escrow terms. The escrow stores nothing, so every later call
   * re-supplies these and proves them against the commitment `open` published.
   * Recoverable from the order's two notes (see resolveOrderEscrowTerms).
   */
  terms: EscrowTerms;
  /**
   * Per-order escrow secret. Shared with the vendor inside the order's escrow
   * note -- it gives the escrow's keys, and it cannot be used to steal.
   */
  escrowSecret: Fr;
  /**
   * BUYER-ONLY. The preimage of `terms.buyer_auth`, and the only thing keeping
   * the vendor -- who holds every other key to this escrow -- out of the two
   * payout paths that pay their caller. It appears in NO note. If it is lost,
   * the buyer cannot release or refund the order and the funds can only reach
   * the vendor. PERSIST IT.
   */
  buyerSecret: Fr;
}

export async function placeOrder(options: PlaceOrderOptions): Promise<PlacedOrder> {
  const { wallet, from, fee, accessSecret, vendorInbox } = options;
  const wait = { timeout: options.txTimeoutSeconds ?? 180 };
  if (options.quantity < 1) {
    throw new Error('quantity must be at least 1');
  }

  // Resolve the buyer's choices against the document. These are checked in the
  // circuit too -- an out-of-range index would select an unused, zero-priced
  // table slot -- but failing here gives a comprehensible error instead of a
  // proof failure.
  const optionIndex = options.optionIndex ?? 0;
  const shippingIndex = options.shippingIndex ?? 0;
  const option = options.listing.options[optionIndex];
  const shipping = options.listing.shipping[shippingIndex];
  if (option === undefined) {
    throw new Error(
      `option ${optionIndex} is not offered: this listing has ` +
        `${options.listing.options.length}`,
    );
  }
  if (shipping === undefined) {
    throw new Error(
      `shipping method ${shippingIndex} is not offered: this listing has ` +
        `${options.listing.shipping.length}`,
    );
  }
  // Mirrors the circuit exactly: shipping is charged once, per ORDER.
  const amount = BigInt(option.price) * BigInt(options.quantity) + BigInt(shipping.price);
  const { optionPrices, shippingPrices } = priceTable(options.listing);

  const marketplace = await marketplaceAt(options);

  // The escrow's terms must be EXACTLY what the contract will snapshot into
  // the order note, because those terms are what the escrow address commits
  // to. Read them from the same live config place_order reads in-circuit.
  const config = (await marketplace.methods.get_config().simulate({ from })).result as {
    payment_asset: AztecAddress;
    fee_bps: bigint;
    finalization_collateral: bigint;
  };
  const collateral = config.finalization_collateral;
  // Integer division, matching the circuit exactly.
  const orderFee = (amount * config.fee_bps) / 10_000n;

  const marketplaceId = asFr(
    (await marketplace.methods.get_marketplace_id().simulate({ from })).result,
    'get_marketplace_id',
  );
  const orderNonce = Fr.random();
  const orderId = await deriveOrderId(marketplaceId, options.listingId, from, orderNonce);

  // The owner IS the treasury: fees go to the superadmin, which is what the
  // contract's own settlement used to read.
  const treasury = AztecAddressClass.fromFieldUnsafe(
    asFr(
      (await marketplace.methods.get_superadmin_identity().simulate({ from })).result,
      'get_superadmin_identity',
    ),
  );

  const escrowSecret = Fr.random();
  const buyerSecret = Fr.random();
  const terms: EscrowTerms = {
    asset: config.payment_asset,
    marketplace: options.marketplaceAddress,
    order_states_slot: orderStatesSlot(),
    order_id: orderId,
    vendor: vendorInbox,
    treasury,
    amount,
    fee: orderFee,
    collateral,
    buyer_auth: await deriveBuyerAuth(buyerSecret),
  };

  const payer = options.payer ?? from;
  const { escrowAddress, authwitNonce, authWitness, scopes } = await prepareEscrowFunding({
    wallet,
    node: options.node,
    escrowSecret,
    terms,
    funder: payer,
    marketplaceAddress: options.marketplaceAddress,
    createTransferInteraction: options.createEscrowTransferInteraction,
  });

  // ONE call, not a batch. place_order opens the escrow at `escrowAddress` and
  // pulls the funds into it itself, so the order note and the money behind it
  // are the same transaction by construction -- and, because the address
  // commits to the terms it is opened with, the amount cannot be understated.
  // The terms above are rebuilt here only so the client knows which address to
  // fund and can hand back a usable handle; the contract derives its own.
  const { receipt } = await marketplace.methods
    .place_order(
      accessSecret,
      options.listingId,
      padTable(optionPrices, MAX_PRICE_OPTIONS),
      optionPrices.length,
      padTable(shippingPrices, MAX_SHIPPING_OPTIONS),
      shippingPrices.length,
      optionIndex,
      shippingIndex,
      options.quantity,
      vendorInbox,
      orderNonce,
      memoToFields(options.deliveryMemo),
      escrowSecret,
      terms.buyer_auth,
      escrowAddress,
      payer,
      authwitNonce,
    )
    .with({ authWitnesses: [authWitness] })
    .send({
      from,
      ...(fee ? { fee } : {}),
      additionalScopes: scopes,
      wait,
    });

  const orders = await readOrders(marketplace, from);
  if (!orders.some(o => o.orderId.equals(orderId))) {
    throw new Error('order receipt note missing after place_order succeeded');
  }
  return {
    orderId,
    amount,
    collateral,
    txHash: receipt.txHash.toString(),
    orderNonce,
    escrowAddress,
    terms,
    escrowSecret,
    buyerSecret,
  };
}

/**
 * Rebuilds an order's escrow terms from what the chain and the order's notes
 * already hold. This is how the VENDOR reaches an escrow (they never saw the
 * terms object) and how a buyer recovers one on a new device.
 *
 * `buyer_auth` comes from the order's escrow note, so this works for both
 * parties; the buyer additionally needs their own `buyerSecret`, which is in no
 * note at all, to actually spend through it.
 */
export async function resolveOrderEscrowTerms(
  options: OrderSessionOptions & { orderId: Fr },
): Promise<{ terms: EscrowTerms; escrowSecret: Fr }> {
  const { from, orderId } = options;
  const marketplace = await marketplaceAt(options);

  const order = (await readOrders(marketplace, from)).find(o => o.orderId.equals(orderId));
  if (order === undefined) {
    throw new Error(`no order note for ${orderId.toString()} is visible to this account`);
  }
  const escrowNote = (await readOrderEscrows(marketplace, from)).find(e =>
    e.orderId.equals(orderId),
  );
  if (escrowNote === undefined) {
    throw new Error(`no escrow note for ${orderId.toString()} is visible to this account`);
  }

  const config = (await marketplace.methods.get_config().simulate({ from })).result as {
    payment_asset: AztecAddress;
  };
  const treasury = AztecAddressClass.fromFieldUnsafe(
    asFr(
      (await marketplace.methods.get_superadmin_identity().simulate({ from })).result,
      'get_superadmin_identity',
    ),
  );

  return {
    escrowSecret: escrowNote.escrowSecret,
    terms: {
      asset: config.payment_asset,
      marketplace: options.marketplaceAddress,
      order_states_slot: orderStatesSlot(),
      order_id: orderId,
      vendor: order.raw.vendor_inbox,
      treasury,
      amount: order.raw.amount,
      fee: order.raw.fee,
      collateral: order.raw.collateral,
      buyer_auth: escrowNote.buyerAuth,
    },
  };
}

export interface OrderView {
  orderId: Fr;
  listingId: bigint;
  /** Finalization collateral escrowed with this order. */
  collateral: bigint;
  amount: bigint;
  fee: bigint;
  vendorInbox: AztecAddress;
  timeoutAt: bigint;
  accepted: boolean;
  /**
   * The order reached a terminal state through the MARKETPLACE: cancelled,
   * completed, or claimed by the vendor.
   *
   * NOT set by a refund ruling. That path ends with the buyer pulling from the
   * escrow, and the marketplace cannot observe an escrow call -- so a
   * REFUND_BUYER order reads `settled: false` whether or not the buyer has
   * collected yet. Use `disputeOutcome`/`statuses` to recognise it, and the
   * escrow's own balance (getOrderEscrowBalance) to tell collected from not.
   */
  settled: boolean;
  /** The buyer marked the order disputed (anonymous on-chain flag). */
  disputed: boolean;
  /** The arbiter's ruling on a disputed order (None until ruled). */
  disputeOutcome: DisputeOutcome;
  /** Delivery memo (vendor view only; empty for buyers). */
  deliveryMemo: string;
  /** Fulfillment updates received for this order. */
  statuses: OrderStatus[];
}

interface RawOrderNote {
  order_id: bigint | Fr;
  listing_id: bigint;
  collateral: bigint;
  amount: bigint;
  fee: bigint;
  vendor_inbox: AztecAddress;
  timeout_at: bigint;
}

async function readOrders(
  marketplace: Awaited<ReturnType<typeof MarketplaceContract.at>>,
  owner: AztecAddress,
): Promise<{ orderId: Fr; raw: RawOrderNote }[]> {
  // Dedupe by order id. The buyer both SENDS place_order and is a recipient of
  // the order note's constrained delivery, so a shared PXE discovers the
  // buyer's own note twice (once from the tx it sent, once from the delivered
  // log). Order ids are derived from a random per-order nonce, so two notes
  // sharing an id are always the same order -- never distinct orders.
  const seen = new Set<string>();
  const out: { orderId: Fr; raw: RawOrderNote }[] = [];
  for (let page = 0; ; page++) {
    const { result } = await marketplace.methods.get_orders(owner, page).simulate({ from: owner });
    const [notes, count] = result as [RawOrderNote[], bigint];
    for (let i = 0; i < Number(count); i++) {
      const raw = notes[i];
      if (raw === undefined) {
        throw new Error('get_orders returned fewer notes than its count');
      }
      const orderId = asFr(raw.order_id, 'order_id');
      const key = orderId.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({ orderId, raw });
    }
    if (Number(count) < 10) {
      break;
    }
  }
  return out;
}

/**
 * Reads the escrow notes visible to `owner`. Paired with the order notes, these
 * are what rebuild an escrow's address and terms; both parties hold identical
 * copies. Deduped for the same reason readOrders is.
 */
async function readOrderEscrows(
  marketplace: Awaited<ReturnType<typeof MarketplaceContract.at>>,
  owner: AztecAddress,
): Promise<{ orderId: Fr; escrowSecret: Fr; buyerAuth: Fr }[]> {
  const seen = new Set<string>();
  const out: { orderId: Fr; escrowSecret: Fr; buyerAuth: Fr }[] = [];
  for (let page = 0; ; page++) {
    const { result } = await marketplace.methods
      .get_order_escrows(owner, page)
      .simulate({ from: owner });
    const [notes, count] = result as [
      { order_id: bigint | Fr; escrow_secret: bigint | Fr; buyer_auth: bigint | Fr }[],
      bigint,
    ];
    for (let i = 0; i < Number(count); i++) {
      const raw = notes[i];
      if (raw === undefined) {
        throw new Error('get_order_escrows returned fewer notes than its count');
      }
      const orderId = asFr(raw.order_id, 'order_id');
      const key = orderId.toString();
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push({
        orderId,
        escrowSecret: asFr(raw.escrow_secret, 'escrow_secret'),
        buyerAuth: asFr(raw.buyer_auth, 'buyer_auth'),
      });
    }
    if (Number(count) < 10) {
      break;
    }
  }
  return out;
}

/**
 * Reads all orders visible to `owner` (buyer receipts or a vendor inbox),
 * enriched with acceptance/settlement flags, received status notes, and --
 * for vendors -- the delivery memo.
 */
export async function resolveOrders(
  options: OrderSessionOptions & { accessSecret: Fr },
): Promise<OrderView[]> {
  const { from } = options;
  const marketplace = await marketplaceAt(options);
  const orders = await readOrders(marketplace, from);

  // Status notes and memos, indexed by order id.
  const memosById = new Map<string, string>();
  for (let page = 0; ; page++) {
    const { result } = await marketplace.methods.get_order_memos(from, page).simulate({ from });
    const [notes, count] = result as [{ order_id: bigint | Fr; data: Fr[] | bigint[] }[], bigint];
    for (let i = 0; i < Number(count); i++) {
      const note = notes[i];
      if (note === undefined) {
        throw new Error('get_order_memos returned fewer notes than its count');
      }
      memosById.set(
        asFr(note.order_id, 'order_id').toString(),
        fieldsToMemo(note.data.map((f, j) => asFr(f, `memo[${j}]`))),
      );
    }
    if (Number(count) < 10) {
      break;
    }
  }

  const views: OrderView[] = [];
  for (const { orderId, raw } of orders) {
    const accepted = (
      await marketplace.methods.is_order_accepted(orderId).simulate({ from })
    ).result as boolean;
    const settled = (
      await marketplace.methods.is_order_settled(orderId).simulate({ from })
    ).result as boolean;
    const disputed = (
      await marketplace.methods.is_order_disputed(orderId).simulate({ from })
    ).result as boolean;
    const disputeOutcome = disputed
      ? (Number(
          (await marketplace.methods.get_dispute_outcome(orderId).simulate({ from })).result,
        ) as DisputeOutcome)
      : DisputeOutcome.None;
    // Vendor->buyer fulfillment is a public per-order word now (no buyer
    // address); the rest of the status timeline is derived from public state.
    const fulfillment = Number(
      (await marketplace.methods.get_order_fulfillment(orderId).simulate({ from })).result,
    );
    const statuses: OrderStatus[] = [];
    if (accepted) statuses.push(OrderStatus.Accepted);
    if (fulfillment >= OrderStatus.Shipped) statuses.push(OrderStatus.Shipped);
    if (fulfillment >= OrderStatus.Delivered) statuses.push(OrderStatus.Delivered);
    // A refund RULING is the refunded status. It deliberately does not wait for
    // `settled`: the buyer pulls their refund from the escrow, and the
    // marketplace cannot see that happen (see OrderView.settled).
    if (disputeOutcome === DisputeOutcome.RefundBuyer) {
      statuses.push(OrderStatus.Refunded);
    }
    views.push({
      orderId,
      listingId: raw.listing_id,
      collateral: raw.collateral,
      amount: raw.amount,
      fee: raw.fee,
      vendorInbox: raw.vendor_inbox,
      timeoutAt: raw.timeout_at,
      accepted,
      settled,
      disputed,
      disputeOutcome,
      deliveryMemo: memosById.get(orderId.toString()) ?? '',
      statuses,
    });
  }
  return views;
}

interface SettlementOptions extends OrderSessionOptions {
  fee?: { paymentMethod: FeePaymentMethod };
  accessSecret: Fr;
  orderId: Fr;
  txTimeoutSeconds?: number;
}

/**
 * A state-machine call on the marketplace. No token notes are touched here any
 * more -- these calls decide, in public, which terminal state an order reaches;
 * the money moves in a following escrow call.
 */
async function settlementCall(
  options: SettlementOptions,
  build: (
    marketplace: Awaited<ReturnType<typeof MarketplaceContract.at>>,
  ) => { send(opts: object): Promise<{ receipt: { txHash: { toString(): string } } }> },
): Promise<{ txHash: string }> {
  const { from, fee } = options;
  const wait = { timeout: options.txTimeoutSeconds ?? 180 };
  const marketplace = await marketplaceAt(options);
  const { receipt } = await build(marketplace).send({
    from,
    ...(fee ? { fee } : {}),
    wait,
  });
  return { txHash: receipt.txHash.toString() };
}

/**
 * The same, made AS a per-market account (vendor paths): adds the identity
 * authwit of {@link sendActingAs} so the universal wallet can send and pay.
 */
async function settlementActingAs(
  options: SettlementOptions,
  build: (
    marketplace: Awaited<ReturnType<typeof MarketplaceContract.at>>,
    account: AztecAddress,
    authwitNonce: Fr,
  ) => ContractFunctionInteraction,
): Promise<{ txHash: string }> {
  const marketplace = await marketplaceAt(options);
  return sendActingAs(options, (account, nonce) => build(marketplace, account, nonce));
}

/** Vendor commits to fulfilling the order. */
export async function acceptOrder(
  options: OrderSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    orderId: Fr;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const marketplace = await marketplaceAt(options);
  return sendActingAs(options, (account, nonce) =>
    marketplace.methods.accept_order(options.orderId, account, nonce),
  );
}

/**
 * Buyer cancels before acceptance -- AUTHORIZES the refund by moving the order
 * to CANCELLED. The buyer then pulls the escrow themselves with
 * claimOrderEscrowRefund.
 *
 * The authorization has to happen here, not in the escrow: this is a race with
 * the vendor's acceptance, and only a public call can be serialized against it.
 * If the acceptance lands first, this reverts and the funds stay escrowed.
 */
export function cancelOrder(options: SettlementOptions): Promise<{ txHash: string }> {
  return settlementCall(options, m => m.methods.cancel_order(options.orderId));
}

/**
 * Buyer confirms receipt AND leaves feedback (mandatory: the finalization
 * collateral refund pays them to do it). Appends the sealed rating+statement
 * to the listing and moves the order to COMPLETED, which authorizes
 * releaseOrderEscrow -- vendor paid, fee split off, collateral returned.
 */
export async function confirmCompletion(
  options: SettlementOptions & {
    /** 1-5 stars. */
    rating: number;
    /** Short statement ('' for rating-only). */
    feedbackText: string;
  },
): Promise<{ txHash: string }> {
  const blob = await sealFeedbackBlob(
    { rating: options.rating, text: options.feedbackText },
    options.accessSecret,
  );
  return settlementCall(options, m => m.methods.confirm_completion(options.orderId, blob));
}

/**
 * Vendor settles an accepted order whose timeout has passed -- AUTHORIZES the
 * payout by moving the order to SETTLED_VENDOR, after proving in public that
 * the order is accepted, not disputed, and past its deadline. The vendor then
 * collects with claimOrderEscrow. Those are exactly the checks the escrow could
 * not make race-free for itself, which is why it waits for the state instead.
 */
export function claimTimeoutSettlement(options: SettlementOptions): Promise<{ txHash: string }> {
  return settlementActingAs(options, (m, account, nonce) =>
    m.methods.claim_timeout_settlement(options.orderId, account, nonce),
  );
}

/**
 * Buyer marks an ACCEPTED order disputed: an anonymous public flag keyed by
 * the opaque order id. While set, the vendor's timeout settlement reverts, so
 * the order can only end by the buyer confirming or the vendor refunding --
 * this is what makes the off-chain arbitration binding. Reads the flag back.
 */
export async function markOrderDisputed(
  options: OrderSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    orderId: Fr;
    /**
     * The buyer's dispute-auth commitment (AD-6): poseidon2([dispute_secret,
     * DOMAIN_DISPUTE_COMMITMENT]). Published on-chain so a moderator can later
     * authenticate the buyer from the secret they reveal in the dispute room,
     * with a single hash instead of a ZK proof.
     */
    disputeCommitment: Fr;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const { from, fee, orderId, disputeCommitment } = options;
  const wait = { timeout: options.txTimeoutSeconds ?? 180 };
  const marketplace = await marketplaceAt(options);
  const { receipt } = await marketplace.methods
    .dispute_order(orderId, disputeCommitment)
    .send({ from, ...(fee ? { fee } : {}), wait });

  const disputed = (await marketplace.methods.is_order_disputed(orderId).simulate({ from }))
    .result as boolean;
  if (!disputed) {
    throw new Error('order is not marked disputed after dispute_order succeeded');
  }
  return { txHash: receipt.txHash.toString() };
}

/**
 * Reads the buyer's dispute-auth commitment for an order (AD-6), or Fr.ZERO if
 * the order was never disputed. A moderator recomputes
 * deriveDisputeCommitment(revealedSecret) and matches it against this to
 * confirm -- automatically and offline -- that the party in the dispute room
 * is the genuine buyer, without ever learning the buyer's address.
 */
export async function getDisputeCommitment(
  options: OrderSessionOptions & { orderId: Fr },
): Promise<Fr> {
  const { from, orderId } = options;
  const marketplace = await marketplaceAt(options);
  return asFr(
    (await marketplace.methods.get_dispute_commitment(orderId).simulate({ from })).result,
    'get_dispute_commitment',
  );
}

/**
 * Vendor OFFERS a full refund (amount + the buyer's collateral) -- the dispute
 * escape valve, also usable as goodwill. It sets the same REFUND_BUYER state an
 * arbiter's refund ruling does, and the buyer then pulls the escrow themselves
 * with claimOrderEscrowRefund. Pull, not push: the vendor never learns the
 * buyer's address, so it could not send the funds anywhere even if it held them.
 */
export function refundOrder(options: SettlementOptions): Promise<{ txHash: string }> {
  return settlementActingAs(options, (m, account, nonce) =>
    m.methods.refund_order(options.orderId, account, nonce),
  );
}

/**
 * Bounded arbitration: an authorized moderator (PERM_RESOLVE_DISPUTES) or the
 * superadmin rules a DISPUTED order toward one of the two legitimate
 * outcomes. One anonymous public flag; the arbiter never touches funds --
 * execution stays with the winning party. Reads the ruling back.
 */
export async function resolveDispute(
  options: OrderSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    orderId: Fr;
    outcome: DisputeOutcome.RefundBuyer | DisputeOutcome.PayVendor;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const { from, orderId, outcome } = options;
  const marketplace = await marketplaceAt(options);
  const { txHash } = await sendActingAs(options, (account, nonce) =>
    marketplace.methods.resolve_dispute(orderId, outcome, account, nonce),
  );

  const ruled = Number(
    (await marketplace.methods.get_dispute_outcome(orderId).simulate({ from })).result,
  ) as DisputeOutcome;
  if (ruled !== outcome) {
    throw new Error(`dispute outcome is ${ruled} after ruling ${outcome}`);
  }
  return { txHash };
}

// NOTE: there is no claimRefund here any more. REFUND_BUYER and CANCELLED are
// already terminal, so they authorize the ESCROW's own refund path directly --
// the buyer pulls with claimOrderEscrowRefund and never touches the
// marketplace again.

/**
 * The PUBLIC dispute-relevant state of any order id (AD-6): whether it has
 * been accepted by its vendor and whether it has settled. Both are free
 * utility reads of anonymous public flags keyed by the opaque order id, so
 * anyone -- crucially, a moderator who is NOT a party to the order -- can
 * check them. A dispute is meaningful iff the order is accepted (the vendor
 * committed) and not yet settled (it is still live).
 */
export async function getOrderDisputeState(
  options: OrderSessionOptions & { orderId: Fr },
): Promise<{ accepted: boolean; settled: boolean; disputed: boolean }> {
  const { from, orderId } = options;
  const marketplace = await marketplaceAt(options);
  const accepted = (await marketplace.methods.is_order_accepted(orderId).simulate({ from }))
    .result as boolean;
  const settled = (await marketplace.methods.is_order_settled(orderId).simulate({ from }))
    .result as boolean;
  const disputed = (await marketplace.methods.is_order_disputed(orderId).simulate({ from }))
    .result as boolean;
  return { accepted, settled, disputed };
}

/** Vendor sends a shipped/delivered update to the buyer. */
export async function updateOrderStatus(
  options: OrderSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    orderId: Fr;
    status: OrderStatus.Shipped | OrderStatus.Delivered;
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const marketplace = await marketplaceAt(options);
  return sendActingAs(options, (account, nonce) =>
    marketplace.methods.update_order_status(options.orderId, options.status, account, nonce),
  );
}

export interface ListingFeedback {
  /** Valid, decrypted feedback entries (each backed by a finalized order). */
  entries: FeedbackDocument[];
  /**
   * Entries that failed to unpack/decrypt/validate. Feedback bytes are
   * buyer-supplied and therefore ADVERSARIAL on read: a hostile buyer can
   * store garbage through confirm_completion, and one griefer must not blank
   * out a listing's whole review section -- so invalid entries are counted
   * and skipped rather than thrown.
   */
  invalid: number;
}

/**
 * Reads all feedback left on one listing via the paged on-chain view and
 * decrypts it with the market link.
 */
export async function listListingFeedback(
  options: OrderSessionOptions & { listingId: bigint; accessSecret: Fr },
): Promise<ListingFeedback> {
  const { from, accessSecret } = options;
  const marketplace = await marketplaceAt(options);

  const entries: FeedbackDocument[] = [];
  let invalid = 0;
  for (let page = 0n; ; page++) {
    const { result } = await marketplace.methods
      .get_feedback_page(options.listingId, page)
      .simulate({ from });
    const [data, count] = result as [(Fr | bigint)[], bigint];
    for (let i = 0; i < Number(count); i++) {
      const fields = data
        .slice(i * FEEDBACK_FIELDS, (i + 1) * FEEDBACK_FIELDS)
        .map((f, j) => asFr(f, `feedback[${i}][${j}]`));
      try {
        entries.push(await openFeedbackBlob(fields, accessSecret));
      } catch {
        invalid++;
      }
    }
    if (Number(count) < 4) {
      break;
    }
  }
  return { entries, invalid };
}

// NOTE: there is no getEscrowBalance any more. The marketplace holds no
// private notes at all -- order funds live at per-order escrow addresses
// (getOrderEscrowBalance) and vendor deposits sit in its PUBLIC balance --
// and it is now deployed with NO encryption keys, so there is nothing there
// to read and no key with which to read it.
