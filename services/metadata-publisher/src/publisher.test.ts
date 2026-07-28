import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeContentHash, computeMetadataCommitment } from '@market/market-metadata';

import { PublisherClient } from './client.js';
import { createPublisherServer } from './server.js';
import { FileContentStore } from './store.js';

async function freshStore(): Promise<{ store: FileContentStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'publisher-test-'));
  return { store: await FileContentStore.create(dir), dir };
}

describe('FileContentStore', () => {
  it('round-trips bytes by content hash', async () => {
    const { store } = await freshStore();
    const bytes = new TextEncoder().encode('{"hello":"world"}');
    const hash = await store.put(bytes);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const back = await store.get(hash);
    expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
  });

  it('put is idempotent for identical content', async () => {
    const { store, dir } = await freshStore();
    const bytes = new TextEncoder().encode('same');
    const a = await store.put(bytes);
    const b = await store.put(bytes);
    expect(a).toBe(b);
    // One blob + one commitment alias, regardless of how often it was put.
    expect((await readdir(dir)).length).toBe(2);
  });

  it('rejects malformed hashes', async () => {
    const { store } = await freshStore();
    await expect(store.get('nothex')).rejects.toThrow('invalid content hash');
    await expect(store.get('AB'.repeat(32))).rejects.toThrow('invalid content hash');
  });

  it('throws on missing blobs', async () => {
    const { store } = await freshStore();
    await expect(store.get('0'.repeat(64))).rejects.toThrow();
  });

  it('detects tampered blobs instead of serving them', async () => {
    const { store, dir } = await freshStore();
    const hash = await store.put(new TextEncoder().encode('original'));
    await writeFile(join(dir, hash), 'tampered');
    await expect(store.get(hash)).rejects.toThrow('integrity failure');
  });
});

describe('publisher HTTP server + client', () => {
  it('publishes and fetches with verification end to end', async () => {
    const { store } = await freshStore();
    const server = createPublisherServer(store);
    await new Promise<void>(resolve => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const client = new PublisherClient(`http://127.0.0.1:${port}`);

    try {
      const bytes = new TextEncoder().encode('{"doc":"canonical metadata"}');
      const hash = await client.publish(bytes);
      const back = await client.fetchContent(hash);
      expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);

      // Resolution by on-chain commitment (the Portal path).
      const commitment = await computeMetadataCommitment(computeContentHash(bytes));
      const byCommitment = await client.fetchByCommitment(commitment.toString());
      expect(Buffer.from(byCommitment).equals(Buffer.from(bytes))).toBe(true);

      await expect(client.fetchContent('0'.repeat(64))).rejects.toThrow('failed: 404');

      const health = await fetch(`http://127.0.0.1:${port}/health`);
      expect(health.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve())),
      );
    }
  });

  it('client rejects a lying store', async () => {
    // A server that returns wrong bytes for a requested hash must be caught
    // by the client-side re-hash.
    const { store } = await freshStore();
    const goodHash = await store.put(new TextEncoder().encode('good'));
    const evilHash = await store.put(new TextEncoder().encode('evil'));

    const server = createPublisherServer({
      put: bytes => store.put(bytes),
      get: () => store.get(evilHash),
      getByCommitment: () => store.get(evilHash),
    });
    await new Promise<void>(resolve => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    const client = new PublisherClient(`http://127.0.0.1:${port}`);

    try {
      await expect(client.fetchContent(goodHash)).rejects.toThrow('fetched content hashes to');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve())),
      );
    }
  });
});
