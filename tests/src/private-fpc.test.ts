// Phase 3 integration: the shared PrivateFPC private-fee mechanism, end to end
// against a local Aztec network.
//
// Verifies the whole self-funded private-fee path:
//   - registerPrivateFpc registers the shared FPC with NO deploy tx
//   - fundFpcCredit bridges fee juice from L1 with a claimer-bound secret,
//     claims it, and proves the claim in-circuit via `mint`, crediting the
//     caller's PRIVATE fee-juice balance inside the FPC
//   - a real transaction then pays its fee via FPCFeePaymentMethod: the tx
//     succeeds, the FPC is the on-chain fee payer, and the caller's private
//     credit drops by the gas spent (proof the FPC actually paid).
//
// The bootstrap (account deploys + the claim/mint funding txs) is paid by the
// sponsored FPC -- dev-only; on a public network the first funding tx would
// use mint_and_pay_fee to pay for itself out of the bridged juice.

import { NO_FROM } from '@aztec/aztec.js/account';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { EmbeddedWallet } from '@aztec/wallets/embedded';

import { FPCFeePaymentMethod, fpcCreditOf, registerPrivateFpc } from '@market/deployment';
import { fundFpcCredit } from '@market/deployment/fpc-funding';
import { deriveMarketAccountKeys } from '@market/identity';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080';
const TX_WAIT = { timeout: 300 };

let node: AztecNode;
let wallet: EmbeddedWallet;
let sponsored: SponsoredFeePaymentMethod;
let claimer: AztecAddress;
let fpcAddress: AztecAddress;

async function newAccount(): Promise<AztecAddress> {
  const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  const deploy = await account.getDeployMethod();
  await deploy.send({ from: NO_FROM, fee: { paymentMethod: sponsored }, wait: TX_WAIT });
  return account.address;
}

// Force the idle local network to build a block (needed so the L1->L2 bridge
// message lands in the message tree).
async function produceL2Block(): Promise<void> {
  await newAccount();
}

// Bridge -> claim -> mint FPC credit for `account`, paid via the sponsored FPC.
function fundFpcCreditFor(account: AztecAddress, salt: Fr) {
  return fundFpcCredit({
    wallet,
    node,
    fpcAddress,
    claimer: account,
    salt,
    produceL2Block,
    fee: { paymentMethod: sponsored },
    txTimeoutSeconds: 300,
  });
}

beforeAll(async () => {
  node = createAztecNodeClient(NODE_URL);
  wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: false },
  });
  const sponsoredFPC = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  sponsored = new SponsoredFeePaymentMethod(sponsoredFPC.address);

  claimer = await newAccount();

  // Register the shared PrivateFPC (no deploy tx) at a fixed salt.
  const fpc = await registerPrivateFpc(wallet, new Fr(0xf9c_0001n));
  fpcAddress = fpc.address;
}, 300_000);

test('funds a private fee-juice credit and pays a real tx from it', async () => {
  // The FPC starts with no credit for this claimer.
  expect(await fpcCreditOf({ wallet, fpcAddress, account: claimer })).toBe(0n);

  // Bridge -> claim -> mint: credit the claimer's private balance in the FPC.
  const { credited } = await fundFpcCredit({
    wallet,
    node,
    fpcAddress,
    claimer,
    salt: new Fr(0xf9c_0002n),
    produceL2Block,
    fee: { paymentMethod: sponsored },
    txTimeoutSeconds: 300,
  });
  expect(credited).toBeGreaterThan(0n);

  const creditAfterMint = await fpcCreditOf({ wallet, fpcAddress, account: claimer });
  expect(creditAfterMint).toBe(credited);

  // Now pay a REAL transaction's fee via the FPC (no sponsored FPC involved).
  const fpcPayment = new FPCFeePaymentMethod(fpcAddress);
  const { contract: token } = await TokenContract.deploy(
    wallet,
    claimer,
    'FpcPaidToken',
    'FPT',
    18,
  ).send({ from: claimer, fee: { paymentMethod: fpcPayment }, wait: TX_WAIT });
  expect(token.address).toBeDefined();

  // The FPC paid: the claimer's private credit dropped by the gas spent.
  const creditAfterPay = await fpcCreditOf({ wallet, fpcAddress, account: claimer });
  expect(creditAfterPay).toBeLessThan(creditAfterMint);
  expect(creditAfterPay).toBeGreaterThan(0n);
}, 600_000);

// The account-model design question (task a): can a user's L1-facing account
// pay for a FRESH per-market account's transactions without linking them, via
// the DELEGATED payer path (the chosen model). See the delegated-payer test
// below.

// The account-model design, second form (the one the user chose): the DELEGATED
// payer. Instead of pre-funding P with its own credit, P pays a tx's fee
// directly out of U's ONE shared-FPC credit balance, authorized per-tx by an
// authwit from U (authorize_once). No per-account credit, no transfer -- P
// holds zero credit throughout. The FPC stays the public fee payer; U's credit
// is debited privately; nothing public links P to U or to L1.
// NOTE: the delegated-payer test that lived here was removed when the FPC moved
// to Wonderland's STANDARD PrivateFPC, which has no `pay_fee_from`. Per-market
// accounts now pay via the sponsored FPC (see session.ts).

// Account-model primitives composed: a per-market account is DERIVED from a
// universal seed (HD) and created as an INITIALIZERLESS account, so it transacts
// from a fresh address with NO deploy tx. This is the shape every per-market
// account (vendor/mod/owner) takes.
test('an HD-derived initializerless per-market account transacts with no deploy', async () => {
  // Derive a per-market account from a universal SEED + a market address, and
  // create it as an initializerless account (usable with no deployment).
  const seed = Fr.random();
  const marketAddress = Fr.random(); // stand-in for a market contract address
  const keys = await deriveMarketAccountKeys(seed, marketAddress, 0);
  const perMarketMgr = await wallet.createSchnorrInitializerlessAccount(
    keys.secret,
    keys.salt,
    keys.signingKey,
  );
  const perMarket = perMarketMgr.address;
  expect(await fpcCreditOf({ wallet, fpcAddress, account: perMarket })).toBe(0n);

  // Recoverability: re-deriving from the same seed reproduces the SAME address.
  const keys2 = await deriveMarketAccountKeys(seed, marketAddress, 0);
  const perMarketMgr2 = await wallet.createSchnorrInitializerlessAccount(
    keys2.secret,
    keys2.salt,
    keys2.signingKey,
  );
  expect(perMarketMgr2.address.equals(perMarket)).toBe(true);

  // The per-market account sends a REAL tx. It is NEVER deployed (no
  // getDeployMethod/send is ever called for it); the tx succeeds purely because
  // an initializerless account can transact from a fresh address. Its fee is
  // paid by the sponsored FPC, the per-market gas path.
  const { contract: token } = await TokenContract.deploy(
    wallet,
    perMarket,
    'HDToken',
    'HDT',
    18,
  ).send({
    from: perMarket,
    fee: { paymentMethod: sponsored },
    wait: TX_WAIT,
  });
  expect(token.address).toBeDefined();

  // It never bridged and holds no credit of its own.
  expect(await fpcCreditOf({ wallet, fpcAddress, account: perMarket })).toBe(0n);
}, 900_000);
