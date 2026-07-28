import { sampleMarketplaceMetadata } from './fixtures.js';
import { validateMarketplaceMetadata } from './schema.js';

function mutated(mutate: (doc: Record<string, unknown>) => void): unknown {
  const doc = JSON.parse(JSON.stringify(sampleMarketplaceMetadata())) as Record<string, unknown>;
  mutate(doc);
  return doc;
}

describe('validateMarketplaceMetadata', () => {
  it('accepts the sample document', () => {
    const doc = sampleMarketplaceMetadata();
    expect(validateMarketplaceMetadata(doc)).toEqual(doc);
  });

  it('rejects non-objects', () => {
    expect(() => validateMarketplaceMetadata('nope')).toThrow('metadata must be an object');
    expect(() => validateMarketplaceMetadata(null)).toThrow('metadata must be an object');
  });

  it('rejects a wrong schema version', () => {
    expect(() => validateMarketplaceMetadata(mutated(d => (d.schemaVersion = 3)))).toThrow(
      'schemaVersion must be 5',
    );
  });

  it('rejects missing keys', () => {
    expect(() => validateMarketplaceMetadata(mutated(d => delete d.contact))).toThrow(
      'metadata.contact is missing',
    );
  });

  it('rejects unknown keys', () => {
    expect(() => validateMarketplaceMetadata(mutated(d => (d.extra = 1)))).toThrow(
      'metadata.extra is not part of the schema',
    );
  });

  it('rejects an empty name and an overlong name', () => {
    expect(() => validateMarketplaceMetadata(mutated(d => (d.name = '')))).toThrow(
      'metadata.name must be 1..64 characters',
    );
    expect(() => validateMarketplaceMetadata(mutated(d => (d.name = 'x'.repeat(65))))).toThrow(
      'metadata.name must be 1..64 characters',
    );
  });

  it('rejects too many categories', () => {
    expect(
      () => validateMarketplaceMetadata(mutated(d => (d.categories = Array(17).fill('c')))),
    ).toThrow('at most 16 entries');
  });

  it('accepts and validates custom pages (title + Arweave storage id only)', () => {
    const id = 'A'.repeat(43);
    expect(() =>
      validateMarketplaceMetadata(
        mutated(d => (d.pages = [{ title: 'About', storageId: id }])),
      ),
    ).not.toThrow();
    expect(() =>
      validateMarketplaceMetadata(
        mutated(d => (d.pages = Array(9).fill({ title: 'x', storageId: id }))),
      ),
    ).toThrow('metadata.pages must have at most 8 entries');
    expect(() =>
      validateMarketplaceMetadata(mutated(d => (d.pages = [{ title: '', storageId: id }]))),
    ).toThrow('metadata.pages[0].title must be 1..48 characters');
    expect(() =>
      validateMarketplaceMetadata(mutated(d => (d.pages = [{ title: 'x' }]))),
    ).toThrow('metadata.pages[0].storageId is missing');
    // Bodies do not belong on-chain anymore (they live on Arweave).
    expect(() =>
      validateMarketplaceMetadata(
        mutated(d => (d.pages = [{ title: 'x', storageId: id, body: 'inline' }])),
      ),
    ).toThrow('metadata.pages[0].body is not part of the schema');
    expect(() =>
      validateMarketplaceMetadata(mutated(d => (d.pages = [{ title: 'x', storageId: 'short' }]))),
    ).toThrow('metadata.pages[0].storageId must be a Arweave storage id');
  });

  it('mirrors the contract cross-field config rules', () => {
    const onchain = (d: Record<string, unknown>) => d.onchain as Record<string, unknown>;
    expect(
      () => validateMarketplaceMetadata(mutated(d => (onchain(d).paymentAsset = '0x0'))),
    ).toThrow('paymentAsset must not be the zero address');
    // There is no feeRecipient: the fee goes to the market's owner, so a fee
    // can never be misconfigured to an unowned address.
    expect(() =>
      validateMarketplaceMetadata(mutated(d => (onchain(d).feeBps = 0))),
    ).not.toThrow();
    // Deposit-requiring policies need a nonzero deposit (sample has '0').
    expect(
      () => validateMarketplaceMetadata(mutated(d => (onchain(d).vendorPolicy = 2))),
    ).toThrow('vendorDeposit must be positive when the vendor policy requires a deposit');
    expect(
      () => validateMarketplaceMetadata(mutated(d => (onchain(d).vendorPolicy = 3))),
    ).toThrow('vendorDeposit must be positive when the vendor policy requires a deposit');
    expect(() =>
      validateMarketplaceMetadata(
        mutated(d => {
          onchain(d).vendorPolicy = 2;
          onchain(d).vendorDeposit = '1000';
        }),
      ),
    ).not.toThrow();
  });

  it('rejects a malformed accent color', () => {
    expect(
      () =>
        validateMarketplaceMetadata(
          mutated(d => ((d.appearance as Record<string, unknown>).accentColor = 'blue')),
        ),
    ).toThrow('metadata.appearance.accentColor');
  });

  it('rejects a non-hex payment asset', () => {
    expect(
      () =>
        validateMarketplaceMetadata(
          mutated(d => ((d.onchain as Record<string, unknown>).paymentAsset = '12345')),
        ),
    ).toThrow('metadata.onchain.paymentAsset must be a 0x-hex field element');
  });

  it('rejects a non-decimal vendor deposit', () => {
    expect(
      () =>
        validateMarketplaceMetadata(
          mutated(d => ((d.onchain as Record<string, unknown>).vendorDeposit = '0x10')),
        ),
    ).toThrow('metadata.onchain.vendorDeposit must be a decimal string');
  });

  it('rejects fractional feeBps', () => {
    expect(
      () =>
        validateMarketplaceMetadata(
          mutated(d => ((d.onchain as Record<string, unknown>).feeBps = 2.5)),
        ),
    ).toThrow('metadata.onchain.feeBps must be an integer');
  });

  it('rejects out-of-range allowedOutcomes', () => {
    expect(
      () =>
        validateMarketplaceMetadata(
          mutated(d => ((d.onchain as Record<string, unknown>).allowedOutcomes = 0)),
        ),
    ).toThrow('metadata.onchain.allowedOutcomes');
    expect(
      () =>
        validateMarketplaceMetadata(
          mutated(d => ((d.onchain as Record<string, unknown>).allowedOutcomes = 32)),
        ),
    ).toThrow('metadata.onchain.allowedOutcomes');
  });
});
