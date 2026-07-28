// Fetch-based client for the publisher HTTP API. Works in node and the
// browser. Verifies content hashes client-side on fetch — the Portal/Creator
// must never trust the store.

import { computeContentHash, computeMetadataCommitment } from '@market/market-metadata';

import { assertCommitmentHex, assertContentHashHex } from './hashes.js';

export class PublisherClient {
  constructor(private readonly baseUrl: string) {
    if (!/^https?:\/\//.test(baseUrl)) {
      throw new Error(`publisher baseUrl must be http(s), got "${baseUrl}"`);
    }
  }

  async publish(bytes: Uint8Array): Promise<string> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/store`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes as BodyInit,
    });
    if (!res.ok) {
      throw new Error(`publisher POST /store failed: ${res.status} ${await res.text()}`);
    }
    const { contentHash } = (await res.json()) as { contentHash: string };
    assertContentHashHex(contentHash);
    const expected = Buffer.from(computeContentHash(bytes)).toString('hex');
    if (contentHash !== expected) {
      throw new Error(
        `publisher returned hash ${contentHash} but content hashes to ${expected}`,
      );
    }
    return contentHash;
  }

  async fetchContent(contentHashHex: string): Promise<Uint8Array> {
    assertContentHashHex(contentHashHex);
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/content/${contentHashHex}`);
    if (!res.ok) {
      throw new Error(
        `publisher GET /content/${contentHashHex} failed: ${res.status} ${await res.text()}`,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const actual = Buffer.from(computeContentHash(bytes)).toString('hex');
    if (actual !== contentHashHex) {
      throw new Error(`fetched content hashes to ${actual}, expected ${contentHashHex}`);
    }
    return bytes;
  }

  /**
   * Fetches a blob by its on-chain commitment (0x-hex field element) and
   * verifies it by recomputing the commitment from the bytes. This is the
   * Portal's resolution path: the contract stores only the commitment.
   */
  async fetchByCommitment(commitmentHex: string): Promise<Uint8Array> {
    assertCommitmentHex(commitmentHex);
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/commitment/${commitmentHex}`);
    if (!res.ok) {
      throw new Error(
        `publisher GET /commitment/${commitmentHex} failed: ${res.status} ${await res.text()}`,
      );
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const actual = await computeMetadataCommitment(computeContentHash(bytes));
    if (actual.toString() !== commitmentHex) {
      throw new Error(
        `fetched content commits to ${actual.toString()}, expected ${commitmentHex}`,
      );
    }
    return bytes;
  }
}
