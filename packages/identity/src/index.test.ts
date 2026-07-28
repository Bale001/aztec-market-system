import { Fr } from '@aztec/foundation/curves/bn254';
import {
  DOMAIN_ESCROW_KEYS,
  DOMAIN_IDENTITY,
  DOMAIN_MARKET_LOOKUP,
  DOMAIN_METADATA,
  DOMAIN_ORDER_ID,
  DOMAIN_ORDER_SETTLEMENT,
  DOMAIN_PRICE_BLINDING,
  DOMAIN_PRICE_COMMITMENT,
  DOMAIN_VENDOR_REGISTRATION,
} from '@market/shared-types';

import {
  deriveActionNullifier,
  deriveMarketLookupKey,
  deriveMarketplaceId,
  deriveMarketplaceIdentity,
  deriveOrderId,
  deriveOrderSettlementNullifier,
  derivePriceBlinding,
  derivePriceCommitment,
  packSelection,
  unpackSelection,
  generateMarketAccessSecret,
  generateUserSecret,
  toFr,
} from './index.js';

const SECRET = 0x1234n;
const OTHER_SECRET = 0x5678n;
const MARKET_A = 0xaaaan;
const MARKET_B = 0xbbbbn;

describe('domain constants', () => {
  it('are pairwise distinct', () => {
    const domains = [
      DOMAIN_IDENTITY,
      DOMAIN_VENDOR_REGISTRATION,
      DOMAIN_ORDER_SETTLEMENT,
      DOMAIN_METADATA,
      DOMAIN_MARKET_LOOKUP,
      DOMAIN_PRICE_BLINDING,
      DOMAIN_PRICE_COMMITMENT,
      // Retired but still checked: the point of keeping it is that no
      // future domain reuses the number.
      DOMAIN_ESCROW_KEYS,
      DOMAIN_ORDER_ID,
    ];
    expect(new Set(domains).size).toBe(domains.length);
  });
});

describe('cross-language vectors (must equal market_protocol Noir tests)', () => {
  // Mirrored in contracts/market-protocol/src/test.nr::matches_typescript_vectors.
  // If these change, the protocol changed — update both sides in one commit.
  it('deriveMarketplaceId(0x1111, 7, 0x2222)', async () => {
    const id = await deriveMarketplaceId(0x1111n, 7n, 0x2222n);
    expect(id.toString()).toBe(
      '0x144a87d92cb61ea880a399e60ff1f09df4518c1c5bbf21d03eb1c3dce60c10cd',
    );
  });

  it('deriveMarketplaceIdentity(0x1234, 0xaaaa)', async () => {
    const identity = await deriveMarketplaceIdentity(SECRET, MARKET_A);
    expect(identity.toString()).toBe(
      '0x219817ba9ec2a8adde00c4d4daa0b034c285269f06e55fa08e2f18d7bedb6120',
    );
  });

  it('deriveActionNullifier(0x1234, 0xaaaa, ORDER_SETTLEMENT, 0x77)', async () => {
    const nullifier = await deriveActionNullifier(
      SECRET,
      MARKET_A,
      DOMAIN_ORDER_SETTLEMENT,
      0x77n,
    );
    expect(nullifier.toString()).toBe(
      '0x279cfc4c8f0af0d45239d2ef56596a5c7c2de9bc92848d822583a16f6a223ef4',
    );
  });

  it('deriveMarketLookupKey(0x5555)', async () => {
    const lookupKey = await deriveMarketLookupKey(0x5555n);
    expect(lookupKey.toString()).toBe(
      '0x1e46d6657fc6ba7909b26ad684fddb694928a6dd7905ced5461499275afe6369',
    );
  });

  it('derivePriceBlinding(0x5555, 3) and derivePriceCommitment over a table', async () => {
    const blinding = await derivePriceBlinding(0x5555n, 3n);
    expect(blinding.toString()).toBe(
      '0x084f0884e8c43ec61ea80cf46eba1a83e9965397fd5aa93107f262b6470ff9e0',
    );
    // Two variants, two shipping methods -- the vector the Noir side pins.
    const commitment = await derivePriceCommitment([10n, 20n], [5n, 7n], blinding);
    expect(commitment.toString()).toBe('0x00e862019d00348bfe4223fdbb1b16f1a4950bc45af9d2a304d6f2ae71912ded');
  });

  it('deriveOrderId, deriveOrderSettlementNullifier', async () => {
    const orderId = await deriveOrderId(MARKET_A, 3n, SECRET, 0x77n);
    expect(orderId.toString()).toBe(
      '0x268e6130ddc3bd0be3295d1a98f0f82324d17a1b3ee2b6955a4eab6b1b8df616',
    );
    const settle = await deriveOrderSettlementNullifier(orderId);
    expect(settle.toString()).toBe(
      '0x2b543ef4a7c6343de432296820f07044a587c8d3d336a1b7abcbfd98481b2b47',
    );
  });
});

