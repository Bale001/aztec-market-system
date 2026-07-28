// PrivateFPC funding -- the L1 bridge half. Bridges fee juice from L1 with a
// claimer-bound secret, claims it, and proves the claim in-circuit via the
// FPC's `mint`, crediting the caller's private fee-juice balance. This pulls in
// viem + the L1 (@aztec/ethereum, @aztec/l1-artifacts) packages, so it is kept
// OUT of the light ./private-fpc module and is meant to be dynamically imported
// (e.g. only when a wallet tops up) so it never lands on the wallet-open bundle.

import { L1FeeJuicePortalManager } from '@aztec/aztec.js/ethereum';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import { isL1ToL2MessageReady } from '@aztec/aztec.js/messaging';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { computeSecretHash } from '@aztec/aztec.js/crypto';
import { createExtendedL1Client } from '@aztec/ethereum/client';
import { extractEvent } from '@aztec/ethereum/utils';
import { createLogger } from '@aztec/foundation/log';
import { FeeJuicePortalAbi } from '@aztec/l1-artifacts/FeeJuicePortalAbi';
import { FeeJuiceContract } from '@aztec/noir-contracts.js/FeeJuice';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';
import { PrivateFPCContract } from '@alejoamiras/aztec-fee-payment';
import { getContract } from 'viem';

import { deriveBridgeSecret, type FpcBridgeClaim } from './private-fpc.js';
import { ensureContractRegistered, type RegistersContracts } from './register.js';

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';
const DEFAULT_L1_RPC = 'http://localhost:8545';

export type { FpcBridgeClaim };

/**
 * Bridges fee juice from L1 to the FPC address using a CLAIMER-BOUND secret, so
 * only `claimer` can later prove the bridge in the FPC's `mint`. Unlike the
 * generic bridge helper (which uses a random secret), this deposits directly on
 * the portal with `secretHash = computeSecretHash(deriveBridgeSecret(salt,
 * claimer))`. Local-network/dev: mints + approves the L1 test token first.
 *
 * `produceL2Block` is called while polling until the L1->L2 message lands in the
 * message tree (an idle local network only builds blocks on demand).
 */
