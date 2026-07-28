// cUSDC network configuration: which token address is the marketplace currency
// on each network.
//
// - testnet / mainnet: a fixed, already-deployed cUSDC (Shield's compliant "Clean
//   USDC" = the aztec-standards Token). Obtained by bridging (Shield), never minted.
// - local sandbox: no cUSDC exists, so the app deploys a MOCK cUSDC (also the
//   aztec-standards Token) whose address is remembered per device.
//
// The contract artifact for cUSDC (the same on every network -- it's the
// aztec-standards Token) is owned by @market/deployment's getCusdcTokenArtifact.

// Fixed cUSDC token addresses, imported from @market/deployment rather than
// restated here. They are also the payment-asset ALLOWLIST that
// resolveMarketplace enforces, and a second copy that could drift from it would
// defeat the point. Re-exported so existing importers of this module still work.
import { CUSDC_MAINNET_ADDRESS, CUSDC_TESTNET_ADDRESS } from '@market/deployment';

export { CUSDC_MAINNET_ADDRESS, CUSDC_TESTNET_ADDRESS };

/** Per-device address of the locally-deployed mock cUSDC (sandbox only). */
const LOCAL_MOCK_STORAGE_KEY = 'cusdcMockAddress';

export type MarketNetwork = 'local' | 'testnet' | 'mainnet';

export function networkOf(nodeUrl: string): MarketNetwork {
  if (/localhost|127\.0\.0\.1/.test(nodeUrl)) {
    return 'local';
  }
  if (/testnet/i.test(nodeUrl)) {
    return 'testnet';
  }
  return 'mainnet';
}

/** True on the local sandbox, where cUSDC is a deployable, mintable mock. */
export function isLocalNetwork(nodeUrl: string): boolean {
  return networkOf(nodeUrl) === 'local';
}

export function loadLocalMockCusdc(): string {
  return localStorage.getItem(LOCAL_MOCK_STORAGE_KEY) ?? '';
}

export function storeLocalMockCusdc(address: string): void {
  localStorage.setItem(LOCAL_MOCK_STORAGE_KEY, address);
}

/**
 * The cUSDC address a new market should default its `paymentAsset` to on this
 * network: the fixed token on testnet/mainnet, or the locally-deployed mock on
 * the sandbox (empty until one is deployed).
 */
export function defaultCusdcAddress(nodeUrl: string): string {
  switch (networkOf(nodeUrl)) {
    case 'testnet':
      return CUSDC_TESTNET_ADDRESS;
    case 'mainnet':
      return CUSDC_MAINNET_ADDRESS;
    case 'local':
      return loadLocalMockCusdc();
  }
}
