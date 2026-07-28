// Estimates what our transactions would cost on real Aztec networks.
//
// A transaction's BILLED GAS (DA + L2 mana) is protocol-determined and network-
// independent; only the PRICE per gas differs between networks. So: simulate
// representative txs against the local network to measure their billed gas,
// then price that gas at each network's current min fees, queried live:
//   - local     (whatever node URL is passed / localhost:8080)
//   - testnet   v5.0.0   https://v5.testnet.rpc.aztec-labs.com
//   - mainnet   (Alpha)  https://aztec-mainnet.drpc.org  (runs 4.3.x; the RPC
//                        may reject a v5 client -- reported, not fatal)
//
// Notes on accuracy:
//   - min fees move with L1 prices/congestion; this is a snapshot.
//   - the simulated payloads exclude the FPC's pay_fee() call (a small,
//     constant private-call overhead), so figures are slight underestimates.
//   - our PrivateFPC debits ~1.862x the actual fee (no-refund worst-case,
//     measured); the last column shows that debit.
//
// Usage: node scripts/estimate-fees.mjs [local-node-url]

import { NO_FROM } from '@aztec/aztec.js/account';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { TokenContract } from '@aztec/noir-contracts.js/Token';
import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { MarketplaceRegistryContract } from '@market/contract-bindings';

const LOCAL_URL = process.argv[2] ?? 'http://localhost:8080';
const NETWORKS = [
  { name: 'local', url: LOCAL_URL },
  { name: 'testnet (v5)', url: 'https://v5.testnet.rpc.aztec-labs.com' },
  { name: 'mainnet (Alpha)', url: 'https://aztec-mainnet.drpc.org' },
];

// Measured on the local network (see fee diagnostics 2026-07-13): the full
// marketplace deploy (class publication + instance + registry registration)
// costs ~2.48x a Token deploy. Used to extrapolate the marketplace row.
const MARKETPLACE_OVER_TOKEN = 2.48;
// Measured PrivateFPC debit vs actual fee (no-refund worst case).
const FPC_DEBIT_RATIO = 1.862;

const UNIT = 10n ** 18n;
function fj(amount) {
  const whole = amount / UNIT;
  const frac = amount % UNIT;
  if (frac === 0n) return `${whole} FJ`;
  const fracTrim = frac.toString().padStart(18, '0').replace(/0+$/, '');
  const shown = fracTrim.length > 9 ? fracTrim.slice(0, 9) + '…' : fracTrim;
  return `${whole}.${shown} FJ`;
}

async function main() {
  console.log(`measuring billed gas against ${LOCAL_URL} ...`);
  const node = createAztecNodeClient(LOCAL_URL);
  const wallet = await EmbeddedWallet.create(node, {
    ephemeral: true,
    pxeConfig: { proverEnabled: false },
  });
  const sponsoredFPC = await getContractInstanceFromInstantiationParams(
    SponsoredFPCContractArtifact,
    { salt: new Fr(SPONSORED_FPC_SALT) },
  );
  await wallet.registerContract(sponsoredFPC, SponsoredFPCContractArtifact);
  const sponsored = new SponsoredFeePaymentMethod(sponsoredFPC.address);

  const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  const accountDeploy = await account.getDeployMethod();
  await accountDeploy.send({
    from: NO_FROM,
    fee: { paymentMethod: sponsored },
    wait: { timeout: 300 },
  });
  const from = account.address;

  // A real token deployed + minted (cheaply, sponsored) so simulated calls
  // have a balance to spend.
  const { contract: token } = await TokenContract.deploy(wallet, from, 'Probe', 'PRB', 18).send({
    from,
    fee: { paymentMethod: sponsored },
    wait: { timeout: 300 },
  });
  await token.methods.mint_to_private(from, 10n ** 18n).send({
    from,
    fee: { paymentMethod: sponsored },
    wait: { timeout: 300 },
  });

  // Gas probes: simulate, take billedGas (what the fee is computed from).
  async function billedGas(payload) {
    const sim = await wallet.simulateTx(payload, {
      from,
      skipTxValidation: true,
      skipFeeEnforcement: true,
    });
    return sim.gasUsed.billedGas;
  }

  const probes = [
    { name: 'token transfer (private)', gas: await billedGas(await token.methods.transfer_in_private(from, from, 1n, 0).request()) },
    { name: 'token mint (private)', gas: await billedGas(await token.methods.mint_to_private(from, 1000n).request()) },
    { name: 'registry deploy', gas: await billedGas(await MarketplaceRegistryContract.deploy(wallet, { deployer: from }).request()) },
    { name: 'token deploy (class pub)', gas: await billedGas(await TokenContract.deploy(wallet, from, 'P2', 'P2', 18, { deployer: from }).request()) },
  ];
  const tokenDeployGas = probes[probes.length - 1].gas;
  probes.push({
    name: `marketplace deploy (extrapolated x${MARKETPLACE_OVER_TOKEN})`,
    gas: {
      daGas: BigInt(Math.round(Number(tokenDeployGas.daGas) * MARKETPLACE_OVER_TOKEN)),
      l2Gas: BigInt(Math.round(Number(tokenDeployGas.l2Gas) * MARKETPLACE_OVER_TOKEN)),
    },
  });

  console.log('\nbilled gas (network-independent):');
  for (const p of probes) {
    console.log(`  ${p.name}: da=${p.gas.daGas} l2=${p.gas.l2Gas}`);
  }

  for (const net of NETWORKS) {
    let fees;
    try {
      fees = await createAztecNodeClient(net.url).getCurrentMinFees();
    } catch (err) {
      console.log(`\n=== ${net.name} (${net.url}) UNAVAILABLE: ${err.message ?? err}`);
      continue;
    }
    console.log(`\n=== ${net.name} — feePerDaGas=${fees.feePerDaGas} feePerL2Gas=${fees.feePerL2Gas}`);
    for (const p of probes) {
      const fee = BigInt(p.gas.daGas) * BigInt(fees.feePerDaGas) + BigInt(p.gas.l2Gas) * BigInt(fees.feePerL2Gas);
      const debit = (fee * 1862n) / 1000n;
      console.log(`  ${p.name}: fee ${fj(fee)}  | FPC debit ~${fj(debit)}`);
    }
  }
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
