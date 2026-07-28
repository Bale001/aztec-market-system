// cUSDC -- the marketplace's standard currency. On testnet/mainnet this is a
// fixed, already-deployed token (Shield's compliant "Clean USDC"); on the local
// sandbox, where no cUSDC exists, the app deploys a MOCK cUSDC so dev/testing
// works, and the deployer becomes its minter for the dev faucet.
//
// cUSDC is the @aztec-foundation/aztec-standards Token (its on-chain class
// matches that package @5.0.1), NOT the noir-contracts Token -- a different ABI
// (transfer_private_to_private, not transfer_in_private; a commitment-based
// partial-note flow; etc.). We bind to it generically from its published
// artifact rather than a typed contract class (the package ships none).

import { loadContractArtifact, type ContractArtifact } from '@aztec/aztec.js/abi';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Contract } from '@aztec/aztec.js/contracts';
import type { FeePaymentMethod } from '@aztec/aztec.js/fee';
import { Fr } from '@aztec/aztec.js/fields';
import type { AztecNode } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';

import { ensureContractRegistered, type RegistersContracts } from './register.js';

/**
 * The deployed cUSDC on each real network. THE SINGLE SOURCE OF TRUTH: the
 * desktop re-exports these rather than keeping its own copy, because they are
 * also the payment-asset allowlist below, and two lists that could drift would
 * defeat the point of having one.
 */
export const CUSDC_TESTNET_ADDRESS =
  '0x11a748929f8534259b531f742a0c60e067def53aa6cfe7952a6ce7e9ef1f511f';
export const CUSDC_MAINNET_ADDRESS =
  '0x018d47f656a0d242e28e5d15b5c965f39529bd860f2eaae947527b5094d800f6';

/**
 * Payment assets a client will transact in. A market names its own currency,
 * and nothing on-chain constrains that choice, so a market could be deployed
 * against a token its operator wrote: one that lets them mint freely, freeze a
 * buyer's balance, or refuse the escrow's transfer after the buyer has funded
 * it. Escrowing into such a token is unrecoverable.
 *
 * This is the same kind of anchor as the Marketplace class-id allowlist, and it
 * belongs in the same place for the same reason: it protects the BUYER, and the
 * buyer runs this code. An on-chain check would be worth little, since a market
 * whose contract is malicious enough to skip it is already refused by the class
 * check.
 *
 * Deliberately a SET and deliberately client-side, so a future client can trust
 * several currencies at once without any on-chain change.
 */
export function acceptedPaymentAssets(): ReadonlySet<string> {
  return new Set([
    AztecAddress.fromFieldUnsafe(Fr.fromString(CUSDC_TESTNET_ADDRESS)).toString(),
    AztecAddress.fromFieldUnsafe(Fr.fromString(CUSDC_MAINNET_ADDRESS)).toString(),
  ]);
}

export const CUSDC_NAME = 'cUSDC';
export const CUSDC_SYMBOL = 'cUSDC';
// USDC-standard precision. NOTE: fee juice is 18 decimals -- a different unit;
// never format cUSDC amounts with fee-juice helpers or vice versa.
export const CUSDC_DECIMALS = 6;

// The aztec-standards Token artifact (cUSDC), loaded once. Dynamically imported
// so the ~5 MB JSON stays out of eager bundles and resolves in both Node and the
// browser (Vite). Consumers already run async, so a cached promise is fine.
let artifactPromise: Promise<ContractArtifact> | null = null;
export function getCusdcTokenArtifact(): Promise<ContractArtifact> {
  if (artifactPromise === null) {
    artifactPromise = import(
      '@aztec-foundation/aztec-standards/artifacts/target/token_contract-Token.json',
      { with: { type: 'json' } }
    ).then(m => loadContractArtifact((m as { default: unknown }).default as never));
  }
  return artifactPromise;
}

interface TokenSessionOptions {
  wallet: Wallet & RegistersContracts;
  node: AztecNode;
  from: AztecAddress;
}

/**
 * Deploys a MOCK cUSDC (the aztec-standards Token) for the local sandbox. The
 * deployer (`from`) becomes its minter, so the same session can run the dev
 * faucet (mintCusdc). `auth_contract = zero` disables the compliance hook Shield
 * sets on the real cUSDC. Not used on testnet/mainnet (real cUSDC exists there).
 */
export async function deployMockCusdc(
  options: TokenSessionOptions & {
    fee?: { paymentMethod: FeePaymentMethod };
    txTimeoutSeconds?: number;
  },
): Promise<AztecAddress> {
  const { wallet, from, fee } = options;
  const wait = { timeout: options.txTimeoutSeconds ?? 180 };
  const artifact = await getCusdcTokenArtifact();
  const { contract } = await Contract.deploy(
    wallet,
    artifact,
    [CUSDC_NAME, CUSDC_SYMBOL, CUSDC_DECIMALS, from, AztecAddress.zero()],
    'constructor_with_minter',
  ).send({ from, ...(fee ? { fee } : {}), wait });
  return contract.address;
}

