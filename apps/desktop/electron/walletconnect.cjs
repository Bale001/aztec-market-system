// External-wallet connection relay (the "web wallet URL" endpoint).
//
// Third-party dApps -- notably the Shield (human.tech) bridge -- connect to an
// Aztec wallet using the @aztec/wallet-sdk iframe transport: the dApp loads a
// "web wallet URL" in a cross-origin iframe and speaks an encrypted postMessage
// protocol to it. We host that URL here, but the page we serve is a DUMB RELAY:
// it does no crypto and holds no keys. It forwards raw postMessage frames over a
// localhost WebSocket to the Electron MAIN process, which forwards them (over
// IPC) to the renderer, where the REAL wallet handler runs -- ECDH key exchange,
// AES-GCM decrypt/encrypt, the emoji verification, discovery approval, and the
// actual EmbeddedWallet dispatch all live in the app, with native UI. The relay
// only ever sees ciphertext (plus the unencrypted discovery/key-exchange
// envelopes), never plaintext wallet calls or any key.
//
//   Shield tab
//     └─ iframe: relay page (127.0.0.1:PORT) --WS--> main --IPC--> renderer
//          ▲ encrypted postMessage with Shield          (handler + wallet + UI)
//
// IMPORTANT: the SDK opens our URL as SEVERAL iframes at once -- a hidden
// discovery probe plus the real connection panel (and it may probe more than one
// wallet URL). Each iframe is a separate relay page with its own WebSocket, all
// alive simultaneously. So we support MANY concurrent channels, each addressed
// by a stable channel id the relay page mints once and re-announces on every
// (re)connect. Frames to the renderer carry their channel id; responses are
// routed back to that channel's current socket. (A single "newest wins" socket
// made the iframes fight and flap.)
//
// The server runs only while the user has "Connect an external wallet" enabled
// in the Wallet tab, and binds to 127.0.0.1 only.
const http = require('node:http');
const { ipcMain, BrowserWindow } = require('electron');
const { WebSocketServer } = require('ws');

// Preferred port first (so the URL the user pastes into Shield is stable across
// launches); fall back upward if it's taken (e.g. a second MARKET_INSTANCE).
const PREFERRED_PORT = 8790;
const MAX_PORT = 8810;

let server = null; // http.Server
let wss = null; // WebSocketServer
const channels = new Map(); // channelId -> live ws
let boundPort = null;

