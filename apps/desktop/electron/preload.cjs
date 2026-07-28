// Bridges the sandboxed renderer to the main process. The only privileged
// surface is the SimpleX messaging core (a native addon + SQLite store that
// must live in the main process, see simplex.cjs): a narrow invoke-style API
// plus an event stream. The Aztec wallet still runs entirely in the renderer.
const { contextBridge, ipcRenderer } = require('electron');

const SIMPLEX_METHODS = [
  'status',
  'init',
  'createUser',
  'setActiveUser',
  'start',
  'createAddress',
  'getAddress',
  'connect',
  'listContacts',
  'listGroups',
  'listMembers',
  'addMember',
  'joinGroup',
  'sendText',
  'getChats',
  'getChat',
];

const simplex = Object.fromEntries(
  SIMPLEX_METHODS.map(name => [name, (...args) => ipcRenderer.invoke(`simplex:${name}`, ...args)]),
);

// Subscribes to core events; returns an unsubscribe function.
simplex.onEvent = handler => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on('simplex:event', listener);
  return () => ipcRenderer.removeListener('simplex:event', listener);
};

contextBridge.exposeInMainWorld('marketSimplex', simplex);

// External-wallet connection relay (the "web wallet URL" endpoint). The renderer
// runs the real wallet handler; main hosts the localhost relay page + WebSocket
// and shuttles raw postMessage frames between the two. See walletconnect.cjs.
const walletConnect = {
  // Starts the relay server (idempotent); resolves to { url, port }.
  start: () => ipcRenderer.invoke('walletconnect:start'),
  stop: () => ipcRenderer.invoke('walletconnect:stop'),
  // app -> dApp: post an outbound frame ({ origin, data }) to the relay page.
  send: frame => ipcRenderer.send('walletconnect:send', frame),
  // dApp -> app: inbound frames ({ origin, data }) from the relay page.
  onFrame: handler => {
    const listener = (_event, frame) => handler(frame);
    ipcRenderer.on('walletconnect:frame', listener);
    return () => ipcRenderer.removeListener('walletconnect:frame', listener);
  },
  // Relay page connection lifecycle ({ state: 'connected' | 'disconnected' }).
  onRelay: handler => {
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on('walletconnect:relay', listener);
    return () => ipcRenderer.removeListener('walletconnect:relay', listener);
  },
};

contextBridge.exposeInMainWorld('marketWalletConnect', walletConnect);
