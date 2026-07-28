// Confirms which Barretenberg backend a given BackendType actually resolves to,
// and whether a native bb process is spawned. Guards the benchmark against
// silently measuring WASM twice.

import { Barretenberg, BackendType } from '@aztec/bb.js';
import { findBbBinary } from '@aztec/bb.js/platform';
import { execSync } from 'node:child_process';

const want = process.argv[2];
console.log('findBbBinary() ->', findBbBinary() ?? 'NOT FOUND');
console.log('BackendType values:', Object.values(BackendType).join(', '));

const bbBefore = Number(execSync('pgrep -c bb || true').toString().trim() || 0);
const api = await Barretenberg.new({ backend: want });
const bbAfter = Number(execSync('pgrep -c bb || true').toString().trim() || 0);

// The backend instance is private; its constructor name is the ground truth.
const backend = Object.values(api).find(v => v && v.constructor && /Backend|Socket|Wasm|Shm|Pipe/.test(v.constructor.name));
console.log(`requested=${want}  actualBackendClass=${backend?.constructor?.name ?? 'unknown'}`);
console.log(`bb processes: before=${bbBefore} after=${bbAfter}`);
await api.destroy();
process.exit(0);
