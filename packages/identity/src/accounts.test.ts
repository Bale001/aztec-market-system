import { Fr } from '@aztec/foundation/curves/bn254';

import { deriveMarketAccountKeys } from './accounts.js';

describe('per-market account derivation', () => {
  const seed = Fr.random();
  const marketA = Fr.random();
  const marketB = Fr.random();

  it('is deterministic: same (seed, market, index) -> same keys', async () => {
    const a = await deriveMarketAccountKeys(seed, marketA, 0);
    const b = await deriveMarketAccountKeys(seed, marketA, 0);
    expect(a.secret.equals(b.secret)).toBe(true);
    expect(a.salt.equals(b.salt)).toBe(true);
    expect(a.signingKey.equals(b.signingKey)).toBe(true);
  });

  it('gives independent accounts per market', async () => {
    const a = await deriveMarketAccountKeys(seed, marketA, 0);
    const b = await deriveMarketAccountKeys(seed, marketB, 0);
    expect(a.secret.equals(b.secret)).toBe(false);
    expect(a.salt.equals(b.salt)).toBe(false);
    expect(a.signingKey.equals(b.signingKey)).toBe(false);
  });

  it('gives independent accounts per index on one market', async () => {
    const zero = await deriveMarketAccountKeys(seed, marketA, 0);
    const one = await deriveMarketAccountKeys(seed, marketA, 1);
    expect(zero.secret.equals(one.secret)).toBe(false);
    expect(zero.salt.equals(one.salt)).toBe(false);
    expect(zero.signingKey.equals(one.signingKey)).toBe(false);
  });

  it("the three key materials are domain-separated (secret != salt != signing)", async () => {
    const { secret, salt, signingKey } = await deriveMarketAccountKeys(seed, marketA, 0);
    expect(secret.equals(salt)).toBe(false);
    // signingKey is a reduced Grumpkin scalar; compare its hex to the fields'.
    expect(signingKey.toString()).not.toBe(secret.toString());
  });

  it('a different seed yields different accounts', async () => {
    const a = await deriveMarketAccountKeys(seed, marketA, 0);
    const b = await deriveMarketAccountKeys(Fr.random(), marketA, 0);
    expect(a.secret.equals(b.secret)).toBe(false);
  });

  it('rejects a negative or non-integer index', async () => {
    await expect(deriveMarketAccountKeys(seed, marketA, -1)).rejects.toThrow(/index/);
    await expect(deriveMarketAccountKeys(seed, marketA, 1.5)).rejects.toThrow(/index/);
  });
});
