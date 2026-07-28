// Measures how long it takes to PROVE one real marketplace transaction, with a
// selectable Barretenberg backend.
//
//   node bench-prover.mjs Wasm
//   node bench-prover.mjs NativeUnixSocket
//
// ONE BACKEND PER PROCESS: bb.js proving goes through Barretenberg.initSingleton,
// so a process is pinned to whichever backend it initialises first. Run this
// once per backend and compare, never both in one process.
//
// The transaction measured is placeOrder, which is the right thing to measure
// rather than a toy circuit: it is the heaviest thing a buyer does (a batch of
// escrow-open + token transfer + place_order, so several kernel iterations) and
// it is on the critical path of the app's main flow.
//
// Setup runs on a SEPARATE non-proving wallet, so the number reported covers the
// measured transaction only. The buyer's own account deployment is proved (it
// has to be, it is in the proving wallet) but is deliberately untimed.
//
// Requires a local Aztec network on :8080.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { NO_FROM } from '@aztec/aztec.js/account';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Contract, getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { loadContractArtifact } from '@aztec/stdlib/abi';
import { EmbeddedWallet } from '@aztec/wallets/embedded';

import { MarketplaceRegistryContract } from '@market/contract-bindings';
import {
  createListing,
  deployMarketplace,
  placeOrder,
  registerUser,
  registerVendor,
} from '@market/deployment';
import { sampleListingDocument, sampleMarketplaceMetadata } from '@market/market-metadata';
import { VendorPolicy } from '@market/shared-types';

// Inlined rather than imported from src/arweave-io.ts: this is a plain .mjs so
// it cannot import TypeScript. Listing content is irrelevant to the timing.
function memoryArweaveIO() {
  const store = new Map();
  return {
    uploadPayload: sealed => {
      const id = Buffer.from(Fr.random().toBuffer()).toString('base64url').slice(0, 43);
      store.set(id, sealed);
      return Promise.resolve(id);
    },
    fetchPayload: id => {
      const bytes = store.get(id);
      return bytes === undefined
        ? Promise.reject(new Error(`no blob stored under ${id}`))
        : Promise.resolve(bytes);
    },
  };
}

const BACKEND = process.argv[2];
if (!BACKEND) {
  throw new Error('usage: node bench-prover.mjs <Wasm|WasmWorker|NativeUnixSocket>');
}

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080';
const TX_WAIT = { timeout: 900 };
const PRICE = 1000n;
const QUANTITY = 2;
const LISTING_ID = 1n;

const tokenArtifact = loadContractArtifact(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          '../node_modules/@aztec-foundation/aztec-standards/artifacts/target/token_contract-Token.json',
          import.meta.url,
        ),
      ),
      'utf-8',
    ),
  ),
);

const node = createAztecNodeClient(NODE_URL);
const sponsoredFPC = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
  salt: new Fr(SPONSORED_FPC_SALT),
});

async function makeWallet(proving) {
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: proving },
    // The A/B lever: BBPrivateKernelProverOptions IS bb.js BackendOptions, so
    // the backend passes straight through to Barretenberg.
    ...(proving
      ? {
          pxeOptions: {
            proverOrOptions: {
              backend: BACKEND,
              ...(process.env.BENCH_THREADS ? { threads: Number(process.env.BENCH_THREADS) } : {}),
            },
          },
        }
      : {}),
  });
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  return wallet;
}

async function newAccount(wallet, payment) {
  const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  await (await account.getDeployMethod()).send({
    from: NO_FROM,
    fee: { paymentMethod: payment },
    wait: TX_WAIT,
  });
  return account.address;
}

// ---- setup, unproved and untimed ----------------------------------------
const setupWallet = await makeWallet(false);
const payment = new SponsoredFeePaymentMethod(sponsoredFPC.address);

const operator = await newAccount(setupWallet, payment);
const vendor = await newAccount(setupWallet, payment);

const { contract: token } = await Contract.deploy(
  setupWallet,
  tokenArtifact,
  ['BenchToken000000000000000000000', 'BCH0000000000000000000000000000', 6, operator, AztecAddress.ZERO],
  'constructor_with_minter',
).send({ from: operator, fee: { paymentMethod: payment }, wait: TX_WAIT });

const { contract: registry } = await MarketplaceRegistryContract.deploy(setupWallet).send({
  from: operator,
  fee: { paymentMethod: payment },
  wait: TX_WAIT,
});

const metadata = sampleMarketplaceMetadata();
metadata.onchain.paymentAsset = token.address.toString();
metadata.onchain.vendorPolicy = VendorPolicy.Open;
metadata.onchain.finalizationCollateral = '500';
const market = await deployMarketplace({
  wallet: setupWallet,
  node,
  from: operator,
  superadmin: operator,
  ownerUsername: 'owner',
  fee: { paymentMethod: payment },
  registryAddress: registry.address,
  metadata,
  deploymentNonce: Fr.random().toBigInt(),
});

const vendorSession = {
  wallet: setupWallet,
  node,
  from: vendor,
  fee: { paymentMethod: payment },
  marketplaceAddress: market.marketplaceAddress,
};
await registerUser({ ...vendorSession, accessSecret: market.accessSecret, username: 'benchco' });
await registerVendor(vendorSession);
await createListing({
  ...memoryArweaveIO(),
  ...vendorSession,
  listing: { ...sampleListingDocument(), price: PRICE.toString() },
  accessSecret: market.accessSecret,
});

// ---- the proving wallet --------------------------------------------------
const buyerWallet = await makeWallet(true);
console.log(`[${BACKEND}] deploying the buyer account (proved, untimed)...`);
const accountTimer = Date.now();
const buyer = await newAccount(buyerWallet, payment);
console.log(`[${BACKEND}] account deploy: ${((Date.now() - accountTimer) / 1000).toFixed(1)}s`);

await token.methods
  .mint_to_private(buyer, 100_000n)
  .send({ from: operator, fee: { paymentMethod: payment }, wait: TX_WAIT });

await buyerWallet.registerContract(await node.getContract(token.address), tokenArtifact);
const buyerToken = await Contract.at(token.address, tokenArtifact, buyerWallet);

// ---- the measurement -----------------------------------------------------
const runs = Number(process.env.BENCH_RUNS ?? 2);
const times = [];
for (let i = 0; i < runs; i++) {
  const t = Date.now();
  await placeOrder({
    wallet: buyerWallet,
    node,
    from: buyer,
    fee: { paymentMethod: payment },
    marketplaceAddress: market.marketplaceAddress,
    accessSecret: market.accessSecret,
    listingId: LISTING_ID,
    price: PRICE,
    quantity: QUANTITY,
    vendorInbox: vendor,
    deliveryMemo: `bench ${i}`,
    createEscrowTransferInteraction: (from, to, amount, nonce) =>
      Promise.resolve(buyerToken.methods.transfer_private_to_private(from, to, amount, nonce)),
    txTimeoutSeconds: 900,
  });
  const secs = (Date.now() - t) / 1000;
  times.push(secs);
  console.log(`[${BACKEND}] placeOrder run ${i + 1}: ${secs.toFixed(1)}s`);
}

const best = Math.min(...times);
console.log(`\n[${BACKEND}] RESULT  best=${best.toFixed(1)}s  all=[${times.map(t => t.toFixed(1)).join(', ')}]`);
await buyerWallet.stop();
await setupWallet.stop();
process.exit(0);
