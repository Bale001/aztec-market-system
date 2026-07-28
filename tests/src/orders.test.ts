// M5 integration: fully private orders against a local Aztec network.
//
// The core claims verified here (AD-5):
//   - placing an order moves funds buyer -> that order's OWN escrow address,
//     which NOBODY DEPLOYED, without any public token balance ever changing
//   - the vendor receives the order, its escrow keys, and the delivery memo as
//     encrypted notes (and needs no funding check: place_order OPENS the escrow
//     it funds, so the order note cannot exist without the money -- see the
//     wrong-escrow test below)
//   - settlement pays the vendor and the treasury out of that one escrow, and
//     empties it -- one order's escrow holds exactly one order's money
//   - cancellation refunds the buyer, and is blocked after acceptance
//   - a settled order can never settle again
//
// EVERY SETTLEMENT IS TWO TRANSACTIONS. The marketplace decides, in public
// where transactions serialize, and writes a TERMINAL order state; the escrow
// then reads that state from a historical block and pays. The escrow has no
// public functions, so it cannot serialize itself against a concurrent
// transaction -- the marketplace half is what makes the payout race-free.
//
// The payment token is the aztec-standards Token, not
// @aztec/noir-contracts.js/Token: the escrow calls transfer_private_to_private,
// which the latter does not expose. It is also what cUSDC actually is.
//
// THIS SUITE ALSO CARRIES THE UNDEPLOYED-ESCROW CLAIM, which used to live in a
// standalone undeployed-escrow.test.ts. The first test asserts the node has no
// contract at the escrow's address both BEFORE it is funded and AFTER it has
// paid out real cUSDC. That is the whole claim, and it is stronger here: the
// arbitrating marketplace is a real one, not a stand-in. The standalone file
// was removed rather than duplicated -- once every payout requires a terminal
// order state, testing one in isolation means deploying a marketplace and
// placing an order, which is exactly this file.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NO_FROM } from '@aztec/aztec.js/account';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import {
  Contract,
  getContractClassFromArtifact,
  getContractInstanceFromInstantiationParams,
} from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { loadContractArtifact } from '@aztec/stdlib/abi';
import { EmbeddedWallet } from '@aztec/wallets/embedded';

import {
  MarketplaceContract,
  MarketplaceRegistryContract,
  OrderEscrowContract,
} from '@market/contract-bindings';
import {
  acceptOrder,
  cancelOrder,
  claimOrderEscrow,
  claimOrderEscrowRefund,
  claimTimeoutSettlement,
  confirmCompletion,
  createListing,
  deriveBuyerAuth,
  getDisputeCommitment,
  getOrderEscrowBalance,
  markOrderDisputed,
  orderStatesSlot,
  registerOrderEscrow,
  refundOrder,
  releaseOrderEscrow,
  resolveDispute,
  deployMarketplace,
  listListingFeedback,
  placeOrder,
  registerUser,
  registerVendor,
  resolveOrders,
  updateOrderStatus,
  type PlacedOrder,
} from '@market/deployment';
import { deriveDisputeCommitment, deriveOrderId } from '@market/identity';
import type { ListingDocument } from '@market/market-metadata';
import { sampleListingDocument, sampleMarketplaceMetadata } from '@market/market-metadata';
import { DisputeOutcome, OrderStatus, VendorPolicy } from '@market/shared-types';

import { memoryArweaveIO } from './arweave-io.js';

// Listing content is stored off-chain; use an in-memory store for the pipeline.
const io = memoryArweaveIO();

// cUSDC is the aztec-standards Token, and the escrow calls ITS abi.
const tokenArtifact = loadContractArtifact(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../../node_modules/@aztec-foundation/aztec-standards/artifacts/target/token_contract-Token.json',
          import.meta.url,
        ),
      ),
      'utf-8',
    ),
  ) as Parameters<typeof loadContractArtifact>[0],
);

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080';

// The standard test listing: one unnamed variant at PRICE, one free shipping
// method -- an ordinary single-price listing in the table form the commitment
// now binds. placeOrder proves this table against the on-chain commitment.
function testListing(): ListingDocument {
  return {
    ...sampleListingDocument(),
    options: [{ label: '', price: PRICE.toString() }],
    shipping: [{ label: 'Standard', price: '0' }],
  };
}

const TX_WAIT = { timeout: 300 };
const PRICE = 1000n;
const QUANTITY = 2;
const AMOUNT = PRICE * BigInt(QUANTITY);
const FEE = (AMOUNT * 250n) / 10000n; // 250 bps
// Finalization collateral: escrowed on top of AMOUNT, back to the buyer at
// confirmation (with review) or forfeited to the vendor on a timeout claim.
const COLLATERAL = 500n;
const ESCROW = AMOUNT + COLLATERAL;
// Listing ids are 1-BASED (0 is the null for the per-category ordering links,
// see LISTING_FIRST_ID), so the single listing each market here creates is 1.
const LISTING_ID = 1n;

