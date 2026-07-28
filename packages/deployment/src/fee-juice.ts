// Fee juice -- self-funded network gas for the wallet. Bridged from L1 (anvil,
// on the local network) into an L2 fee-juice balance. These are wallet-agnostic
// primitives; the caller advances a couple of L2 blocks between bridge and claim
// so the L1->L2 message lands in the message tree (an idle local network builds
// blocks only on demand).

import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { L1FeeJuicePortalManager, type L2AmountClaim } from '@aztec/aztec.js/ethereum';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import type { AztecNode } from '@aztec/aztec.js/node';
import { getFeeJuiceBalance } from '@aztec/aztec.js/utils';
import type { Wallet } from '@aztec/aztec.js/wallet';
import { createExtendedL1Client } from '@aztec/ethereum/client';
import { createLogger } from '@aztec/foundation/log';
import { FeeJuiceContract } from '@aztec/noir-contracts.js/FeeJuice';
import { ProtocolContractAddress } from '@aztec/protocol-contracts';

import { ensureContractRegistered, type RegistersContracts } from './register.js';

// anvil's default account 0 -- the funded L1 account on the local network.
const ANVIL_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEFAULT_L1_RPC = 'http://localhost:8545';

export type FeeJuiceClaim = Pick<L2AmountClaim, 'claimAmount' | 'claimSecret' | 'messageLeafIndex'>;

/** Reads an account's fee-juice balance. */
export async function feeJuiceBalanceOf(node: AztecNode, owner: AztecAddress): Promise<bigint> {
  return getFeeJuiceBalance(owner, node);
}

/**
 * Bridges fee juice from L1 (anvil) to `recipient` on L2 and returns the L2
 * claim. On the local network `mint=true` mints a fixed test chunk on L1. The
 * claim is redeemed on L2 with {@link claimFeeJuice} once the L1->L2 message
 * has been pulled into the message tree (a couple of L2 blocks later).
 */
export async function bridgeFeeJuice(options: {
  node: AztecNode;
  recipient: AztecAddress;
  l1RpcUrl?: string;
  l1PrivateKey?: string;
}): Promise<FeeJuiceClaim> {
  const l1 = createExtendedL1Client(
    [options.l1RpcUrl ?? DEFAULT_L1_RPC],
    options.l1PrivateKey ?? ANVIL_KEY,
  );
  const portal = await L1FeeJuicePortalManager.new(options.node, l1, createLogger('market:fee-juice'));
  return portal.bridgeTokensPublic(options.recipient, undefined, true);
}

/** Redeems a bridged fee-juice claim into `from`'s L2 fee-juice balance. */
export async function claimFeeJuice(options: {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
  claim: FeeJuiceClaim;
  fee?: { paymentMethod: FeePaymentMethod };
  txTimeoutSeconds?: number;
}): Promise<{ txHash: string }> {
  const { wallet, node, from, claim, fee } = options;
  const wait = { timeout: options.txTimeoutSeconds ?? 180 };
  await ensureContractRegistered(
    wallet,
    node,
    ProtocolContractAddress.FeeJuice,
    FeeJuiceContract.artifact,
    'fee juice',
  );
  const feeJuice = await FeeJuiceContract.at(ProtocolContractAddress.FeeJuice, wallet);
  const { receipt } = await feeJuice.methods
    .claim(from, claim.claimAmount, claim.claimSecret, claim.messageLeafIndex)
    .send({ from, ...(fee ? { fee } : {}), wait });
  return { txHash: receipt.txHash.toString() };
}
