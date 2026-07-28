// Minimal HTTP front for a ContentStore.
//
//   POST /store              body: raw bytes -> 200 {"contentHash":"<hex>"}
//   GET  /content/<sha256hex>                -> 200 raw bytes (verified)
//   GET  /commitment/<0xfield>               -> 200 raw bytes (verified)
//   GET  /health                             -> 200 {"status":"ok"}
//
// CORS is wide open: this is a local development service; the Creator app
// (vite dev server) talks to it directly from the browser.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { ContentStore } from './store.js';

const MAX_BLOB_BYTES = 4 * 1024 * 1024;

export function createPublisherServer(store: ContentStore): Server {
  return createServer((req, res) => {
    void route(store, req, res).catch(err => {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, message.includes('ENOENT') ? 404 : 400, { error: message });
    });
  });
}

async function route(store: ContentStore, req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const url = req.url ?? '';

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  if (req.method === 'GET' && url === '/health') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'POST' && url === '/store') {
    const bytes = await readBody(req);
    if (bytes.length === 0) {
      throw new Error('empty body');
    }
    const contentHash = await store.put(bytes);
    sendJson(res, 200, { contentHash });
    return;
  }

  if (req.method === 'GET' && url.startsWith('/content/')) {
    const hash = url.slice('/content/'.length);
    const bytes = await store.get(hash);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': bytes.length,
    });
    res.end(Buffer.from(bytes));
    return;
  }

  if (req.method === 'GET' && url.startsWith('/commitment/')) {
    const commitment = url.slice('/commitment/'.length);
    const bytes = await store.getByCommitment(commitment);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': bytes.length,
    });
    res.end(Buffer.from(bytes));
    return;
  }

  sendJson(res, 404, { error: `no route for ${req.method} ${url}` });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BLOB_BYTES) {
      throw new Error(`body exceeds ${MAX_BLOB_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return new Uint8Array(Buffer.concat(chunks));
}
