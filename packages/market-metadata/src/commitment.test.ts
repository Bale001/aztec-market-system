import { canonicalBytes } from './canonical.js';
import {
  commitMetadata,
  computeContentHash,
  computeMetadataCommitment,
} from './commitment.js';
import { sampleMarketplaceMetadata } from './fixtures.js';

describe('computeContentHash', () => {
  it('is a 32-byte sha256 of the input', () => {
    // sha256("abc") — the classic NIST vector.
    const hash = computeContentHash(new TextEncoder().encode('abc'));
    expect(Buffer.from(hash).toString('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('computeMetadataCommitment', () => {
  it('rejects hashes that are not 32 bytes', async () => {
    await expect(computeMetadataCommitment(new Uint8Array(31))).rejects.toThrow(
      'content hash must be 32 bytes, got 31',
    );
  });

  // Mirrored in contracts/market-protocol/src/test.nr::matches_typescript_vectors:
  // derive_metadata_commitment(0x11, 0x22). hi = bytes 0..16 = 0x11,
  // lo = bytes 16..32 = 0x22, big-endian.
  it('matches the Noir cross-language vector', async () => {
    const hash = new Uint8Array(32);
    hash[15] = 0x11;
    hash[31] = 0x22;
    const commitment = await computeMetadataCommitment(hash);
    expect(commitment.toString()).toBe(
      '0x2856f314bb278d176fa31bd69bf462568393549477fd1a95b857215c48195bea',
    );
  });
});

describe('commitMetadata', () => {
  it('produces a stable commitment for the same document', async () => {
    const a = await commitMetadata(sampleMarketplaceMetadata());
    const b = await commitMetadata(sampleMarketplaceMetadata());
    expect(a.commitment.equals(b.commitment)).toBe(true);
    expect(a.contentHashHex).toBe(b.contentHashHex);
  });

  it('changes the commitment when any field changes', async () => {
    const base = await commitMetadata(sampleMarketplaceMetadata());
    const changed = sampleMarketplaceMetadata();
    changed.name = 'Test Bazaar 2';
    const other = await commitMetadata(changed);
    expect(base.commitment.equals(other.commitment)).toBe(false);
  });

  it('canonical bytes match a re-canonicalization of the parsed document', async () => {
    // What gets published must re-verify after a JSON round-trip, which is
    // exactly what the Portal will do.
    const committed = await commitMetadata(sampleMarketplaceMetadata());
    const roundTripped = JSON.parse(new TextDecoder().decode(committed.canonical)) as unknown;
    expect(Buffer.from(canonicalBytes(roundTripped)).toString('hex')).toBe(
      Buffer.from(committed.canonical).toString('hex'),
    );
  });

  it('rejects invalid documents before hashing', async () => {
    const bad = sampleMarketplaceMetadata() as unknown as Record<string, unknown>;
    bad.name = '';
    await expect(commitMetadata(bad)).rejects.toThrow('metadata.name must be 1..64 characters');
  });
});
