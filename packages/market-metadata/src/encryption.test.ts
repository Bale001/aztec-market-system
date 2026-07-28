import { Fr } from '@aztec/foundation/curves/bn254';

import { canonicalBytes } from './canonical.js';
import {
  SEALED_FORMAT_VERSION,
  decryptMetadataBytes,
  encryptMetadataBytes,
  openMetadata,
  sealMetadata,
} from './encryption.js';
import { sampleMarketplaceMetadata } from './fixtures.js';

const SECRET = new Fr(0x5555n);
const WRONG_SECRET = new Fr(0x6666n);

describe('encryptMetadataBytes / decryptMetadataBytes', () => {
  it('round-trips bytes', async () => {
    const plaintext = new TextEncoder().encode('hello hidden market');
    const sealed = await encryptMetadataBytes(plaintext, SECRET);
    expect(sealed[0]).toBe(SEALED_FORMAT_VERSION);
    const opened = await decryptMetadataBytes(sealed, SECRET);
    expect(Buffer.from(opened).toString()).toBe('hello hidden market');
  });

  it('produces a different blob per call (random IV)', async () => {
    const plaintext = new TextEncoder().encode('same content');
    const a = await encryptMetadataBytes(plaintext, SECRET);
    const b = await encryptMetadataBytes(plaintext, SECRET);
    expect(Buffer.from(a).toString('hex')).not.toBe(Buffer.from(b).toString('hex'));
  });

  it('rejects the wrong secret', async () => {
    const sealed = await encryptMetadataBytes(new TextEncoder().encode('x'), SECRET);
    await expect(decryptMetadataBytes(sealed, WRONG_SECRET)).rejects.toThrow(
      'wrong access secret or tampered blob',
    );
  });

  it('rejects a tampered blob', async () => {
    const sealed = await encryptMetadataBytes(new TextEncoder().encode('x'), SECRET);
    sealed[sealed.length - 1] ^= 0x01;
    await expect(decryptMetadataBytes(sealed, SECRET)).rejects.toThrow(
      'wrong access secret or tampered blob',
    );
  });

  it('rejects unknown format versions and truncated blobs', async () => {
    const sealed = await encryptMetadataBytes(new TextEncoder().encode('x'), SECRET);
    const wrongVersion = Uint8Array.from(sealed);
    wrongVersion[0] = 0x02;
    await expect(decryptMetadataBytes(wrongVersion, SECRET)).rejects.toThrow(
      'unknown sealed format version 2',
    );
    await expect(decryptMetadataBytes(sealed.subarray(0, 10), SECRET)).rejects.toThrow(
      'sealed blob too short',
    );
  });

  it('rejects a zero access secret', async () => {
    await expect(
      encryptMetadataBytes(new TextEncoder().encode('x'), Fr.ZERO),
    ).rejects.toThrow('access secret must not be zero');
  });
});

describe('sealMetadata / openMetadata', () => {
  it('round-trips the sample document', async () => {
    const doc = sampleMarketplaceMetadata();
    const sealed = await sealMetadata(doc, SECRET);
    const opened = await openMetadata(sealed.sealed, SECRET);
    expect(opened).toEqual(doc);
  });

  it('two seals of the same document are unlinkable', async () => {
    const doc = sampleMarketplaceMetadata();
    const a = await sealMetadata(doc, SECRET);
    const b = await sealMetadata(doc, SECRET);
    expect(Buffer.from(a.sealed).toString('hex')).not.toBe(Buffer.from(b.sealed).toString('hex'));
  });

  it('rejects documents whose sealed blob exceeds the on-chain cap', async () => {
    const doc = sampleMarketplaceMetadata();
    doc.policies.feeExplanation = 'x'.repeat(2000);
    doc.policies.vendorRequirements = 'y'.repeat(2000);
    doc.policies.disputeRules = 'z'.repeat(2000);
    await expect(sealMetadata(doc, SECRET)).rejects.toThrow('on-chain cap');
  });

  it('openMetadata rejects the wrong secret', async () => {
    const sealed = await sealMetadata(sampleMarketplaceMetadata(), SECRET);
    await expect(openMetadata(sealed.sealed, WRONG_SECRET)).rejects.toThrow(
      'wrong access secret or tampered blob',
    );
  });

  it('openMetadata rejects non-canonical plaintext', async () => {
    // Encrypt a valid but non-canonical serialization (extra whitespace).
    const doc = sampleMarketplaceMetadata();
    const nonCanonical = new TextEncoder().encode(JSON.stringify(doc, null, 2));
    // Ensure this is genuinely different from the canonical form.
    expect(Buffer.compare(Buffer.from(nonCanonical), Buffer.from(canonicalBytes(doc)))).not.toBe(0);
    const sealed = await encryptMetadataBytes(nonCanonical, SECRET);
    await expect(openMetadata(sealed, SECRET)).rejects.toThrow(
      'not in canonical form',
    );
  });

  it('openMetadata validates the decrypted document', async () => {
    const bad = sampleMarketplaceMetadata() as unknown as Record<string, unknown>;
    bad.extra = 1;
    const bytes = new TextEncoder().encode(JSON.stringify(bad));
    const sealed = await encryptMetadataBytes(bytes, SECRET);
    await expect(openMetadata(sealed, SECRET)).rejects.toThrow(
      'metadata.extra is not part of the schema',
    );
  });
});
