// Hash/commitment format guards shared by the store (node) and the client
// (browser). Must stay free of node-only imports.

const HASH_HEX = /^[0-9a-f]{64}$/;
const COMMITMENT_HEX = /^0x[0-9a-f]{64}$/;

export function assertContentHashHex(value: string): void {
  if (!HASH_HEX.test(value)) {
    throw new Error(`invalid content hash: expected 64 lowercase hex chars, got "${value}"`);
  }
}

export function assertCommitmentHex(value: string): void {
  if (!COMMITMENT_HEX.test(value)) {
    throw new Error(
      `invalid commitment: expected 0x + 64 lowercase hex chars, got "${value}"`,
    );
  }
}
