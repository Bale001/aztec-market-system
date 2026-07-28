import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// Relative base so the packaged app can load the bundle over file://.
export default defineConfig({
  base: './',
  plugins: [
    react(),
    // aztec.js and our packages use Buffer and node built-ins in the renderer.
    nodePolyfills({ globals: { Buffer: true, process: true }, protocolImports: true }),
  ],
  server: { port: 5175 },
  // Treat .wasm as assets to be served as-is, not parsed as modules.
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    // Exclude packages that resolve workers/WASM via `new URL(..., import.meta.url)`.
    // Pre-bundling rewrites import.meta.url into the .vite/deps directory, which
    // breaks the relative path to the asset. IMPORTANT: excluding the asset owner
    // alone is NOT enough -- if an optimized package imports it, the optimizer
    // inlines it into that package's bundle anyway. So the whole import chain
    // down to the worker must be excluded:
    //   - @aztec/wallets (EmbeddedWallet) -> @aztec/pxe -> @aztec/kv-store
    //     (spawns the SQLite-OPFS worker, v5 PXE storage)
    //   - @aztec/sqlite3mc-wasm is the SQLite WASM that worker loads
    exclude: [
      '@aztec/bb.js',
      '@aztec/noir-acvm_js',
      '@aztec/noir-noirc_abi',
      '@aztec/wallets',
      '@aztec/pxe',
      '@aztec/kv-store',
      '@aztec/key-store',
      '@aztec/sqlite3mc-wasm',
    ],
    esbuildOptions: { target: 'es2022' },
  },
  build: { target: 'es2022', outDir: 'dist' },
});
