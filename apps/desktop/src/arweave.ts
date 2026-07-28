// Self-custodial Arweave wallet (permanent off-chain storage for large files:
// images, documents). An Arweave wallet is an RSA-4096 keypair in JWK form;
// the address is a hash of the public modulus. The key is generated locally
// (WebCrypto), stored on this device like our other secrets, and included in
// the wallet backup. Uploads (a later step) are paid in AR from this wallet.

import Arweave from 'arweave';
import type { JWKInterface } from 'arweave/web/lib/wallet';

/** localStorage keys, exported so the wallet backup can include them. */
export const ARWEAVE_KEY_STORAGE_KEY = 'market.arweave.v1';
export const ARWEAVE_GATEWAY_STORAGE_KEY = 'market.arweaveGateway.v1';
const KEY_STORAGE_KEY = ARWEAVE_KEY_STORAGE_KEY;
const GATEWAY_STORAGE_KEY = ARWEAVE_GATEWAY_STORAGE_KEY;

/** Mainnet gateway. For local testing run arlocal and point this at :1984. */
export const DEFAULT_ARWEAVE_GATEWAY = 'https://arweave.net';

/** 1 AR = 1e12 winston. */
const WINSTON_PER_AR = 10n ** 12n;

/** True if a gateway URL points at a local arlocal instance (dev). */
export function isLocalGateway(gatewayUrl = getArweaveGateway()): boolean {
  return /localhost|127\.0\.0\.1/.test(gatewayUrl);
}

/**
 * Mints test AR to an address on a LOCAL arlocal gateway (its /mint faucet).
 * Fails on a real gateway -- callers gate this behind isLocalGateway. The
 * amount is whole AR (converted to winston). Loaded from @market/arweave-store
 * lazily to keep the arweave-store code off the initial bundle.
 */
export async function mintTestAr(address: string, amountAr: bigint): Promise<void> {
  const gateway = getArweaveGateway();
  if (!isLocalGateway(gateway)) {
    throw new Error('minting test AR only works on a local arlocal gateway');
  }
  const store = await import('@market/arweave-store');
  await store.arlocalMint(gateway, address, amountAr * WINSTON_PER_AR);
  await store.arlocalMine(gateway);
}

export function getArweaveGateway(): string {
  return localStorage.getItem(GATEWAY_STORAGE_KEY) ?? DEFAULT_ARWEAVE_GATEWAY;
}

export function setArweaveGateway(url: string): void {
  localStorage.setItem(GATEWAY_STORAGE_KEY, url.trim());
}

export function arweaveClient(gatewayUrl = getArweaveGateway()): Arweave {
  const url = new URL(gatewayUrl);
  return Arweave.init({
    host: url.hostname,
    port: url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
    protocol: url.protocol.replace(':', ''),
  });
}

export function loadStoredArweaveKey(): JWKInterface | null {
  const raw = localStorage.getItem(KEY_STORAGE_KEY);
  if (raw === null) {
    return null;
  }
  const jwk = JSON.parse(raw) as JWKInterface;
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.d) {
    throw new Error('stored Arweave key is malformed; re-import or clear app data');
  }
  return jwk;
}

export function storeArweaveKey(jwk: JWKInterface): void {
  localStorage.setItem(KEY_STORAGE_KEY, JSON.stringify(jwk));
}

/** Generates a fresh RSA-4096 keypair locally, stores it, returns the address. */
export async function createArweaveWallet(): Promise<{ jwk: JWKInterface; address: string }> {
  const client = arweaveClient();
  const jwk = await client.wallets.generate();
  storeArweaveKey(jwk);
  return { jwk, address: await client.wallets.jwkToAddress(jwk) };
}

/**
 * Imports a JWK keyfile (the standard Arweave key format). Validates it is a
 * full RSA private key before storing -- replaces any existing key.
 */
export async function importArweaveKey(json: string): Promise<{ jwk: JWKInterface; address: string }> {
  let jwk: JWKInterface;
  try {
    jwk = JSON.parse(json) as JWKInterface;
  } catch {
    throw new Error('not valid JSON — paste the full Arweave keyfile');
  }
  if (jwk.kty !== 'RSA' || !jwk.n) {
    throw new Error('not an Arweave keyfile (expected an RSA JWK with an "n" field)');
  }
  if (!jwk.d) {
    throw new Error('this JWK has no private part ("d") — it cannot sign uploads');
  }
  const address = await arweaveClient().wallets.jwkToAddress(jwk);
  storeArweaveKey(jwk);
  return { jwk, address };
}

export function arweaveAddress(jwk: JWKInterface): Promise<string> {
  return arweaveClient().wallets.jwkToAddress(jwk);
}

/** Balance in winston (1e-12 AR), queried from the configured gateway. */
export async function arweaveBalance(address: string): Promise<bigint> {
  return BigInt(await arweaveClient().wallets.getBalance(address));
}

/**
 * Builds the upload/fetch callbacks the listing pipeline needs, bound to the
 * configured gateway. The upload side opens the "Store on Arweave" chooser
 * (arweave-upload.tsx) so the user can either pay from the built-in storage
 * wallet or download the sealed blob and upload it themselves via a 3rd-party
 * service. The chooser (and the store code it dynamically loads) stays off the
 * initial bundle. Fetching stays keyless so buyers can browse listings without
 * ever creating a storage wallet.
 */
export async function makeArweavePayloadIO(): Promise<{
  uploadPayload: (sealed: Uint8Array) => Promise<string>;
  fetchPayload: (storageId: string) => Promise<Uint8Array>;
}> {
  const gateway = getArweaveGateway();
  const store = await import('@market/arweave-store');

  return {
    uploadPayload: async (sealed: Uint8Array) => {
      const { runArweaveUpload } = await import('./arweave-upload.js');
      return runArweaveUpload(sealed);
    },
    fetchPayload: (storageId: string) => store.fetchBlob(gateway, storageId),
  };
}

/** Formats winston as whole AR with up to 6 decimal places. */
export function formatAr(winston: bigint): string {
  const whole = winston / WINSTON_PER_AR;
  const frac = winston % WINSTON_PER_AR;
  if (frac === 0n) {
    return whole.toString();
  }
  const fracTrim = frac.toString().padStart(12, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracTrim.length > 6 ? fracTrim.slice(0, 6) + '…' : fracTrim}`;
}
