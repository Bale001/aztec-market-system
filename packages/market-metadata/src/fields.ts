// Byte <-> field packing for on-chain sealed blobs (AD-3).
//
// Blobs are stored in public contract storage as field chunks, 31 bytes per
// field big-endian (a BN254 field safely holds 31 bytes). The byte length is
// stored separately on-chain; trailing padding inside the last chunk is
// zeros. Mirrors the Marketplace contract's BLOB_* constants.

import { Fr } from '@aztec/foundation/curves/bn254';

export const BLOB_FIELD_BYTES = 31;
export const BLOB_MAX_FIELDS = 128;
/** Hard cap for one sealed blob (metadata or a listing payload). */
export const MAX_SEALED_BLOB_BYTES = BLOB_FIELD_BYTES * BLOB_MAX_FIELDS; // 3968

export function bytesToFields(bytes: Uint8Array): Fr[] {
  const fields: Fr[] = [];
  for (let offset = 0; offset < bytes.length; offset += BLOB_FIELD_BYTES) {
    const chunk = bytes.subarray(offset, offset + BLOB_FIELD_BYTES);
    let value = 0n;
    for (const byte of chunk) {
      value = (value << 8n) | BigInt(byte);
    }
    // Short (final) chunks shift up so the packing is position-stable.
    value <<= 8n * BigInt(BLOB_FIELD_BYTES - chunk.length);
    fields.push(new Fr(value));
  }
  return fields;
}

export function fieldsToBytes(fields: Fr[], byteLength: number): Uint8Array {
  const needed = Math.ceil(byteLength / BLOB_FIELD_BYTES);
  if (fields.length < needed) {
    throw new Error(
      `need ${needed} fields for ${byteLength} bytes, got ${fields.length}`,
    );
  }
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < needed; i++) {
    const field = fields[i];
    if (field === undefined) {
      throw new Error(`field ${i} is missing`);
    }
    // Fr.toBuffer() is 32 bytes big-endian; a 31-byte chunk occupies the low
    // 31 bytes, so drop the leading zero byte.
    const buf = field.toBuffer();
    if (buf[0] !== 0) {
      throw new Error(`field ${i} does not fit in 31 bytes -- not a packed blob chunk`);
    }
    const chunk = buf.subarray(1);
    const start = i * BLOB_FIELD_BYTES;
    const take = Math.min(BLOB_FIELD_BYTES, byteLength - start);
    out.set(chunk.subarray(0, take), start);
  }
  return out;
}

/** Pads a field list to the fixed on-chain array size with zeros. */
export function toBlobArray(fields: Fr[]): Fr[] {
  if (fields.length > BLOB_MAX_FIELDS) {
    throw new Error(`blob has ${fields.length} fields, cap is ${BLOB_MAX_FIELDS}`);
  }
  const out = fields.slice();
  while (out.length < BLOB_MAX_FIELDS) {
    out.push(Fr.ZERO);
  }
  return out;
}
