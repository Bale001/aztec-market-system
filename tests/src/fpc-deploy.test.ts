// Phase 4 integration: deploying a marketplace with fees paid by the shared
// PrivateFPC, mirroring what the desktop app's Create flow now does.
//
// Proves the riskiest Phase 4 change end to end: an account funds its private
// fee-juice credit in the shared FPC, then deploys the registry AND a full
// marketplace paying every fee via FPCFeePaymentMethod (no sponsored FPC on the
// real deploys). The sponsored FPC is used ONLY to bootstrap -- deploy the
// account and fund the credit -- exactly as session.ts does.

import { NO_FROM } from '@aztec/aztec.js/account';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient, type AztecNode } from '@aztec/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { EmbeddedWallet } from '@aztec/wallets/embedded';

import { MarketplaceRegistryContract } from '@market/contract-bindings';
import {
  deployMarketplace,
  FPCFeePaymentMethod,
  fpcCreditOf,
  registerPrivateFpc,
} from '@market/deployment';
import { fundFpcCredit } from '@market/deployment/fpc-funding';
import { sampleMarketplaceMetadata } from '@market/market-metadata';
import { VendorPolicy } from '@market/shared-types';

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080';
const TX_WAIT = { timeout: 300 };

let node: AztecNode;
let wallet: EmbeddedWallet;
let sponsored: SponsoredFeePaymentMethod;
let account: AztecAddress;
let fpcAddress: AztecAddress;
let fpcPayment: FPCFeePaymentMethod;

async function newAccount(): Promise<AztecAddress> {
  const acct = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  const deploy = await acct.getDeployMethod();
  await deploy.send({ from: NO_FROM, fee: { paymentMethod: sponsored }, wait: TX_WAIT });
  return acct.address;
}

beforeAll(async () => {
  node = createAztecNodeClient(NODE_URL);
  wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });

  const sponsoredFPC = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
    salt: new Fr(SPONSORED_FPC_SALT),
  });
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  sponsored = new SponsoredFeePaymentMethod(sponsoredFPC.address);

  // The "wallet account" and the shared FPC (as session.ts sets them up).
  account = await newAccount();
  const fpc = await registerPrivateFpc(wallet, new Fr(0xf9c0d1n));
  fpcAddress = fpc.address;
  fpcPayment = new FPCFeePaymentMethod(fpcAddress);

  // Bootstrap: fund the account's private FPC credit (sponsored pays claim/mint).
  await fundFpcCredit({
    wallet,
    node,
    fpcAddress,
    claimer: account,
    salt: new Fr(0xf9c0d2n),
    produceL2Block: async () => {
      await newAccount();
    },
    fee: { paymentMethod: sponsored },
    txTimeoutSeconds: 300,
  });
}, 600_000);

test('deploys a registry and a marketplace paying every fee via the FPC', async () => {
  const creditStart = await fpcCreditOf({ wallet, fpcAddress, account });
  expect(creditStart).toBeGreaterThan(0n);

  // Registry deploy, paid via the FPC.
  const { contract: registry } = await MarketplaceRegistryContract.deploy(wallet).send({
    from: account,
    fee: { paymentMethod: fpcPayment },
    wait: TX_WAIT,
  });

  // Marketplace deploy (+ registry registration), all paid via the FPC.
  const metadata = sampleMarketplaceMetadata();
  metadata.onchain.vendorPolicy = VendorPolicy.Open;
  const deployed = await deployMarketplace({
    wallet,
    node,
    from: account,
    superadmin: account, // account model: the superadmin is an address
    ownerUsername: 'owner',
    fee: { paymentMethod: fpcPayment },
    registryAddress: registry.address,
    metadata,
    deploymentNonce: Fr.random().toBigInt(),
  });
  expect(deployed.marketplaceAddress).toBeDefined();

  // Every deploy fee came out of the FPC credit.
  const creditEnd = await fpcCreditOf({ wallet, fpcAddress, account });
  expect(creditEnd).toBeLessThan(creditStart);
  expect(creditEnd).toBeGreaterThan(0n);
}, 600_000);
