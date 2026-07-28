// L1 (Ethereum) settings for the fee-juice bridge.
//
// The PrivateFPC is funded by depositing fee juice on the L1 fee-juice portal,
// so bridging needs an L1 RPC and a funded L1 account. On the Aztec testnet
// that L1 is Ethereum SEPOLIA: fund the account with Sepolia ETH (e.g. the
// Aztec faucet) to pay L1 gas; the testnet's fee-asset handler dispenses the
// test fee-juice token for free.
//
// The signer secret controls a real Ethereum account (real ETH on mainnet), so
// it lives ONLY in this device's local storage and is sent nowhere but the L1
// RPC you configure. It is intentionally NOT part of the wallet backup: it is a
// pointer to an external account you manage yourself.

const RPC_KEY = 'market.l1RpcUrl.v1';
const SIGNER_KEY = 'market.l1Signer.v1';

/** A public Sepolia RPC default; point at your own (Infura/Alchemy/…) if you hit rate limits. */
export const DEFAULT_L1_RPC = 'https://ethereum-sepolia-rpc.publicnode.com';

export function getL1RpcUrl(): string {
  const stored = localStorage.getItem(RPC_KEY);
  return stored !== null && stored.trim() !== '' ? stored : DEFAULT_L1_RPC;
}

export function setL1RpcUrl(url: string): void {
  localStorage.setItem(RPC_KEY, url.trim());
}

/** The L1 signer: a 12-word mnemonic OR a 0x private key. Empty string when unset. */
export function getL1Signer(): string {
  return localStorage.getItem(SIGNER_KEY) ?? '';
}

export function setL1Signer(value: string): void {
  localStorage.setItem(SIGNER_KEY, value.trim());
}

export function hasL1Signer(): boolean {
  return getL1Signer() !== '';
}
