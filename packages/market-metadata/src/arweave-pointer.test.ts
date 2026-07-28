import { Fr } from '@aztec/foundation/curves/bn254';

import {
  openArweavePointer,
  POINTER_FIELDS,
  POINTER_SEALED_BYTES,
  sealArweavePointer,
} from './arweave-pointer.js';
import { bytesToFields, fieldsToBytes } from './fields.js';

// A realistic Arweave tx id: 43 base64url chars (incl. - and _) = 32 bytes.
const TX_ID = 'nRon6MCXeWuhBLIW0aqZEg4ecc4wlb0R6ZdK_8sHV-Q';

describe('arweave listing pointers', () => {
  const secret = new Fr(123456789n);

  it('round-trips a tx id through seal/open', async () => {
    const sealed = await sealArweavePointer(TX_ID, secret);
    expect(sealed.length).toBe(POINTER_SEALED_BYTES);
    expect(await openArweavePointer(sealed, secret)).toBe(TX_ID);
  });

  it('packs into exactly POINTER_FIELDS fields and survives the round trip', async () => {
    const sealed = await sealArweavePointer(TX_ID, secret);
    const fields = bytesToFields(sealed);
    expect(fields.length).toBe(POINTER_FIELDS);
    const unpacked = fieldsToBytes(fields, POINTER_SEALED_BYTES);
    expect(await openArweavePointer(unpacked, secret)).toBe(TX_ID);
  });

  it('rejects the wrong access secret (GCM auth)', async () => {
    const sealed = await sealArweavePointer(TX_ID, secret);
    await expect(openArweavePointer(sealed, new Fr(42n))).rejects.toThrow(/decryption failed/);
  });

  it('rejects tampered pointers', async () => {
    const sealed = await sealArweavePointer(TX_ID, secret);
    sealed[20] ^= 0xff;
    await expect(openArweavePointer(sealed, secret)).rejects.toThrow(/decryption failed/);
  });

  it('rejects malformed tx ids', async () => {
    await expect(sealArweavePointer('too-short', secret)).rejects.toThrow(/transaction id/);
    await expect(sealArweavePointer('x'.repeat(44), secret)).rejects.toThrow(/transaction id/);
  });

  it('rejects blobs of the wrong length', async () => {
    await expect(openArweavePointer(new Uint8Array(60), secret)).rejects.toThrow(/61 bytes/);
  });
});