export async function bridgeForFpcMint(options: {
  node: AztecNode;
  fpcAddress: AztecAddress;
  claimer: AztecAddress;
  salt: Fr;
  produceL2Block: () => Promise<void>;
  l1RpcUrl?: string;
  l1Mnemonic?: string;
  messagePollTries?: number;
  /** Delay between L1->L2 message-ready polls. Tiny for a local network that
   * builds blocks on demand; seconds on a public network (Sepolia -> L2 inbox
   * ingestion takes minutes). */
  messagePollIntervalMs?: number;
}): Promise<FpcBridgeClaim> {
  const logger = createLogger('market:fpc-bridge');
  const secret = await deriveBridgeSecret(options.salt, options.claimer);
  const secretHash = await computeSecretHash(secret);

  const l1Client = createExtendedL1Client(
    [options.l1RpcUrl ?? DEFAULT_L1_RPC],
    options.l1Mnemonic ?? ANVIL_MNEMONIC,
  );

  const {
    l1ContractAddresses: { feeJuicePortalAddress, feeJuiceAddress, feeAssetHandlerAddress },
  } = await options.node.getNodeInfo();

  const handlerAddress =
    feeAssetHandlerAddress && !feeAssetHandlerAddress.isZero() ? feeAssetHandlerAddress : undefined;

  // Mint + approve the L1 fee-juice test token, then deposit with our custom
  // (claimer-bound) secret hash.
  const feeJuiceManager = new L1FeeJuicePortalManager(
    feeJuicePortalAddress,
    feeJuiceAddress,
    handlerAddress,
    l1Client,
    logger,
  );
  const tokenManager = feeJuiceManager.getTokenManager();
  const claimAmount = await tokenManager.getMintAmount();
  await tokenManager.mint(l1Client.account.address);
  await tokenManager.approve(claimAmount, feeJuicePortalAddress.toString(), 'FeeJuice Portal');

  const portalContract = getContract({
    address: feeJuicePortalAddress.toString() as `0x${string}`,
    abi: FeeJuicePortalAbi,
    client: l1Client,
  });
  const txHash = await portalContract.write.depositToAztecPublic([
    options.fpcAddress.toString(),
    claimAmount,
    secretHash.toString(),
  ]);
  const txReceipt = await l1Client.waitForTransactionReceipt({ hash: txHash });

  const log = extractEvent(
    txReceipt.logs,
    feeJuicePortalAddress.toString(),
    FeeJuicePortalAbi,
    'DepositToAztecPublic',
    (l) =>
      l.args.amount === claimAmount &&
      l.args.to?.toLowerCase() === options.fpcAddress.toString().toLowerCase(),
    logger,
  );
  const messageHash = Fr.fromString(log.args.key as string);
  const leafIndex = new Fr(log.args.index as bigint);

  const pollTries = options.messagePollTries ?? 400;
  const pollIntervalMs = options.messagePollIntervalMs ?? 10;
  let ready = false;
  for (let i = 0; i < pollTries; i++) {
    ready = await isL1ToL2MessageReady(options.node, messageHash);
    if (ready) break;
    await options.produceL2Block();
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  if (!ready) {
    throw new Error(`L1->L2 message not ingested for FPC deposit: ${messageHash.toString()}`);
  }

  return { secret, claimAmount, leafIndex };
}

/**
 * Funds `claimer`'s private credit inside the FPC end to end: bridge -> claim ->
 * mint. The claim and mint transactions themselves need a fee path (`fee`);
 * on the local network this is the sponsored FPC (dev bootstrap). On a public
 * network a cold-start would instead use `mint_and_pay_fee` so the very first
 * funding tx pays for itself out of the bridged juice.
 *
 * Returns the amount credited (the full bridged amount; `pay_fee` later debits
 * gas from it).
 */
export async function fundFpcCredit(options: {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  fpcAddress: AztecAddress;
  claimer: AztecAddress;
  salt: Fr;
  produceL2Block: () => Promise<void>;
  fee?: { paymentMethod: FeePaymentMethod };
  l1RpcUrl?: string;
  l1Mnemonic?: string;
  messagePollTries?: number;
  messagePollIntervalMs?: number;
  txTimeoutSeconds?: number;
}): Promise<{ credited: bigint }> {
  const { wallet, node, fpcAddress, claimer, salt, fee } = options;
  const wait = { timeout: options.txTimeoutSeconds ?? 180 };

  const { secret, claimAmount, leafIndex } = await bridgeForFpcMint({
    node,
    fpcAddress,
    claimer,
    salt,
    produceL2Block: options.produceL2Block,
    ...(options.l1RpcUrl ? { l1RpcUrl: options.l1RpcUrl } : {}),
    ...(options.l1Mnemonic ? { l1Mnemonic: options.l1Mnemonic } : {}),
    ...(options.messagePollTries ? { messagePollTries: options.messagePollTries } : {}),
    ...(options.messagePollIntervalMs ? { messagePollIntervalMs: options.messagePollIntervalMs } : {}),
  });

  // 1. Claim the bridged juice into the FPC's public fee-juice balance.
  await ensureContractRegistered(
    wallet,
    node,
    ProtocolContractAddress.FeeJuice,
    FeeJuiceContract.artifact,
    'fee juice',
  );
  const feeJuice = await FeeJuiceContract.at(ProtocolContractAddress.FeeJuice, wallet);
  await feeJuice.methods
    .claim(fpcAddress, claimAmount, secret, leafIndex)
    .send({ from: claimer, ...(fee ? { fee } : {}), wait });

  // 2. Prove the claim in-circuit and credit the claimer's private balance.
  const fpc = await PrivateFPCContract.at(fpcAddress, wallet);
  await fpc.methods
    .mint(claimAmount, salt, leafIndex)
    .send({ from: claimer, ...(fee ? { fee } : {}), wait });

  return { credited: claimAmount };
}