let node: AztecNode;
let wallet: EmbeddedWallet;
// Deploys everything and is the market's superadmin -- which is also where the
// marketplace fee lands, since the owner IS the treasury (no fee_recipient).
let operator: AztecAddress;
let vendor: AztecAddress;
let buyer: AztecAddress;
let paymentMethod: SponsoredFeePaymentMethod;
let token: Contract;
let marketplaceAddress: AztecAddress;
let accessSecret: Fr;
let vendorInbox: AztecAddress;
let registryAddress: AztecAddress;

async function newAccount(): Promise<AztecAddress> {
  const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  const deploy = await account.getDeployMethod();
  await deploy.send({ from: NO_FROM, fee: { paymentMethod }, wait: TX_WAIT });
  return account.address;
}

function session(from: AztecAddress) {
  return { wallet, node, from, marketplaceAddress, fee: { paymentMethod } };
}

/** Funds an order's own escrow. Self-authorized, so no authwit is involved. */
const transferIntoEscrow = (from: AztecAddress, to: AztecAddress, amount: bigint, nonce: Fr) =>
  Promise.resolve(token.methods.transfer_private_to_private!(from, to, amount, nonce));

async function placeTestOrder(memo: string) {
  return placeOrder({
    ...session(buyer),
    accessSecret,
    listingId: LISTING_ID,
    listing: testListing(),
    quantity: QUANTITY,
    vendorInbox,
    deliveryMemo: memo,
    createEscrowTransferInteraction: transferIntoEscrow,
  });
}

/** The escrow-call arguments an order needs, for whichever party is settling. */
function escrowSession(placed: PlacedOrder, from: AztecAddress) {
  return {
    wallet,
    node,
    from,
    fee: { paymentMethod },
    escrowSecret: placed.escrowSecret,
    terms: placed.terms,
  };
}

async function escrowBalance(placed: PlacedOrder): Promise<bigint> {
  return getOrderEscrowBalance({
    ...escrowSession(placed, buyer),
    createBalanceInteraction: owner =>
      Promise.resolve(token.methods.balance_of_private!(owner)),
  });
}

async function publicBalance(owner: AztecAddress): Promise<bigint> {
  return (await token.methods.balance_of_public!(owner).simulate({ from: operator }))
    .result as bigint;
}

async function privateBalance(owner: AztecAddress): Promise<bigint> {
  return (await token.methods.balance_of_private!(owner).simulate({ from: owner }))
    .result as bigint;
}

beforeAll(async () => {
  node = createAztecNodeClient(NODE_URL);
  wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: false },
  });
  const sponsoredFPC = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  paymentMethod = new SponsoredFeePaymentMethod(sponsoredFPC.address);

  operator = await newAccount();
  vendor = await newAccount();
  buyer = await newAccount();
  vendorInbox = vendor;

  // Payment token; the operator mints the buyer's private funds.
  const { contract } = await Contract.deploy(
    wallet,
    tokenArtifact,
    [
      'MarketToken00000000000000000000',
      'MKT0000000000000000000000000000',
      6,
      operator,
      AztecAddress.ZERO,
    ],
    'constructor_with_minter',
  ).send({ from: operator, fee: { paymentMethod }, wait: TX_WAIT });
  token = contract;
  await token.methods
    .mint_to_private!(buyer, 10_000n)
    .send({ from: operator, fee: { paymentMethod }, wait: TX_WAIT });

  // Registry + hidden market paying in that token, open vendor policy,
  // 250 bps fee to the operator.
  const { contract: registry } = await MarketplaceRegistryContract.deploy(wallet).send({
    from: operator,
    fee: { paymentMethod },
    wait: TX_WAIT,
  });
  registryAddress = registry.address;
  const metadata = sampleMarketplaceMetadata();
  metadata.onchain.paymentAsset = token.address.toString();
  metadata.onchain.vendorPolicy = VendorPolicy.Open;
  metadata.onchain.finalizationCollateral = COLLATERAL.toString();
  const deployed = await deployMarketplace({
    wallet,
    node,
    from: operator,
    superadmin: operator, // orders tests don't administer; operator owns
    ownerUsername: 'owner',
    fee: { paymentMethod },
    registryAddress: registry.address,
    metadata,
    deploymentNonce: Fr.random().toBigInt(),
  });
  marketplaceAddress = deployed.marketplaceAddress;
  accessSecret = deployed.accessSecret;

  // Vendor's per-market account claims a username, registers (open policy ->
  // active immediately), and lists an item at PRICE.
  await registerUser({ ...session(vendor), accessSecret, username: 'vendorco' });
  await registerVendor({ ...session(vendor) });
  const listing = { ...sampleListingDocument(), options: [{ label: '', price: PRICE.toString() }], shipping: [{ label: 'Standard', price: '0' }] };
  await createListing({
    ...io,
    ...session(vendor),
    listing,
    accessSecret,
  });
}, 600_000);


