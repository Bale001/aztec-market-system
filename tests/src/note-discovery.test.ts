// Cross-PXE note discovery -- the PRODUCTION topology.
//
// Every other integration test runs all parties inside ONE wallet/PXE, which
// cannot certify note discoverability: a shared PXE holds every local account
// and would find the notes regardless. Here the buyer and the vendor run
// SEPARATE EmbeddedWallets (separate PXE stores), like two real devices:
//
//   - wallet A: the operator (deploys everything) and the buyer
//   - wallet B: the vendor -- which has NEVER seen the buyer's account
//
// The claims certified:
//   1. the vendor's PXE discovers the buyer's OrderNote + memo from a sender
//      it has no knowledge of (constrained delivery is handshake-backed: the
//      recipient finds the onchain handshake knowing only its own address)
//   2. the reverse direction: the buyer's PXE discovers the vendor's status
//      note the same way
//
// Requires a running local network (AZTEC_NODE_URL or localhost:8080).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NO_FROM } from '@aztec/aztec.js/account';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Contract, getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { loadContractArtifact } from '@aztec/stdlib/abi';
import { EmbeddedWallet } from '@aztec/wallets/embedded';

import { MarketplaceRegistryContract } from '@market/contract-bindings';
import {
  acceptOrder,
  createListing,
  deployMarketplace,
  placeOrder,
  registerUser,
  registerVendor,
  resolveOrders,
} from '@market/deployment';
import type { ListingDocument } from '@market/market-metadata';
import { sampleListingDocument, sampleMarketplaceMetadata } from '@market/market-metadata';
import { VendorPolicy } from '@market/shared-types';

import { memoryArweaveIO } from './arweave-io.js';

const io = memoryArweaveIO();

// cUSDC is the aztec-standards Token, and the order escrow calls ITS abi.
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
const PRICE = 700n;
const QUANTITY = 1;
const AMOUNT = PRICE * BigInt(QUANTITY);
const MEMO = 'cross-PXE delivery: 7 Cipher Court';

let node: AztecNode;
let walletA: EmbeddedWallet; // operator + buyer ("buyer device")
let walletB: EmbeddedWallet; // vendor only ("vendor device")
let paymentA: SponsoredFeePaymentMethod;
let paymentB: SponsoredFeePaymentMethod;
let operator: AztecAddress;
let buyer: AztecAddress;
let vendor: AztecAddress;
let token: Contract;
let marketplaceAddress: AztecAddress;
let accessSecret: Fr;
let placedOrderId: Fr;

async function newWallet(): Promise<{ wallet: EmbeddedWallet; payment: SponsoredFeePaymentMethod }> {
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: false },
  });
  const sponsoredFPC = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  return { wallet, payment: new SponsoredFeePaymentMethod(sponsoredFPC.address) };
}

async function newAccount(wallet: EmbeddedWallet, payment: SponsoredFeePaymentMethod): Promise<AztecAddress> {
  const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  const deploy = await account.getDeployMethod();
  await deploy.send({ from: NO_FROM, fee: { paymentMethod: payment }, wait: TX_WAIT });
  return account.address;
}

const sessionA = (from: AztecAddress) => ({
  wallet: walletA, node, from, marketplaceAddress, fee: { paymentMethod: paymentA },
});
const sessionB = (from: AztecAddress) => ({
  wallet: walletB, node, from, marketplaceAddress, fee: { paymentMethod: paymentB },
});

beforeAll(async () => {
  node = createAztecNodeClient(NODE_URL);
  ({ wallet: walletA, payment: paymentA } = await newWallet());
  ({ wallet: walletB, payment: paymentB } = await newWallet());

  operator = await newAccount(walletA, paymentA);
  buyer = await newAccount(walletA, paymentA);
  vendor = await newAccount(walletB, paymentB);

  // Token + buyer funds live on the buyer device; the vendor device never
  // learns the buyer's address before the order arrives.
  const { contract } = await Contract.deploy(
    walletA,
    tokenArtifact,
    [
      'MarketToken00000000000000000000',
      'MKT0000000000000000000000000000',
      6,
      operator,
      AztecAddress.ZERO,
    ],
    'constructor_with_minter',
  ).send({ from: operator, fee: { paymentMethod: paymentA }, wait: TX_WAIT });
  token = contract;
  await token.methods
    .mint_to_private!(buyer, 10_000n)
    .send({ from: operator, fee: { paymentMethod: paymentA }, wait: TX_WAIT });

  const { contract: registry } = await MarketplaceRegistryContract.deploy(walletA).send({
    from: operator,
    fee: { paymentMethod: paymentA },
    wait: TX_WAIT,
  });
  const metadata = sampleMarketplaceMetadata();
  metadata.onchain.paymentAsset = token.address.toString();
  metadata.onchain.vendorPolicy = VendorPolicy.Open;
  metadata.onchain.finalizationCollateral = '0';
  const deployed = await deployMarketplace({
    wallet: walletA,
    node,
    from: operator,
    superadmin: operator,
    ownerUsername: 'owner',
    fee: { paymentMethod: paymentA },
    registryAddress: registry.address,
    metadata,
    deploymentNonce: Fr.random().toBigInt(),
  });
  marketplaceAddress = deployed.marketplaceAddress;
  accessSecret = deployed.accessSecret;

  // The vendor onboards entirely from its own device (wallet B).
  await registerUser({ ...sessionB(vendor), accessSecret, username: 'crosspxe' });
  await registerVendor({ ...sessionB(vendor) });
  await createListing({
    ...io,
    ...sessionB(vendor),
    listing: { ...sampleListingDocument(), options: [{ label: '', price: PRICE.toString() }], shipping: [{ label: 'Standard', price: '0' }] },
    accessSecret,
  });
}, 900_000);

afterAll(async () => {
  await walletA?.stop();
  await walletB?.stop();
});

describe('cross-PXE note discovery (production topology)', () => {
  it("vendor's separate PXE discovers the order from a never-seen buyer", async () => {
    const placed = await placeOrder({
      ...sessionA(buyer),
      accessSecret,
      listingId: 1n,
      listing: testListing(),
      quantity: QUANTITY,
      vendorInbox: vendor,
      deliveryMemo: MEMO,
      createEscrowTransferInteraction: (from, to, amount, nonce) =>
        Promise.resolve(token.methods.transfer_private_to_private!(from, to, amount, nonce)),
    });
    placedOrderId = placed.orderId;

    // Wallet B has never seen the buyer's account, registered no senders, and
    // shares no state with wallet A: the OrderNote + memo must be found via
    // the onchain handshake registry + tagged logs alone.
    const vendorOrders = await resolveOrders({ ...sessionB(vendor), accessSecret });
    expect(vendorOrders).toHaveLength(1);
    const order = vendorOrders[0]!;
    expect(order.orderId.equals(placed.orderId)).toBe(true);
    expect(order.amount).toBe(AMOUNT);
    expect(order.deliveryMemo).toBe(MEMO);
    // Option A: the vendor's note carries the vendor inbox but NO buyer address.
    expect(order.vendorInbox.equals(vendor)).toBe(true);
  }, 600_000);

  it("buyer's separate PXE discovers the vendor's acceptance the same way", async () => {
    await acceptOrder({ ...sessionB(vendor), orderId: placedOrderId });

    const buyerOrders = await resolveOrders({ ...sessionA(buyer), accessSecret });
    expect(buyerOrders).toHaveLength(1);
    const order = buyerOrders[0]!;
    expect(order.orderId.equals(placedOrderId)).toBe(true);
    expect(order.accepted).toBe(true);
  }, 600_000);
});
