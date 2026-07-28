import { Fr } from '@aztec/foundation/curves/bn254';

import { sealMetadata } from './encryption.js';
import { sampleMarketplaceMetadata } from './fixtures.js';
import {
  openListing,
  sampleListingDocument,
  sealListing,
  validateListingDocument,
} from './listing.js';

const SECRET = new Fr(0x5555n);
const WRONG_SECRET = new Fr(0x6666n);

describe('validateListingDocument', () => {
  function mutated(mutate: (doc: Record<string, unknown>) => void): unknown {
    const doc = JSON.parse(JSON.stringify(sampleListingDocument())) as Record<string, unknown>;
    mutate(doc);
    return doc;
  }

  it('accepts the sample document', () => {
    const doc = sampleListingDocument();
    expect(validateListingDocument(doc)).toEqual(doc);
  });

  it('rejects missing and unknown keys', () => {
    expect(() => validateListingDocument(mutated(d => delete d.options))).toThrow(
      'listing.options is missing',
    );
    expect(() => validateListingDocument(mutated(d => delete d.shipping))).toThrow(
      'listing.shipping is missing',
    );
    expect(() => validateListingDocument(mutated(d => (d.extra = 1)))).toThrow(
      'listing.extra is not part of the schema',
    );
  });

  it('rejects a non-decimal price', () => {
    expect(() => validateListingDocument(mutated(d => (d.options[0].price = '1.5')))).toThrow(
      'listing.options[0].price must be a decimal string',
    );
    expect(() => validateListingDocument(mutated(d => (d.options[0].price = '007')))).toThrow(
      'listing.options[0].price must be a decimal string',
    );

    // The caps mirror the circuit's fixed-size price table: a document that
    // exceeded them could be sealed but never bought.
    expect(() => validateListingDocument(mutated(d => (d.options = [])))).toThrow(
      'listing.options must be an array of 1..8 priced rows',
    );
    expect(() =>
      validateListingDocument(
        mutated(d => (d.options = Array(9).fill({ label: 'x', price: '1' }))),
      ),
    ).toThrow('listing.options must be an array of 1..8 priced rows');
    expect(() =>
      validateListingDocument(
        mutated(d => (d.shipping = Array(5).fill({ label: 'x', price: '1' }))),
      ),
    ).toThrow('listing.shipping must be an array of 1..4 priced rows');
  });

  it('rejects an empty title and an over-long category', () => {
    expect(() => validateListingDocument(mutated(d => (d.title = '')))).toThrow(
      'listing.title must be 1..96 characters',
    );
    expect(
      () => validateListingDocument(mutated(d => (d.category = 'c'.repeat(65)))),
    ).toThrow('listing.category must be 0..64 characters');
  });

  it('rejects an empty or over-long username', () => {
    expect(() => validateListingDocument(mutated(d => (d.username = '')))).toThrow(
      'listing.username must be 1..20 characters',
    );
    expect(() => validateListingDocument(mutated(d => (d.username = 'u'.repeat(21))))).toThrow(
      'listing.username must be 1..20 characters',
    );
  });

  it('accepts inline images and rejects malformed ones', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    expect(() =>
      validateListingDocument(mutated(d => (d.images = [{ mime: 'image/png', dataBase64: png }]))),
    ).not.toThrow();
    expect(() =>
      validateListingDocument(
        mutated(d => (d.images = [{ mime: 'text/html', dataBase64: png }])),
      ),
    ).toThrow('image MIME type');
    expect(() =>
      validateListingDocument(
        mutated(d => (d.images = [{ mime: 'image/png', dataBase64: 'data:image/png;base64,x' }])),
      ),
    ).toThrow('base64');
    expect(() =>
      validateListingDocument(
        mutated(d => (d.images = Array(7).fill({ mime: 'image/png', dataBase64: png }))),
      ),
    ).toThrow('at most 6 images');
  });
});

describe('sealListing / openListing', () => {
  it('round-trips the sample listing', async () => {
    const doc = sampleListingDocument();
    const sealed = await sealListing(doc, SECRET);
    expect(await openListing(sealed.sealed, SECRET)).toEqual(doc);
  });

  it('rejects the wrong secret', async () => {
    const sealed = await sealListing(sampleListingDocument(), SECRET);
    await expect(openListing(sealed.sealed, WRONG_SECRET)).rejects.toThrow(
      'wrong access secret or tampered blob',
    );
  });

  it('is key-domain-separated from metadata blobs', async () => {
    // A sealed METADATA blob must not open as a listing even with the right
    // secret: the derivation contexts differ, so the keys differ.
    const sealedMetadata = await sealMetadata(sampleMarketplaceMetadata(), SECRET);
    await expect(openListing(sealedMetadata.sealed, SECRET)).rejects.toThrow(
      'wrong access secret or tampered blob',
    );
  });

  it('validates the decrypted document', async () => {
    const bad = sampleListingDocument() as unknown as Record<string, unknown>;
    bad.options[0].price = 'free';
    await expect(sealListing(bad, SECRET)).rejects.toThrow(
      'listing.options[0].price must be a decimal',
    );
  });
});
