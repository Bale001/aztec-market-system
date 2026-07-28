// Throwaway probe: exercises the desktop spend gate's exact mechanics against
// the real wallet stack + local network. Mirrors apps/desktop/src/spend.tsx:
// patch the DEEPEST sendTx owner, discriminate by payload.feePayer, read the
// exact fee via opts.fee.gasSettings.getFeeLimit().
//
// Run 1: the sponsored FPC is registered as the "user fee payer" -> the
//        account deploy MUST prompt exactly once with a nonzero fee.
// Run 2: user fee payer set to a different address -> MUST NOT prompt.
import { NO_FROM } from '@aztec/aztec.js/account';
import { getContractInstanceFromInstantiationParams } from '@aztec/aztec.js/contracts';
import { SponsoredFeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import { SPONSORED_FPC_SALT } from '@aztec/constants';
import { GrumpkinScalar } from '@aztec/foundation/curves/grumpkin';
import { SponsoredFPCContractArtifact } from '@aztec/noir-contracts.js/SponsoredFPC';
import { EmbeddedWallet } from '@aztec/wallets/embedded';

// --- the gate, exactly as in spend.tsx (minus React) ---
let userFeePayer = null;
const prompts = [];
let owner = null;
for (let proto = EmbeddedWallet.prototype; proto !== null; proto = Object.getPrototypeOf(proto)) {
  if (Object.prototype.hasOwnProperty.call(proto, 'sendTx')) owner = proto;
}
if (owner === null) throw new Error('FAIL: no sendTx owner found');
console.log('patched deepest sendTx owner:', owner.constructor?.name);
const original = owner.sendTx;
owner.sendTx = async function (...args) {
  const feePayer = args[0]?.feePayer?.toString();
  if (userFeePayer !== null && feePayer === userFeePayer) {
    const gs = args[1]?.fee?.gasSettings;
    if (typeof gs?.getFeeLimit !== 'function') {
      throw new Error('FAIL: FPC-paid tx reached sendTx without final gas settings');
    }
    prompts.push(gs.getFeeLimit().toBigInt());
  }
  return original.apply(this, args);
};
// --- end gate ---

const node = createAztecNodeClient(process.env.AZTEC_NODE_URL ?? 'http://localhost:8080');
const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxeConfig: { proverEnabled: false } });
const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContractArtifact, {
  salt: new Fr(SPONSORED_FPC_SALT),
});
await wallet.registerContract(fpc, SponsoredFPCContractArtifact);
const paymentMethod = new SponsoredFeePaymentMethod(fpc.address);

async function deployThrowaway() {
  const account = await wallet.createSchnorrAccount(Fr.random(), Fr.random(), GrumpkinScalar.random());
  const deploy = await account.getDeployMethod();
  await deploy.send({ from: NO_FROM, fee: { paymentMethod }, wait: { timeout: 300 } });
}

// Run 1: sponsored FPC treated as the user's payer -> must prompt with the fee.
userFeePayer = fpc.address.toString();
await deployThrowaway();
if (prompts.length !== 1) throw new Error(`FAIL: expected exactly 1 prompt, got ${prompts.length}`);
if (prompts[0] <= 0n) throw new Error('FAIL: prompted fee is not positive');
console.log(`run 1 OK: exactly one prompt, exact fee = ${prompts[0]} (base units of fee juice)`);

// Run 2: a different payer address -> the same tx type must NOT prompt.
prompts.length = 0;
userFeePayer = '0x' + '11'.repeat(32);
await deployThrowaway();
if (prompts.length !== 0) throw new Error(`FAIL: expected no prompt, got ${prompts.length}`);
console.log('run 2 OK: non-user fee payer passed silently');

console.log('SPEND-GATE-CHECK-OK');
process.exit(0);
