// Deterministic ("canonical") JSON serialization — PLAN.md D5.
//
// Rules (a strict subset of RFC 8785 JCS):
// - object keys sorted lexicographically (by UTF-16 code units)
// - no whitespace
// - numbers must be safe integers (floats, NaN, Infinity, -0 are rejected;
//   large/decimal quantities belong in the schema as decimal strings)
// - undefined, functions, symbols, bigints, and non-plain objects are
//   rejected outright rather than silently dropped or coerced
//
// The same input value always yields byte-identical output, which is what
// makes content hashes and on-chain commitments over metadata meaningful.

export function canonicalize(value: unknown): string {
  return serialize(value, '$');
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

function serialize(value: unknown, path: string): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isSafeInteger(value)) {
        throw new Error(
          `canonicalize: ${path} is ${value}; only safe integers are allowed ` +
            '(represent decimals and large quantities as strings)',
        );
      }
      if (Object.is(value, -0)) {
        throw new Error(`canonicalize: ${path} is -0; use 0`);
      }
      return String(value);
    }
    case 'bigint':
      throw new Error(`canonicalize: ${path} is a bigint; convert it to a decimal string`);
    case 'undefined':
      throw new Error(`canonicalize: ${path} is undefined; use null or omit the key`);
    case 'function':
    case 'symbol':
      throw new Error(`canonicalize: ${path} is a ${typeof value}, which cannot be serialized`);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialize(item, `${path}[${i}]`)).join(',')}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(
          `canonicalize: ${path} is a non-plain object (${proto?.constructor?.name ?? 'unknown'})`,
        );
      }
      const keys = Object.keys(value as Record<string, unknown>).sort();
      const entries = keys.map(key => {
        const child = (value as Record<string, unknown>)[key];
        if (child === undefined) {
          throw new Error(`canonicalize: ${path}.${key} is undefined; use null or omit the key`);
        }
        return `${JSON.stringify(key)}:${serialize(child, `${path}.${key}`)}`;
      });
      return `{${entries.join(',')}}`;
    }
    default:
      throw new Error(`canonicalize: ${path} has unsupported type ${typeof value}`);
  }
}
