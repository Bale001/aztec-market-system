// Electron main process: a thin shell around the React renderer. The renderer
// runs the embedded Aztec wallet itself (same as the old browser apps); the
// one privileged main-process subsystem is the SimpleX messaging core
// (native addon + SQLite, see simplex.cjs), bridged via preload.cjs.
const { app, BrowserWindow, protocol, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const { registerSimplexIpc, shutdownSimplex } = require('./simplex.cjs');
const { registerWalletConnectIpc, stopWalletConnectServer } = require('./walletconnect.cjs');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;

// Two-party testing on one machine: MARKET_INSTANCE=<name> gives this
// instance its own isolated userData partition (wallet seed, identities,
// messaging database, localStorage) so a second app can play the other side
// of a trade. Without it, two instances would share one wallet AND deadlock
// on the messaging core's SQLite store. Must run before app 'ready'.
const INSTANCE = process.env.MARKET_INSTANCE;
if (INSTANCE) {
  if (!/^[A-Za-z0-9_-]{1,32}$/.test(INSTANCE)) {
    throw new Error('MARKET_INSTANCE must be 1-32 chars of [A-Za-z0-9_-]');
  }
  app.setPath('userData', path.join(app.getPath('userData'), 'instances', INSTANCE));
}

// Serve the packaged renderer over a custom app:// scheme instead of file://.
// v5's PXE runs a SQLite-OPFS worker that loads its WASM via fetch(), and
// Chromium's fetch() categorically refuses file:// URLs ("Failed to fetch"),
// regardless of webSecurity. A privileged standard scheme with supportFetchAPI
// makes fetch work for every bundled asset (sqlite3 WASM, acvm/abi WASM, ...).
// Must be registered before app is ready.
const APP_SCHEME = 'app';
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true, // secure context: OPFS (navigator.storage) requires it
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function registerAppProtocol() {
  const distRoot = path.join(__dirname, '..', 'dist');
  protocol.handle(APP_SCHEME, async request => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = path.normalize(path.join(distRoot, rel));
    // Never serve outside dist (path traversal guard).
    if (!filePath.startsWith(distRoot + path.sep) && filePath !== path.join(distRoot, 'index.html')) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const data = await fs.promises.readFile(filePath);
      const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      return new Response(data, { headers: { 'content-type': mime } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });
}

// v5's PXE persists state in a SQLite-OPFS kv-store whose worker needs
// SharedArrayBuffer (OPFS sync-access handles). Chromium gates SharedArrayBuffer
// behind cross-origin isolation by default; enabling it here makes it available
// in the renderer without COOP/COEP headers, which we can't use anyway (COEP
// require-corp would block the cross-origin fetches to the local node on :8080).
// Without this the SQLite worker crashes on startup and the wallet never opens.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

function isWSL() {
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

// WSLg needs three accommodations, all gated to WSL so native packaged builds
// are untouched:
//  1. Software rendering -- WSLg's GPU is D3D12 passthrough with no DRM node,
//     and Chromium's GPU/compositor path produces an invisible window.
//  2. --disable-dev-shm-usage -- avoids odd shared-memory syscall failures.
//  3. The Ozone platform: Electron defaults to X11 (XWayland), which under
//     WSLg maps a window that never actually paints. WSLg also exposes a
//     native Wayland socket, which DOES paint, so prefer Wayland when present.
//     Override with ELECTRON_OZONE_PLATFORM (e.g. =x11 to force XWayland).
//
// Note: `--no-sandbox` is also required under this WSL2 kernel (the renderer
// seccomp filter breaks shared-memory syscalls), but the sandbox is set up
// before this file runs, so it must be a command-line arg -- the `dev` script
// passes it.
if (isWSL()) {
  app.commandLine.appendSwitch('disable-dev-shm-usage');
  // Defaults that actually paint under WSLg: use the GPU (D3D12/Mesa) path --
  // forcing software rendering pushes the window into "COPY MODE" which
  // renders blank -- and use X11/XWayland (Electron's default Ozone platform),
  // which composites correctly here where native Wayland's COPY MODE did not.
  // Overrides for other setups: ELECTRON_WSL_SOFTWARE=1 forces software
  // rendering; ELECTRON_OZONE_PLATFORM=wayland forces native Wayland.
  if (process.env.ELECTRON_WSL_SOFTWARE === '1') {
    app.disableHardwareAcceleration();
  }
  const ozone = process.env.ELECTRON_OZONE_PLATFORM;
  if (ozone && ozone !== 'x11') {
    app.commandLine.appendSwitch('ozone-platform', ozone);
  }
  // Note: `--no-sandbox` is still required (WSL2 seccomp breaks the renderer's
  // shared-memory syscalls) and is passed on the command line by dev/start.
}

// Open DevTools only when explicitly asked (OPEN_DEVTOOLS=1). Under WSLg the
// detached DevTools shows up as a SECOND window and steals the foreground,
// which makes it look like the app "won't open".
const OPEN_DEVTOOLS = process.env.OPEN_DEVTOOLS === '1';

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 940,
    center: true,
    show: false,
    backgroundColor: '#f4f5f7',
    title: 'Aztec Market',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // This is a local desktop tool that talks to a local Aztec node over
      // http://localhost:8080. Relax web security so the packaged file://
      // origin can reach it (there is no remote content).
      webSecurity: false,
    },
  });

  // Show only once the renderer is ready to paint, then bring it to the
  // front. Avoids a blank window flash and the "hidden behind DevTools" look.
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
    win.moveTop();
  });
  // Fallback: if ready-to-show is slow/missed under WSLg, force it visible.
  setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show();
      win.focus();
    }
  }, 4000);

  // External links (SimpleX contact links, market links) open in the user's
  // browser, not inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      void shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  if (DEV_URL) {
    void win.loadURL(DEV_URL);
  } else {
    // Served by the app:// protocol handler (fetch-capable), not file://.
    void win.loadURL(`${APP_SCHEME}://bundle/index.html`);
  }
  if (OPEN_DEVTOOLS) {
    win.webContents.openDevTools({ mode: 'bottom' });
  }
}

app.whenReady().then(() => {
  registerAppProtocol();
  registerSimplexIpc();
  registerWalletConnectIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Close the SimpleX store cleanly before the process goes away.
let simplexShutdownDone = false;
app.on('before-quit', event => {
  if (simplexShutdownDone) {
    return;
  }
  event.preventDefault();
  void Promise.allSettled([shutdownSimplex(), stopWalletConnectServer()]).finally(() => {
    simplexShutdownDone = true;
    app.quit();
  });
});
