// Market links: the human-facing encoding of a market's access secret,
// styled after Tor v3 onion addresses -- a fixed-length lowercase base32
// string ending in ".aztec".
//
//   link = base32( secret[32] || checksum[2] || version[1] ) + ".aztec"
//
// 35 bytes encode to exactly 56 base32 characters (280 bits / 5), the same
// body length as an onion address. The checksum (2 bytes of a domain-
// separated poseidon2 over the secret+version) catches paste truncations and
// typos immediately with a clear error, instead of the generic "could not
// decrypt the market" failure a corrupted secret would otherwise produce.
// The version byte lets the format evolve without breaking old links.
//
// The link is pure presentation: everything on-chain keys off the secret Fr
// itself (deriveMarketLookupKey, AEAD keys), so old raw-hex secrets and new
// links refer to the same markets.

import { poseidon2HashBytes } from '@aztec/foundation/crypto/sync';
import { Fr } from '@aztec/foundation/curves/bn254';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const LINK_SUFFIX = '.aztec';
const LINK_VERSION = 1;
const SECRET_LEN = 32;
const CHECKSUM_LEN = 2;
const PAYLOAD_LEN = SECRET_LEN + CHECKSUM_LEN + 1; // 35
const BODY_LEN = (PAYLOAD_LEN * 8) / 5; // 56, exact -- no padding needed

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(acc << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(text: string): Uint8Array {
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let bits = 0;
  let acc = 0;
  let index = 0;
  for (const char of text) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new Error(`invalid character "${char}" in market link`);
    }
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (acc >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return out;
}

/** Domain-separated 2-byte checksum over the secret + version. */
function linkChecksum(secret: Uint8Array, version: number): Uint8Array {
  const preimage = Buffer.concat([
    Buffer.from('aztec-market-link'),
    Buffer.from(secret),
    Buffer.from([version]),
  ]);
  // Take the LOW bytes of the hash: the top bytes of a field element skew
  // toward zero, the low bytes are uniform.
  return poseidon2HashBytes(preimage).toBuffer().subarray(32 - CHECKSUM_LEN, 32);
}

/** Encodes a market access secret as a shareable link: `<56 base32 chars>.aztec`. */
export function encodeMarketLink(accessSecret: Fr): string {
  const secret = accessSecret.toBuffer(); // 32 bytes BE
  const payload = new Uint8Array(PAYLOAD_LEN);
  payload.set(secret, 0);
  payload.set(linkChecksum(secret, LINK_VERSION), SECRET_LEN);
  payload[SECRET_LEN + CHECKSUM_LEN] = LINK_VERSION;
  return base32Encode(payload) + LINK_SUFFIX;
}

/**
 * Decodes a market link back into the access secret. Accepts surrounding
 * whitespace and any letter case. Throws a descriptive error on anything
 * malformed -- wrong suffix, wrong length, bad characters, checksum mismatch
 * (a typo or truncated paste), or an unknown format version.
 */
export function decodeMarketLink(link: string): Fr {
  const trimmed = link.trim().toLowerCase();
  if (!trimmed.endsWith(LINK_SUFFIX)) {
    throw new Error(`a market link ends in ${LINK_SUFFIX}`);
  }
  const body = trimmed.slice(0, -LINK_SUFFIX.length);
  if (body.length !== BODY_LEN) {
    throw new Error(
      `market link body must be ${BODY_LEN} characters, got ${body.length} — was it truncated?`,
    );
  }
  const payload = base32Decode(body);
  const version = payload[PAYLOAD_LEN - 1]!;
  if (version !== LINK_VERSION) {
    throw new Error(`unknown market link version ${version}`);
  }
  const secret = payload.subarray(0, SECRET_LEN);
  const expected = linkChecksum(secret, version);
  const actual = payload.subarray(SECRET_LEN, SECRET_LEN + CHECKSUM_LEN);
  if (expected[0] !== actual[0] || expected[1] !== actual[1]) {
    throw new Error('market link checksum mismatch — the link was mistyped or corrupted');
  }
  // Range-check explicitly: Fr construction must not accept >= modulus bytes.
  const value = BigInt('0x' + Buffer.from(secret).toString('hex'));
  if (value >= Fr.MODULUS) {
    throw new Error('market link does not encode a valid field element');
  }
  return new Fr(value);
}

/** True if the text looks like a market link (suffix check only, no validation). */
export function isMarketLink(text: string): boolean {
  return text.trim().toLowerCase().endsWith(LINK_SUFFIX);
}

/** The set of characters a vanity prefix may use (the base32 alphabet). */
export const VANITY_ALPHABET = BASE32_ALPHABET;

/**
 * Max vanity prefix length. Each char pins 5 bits of the 256-bit secret; the
 * random remainder is what keeps a market link unguessable, so we cap the
 * prefix to leave a comfortable entropy margin (20 chars = 100 bits pinned,
 * ~150+ bits random -- still astronomically unguessable).
 */
export const VANITY_MAX_LENGTH = 20;

/**
 * A market link is base32 of the secret, so a vanity prefix is not brute-forced
 * (as with Tor keypairs) -- we place the prefix's bits directly at the top of
 * the secret and randomize the rest. Instant and deterministic.
 *
 * The one constraint: a valid access secret must be BELOW the field modulus
 * (~2^253.6 of 2^256), which caps the top bits -- so a link can only start with
 * `a`-`g`. A prefix that would force the secret at or above the modulus is
 * unreachable and throws a clear error (the random tail is re-rolled a bounded
 * number of times first, which resolves the `g`-boundary cases).
 *
 * @returns a random access secret whose link body starts with `prefix`.
 */
export function makeVanityMarketSecret(prefix: string): Fr {
  const p = prefix.trim().toLowerCase();
  if (p === '') {
    return Fr.random();
  }
  if (p.length > VANITY_MAX_LENGTH) {
    throw new Error(`a vanity prefix can be at most ${VANITY_MAX_LENGTH} characters`);
  }
  // Pack the prefix into its high bits: char i occupies bits [5i, 5i+5) from
  // the top of the 256-bit secret.
  let packed = 0n;
  for (const char of p) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value < 0) {
      throw new Error(
        `"${char}" can't appear in a market link — use only letters a-z and digits 2-7`,
      );
    }
    packed = (packed << 5n) | BigInt(value);
  }
  const tailBits = BigInt(256 - 5 * p.length);
  const high = packed << tailBits;
  const tailMask = (1n << tailBits) - 1n;

  // Fill the low bits with fresh entropy; re-roll if the result lands >= the
  // field modulus (only possible near the top of the range, e.g. a `g` start).
  for (let i = 0; i < 4096; i++) {
    const value = high | (Fr.random().toBigInt() & tailMask);
    if (value < Fr.MODULUS) {
      return new Fr(value);
    }
  }
  throw new Error(
    `a market link can't start with "${p}" — it must begin with a letter from a to g`,
  );
}

/**
 * Human-readable feasibility of a vanity prefix for live UI feedback: null if
 * it's usable, otherwise a short reason it isn't (bad character, too long, or
 * an unreachable first letter).
 */
export function vanityPrefixError(prefix: string): string | null {
  const p = prefix.trim().toLowerCase();
  if (p === '') {
    return null;
  }
  if (p.length > VANITY_MAX_LENGTH) {
    return `at most ${VANITY_MAX_LENGTH} characters`;
  }
  for (const char of p) {
    if (!BASE32_ALPHABET.includes(char)) {
      return `"${char}" isn't allowed — use only a-z and 2-7`;
    }
  }
  if (!'abcdefg'.includes(p[0]!)) {
    return 'a market link must start with a letter from a to g';
  }
  return null;
}
