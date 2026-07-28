// Arweave payload IO for integration tests.
//
// Most suites exercise MARKETPLACE logic, not Arweave, so they use an
// in-memory store: it produces real 43-char base64url ids that round-trip
// through the pointer codec, with no network. The dedicated Arweave e2e test
// uses `arlocalArweaveIO` against a running arlocal instead.

import { randomBytes } from 'node:crypto';

import type { FetchPayload, UploadPayload } from '@market/deployment';

export interface ArweaveIO {
  uploadPayload: UploadPayload;
  fetchPayload: FetchPayload;
}

function randomTxId(): string {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 43);
}

/** In-memory store: content-addressed by a random id, no network. */
export function memoryArweaveIO(): ArweaveIO {
  const store = new Map<string, Uint8Array>();
  return {
    uploadPayload: (sealed: Uint8Array) => {
      const id = randomTxId();
      store.set(id, sealed);
      return Promise.resolve(id);
    },
    fetchPayload: (id: string) => {
      const bytes = store.get(id);
      if (bytes === undefined) {
        return Promise.reject(new Error(`no blob stored under ${id}`));
      }
      return Promise.resolve(bytes);
    },
  };
}

/**
 * Real Arweave IO against a local arlocal gateway (default :1984). Auto-mints
 * test AR and mines each upload so it is immediately fetchable.
 */
export function arlocalArweaveIO(
  jwk: unknown,
  address: string,
  gateway = 'http://localhost:1984',
): ArweaveIO {
  return {
    uploadPayload: async (sealed: Uint8Array) => {
      const store = await import('@market/arweave-store');
      const price = await store.uploadPrice(gateway, sealed.length);
      await store.arlocalMint(gateway, address, price * 2n);
      const txId = await store.uploadBlob({
        gatewayUrl: gateway,
        jwk: jwk as import('@market/arweave-store').JWKInterface,
        data: sealed,
      });
      await store.arlocalMine(gateway);
      return txId;
    },
    fetchPayload: async (id: string) => {
      const store = await import('@market/arweave-store');
      return store.fetchBlob(gateway, id);
    },
  };
}
