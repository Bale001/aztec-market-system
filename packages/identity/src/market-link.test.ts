import { Fr } from '@aztec/foundation/curves/bn254';

import {
  decodeMarketLink,
  encodeMarketLink,
  isMarketLink,
  makeVanityMarketSecret,
  vanityPrefixError,
  VANITY_MAX_LENGTH,
} from './market-link.js';

describe('market links', () => {
  it('round-trips an access secret', () => {
    const secret = Fr.random();
    const link = encodeMarketLink(secret);
    expect(decodeMarketLink(link).equals(secret)).toBe(true);
  });

  it('looks like an onion-style address ending in .aztec', () => {
    const link = encodeMarketLink(Fr.random());
    expect(link).toMatch(/^[a-z2-7]{56}\.aztec$/);
  });

  it('is case- and whitespace-tolerant on decode', () => {
    const secret = Fr.random();
    const link = encodeMarketLink(secret);
    expect(decodeMarketLink(`  ${link.toUpperCase()}\n`).equals(secret)).toBe(true);
  });

  it('produces distinct links for distinct secrets', () => {
    expect(encodeMarketLink(new Fr(1n))).not.toEqual(encodeMarketLink(new Fr(2n)));
  });

  it('rejects a mistyped character (checksum)', () => {
    const link = encodeMarketLink(Fr.random());
    const flipped = (link[0] === 'a' ? 'b' : 'a') + link.slice(1);
    expect(() => decodeMarketLink(flipped)).toThrow(/checksum/);
  });

  it('rejects truncation with a clear error', () => {
    const link = encodeMarketLink(Fr.random());
    expect(() => decodeMarketLink(link.slice(4))).toThrow(/truncated|characters/);
  });

  it('rejects the wrong suffix and garbage', () => {
    expect(() => decodeMarketLink('nonsense.onion')).toThrow(/\.aztec/);
    expect(() => decodeMarketLink('0x1234abcd')).toThrow(/\.aztec/);
  });

  it('isMarketLink distinguishes links from hex secrets', () => {
    expect(isMarketLink(encodeMarketLink(Fr.random()))).toBe(true);
    expect(isMarketLink('0x1234abcd')).toBe(false);
  });

  it('builds a vanity secret whose link starts with the prefix (directly, not brute force)', () => {
    for (const prefix of ['cafe', 'ace', 'bead', 'deadbeef']) {
      const secret = makeVanityMarketSecret(prefix);
      const link = encodeMarketLink(secret);
      expect(link.startsWith(prefix)).toBe(true);
      expect(link.endsWith('.aztec')).toBe(true);
      // Still a fully valid, decodable secret.
      expect(decodeMarketLink(link).equals(secret)).toBe(true);
    }
  });

  it('produces a different (random-tailed) secret each call for the same prefix', () => {
    const a = makeVanityMarketSecret('cafe');
    const b = makeVanityMarketSecret('cafe');
    expect(a.equals(b)).toBe(false);
  });

  it('handles a g-boundary prefix (near the field modulus)', () => {
    const link = encodeMarketLink(makeVanityMarketSecret('g'));
    expect(link.startsWith('g')).toBe(true);
  });

  it('rejects unreachable first letters (secret would exceed the field modulus)', () => {
    expect(() => makeVanityMarketSecret('shop')).toThrow(/a to g/); // 's' > 'g'
    expect(() => makeVanityMarketSecret('zoo')).toThrow(/a to g/);
  });

  it('rejects out-of-alphabet characters and over-long prefixes', () => {
    expect(() => makeVanityMarketSecret('a0b')).toThrow(/a-z.*2-7/);
    expect(() => makeVanityMarketSecret('a'.repeat(VANITY_MAX_LENGTH + 1))).toThrow(/at most/);
  });

  it('empty prefix yields a valid random secret', () => {
    const link = encodeMarketLink(makeVanityMarketSecret(''));
    expect(isMarketLink(link)).toBe(true);
  });

  it('vanityPrefixError flags bad first letters, bad chars, and length', () => {
    expect(vanityPrefixError('cafe')).toBeNull();
    expect(vanityPrefixError('')).toBeNull();
    expect(vanityPrefixError('shop')).toMatch(/a to g/);
    expect(vanityPrefixError('a0b')).toMatch(/only a-z and 2-7/);
    expect(vanityPrefixError('a'.repeat(VANITY_MAX_LENGTH + 1))).toMatch(/at most/);
  });
});
