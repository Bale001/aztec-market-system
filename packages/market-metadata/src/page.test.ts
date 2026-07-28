import { Fr } from '@aztec/foundation/curves/bn254';

import { decryptMetadataBytes } from './encryption.js';
import { MAX_PAGE_BODY_CHARS, openPageBody, sealPageBody } from './page.js';

const SECRET = new Fr(123456789n);

describe('sealPageBody / openPageBody', () => {
  it('round-trips a body, newlines included', async () => {
    const body = 'Welcome to the market.\n\nWe ship worldwide.';
    const sealed = await sealPageBody(body, SECRET);
    await expect(openPageBody(sealed, SECRET)).resolves.toBe(body);
  });

  it('produces different ciphertext per call (random IV)', async () => {
    const a = await sealPageBody('same body', SECRET);
    const b = await sealPageBody('same body', SECRET);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('rejects a wrong secret', async () => {
    const sealed = await sealPageBody('private text', SECRET);
    await expect(openPageBody(sealed, new Fr(42n))).rejects.toThrow(
      'wrong access secret or tampered blob',
    );
  });

  it('rejects an empty body and an oversized body', async () => {
    await expect(sealPageBody('', SECRET)).rejects.toThrow('page.body must be 1..');
    await expect(sealPageBody('x'.repeat(MAX_PAGE_BODY_CHARS + 1), SECRET)).rejects.toThrow(
      'page.body must be 1..',
    );
  });

  it('is domain-separated from the metadata blob family', async () => {
    // A page blob must not decrypt under the metadata key domain even with
    // the right secret: the derivation contexts differ.
    const sealed = await sealPageBody('domain-separated', SECRET);
    await expect(decryptMetadataBytes(sealed, SECRET)).rejects.toThrow(
      'wrong access secret or tampered blob',
    );
  });
});
