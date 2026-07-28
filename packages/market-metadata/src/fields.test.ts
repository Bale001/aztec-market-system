import { Fr } from '@aztec/foundation/curves/bn254';

import {
  BLOB_FIELD_BYTES,
  BLOB_MAX_FIELDS,
  MAX_SEALED_BLOB_BYTES,
  bytesToFields,
  fieldsToBytes,
  toBlobArray,
} from './fields.js';

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (i * 31 + 7) % 256;
  }
  return out;
}

describe('bytesToFields / fieldsToBytes', () => {
  it.each([1, 30, 31, 32, 61, 62, 100, 1000, MAX_SEALED_BLOB_BYTES])(
    'round-trips %i bytes',
    length => {
      const bytes = randomBytes(length);
      const fields = bytesToFields(bytes);
      expect(fields.length).toBe(Math.ceil(length / BLOB_FIELD_BYTES));
      const back = fieldsToBytes(fields, length);
      expect(Buffer.from(back).toString('hex')).toBe(Buffer.from(bytes).toString('hex'));
    },
  );

  it('round-trips through the padded on-chain array shape', () => {
    const bytes = randomBytes(95);
    const padded = toBlobArray(bytesToFields(bytes));
    expect(padded.length).toBe(BLOB_MAX_FIELDS);
    const back = fieldsToBytes(padded, 95);
    expect(Buffer.from(back).toString('hex')).toBe(Buffer.from(bytes).toString('hex'));
  });

  it('throws when fields are missing for the claimed length', () => {
    expect(() => fieldsToBytes(bytesToFields(randomBytes(31)), 62)).toThrow('need 2 fields');
  });

  it('throws on a field that is not a packed chunk', () => {
    expect(() => fieldsToBytes([Fr.MAX_FIELD_VALUE], 31)).toThrow('does not fit in 31 bytes');
  });

  it('toBlobArray rejects oversized blobs', () => {
    const oversized = bytesToFields(randomBytes(MAX_SEALED_BLOB_BYTES + 31));
    expect(() => toBlobArray(oversized)).toThrow('cap is 128');
  });
});