// The exact page the relay iframe loads. Vanilla JS, no bundle, no dependencies.
// It bridges the parent (dApp) postMessage channel to the localhost WebSocket in
// both directions and nothing else. It mints one stable channel id per page load
// and announces it on every WS (re)connect so the app can address this exact
// iframe for its whole lifetime, even across a transient socket drop.
const RELAY_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Aztec Market — wallet relay</title>
<style>
  html,body{margin:0;height:100%;font:13px/1.5 system-ui,sans-serif;color:#5b6472;background:#fff}
  .wrap{display:flex;align-items:center;justify-content:center;height:100%;padding:12px;text-align:center}
</style>
</head>
<body>
<div class="wrap"><div>Aztec&nbsp;Market wallet relay — approve the connection in the desktop app.</div></div>
<script>
(function () {
  var wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/relay';
  var channelId = (window.crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : String(Date.now()) + '-' + Math.random().toString(16).slice(2);
  var ws = null;
  var outbox = [];

  function flush() {
    if (!ws || ws.readyState !== 1) return;
    while (outbox.length) ws.send(outbox.shift());
  }

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = function () {
      // Announce (or re-announce) which channel this socket belongs to.
      ws.send(JSON.stringify({ __channel: channelId }));
      flush();
    };
    ws.onmessage = function (ev) {
      var frame;
      try { frame = JSON.parse(ev.data); } catch (e) { return; }
      if (window.parent === window) return;
      window.parent.postMessage(frame.data, frame.origin === '*' ? '*' : frame.origin);
    };
    ws.onclose = function () { ws = null; setTimeout(connect, 1000); };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  }
  connect();

  // Parent (the dApp embedding us) -> app. Only relay messages from our embedder.
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    if (!e.data || typeof e.data !== 'object' || typeof e.data.type !== 'string') return;
    var payload = JSON.stringify({ origin: e.origin, data: e.data });
    if (ws && ws.readyState === 1) ws.send(payload);
    else outbox.push(payload);
  });
})();
</script>
</body>
</html>
`;

function broadcastToRenderer(channel, payload) {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

function handleUpgradeOrigin(origin) {
  // The relay page loads it same-origin, so its WS Origin is our own served
  // origin. Reject anything else -- a random web page must not open the relay.
  // (A native process could still spoof this, but every session is gated behind
  // an explicit in-app approval + emoji check, so a spoofed relay can do
  // nothing without the user approving a connection they didn't initiate.)
  if (!origin) return false;
  return origin === `http://127.0.0.1:${boundPort}` || origin === `http://localhost:${boundPort}`;
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(RELAY_PAGE);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
    srv.on('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

async function startWalletConnectServer() {
  if (server !== null && boundPort !== null) {
    return { url: `http://127.0.0.1:${boundPort}/`, port: boundPort };
  }
  let lastErr = null;
  for (let port = PREFERRED_PORT; port <= MAX_PORT; port++) {
    try {
      server = await listen(port);
      boundPort = port;
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'EADDRINUSE') continue;
      throw err;
    }
  }
  if (server === null) {
    throw lastErr ?? new Error('could not bind the wallet-connect relay to any port');
  }

  wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/relay' || !handleUpgradeOrigin(req.headers.origin)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('message', raw => {
        let frame;
        try { frame = JSON.parse(raw.toString()); } catch { return; }
        if (!frame || typeof frame !== 'object') return;
        // First frame on every (re)connect: which channel is this socket?
        if (typeof frame.__channel === 'string') {
          const channelId = frame.__channel;
          const existing = channels.get(channelId);
          if (existing !== undefined && existing !== ws) {
            try { existing.close(); } catch { /* ignore */ }
          }
          ws._channelId = channelId;
          channels.set(channelId, ws);
          broadcastToRenderer('walletconnect:relay', { state: 'connected', connId: channelId });
          return;
        }
        // dApp -> app: tag with the channel id so responses can be routed back.
        if (typeof ws._channelId !== 'string') return;
        broadcastToRenderer('walletconnect:frame', {
          connId: ws._channelId,
          origin: frame.origin,
          data: frame.data,
        });
      });
      ws.on('close', () => {
        const channelId = ws._channelId;
        if (typeof channelId === 'string' && channels.get(channelId) === ws) {
          channels.delete(channelId);
          broadcastToRenderer('walletconnect:relay', { state: 'disconnected', connId: channelId });
        }
      });
      ws.on('error', () => { try { ws.close(); } catch { /* ignore */ } });
    });
  });

  return { url: `http://127.0.0.1:${boundPort}/`, port: boundPort };
}

async function stopWalletConnectServer() {
  for (const ws of channels.values()) {
    try { ws.close(); } catch { /* ignore */ }
  }
  channels.clear();
  if (wss !== null) {
    await new Promise(resolve => wss.close(() => resolve()));
    wss = null;
  }
  if (server !== null) {
    await new Promise(resolve => server.close(() => resolve()));
    server = null;
  }
  boundPort = null;
}

// app -> dApp: route an outbound frame ({ connId, origin, data }) to the socket
// that owns that channel. The relay page only receives { origin, data }.
function sendFrame(frame) {
  if (!frame || typeof frame !== 'object') return;
  const ws = channels.get(frame.connId);
  if (ws === undefined || ws.readyState !== 1) return;
  ws.send(JSON.stringify({ origin: frame.origin, data: frame.data }));
}

function registerWalletConnectIpc() {
  ipcMain.handle('walletconnect:start', () => startWalletConnectServer());
  ipcMain.handle('walletconnect:stop', () => stopWalletConnectServer());
  ipcMain.on('walletconnect:send', (_event, frame) => sendFrame(frame));
}

module.exports = { registerWalletConnectIpc, stopWalletConnectServer };
