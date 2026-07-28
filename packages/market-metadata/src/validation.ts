// Shared validation helpers for canonical documents (metadata + listings).
// Every helper throws on the first problem; nothing is defaulted or coerced.

export const FIELD_HEX = /^0x[0-9a-fA-F]{1,64}$/;
export const DECIMAL = /^(0|[1-9][0-9]*)$/;
/** An Arweave transaction id: 43 base64url characters (32 bytes). */
export const ARWEAVE_TX_ID = /^[A-Za-z0-9_-]{43}$/;

export function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireExactKeys(
  obj: Record<string, unknown>,
  name: string,
  keys: string[],
): void {
  const actual = Object.keys(obj);
  for (const key of keys) {
    if (!(key in obj)) {
      throw new Error(`${name}.${key} is missing`);
    }
  }
  for (const key of actual) {
    if (!keys.includes(key)) {
      throw new Error(`${name}.${key} is not part of the schema`);
    }
  }
}

export function requireString(
  value: unknown,
  name: string,
  len: { min: number; max: number },
): void {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  if (value.length < len.min || value.length > len.max) {
    throw new Error(`${name} must be ${len.min}..${len.max} characters, got ${value.length}`);
  }
}

export function requireStringOrNull(
  value: unknown,
  name: string,
  len: { min: number; max: number },
): void {
  if (value === null) {
    return;
  }
  requireString(value, name, len);
}

export function requireStringArray(
  value: unknown,
  name: string,
  limits: { maxEntries: number; minLen: number; maxLen: number },
): void {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  if (value.length > limits.maxEntries) {
    throw new Error(`${name} must have at most ${limits.maxEntries} entries`);
  }
  value.forEach((entry, i) =>
    requireString(entry, `${name}[${i}]`, { min: limits.minLen, max: limits.maxLen }),
  );
}

export function requirePattern(
  value: unknown,
  name: string,
  pattern: RegExp,
  expected: string,
): void {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`${name} must be a ${expected}, got ${String(value)}`);
  }
}

export function requireInt(
  value: unknown,
  name: string,
  range: { min: number; max?: number },
): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
  if (value < range.min || (range.max !== undefined && value > range.max)) {
    throw new Error(
      `${name} must be in [${range.min}, ${range.max ?? 'inf'}], got ${value}`,
    );
  }
}