describe('order ids', () => {
  it('are scoped per market, listing, buyer, and nonce', async () => {
    const base = await deriveOrderId(MARKET_A, 3n, 0x1234n, 0x77n);
    expect((await deriveOrderId(MARKET_B, 3n, 0x1234n, 0x77n)).equals(base)).toBe(false);
    expect((await deriveOrderId(MARKET_A, 4n, 0x1234n, 0x77n)).equals(base)).toBe(false);
    expect((await deriveOrderId(MARKET_A, 3n, 0x9999n, 0x77n)).equals(base)).toBe(false);
    expect((await deriveOrderId(MARKET_A, 3n, 0x1234n, 0x78n)).equals(base)).toBe(false);
  });
});

describe('price commitments', () => {
  it('blinding is scoped per listing and per secret', async () => {
    const base = await derivePriceBlinding(SECRET, 1n);
    expect((await derivePriceBlinding(SECRET, 2n)).equals(base)).toBe(false);
    expect((await derivePriceBlinding(OTHER_SECRET, 1n)).equals(base)).toBe(false);
  });

  it('equal prices produce unlinkable commitments', async () => {
    const price = 995n;
    const a = await derivePriceCommitment([price], [0n], await derivePriceBlinding(SECRET, 1n));
    const b = await derivePriceCommitment([price], [0n], await derivePriceBlinding(SECRET, 2n));
    expect(a.equals(b)).toBe(false);
  });

  it('commitment binds the price', async () => {
    const blinding = await derivePriceBlinding(SECRET, 1n);
    const a = await derivePriceCommitment([1000n], [0n], blinding);
    const b = await derivePriceCommitment([1001n], [0n], blinding);
    expect(a.equals(b)).toBe(false);
  });

  it('commitment binds every row and both counts', async () => {
    const blinding = await derivePriceBlinding(SECRET, 1n);
    const base = await derivePriceCommitment([10n, 20n], [5n, 7n], blinding);
    // Any priced row moving changes it...
    expect((await derivePriceCommitment([10n, 21n], [5n, 7n], blinding)).equals(base)).toBe(false);
    expect((await derivePriceCommitment([10n, 20n], [5n, 8n], blinding)).equals(base)).toBe(false);
    // ...and so does the SHAPE, so a vendor cannot reveal an extra row later.
    expect((await derivePriceCommitment([10n, 20n, 30n], [5n, 7n], blinding)).equals(base)).toBe(
      false,
    );
  });

  it('rejects a table that cannot fit the circuit', async () => {
    const blinding = await derivePriceBlinding(SECRET, 1n);
    await expect(derivePriceCommitment([], [0n], blinding)).rejects.toThrow(/1\.\.8 options/);
    await expect(
      derivePriceCommitment(Array(9).fill(1n), [0n], blinding),
    ).rejects.toThrow(/1\.\.8 options/);
    await expect(
      derivePriceCommitment([1n], Array(5).fill(1n), blinding),
    ).rejects.toThrow(/1\.\.4 shipping/);
  });

  it('selection packing round-trips both indices', () => {
    expect(packSelection(3, 2).toBigInt()).toBe(3n * 256n + 2n);
    expect(unpackSelection(packSelection(3, 2))).toEqual({ optionIndex: 3, shippingIndex: 2 });
    expect(unpackSelection(packSelection(0, 0))).toEqual({ optionIndex: 0, shippingIndex: 0 });
    expect(packSelection(1, 0).equals(packSelection(0, 1))).toBe(false);
  });
});

