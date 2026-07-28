// Content-addressed storage behind an interface (PLAN.md D5).
//
// The MVP backend is a local directory: one file per blob, named by the
// lowercase-hex sha256 of its contents. Reads re-hash the bytes and throw on
// mismatch, so a corrupted or tampered store can never serve wrong content
// silently. IPFS (or any other backend) slots in behind the same interface
// later.
//
// Blobs are additionally indexed by their on-chain commitment
// (poseidon2([sha256_hi, sha256_lo, DOMAIN_METADATA]), see
// @market/market-metadata). Contracts store only that single Field, so the
// commitment is the only handle a Portal has after resolving a marketplace
// by identifier — the store must be able to answer by it.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { computeContentHash, computeMetadataCommitment } from '@market/market-metadata';

import { assertCommitmentHex, assertContentHashHex } from './hashes.js';

export interface ContentStore {
  /** Stores the blob and returns its content hash (lowercase hex, no 0x). */
  put(bytes: Uint8Array): Promise<string>;
  /** Returns the blob; throws if it is absent or fails hash verification. */
  get(contentHashHex: string): Promise<Uint8Array>;
  /** Returns the blob by its on-chain commitment (0x-hex field element). */
  getByCommitment(commitmentHex: string): Promise<Uint8Array>;
}

export class FileContentStore implements ContentStore {
  constructor(private readonly dir: string) {}

  static async create(dir: string): Promise<FileContentStore> {
    await mkdir(dir, { recursive: true });
    return new FileContentStore(dir);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const hash = Buffer.from(computeContentHash(bytes)).toString('hex');
    await this.atomicWrite(hash, Buffer.from(bytes));

    // Commitment alias: a small file named after the commitment whose body is
    // the content hash it points at.
    const commitment = await computeMetadataCommitment(computeContentHash(bytes));
    await this.atomicWrite(`c-${commitment.toString().slice(2)}`, Buffer.from(hash, 'utf8'));

    return hash;
  }

  async get(contentHashHex: string): Promise<Uint8Array> {
    assertContentHashHex(contentHashHex);
    const bytes = new Uint8Array(await readFile(join(this.dir, contentHashHex)));
    const actual = Buffer.from(computeContentHash(bytes)).toString('hex');
    if (actual !== contentHashHex) {
      throw new Error(
        `content store integrity failure: blob ${contentHashHex} hashes to ${actual}`,
      );
    }
    return bytes;
  }

  async getByCommitment(commitmentHex: string): Promise<Uint8Array> {
    assertCommitmentHex(commitmentHex);
    const alias = await readFile(join(this.dir, `c-${commitmentHex.slice(2)}`), 'utf8');
    const bytes = await this.get(alias);
    // Verify the alias itself: recompute the commitment from the blob.
    const actual = await computeMetadataCommitment(computeContentHash(bytes));
    if (actual.toString() !== commitmentHex) {
      throw new Error(
        `content store integrity failure: alias ${commitmentHex} resolves to a blob committing to ${actual.toString()}`,
      );
    }
    return bytes;
  }

  private async atomicWrite(name: string, data: Buffer): Promise<void> {
    // Temp file + rename so a crash cannot leave a partial file under its
    // final content-addressed name.
    const tmp = join(this.dir, `.tmp-${name}-${process.pid}-${Date.now()}`);
    await writeFile(tmp, data);
    await rename(tmp, join(this.dir, name));
  }
}