async function tokenAt(options: TokenSessionOptions & { tokenAddress: AztecAddress }): Promise<Contract> {
  const artifact = await getCusdcTokenArtifact();
  await ensureContractRegistered(options.wallet, options.node, options.tokenAddress, artifact, 'cUSDC');
  return Contract.at(options.tokenAddress, artifact, options.wallet);
}

/**
 * Dev faucet: mints cUSDC into `to`'s private balance. The caller (`from`) must
 * be the token's minter -- i.e. this only works for the local MOCK cUSDC that
 * this wallet deployed. Real cUSDC is obtained by bridging (Shield), not minting.
 */
export async function mintCusdc(
  options: TokenSessionOptions & {
    tokenAddress: AztecAddress;
    to: AztecAddress;
    amount: bigint;
    fee?: { paymentMethod: FeePaymentMethod };
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const { from, fee } = options;
  const wait = { timeout: options.txTimeoutSeconds ?? 180 };
  const token = await tokenAt(options);
  const { receipt } = await token.methods
    .mint_to_private!(options.to, options.amount)
    .send({ from, ...(fee ? { fee } : {}), wait });
  return { txHash: receipt.txHash.toString() };
}

/**
 * Privately transfers cUSDC `from` -> `to` via `transfer_private_to_private`.
 *
 * This is THE funding hop for per-market accounts (universal -> per-market).
 * NOTE: aztec-standards delivers this CONSTRAINED (there is no unconstrained
 * private transfer), so unlike the old noir-contracts `transfer` it registers a
 * handshake that can mark the L1-linked universal account. Accepted for now (a
 * privacy hardening item); see the cUSDC notes.
 */
export async function transferCusdc(
  options: TokenSessionOptions & {
    tokenAddress: AztecAddress;
    to: AztecAddress;
    amount: bigint;
    fee?: { paymentMethod: FeePaymentMethod };
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const { from, fee } = options;
  const wait = { timeout: options.txTimeoutSeconds ?? 180 };
  const token = await tokenAt(options);
  const { receipt } = await token.methods
    // from == sender, so nonce 0 is a self-authorized transfer (no authwit).
    .transfer_private_to_private!(options.from, options.to, options.amount, 0)
    .send({ from, ...(fee ? { fee } : {}), wait });
  return { txHash: receipt.txHash.toString() };
}

/**
 * Pulls cUSDC OUT of another account you control, with the CALLER paying the fee.
 *
 * `from` sends the transaction (and pays its fee from its own FPC credit) while
 * `source` is the account debited. This is how a per-market account gets its
 * balance out: those accounts are INBOXES ONLY -- they receive vendor earnings
 * but hold no fee-juice credit, so they cannot pay for a transaction themselves.
 * The universal wallet sends the tx and `source` authorizes the debit with a
 * single-use authwit (`transfer_private_to_private` is `#[authorize_once("from",
 * "_nonce")]`, so the authorization is bound to this exact caller+nonce and is
 * nullified on use). `source`'s notes are brought into the prover's scope with
 * `additionalScopes` -- a client-side detail between two accounts of the same
 * wallet, nothing on-chain.
 *
 * PRIVACY: the transfer is delivered CONSTRAINED (aztec-standards has no
 * unconstrained transfer), so it registers a handshake linking `source` and
 * `from`. That is unavoidable when moving funds between two accounts on this
 * token; sweeping less often (or in fewer, larger amounts) reduces the number of
 * such links.
 */
export async function pullCusdc(
  options: TokenSessionOptions & {
    /** The account being debited (e.g. a per-market inbox). */
    source: AztecAddress;
    tokenAddress: AztecAddress;
    amount: bigint;
    fee?: { paymentMethod: FeePaymentMethod };
    txTimeoutSeconds?: number;
  },
): Promise<{ txHash: string }> {
  const { wallet, from, fee, source, amount } = options;
  const wait = { timeout: options.txTimeoutSeconds ?? 180 };
  if (amount <= 0n) {
    throw new Error('the amount to withdraw must be positive');
  }
  if (source.equals(from)) {
    throw new Error('source and destination are the same account');
  }
  const token = await tokenAt(options);
  const authwitNonce = Fr.random();
  // Built twice: once to hash the call for the authwit, once to send. (Building
  // fresh avoids relying on an interaction being reusable after `request()`.)
  const build = () =>
    token.methods.transfer_private_to_private!(source, from, amount, authwitNonce);
  const payload = await build().request();
  const call = payload.calls[0];
  if (call === undefined) {
    throw new Error('transfer interaction produced no calls');
  }
  // `source` authorizes THIS caller (the tx sender) to move exactly this amount.
  const witness = await wallet.createAuthWit(source, { caller: from, call: call as never });
  const { receipt } = await build()
    .with({ authWitnesses: [witness] })
    .send({ from, ...(fee ? { fee } : {}), additionalScopes: [source], wait });
  return { txHash: receipt.txHash.toString() };
}

/** Reads an owner's private cUSDC balance (utility simulation, free). */
export async function cusdcBalanceOf(
  options: TokenSessionOptions & { tokenAddress: AztecAddress; owner: AztecAddress },
): Promise<bigint> {
  const token = await tokenAt(options);
  return (
    await token.methods.balance_of_private!(options.owner).simulate({ from: options.owner })
  ).result as bigint;
}