describe('generateUserSecret', () => {
  it('returns distinct high-entropy secrets', () => {
    const a = generateUserSecret();
    const b = generateUserSecret();
    expect(a.equals(b)).toBe(false);
    expect(a.isZero()).toBe(false);
  });
});

describe('deriveMarketLookupKey', () => {
  it('differs per secret', async () => {
    const a = await deriveMarketLookupKey(SECRET);
    const b = await deriveMarketLookupKey(OTHER_SECRET);
    expect(a.equals(b)).toBe(false);
  });
});

describe('generateMarketAccessSecret', () => {
  it('returns distinct high-entropy secrets', () => {
    const a = generateMarketAccessSecret();
    const b = generateMarketAccessSecret();
    expect(a.equals(b)).toBe(false);
    expect(a.isZero()).toBe(false);
  });
});

describe('deriveMarketplaceId', () => {
  it('is deterministic', async () => {
    const a = await deriveMarketplaceId(0x1111n, 7n, 0x2222n);
    const b = await deriveMarketplaceId(0x1111n, 7n, 0x2222n);
    expect(a.equals(b)).toBe(true);
  });

  it('changes with each input', async () => {
    const base = await deriveMarketplaceId(0x1111n, 7n, 0x2222n);
    expect((await deriveMarketplaceId(0x9999n, 7n, 0x2222n)).equals(base)).toBe(false);
    expect((await deriveMarketplaceId(0x1111n, 8n, 0x2222n)).equals(base)).toBe(false);
    expect((await deriveMarketplaceId(0x1111n, 7n, 0x3333n)).equals(base)).toBe(false);
  });
});

describe('deriveMarketplaceIdentity', () => {
  it('is scoped per marketplace', async () => {
    const idA = await deriveMarketplaceIdentity(SECRET, MARKET_A);
    const idB = await deriveMarketplaceIdentity(SECRET, MARKET_B);
    expect(idA.equals(idB)).toBe(false);
  });

  it('differs per user', async () => {
    const mine = await deriveMarketplaceIdentity(SECRET, MARKET_A);
    const theirs = await deriveMarketplaceIdentity(OTHER_SECRET, MARKET_A);
    expect(mine.equals(theirs)).toBe(false);
  });

  it('does not collide with nullifiers reusing DOMAIN_IDENTITY', async () => {
    const identity = await deriveMarketplaceIdentity(SECRET, MARKET_A);
    const nullifier = await deriveActionNullifier(SECRET, MARKET_A, DOMAIN_IDENTITY, 0n);
    expect(identity.equals(nullifier)).toBe(false);
  });
});

describe('deriveActionNullifier', () => {
  it('is domain-separated', async () => {
    const settle = await deriveActionNullifier(SECRET, MARKET_A, DOMAIN_ORDER_SETTLEMENT, 0x77n);
    const register = await deriveActionNullifier(
      SECRET,
      MARKET_A,
      DOMAIN_VENDOR_REGISTRATION,
      0x77n,
    );
    expect(settle.equals(register)).toBe(false);
  });

  it('is subject-separated', async () => {
    const a = await deriveActionNullifier(SECRET, MARKET_A, DOMAIN_ORDER_SETTLEMENT, 1n);
    const b = await deriveActionNullifier(SECRET, MARKET_A, DOMAIN_ORDER_SETTLEMENT, 2n);
    expect(a.equals(b)).toBe(false);
  });
});

describe('toFr', () => {
  it('accepts Fr, bigint, and toField() objects', () => {
    const fr = new Fr(42n);
    expect(toFr(fr, 'x').equals(fr)).toBe(true);
    expect(toFr(42n, 'x').equals(fr)).toBe(true);
    expect(toFr({ toField: () => fr }, 'x').equals(fr)).toBe(true);
  });

  it('throws on unsupported values instead of falling back', () => {
    expect(() => toFr({} as never, 'creator')).toThrow(
      'creator: expected an Fr, bigint, or object with toField()',
    );
  });
});
