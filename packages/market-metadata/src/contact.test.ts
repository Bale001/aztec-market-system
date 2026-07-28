import { Fr } from '@aztec/foundation/curves/bn254';

import {
  CONTACT_MAX_SEALED_BYTES,
  MAX_CONTACT_ADDRESS_CHARS,
  openContactAddress,
  sealContactAddress,
} from './contact.js';

const SIMPLEX_ADDRESS =
  'https://simplex.chat/contact#/?v=2-7&smp=smp%3A%2F%2F0YuTwO05YJWS8rkjn9eLJDjQhFKvIYd8d4xG8X1blIU%3D%40smp8.simplex.im%2FabcdefghijABCDEFGHIJ0123456789ab%23%2F%3Fv%3D1-3%26dh%3DMCowBQYDK2VuAyEAabcdefghijklmnopqrstuvwxyz012345%253d';

describe('attested contact addresses (AD-6)', () => {
  const secret = Fr.random();

  it('round-trips a realistic SimpleX address within the on-chain budget', async () => {
    const sealed = await sealContactAddress(SIMPLEX_ADDRESS, secret);
    expect(sealed.length).toBeLessThanOrEqual(CONTACT_MAX_SEALED_BYTES);
    await expect(openContactAddress(sealed, secret)).resolves.toBe(SIMPLEX_ADDRESS);
  });

  it('fits even a maximum-length address', async () => {
    const long = 'https://simplex.chat/contact#/'.padEnd(MAX_CONTACT_ADDRESS_CHARS, 'x');
    const sealed = await sealContactAddress(long, secret);
    expect(sealed.length).toBeLessThanOrEqual(CONTACT_MAX_SEALED_BYTES);
    await expect(openContactAddress(sealed, secret)).resolves.toBe(long);
  });

  it('rejects an oversized or empty address at seal time', async () => {
    await expect(
      sealContactAddress('x'.repeat(MAX_CONTACT_ADDRESS_CHARS + 1), secret),
    ).rejects.toThrow(/contact\.address/);
    await expect(sealContactAddress('   ', secret)).rejects.toThrow(/contact\.address/);
  });

  it('a different secret cannot open the blob', async () => {
    const sealed = await sealContactAddress(SIMPLEX_ADDRESS, secret);
    await expect(openContactAddress(sealed, Fr.random())).rejects.toThrow();
  });

  it('rejects a tampered blob', async () => {
    const sealed = await sealContactAddress(SIMPLEX_ADDRESS, secret);
    sealed[sealed.length - 1]! ^= 0x01;
    await expect(openContactAddress(sealed, secret)).rejects.toThrow();
  });
});
