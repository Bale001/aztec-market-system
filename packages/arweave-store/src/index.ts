// Arweave blob store: upload opaque bytes (already sealed by the caller) as an
// Arweave transaction and fetch them back by id. The store is content-agnostic
// -- it never sees plaintext; the marketplace seals listing bytes before they
// arrive here. Works against arweave.net (mainnet) or a local arlocal for dev.

import Arweave from 'arweave';
// The explicit .js extension is required: arweave ships no exports map, and
// under NodeNext ESM resolution extensionless package subpaths do not resolve.
import type { JWKInterface } from 'arweave/web/lib/wallet.js';

export type { JWKInterface };

/** Tag attached to our uploads (public; identifies the app, not the market). */
const APP_TAG = { name: 'App-Name', value: 'aztec-market' };
const CONTENT_TYPE = 'application/octet-stream';

export interface ArweaveEndpoint {
  host: string;
  port: number;
  protocol: string;
}

/** Parses a gateway URL (e.g. https://arweave.net, http://localhost:1984). */
export function parseGateway(url: string): ArweaveEndpoint {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port !== '' ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80,
    protocol: parsed.protocol.replace(':', ''),
  };
}

export function makeArweave(gatewayUrl: string): Arweave {
  return Arweave.init(parseGateway(gatewayUrl));
}

export interface UploadOptions {
  gatewayUrl: string;
  jwk: JWKInterface;
  data: Uint8Array;
  /** Progress callback: (uploadedChunks, totalChunks). */
  onProgress?: (uploaded: number, total: number) => void;
}

/**
 * Uploads `data` as a signed Arweave transaction and returns its id (43-char
 * base64url). The upload is chunked and driven to completion. On arweave.net
 * the wallet must hold enough AR; on arlocal it is free after minting.
 *
 * Note: the returned id is available immediately, but the data becomes
 * fetchable only once the transaction is mined/seeded (instant on arlocal;
 * minutes on mainnet).
 */
export async function uploadBlob(options: UploadOptions): Promise<string> {
  const arweave = makeArweave(options.gatewayUrl);
  const tx = await arweave.createTransaction({ data: options.data }, options.jwk);
  tx.addTag(APP_TAG.name, APP_TAG.value);
  tx.addTag('Content-Type', CONTENT_TYPE);
  await arweave.transactions.sign(tx, options.jwk);

  const uploader = await arweave.transactions.getUploader(tx);
  while (!uploader.isComplete) {
    await uploader.uploadChunk();
    options.onProgress?.(uploader.uploadedChunks, uploader.totalChunks);
  }
  return tx.id;
}

/**
 * Fetches the bytes stored under `txId`. Throws if the transaction is not found
 * or not yet available. The bytes are exactly what was uploaded (opaque
 * ciphertext); integrity is guaranteed by Arweave (the id commits to the data).
 */
export async function fetchBlob(gatewayUrl: string, txId: string): Promise<Uint8Array> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(txId)) {
    throw new Error(`not an Arweave transaction id: "${txId}"`);
  }
  const arweave = makeArweave(gatewayUrl);
  const data = await arweave.transactions.getData(txId, { decode: true });
  if (typeof data === 'string') {
    // decode:true returns a Uint8Array; a string means the gateway returned no
    // data (pending or missing).
    throw new Error(`Arweave data for ${txId} is not available yet`);
  }
  return data;
}

/** The cost (winston) to store `byteSize` bytes, quoted by the gateway. */
export async function uploadPrice(gatewayUrl: string, byteSize: number): Promise<bigint> {
  const arweave = makeArweave(gatewayUrl);
  return BigInt(await arweave.transactions.getPrice(byteSize));
}

/**
 * Transaction status: HTTP-ish code plus confirmations (0 = pending). On
 * arlocal a freshly-mined tx is 200 immediately; on mainnet it takes minutes.
 */
export async function blobStatus(
  gatewayUrl: string,
  txId: string,
): Promise<{ status: number; confirmations: number }> {
  const arweave = makeArweave(gatewayUrl);
  const res = await arweave.transactions.getStatus(txId);
  return { status: res.status, confirmations: res.confirmed?.number_of_confirmations ?? 0 };
}

// --- Local dev (arlocal) helpers -------------------------------------------

/**
 * Mints test AR to an address on a local arlocal gateway (its /mint faucet).
 * No-op-friendly for mainnet: it simply fails there, which callers guard.
 */
export async function arlocalMint(
  gatewayUrl: string,
  address: string,
  winston: bigint,
): Promise<void> {
  const base = gatewayUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/mint/${address}/${winston.toString()}`);
  if (!res.ok) {
    throw new Error(`arlocal mint failed (${res.status}); is this an arlocal gateway?`);
  }
}

/** Mines pending transactions on arlocal (mainnet mines on its own schedule). */
export async function arlocalMine(gatewayUrl: string): Promise<void> {
  const base = gatewayUrl.replace(/\/$/, '');
  const res = await fetch(`${base}/mine`);
  if (!res.ok) {
    throw new Error(`arlocal mine failed (${res.status}); is this an arlocal gateway?`);
  }
}