describe('fully private orders (AD-5)', () => {
  it('runs a complete private purchase: place -> accept -> ship -> confirm', async () => {
    const operatorBalanceBefore = await privateBalance(operator);

    const placed = await placeTestOrder('Ship to: 42 Galaxy Way, Zone 9');
    expect(placed.amount).toBe(AMOUNT);
    expect(placed.collateral).toBe(COLLATERAL);

    // THE core claim: the funds (amount AND the finalization collateral) sit at
    // this ORDER'S OWN address, which nobody deployed and nobody ever will --
    // the node has no contract there at all. The marketplace never touched
    // them, and no public balance anywhere moved. The amounts exist only
    // inside encrypted notes.
    expect(await node.getContract(placed.escrowAddress)).toBeUndefined();
    // Nor is the CLASS published. Publication exists so a sequencer can fetch
    // public bytecode and strangers can fetch the artifact; the escrow has no
    // public functions and both parties ship the artifact, so the kernel's
    // client-side hint is enough. This is why the escrow needs no deployment
    // step of any kind -- not per order, not once at setup.
    const escrowClass = await getContractClassFromArtifact(OrderEscrowContract.artifact);
    expect(await node.getContractClass(escrowClass.id)).toBeUndefined();

    expect(await escrowBalance(placed)).toBe(ESCROW);
    expect(await publicBalance(placed.escrowAddress)).toBe(0n);
    expect(await publicBalance(marketplaceAddress)).toBe(0n);
    expect(await privateBalance(marketplaceAddress)).toBe(0n);
    expect(await privateBalance(buyer)).toBe(10_000n - ESCROW);

    // The vendor's encrypted view: order + snapshotted terms + memo.
    const vendorOrders = await resolveOrders({ ...session(vendor), accessSecret });
    expect(vendorOrders).toHaveLength(1);
    const order = vendorOrders[0]!;
    expect(order.orderId.equals(placed.orderId)).toBe(true);
    expect(order.amount).toBe(AMOUNT);
    expect(order.collateral).toBe(COLLATERAL);
    expect(order.fee).toBe(FEE);
    expect(order.deliveryMemo).toBe('Ship to: 42 Galaxy Way, Zone 9');
    expect(order.accepted).toBe(false);
    expect(order.settled).toBe(false);

    // Vendor accepts and marks shipped; the buyer sees both updates.
    await acceptOrder({ ...session(vendor), orderId: placed.orderId });
    await updateOrderStatus({
      ...session(vendor),
      orderId: placed.orderId,
      status: OrderStatus.Shipped,
    });
    const buyerOrders = await resolveOrders({ ...session(buyer), accessSecret });
    expect(buyerOrders).toHaveLength(1);
    expect(buyerOrders[0]!.accepted).toBe(true);
    expect(buyerOrders[0]!.statuses).toEqual(
      expect.arrayContaining([OrderStatus.Accepted, OrderStatus.Shipped]),
    );

    // Buyer confirms WITH a review. Step 1, the marketplace: the review is
    // appended and the order moves to COMPLETED -- but no money has moved yet.
    await confirmCompletion({
      ...session(buyer),
      accessSecret,
      orderId: placed.orderId,
      rating: 5,
      feedbackText: 'Great product, fast shipping.',
    });
    expect(await escrowBalance(placed)).toBe(ESCROW);

    // Step 2, the escrow, which reads that COMPLETED state and only then pays:
    // vendor gets amount - fee, the operator (the owner IS the treasury) gets
    // the fee, the buyer's collateral comes back, and the escrow EMPTIES --
    // it held exactly this one order and now holds nothing.
    await releaseOrderEscrow({
      ...escrowSession(placed, buyer),
      buyerSecret: placed.buyerSecret,
    });
    expect(await privateBalance(vendor)).toBe(AMOUNT - FEE);
    expect((await privateBalance(operator)) - operatorBalanceBefore).toBe(FEE);
    expect(await privateBalance(buyer)).toBe(10_000n - AMOUNT); // collateral returned
    expect(await escrowBalance(placed)).toBe(0n);
    // Still never deployed, after moving real money.
    expect(await node.getContract(placed.escrowAddress)).toBeUndefined();

    const settled = await resolveOrders({ ...session(buyer), accessSecret });
    expect(settled[0]!.settled).toBe(true);

    // The review is on the listing, sealed: link holders can read it...
    const fb = await listListingFeedback({ ...session(buyer), listingId: LISTING_ID, accessSecret });
    expect(fb.entries).toEqual([
      { schemaVersion: 1, rating: 5, text: 'Great product, fast shipping.' },
    ]);
    expect(fb.invalid).toBe(0);
    // ...but without the market link it is undecodable noise.
    const withoutLink = await listListingFeedback({
      ...session(buyer),
      listingId: LISTING_ID,
      accessSecret: Fr.random(),
    });
    expect(withoutLink.entries).toEqual([]);
    expect(withoutLink.invalid).toBe(1);

    // Settling again is impossible by construction.
    await expect(
      confirmCompletion({
        ...session(buyer),
        accessSecret,
        orderId: placed.orderId,
        rating: 5,
        feedbackText: 'again',
      }),
    ).rejects.toThrow();
  }, 600_000);

  it('lets the buyer cancel before acceptance and blocks cancel after', async () => {
    const balanceBefore = await privateBalance(buyer);

    // Cancel path. Step 1 authorizes it (CANCELLED) but moves nothing...
    const first = await placeTestOrder('cancel me');
    await cancelOrder({ ...session(buyer), accessSecret, orderId: first.orderId });
    const afterCancel = await resolveOrders({ ...session(buyer), accessSecret });
    expect(afterCancel.find(o => o.orderId.equals(first.orderId))!.settled).toBe(true);
    expect(await escrowBalance(first)).toBe(ESCROW);

    // ...step 2 pulls the full escrow back, collateral included.
    await claimOrderEscrowRefund({
      ...escrowSession(first, buyer),
      buyerSecret: first.buyerSecret,
    });
    expect(await privateBalance(buyer)).toBe(balanceBefore);
    expect(await escrowBalance(first)).toBe(0n);

    // Post-acceptance the cancellation REVERTS -- this is the race the escrow
    // could not settle for itself, and why the authorization lives in a public
    // call. The escrow keeps the money.
    const second = await placeTestOrder('too late to cancel');
    await acceptOrder({ ...session(vendor), orderId: second.orderId });
    await expect(
      cancelOrder({ ...session(buyer), accessSecret, orderId: second.orderId }),
    ).rejects.toThrow(/already accepted/);
    expect(await privateBalance(buyer)).toBe(balanceBefore - ESCROW);
    expect(await escrowBalance(second)).toBe(ESCROW);

    // ...and the refund the buyer never got authorized is refused outright.
    await expect(
      claimOrderEscrowRefund({
        ...escrowSession(second, buyer),
        buyerSecret: second.buyerSecret,
      }),
    ).rejects.toThrow();

    // Clean up: complete the second order (with its mandatory review).
    await confirmCompletion({
      ...session(buyer),
      accessSecret,
      orderId: second.orderId,
      rating: 4,
      feedbackText: '',
    });
    await releaseOrderEscrow({
      ...escrowSession(second, buyer),
      buyerSecret: second.buyerSecret,
    });
  }, 600_000);

  it('forfeits the collateral to the vendor on a timeout claim', async () => {
    // A second market with a 3-second order timeout so the claim can run in
    // real time (the anchor header's timestamp must pass the deadline).
    const metadata = sampleMarketplaceMetadata();
    metadata.onchain.paymentAsset = token.address.toString();
    metadata.onchain.vendorPolicy = VendorPolicy.Open;
    metadata.onchain.finalizationCollateral = COLLATERAL.toString();
    metadata.onchain.orderTimeoutSeconds = 3;
    const fast = await deployMarketplace({
      wallet, node, from: operator,
      superadmin: operator,
      ownerUsername: 'owner',
      fee: { paymentMethod },
      registryAddress, metadata,
      deploymentNonce: Fr.random().toBigInt(),
    });
    const fastVendor = {
      wallet, node, from: vendor, fee: { paymentMethod },
      marketplaceAddress: fast.marketplaceAddress,
    };
    await registerUser({ ...fastVendor, accessSecret: fast.accessSecret, username: 'fastco' });
    await registerVendor(fastVendor);
    const listing = { ...sampleListingDocument(), options: [{ label: '', price: PRICE.toString() }], shipping: [{ label: 'Standard', price: '0' }] };
    await createListing({
      ...io, ...fastVendor,
      listing, accessSecret: fast.accessSecret,
    });

    const placed = await placeOrder({
      wallet, node, from: buyer, fee: { paymentMethod },
      marketplaceAddress: fast.marketplaceAddress,
      accessSecret: fast.accessSecret,
      listingId: LISTING_ID, listing: testListing(), quantity: QUANTITY, vendorInbox,
      deliveryMemo: 'buyer will go silent',
      createEscrowTransferInteraction: transferIntoEscrow,
    });
    await acceptOrder({
      wallet, node, from: vendor, fee: { paymentMethod },
      marketplaceAddress: fast.marketplaceAddress, orderId: placed.orderId,
    });

    // Let the deadline pass, then mine a block PAST it so the claim's anchor
    // header proves the time.
    await new Promise(resolve => setTimeout(resolve, 5000));
    await token.methods
      .mint_to_private!(buyer, 1n)
      .send({ from: operator, fee: { paymentMethod }, wait: TX_WAIT });

    const vendorBefore = await privateBalance(vendor);
    // Step 1: the marketplace proves -- in public -- that the order is
    // accepted, undisputed and past its deadline, and writes SETTLED_VENDOR.
    await claimTimeoutSettlement({
      wallet, node, from: vendor, fee: { paymentMethod },
      marketplaceAddress: fast.marketplaceAddress,
      accessSecret: fast.accessSecret, orderId: placed.orderId,
    });
    expect(await privateBalance(vendor)).toBe(vendorBefore);

    // Step 2: the escrow follows that state. Sent from the BUYER's account on
    // purpose -- `claim` is permissionless, since every destination is a bound
    // term, which is what lets a fee-juice-less vendor account be settled for
    // by whoever can pay.
    await claimOrderEscrow(escrowSession(placed, buyer));
    // The vendor is paid AND keeps the buyer's forfeited collateral; the
    // buyer left no feedback, so the listing has none.
    expect((await privateBalance(vendor)) - vendorBefore).toBe(AMOUNT - FEE + COLLATERAL);
    const fb = await listListingFeedback({
      wallet, node, from: vendor,
      marketplaceAddress: fast.marketplaceAddress,
      listingId: LISTING_ID, accessSecret: fast.accessSecret,
    });
    expect(fb.entries).toEqual([]);
    expect(fb.invalid).toBe(0);
  }, 600_000);

  it('authenticates the buyer of an accepted order without a ZK proof (AD-6 commit-reveal)', async () => {
    // A real order, accepted by the vendor -- the situation a dispute is
    // opened from.
    const placed = await placeTestOrder('dispute: item never arrived');
    await acceptOrder({ ...session(vendor), orderId: placed.orderId });

    const marketplace = await MarketplaceContract.at(marketplaceAddress, wallet);

    // The buyer opens the dispute, publishing a commitment to a secret only
    // they hold. ONLY the buyer can reach dispute_order (it spends their order
    // note), so the commitment is itself proof a genuine buyer disputed.
    const secret = Fr.random();
    const commitment = await deriveDisputeCommitment(secret);
    await markOrderDisputed({
      ...session(buyer),
      orderId: placed.orderId,
      disputeCommitment: commitment,
    });

    // A moderator authenticates the anonymous room participant with ONE hash:
    // the revealed secret must open the on-chain commitment, and the order must
    // be accepted, disputed, and still unsettled. All free reads -- no proof,
    // and the buyer's ADDRESS appears nowhere.
    const onChain = await getDisputeCommitment({
      wallet, node, from: operator, marketplaceAddress, orderId: placed.orderId,
    });
    expect(onChain.equals(commitment)).toBe(true);
    // A wrong secret (an impostor) does not open the commitment.
    expect(onChain.equals(await deriveDisputeCommitment(Fr.random()))).toBe(false);
    expect(
      (await marketplace.methods.is_order_accepted(placed.orderId).simulate({ from: operator }))
        .result,
    ).toBe(true);
    expect(
      (await marketplace.methods.is_order_disputed(placed.orderId).simulate({ from: operator }))
        .result,
    ).toBe(true);
    expect(
      (await marketplace.methods.is_order_settled(placed.orderId).simulate({ from: operator }))
        .result,
    ).toBe(false);

    // A disputed order cannot be quietly finalized AROUND the dispute -- it
    // has to be resolved. This is new: the buyer confirming used to be allowed
    // from any state, which let a dispute be papered over.
    await expect(
      confirmCompletion({
        ...session(buyer),
        accessSecret,
        orderId: placed.orderId,
        rating: 4,
        feedbackText: 'Arrived after all.',
      }),
    ).rejects.toThrow();

    // So the vendor concedes instead, and the buyer pulls the escrow. Leaves
    // the suite's world clean, and shows the resolution a moderator's ruling
    // would reach by the same route.
    await refundOrder({ ...session(vendor), accessSecret, orderId: placed.orderId });
    await claimOrderEscrowRefund({
      ...escrowSession(placed, buyer),
      buyerSecret: placed.buyerSecret,
    });
    expect(await escrowBalance(placed)).toBe(0n);
  }, 600_000);

  it('keeps orders invisible to non-participants', async () => {
    // A fresh account in a fresh PXE (knowing even the market link) sees no
    // orders: notes are encrypted to their owners alone.
    const outsiderWallet = await EmbeddedWallet.create(node, {
      ephemeral: true,
      pxeConfig: { proverEnabled: false },
    });
    const outsider = await outsiderWallet.createSchnorrAccount(
      Fr.random(),
      Fr.random(),
      GrumpkinScalar.random(),
    );
    const orders = await resolveOrders({
      wallet: outsiderWallet,
      node,
      from: outsider.address,
      marketplaceAddress,
      accessSecret,
    });
    expect(orders).toEqual([]);
  }, 600_000);

  // PROOF OF PAYMENT. An order note must not be creatable without the money
  // behind it, and place_order cannot check that by looking: an escrow's
  // address is a hash of its class, keys and INITIALIZER ARGUMENTS, none of
  // which a circuit can compute. So it builds the terms itself and OPENS the
  // address the buyer named. The kernel admits that call only if the address
  // really is the one those terms produce.
  //
  // Here the buyer escrows for ONE unit and orders QUANTITY of them. Every
  // other substitution fails identically -- a friendlier vendor, less
  // collateral, another market's order id are all just different terms, and
  // therefore a different address. This is the live counterpart of the
  // marketplace TXE test of the same name.
  it('rejects an order pointed at an escrow opened for a cheaper price', async () => {
    const marketplace = await MarketplaceContract.at(marketplaceAddress, wallet);
    const marketplaceId = new Fr(
      (await marketplace.methods.get_marketplace_id!().simulate({ from: buyer }))
        .result as bigint,
    );
    const orderNonce = Fr.random();
    const orderId = await deriveOrderId(marketplaceId, LISTING_ID, buyer, orderNonce);
    const buyerAuth = await deriveBuyerAuth(Fr.random());

    // Terms for a single unit rather than QUANTITY of them.
    const cheapTerms = {
      asset: token.address,
      marketplace: marketplaceAddress,
      order_states_slot: orderStatesSlot(),
      order_id: orderId,
      vendor: vendorInbox,
      treasury: operator, // the owner IS the treasury
      amount: PRICE,
      fee: (PRICE * 250n) / 10000n,
      collateral: COLLATERAL,
      buyer_auth: buyerAuth,
    };
    const escrowSecret = Fr.random();
    const cheapEscrow = await registerOrderEscrow(wallet, escrowSecret, cheapTerms);

    await expect(
      marketplace.methods
        .place_order!(
          accessSecret,
          LISTING_ID,
          [PRICE, 0n, 0n, 0n, 0n, 0n, 0n, 0n],
          1,
          [0n, 0n, 0n, 0n],
          1,
          0,
          0,
          QUANTITY,
          vendorInbox,
          orderNonce,
          [0n, 0n, 0n, 0n, 0n, 0n],
          escrowSecret,
          buyerAuth,
          cheapEscrow,
          buyer,
          Fr.random(),
        )
        .send({ from: buyer, fee: { paymentMethod }, wait: TX_WAIT }),
    ).rejects.toThrow(/Initialization hash does not match/i);

    // And nothing was written: the vendor's inbox is untouched by the attempt.
    const vendorOrders = await resolveOrders({ ...session(vendor), accessSecret });
    expect(vendorOrders.some(o => o.orderId.equals(orderId))).toBe(false);
  }, 600_000);

  it('blocks the timeout claim while disputed and lets the vendor refund in full', async () => {
    // A market with a 3-second timeout, so the (blocked) claim can be
    // attempted in real time.
    const metadata = sampleMarketplaceMetadata();
    metadata.onchain.paymentAsset = token.address.toString();
    metadata.onchain.vendorPolicy = VendorPolicy.Open;
    metadata.onchain.finalizationCollateral = COLLATERAL.toString();
    metadata.onchain.orderTimeoutSeconds = 3;
    const fast = await deployMarketplace({
      wallet, node, from: operator,
      superadmin: operator,
      ownerUsername: 'owner',
      fee: { paymentMethod },
      registryAddress, metadata,
      deploymentNonce: Fr.random().toBigInt(),
    });
    const fastVendor = {
      wallet, node, from: vendor, fee: { paymentMethod },
      marketplaceAddress: fast.marketplaceAddress,
    };
    await registerUser({ ...fastVendor, accessSecret: fast.accessSecret, username: 'refundco' });
    await registerVendor(fastVendor);
    await createListing({
      ...io, ...fastVendor,
      listing: { ...sampleListingDocument(), options: [{ label: '', price: PRICE.toString() }], shipping: [{ label: 'Standard', price: '0' }] },
      accessSecret: fast.accessSecret,
    });

    // The earlier tests spend most of the buyer's initial mint; this test
    // funds its own escrow so it is order-independent.
    await token.methods
      .mint_to_private!(buyer, ESCROW)
      .send({ from: operator, fee: { paymentMethod }, wait: TX_WAIT });

    const placed = await placeOrder({
      wallet, node, from: buyer, fee: { paymentMethod },
      marketplaceAddress: fast.marketplaceAddress,
      accessSecret: fast.accessSecret,
      listingId: LISTING_ID, listing: testListing(), quantity: QUANTITY, vendorInbox,
      deliveryMemo: 'wrong item received',
      createEscrowTransferInteraction: transferIntoEscrow,
    });
    await acceptOrder({
      wallet, node, from: vendor, fee: { paymentMethod },
      marketplaceAddress: fast.marketplaceAddress, orderId: placed.orderId,
    });

    // The buyer disputes: the anonymous public flag flips on.
    await markOrderDisputed({
      wallet, node, from: buyer, fee: { paymentMethod },
      marketplaceAddress: fast.marketplaceAddress, orderId: placed.orderId,
      disputeCommitment: await deriveDisputeCommitment(Fr.random()),
    });

    // Even after the deadline passes (mine a block past it), the vendor's
    // timeout claim REVERTS: a disputed order cannot be taken by waiting.
    await new Promise(resolve => setTimeout(resolve, 5000));
    await token.methods
      .mint_to_private!(buyer, 1n)
      .send({ from: operator, fee: { paymentMethod }, wait: TX_WAIT });
    await expect(
      claimTimeoutSettlement({
        wallet, node, from: vendor, fee: { paymentMethod },
        marketplaceAddress: fast.marketplaceAddress,
        accessSecret: fast.accessSecret, orderId: placed.orderId,
      }),
    ).rejects.toThrow(/disputed/);
    // SETTLED_VENDOR was therefore never written, so the escrow refuses too --
    // the dispute block holds all the way down to the money.
    await expect(claimOrderEscrow(escrowSession(placed, vendor))).rejects.toThrow();

    // The vendor OFFERS a refund (pull, not push -- it never learns the
    // buyer's address). The offer moves no funds; it flips the order to
    // REFUND_BUYER.
    await refundOrder({
      wallet, node, from: vendor, fee: { paymentMethod },
      marketplaceAddress: fast.marketplaceAddress,
      accessSecret: fast.accessSecret, orderId: placed.orderId,
    });
    const offered = (await resolveOrders({
      wallet, node, from: buyer,
      marketplaceAddress: fast.marketplaceAddress, accessSecret: fast.accessSecret,
    })).find(v => v.orderId.equals(placed.orderId))!;
    expect(offered.disputeOutcome).toBe(DisputeOutcome.RefundBuyer);
    expect(offered.statuses).toContain(OrderStatus.Refunded);
    // REFUND_BUYER is authorized-but-uncollected, and the marketplace cannot
    // see an escrow call, so `settled` stays false on this path -- the escrow's
    // own balance is what says whether the buyer has taken the money.
    expect(offered.settled).toBe(false);
    expect(await escrowBalance(placed)).toBe(ESCROW);

    // The buyer pulls straight from the escrow: EVERYTHING back (amount plus
    // the finalization collateral), to themselves, with no vendor cooperation
    // and no second marketplace call -- REFUND_BUYER is already terminal.
    const buyerBefore = await privateBalance(buyer);
    await claimOrderEscrowRefund({
      ...escrowSession(placed, buyer),
      buyerSecret: placed.buyerSecret,
    });
    expect((await privateBalance(buyer)) - buyerBefore).toBe(ESCROW);
    expect(await escrowBalance(placed)).toBe(0n);
    const view = (await resolveOrders({
      wallet, node, from: buyer,
      marketplaceAddress: fast.marketplaceAddress, accessSecret: fast.accessSecret,
    })).find(v => v.orderId.equals(placed.orderId))!;
    expect(view.disputed).toBe(true);
    expect(view.statuses).toContain(OrderStatus.Refunded);

    // Terminal: the escrow is empty, so a second pull has nothing to take.
    await expect(
      claimOrderEscrowRefund({
        ...escrowSession(placed, buyer),
        buyerSecret: placed.buyerSecret,
      }),
    ).rejects.toThrow();
  }, 600_000);

  it('arbitration: buyer claims a ruled refund; a pay-vendor ruling settles with no wait', async () => {
    // Long timeout on purpose: the PAY_VENDOR settlement below must succeed
    // WITHOUT the deadline ever passing (the ruling waives it).
    const metadata = sampleMarketplaceMetadata();
    metadata.onchain.paymentAsset = token.address.toString();
    metadata.onchain.vendorPolicy = VendorPolicy.Open;
    metadata.onchain.finalizationCollateral = COLLATERAL.toString();
    metadata.onchain.orderTimeoutSeconds = 3600;
    const arb = await deployMarketplace({
      wallet, node, from: operator,
      superadmin: operator, // the operator rules (superadmin has PERM_ALL)
      ownerUsername: 'owner',
      fee: { paymentMethod },
      registryAddress, metadata,
      deploymentNonce: Fr.random().toBigInt(),
    });
    const arbVendor = {
      wallet, node, from: vendor, fee: { paymentMethod },
      marketplaceAddress: arb.marketplaceAddress,
    };
    await registerUser({ ...arbVendor, accessSecret: arb.accessSecret, username: 'arbco' });
    await registerVendor(arbVendor);
    await createListing({
      ...io, ...arbVendor,
      listing: { ...sampleListingDocument(), options: [{ label: '', price: PRICE.toString() }], shipping: [{ label: 'Standard', price: '0' }] },
      accessSecret: arb.accessSecret,
    });
    await token.methods
      .mint_to_private!(buyer, ESCROW * 2n)
      .send({ from: operator, fee: { paymentMethod }, wait: TX_WAIT });

    const order = (memo: string) =>
      placeOrder({
        wallet, node, from: buyer, fee: { paymentMethod },
        marketplaceAddress: arb.marketplaceAddress,
        accessSecret: arb.accessSecret,
        listingId: LISTING_ID, listing: testListing(), quantity: QUANTITY, vendorInbox,
        deliveryMemo: memo,
        createEscrowTransferInteraction: transferIntoEscrow,
      });

    // --- Ruling 1: REFUND_BUYER; the buyer executes it themselves. ---
    const first = await order('never arrived');
    await acceptOrder({ ...arbVendor, orderId: first.orderId });
    await markOrderDisputed({
      wallet, node, from: buyer, fee: { paymentMethod },
      marketplaceAddress: arb.marketplaceAddress, orderId: first.orderId,
      disputeCommitment: await deriveDisputeCommitment(Fr.random()),
    });
    await resolveDispute({
      wallet, node, from: operator, fee: { paymentMethod },
      marketplaceAddress: arb.marketplaceAddress,
      orderId: first.orderId, outcome: DisputeOutcome.RefundBuyer,
    });
    const buyerBefore = await privateBalance(buyer);
    // The ruling is already terminal, so the buyer goes straight to the escrow.
    await claimOrderEscrowRefund({
      ...escrowSession(first, buyer),
      buyerSecret: first.buyerSecret,
    });
    expect((await privateBalance(buyer)) - buyerBefore).toBe(ESCROW);

    // --- Ruling 2: PAY_VENDOR; the vendor settles IMMEDIATELY (the 1-hour
    // deadline has not remotely passed -- the ruling waives it). ---
    const second = await order('buyer changed their mind, goods delivered');
    await acceptOrder({ ...arbVendor, orderId: second.orderId });
    await markOrderDisputed({
      wallet, node, from: buyer, fee: { paymentMethod },
      marketplaceAddress: arb.marketplaceAddress, orderId: second.orderId,
      disputeCommitment: await deriveDisputeCommitment(Fr.random()),
    });
    // Un-ruled, the claim is blocked by the dispute.
    await expect(
      claimTimeoutSettlement({
        ...arbVendor, accessSecret: arb.accessSecret, orderId: second.orderId,
      }),
    ).rejects.toThrow();
    await resolveDispute({
      wallet, node, from: operator, fee: { paymentMethod },
      marketplaceAddress: arb.marketplaceAddress,
      orderId: second.orderId, outcome: DisputeOutcome.PayVendor,
    });
    const vendorBefore = await privateBalance(vendor);
    await claimTimeoutSettlement({
      ...arbVendor, accessSecret: arb.accessSecret, orderId: second.orderId,
    });
    await claimOrderEscrow(escrowSession(second, vendor));
    // Timeout-claim semantics: vendor is paid AND keeps the collateral.
    expect((await privateBalance(vendor)) - vendorBefore).toBe(AMOUNT - FEE + COLLATERAL);
  }, 600_000);
});
