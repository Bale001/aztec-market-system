import { canonicalize, canonicalBytes } from './canonical.js';

describe('canonicalize', () => {
  it('sorts object keys so insertion order does not matter', () => {
    const a = { zebra: 1, alpha: { nested2: true, nested1: false }, mid: 'x' };
    const b = { mid: 'x', alpha: { nested1: false, nested2: true }, zebra: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(canonicalize(a)).toBe('{"alpha":{"nested1":false,"nested2":true},"mid":"x","zebra":1}');
  });

  it('preserves array order', () => {
    expect(canonicalize([3, 1, 2])).toBe('[3,1,2]');
  });

  it('produces byte-identical output across calls', () => {
    const doc = { name: 'Test', tags: ['a', 'b'], n: 42, none: null };
    expect(Buffer.from(canonicalBytes(doc)).equals(Buffer.from(canonicalBytes(doc)))).toBe(true);
  });

  it('escapes strings exactly like JSON', () => {
    expect(canonicalize({ s: 'quote " backslash \\ newline \n unicode é' })).toBe(
      '{"s":"quote \\" backslash \\\\ newline \\n unicode é"}',
    );
  });

  it('rejects floats with the offending path', () => {
    expect(() => canonicalize({ fee: { bps: 2.5 } })).toThrow('$.fee.bps is 2.5');
  });

  it('rejects NaN, Infinity, and -0', () => {
    expect(() => canonicalize({ x: NaN })).toThrow('only safe integers');
    expect(() => canonicalize({ x: Infinity })).toThrow('only safe integers');
    expect(() => canonicalize({ x: -0 })).toThrow('is -0');
  });

  it('rejects unsafe integers', () => {
    expect(() => canonicalize({ x: 2 ** 53 })).toThrow('only safe integers');
  });

  it('rejects bigint instead of silently coercing', () => {
    expect(() => canonicalize({ deposit: 100n })).toThrow('convert it to a decimal string');
  });

  it('rejects undefined values instead of dropping them', () => {
    expect(() => canonicalize({ a: undefined })).toThrow('$.a is undefined');
    expect(() => canonicalize([1, undefined])).toThrow('$[1] is undefined');
  });

  it('rejects non-plain objects', () => {
    expect(() => canonicalize({ when: new Date(0) })).toThrow('non-plain object (Date)');
    expect(() => canonicalize(new Map())).toThrow('non-plain object (Map)');
  });
});
