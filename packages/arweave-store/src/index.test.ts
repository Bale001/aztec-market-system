import { parseGateway } from './index.js';

// Pure-logic tests (no network). The live upload/fetch round-trip is exercised
// by the integration suite against a running arlocal (a unit test must not
// require a network service).

describe('parseGateway', () => {
  it('parses https with default port', () => {
    expect(parseGateway('https://arweave.net')).toEqual({
      host: 'arweave.net',
      port: 443,
      protocol: 'https',
    });
  });

  it('parses a local arlocal gateway with an explicit port', () => {
    expect(parseGateway('http://localhost:1984')).toEqual({
      host: 'localhost',
      port: 1984,
      protocol: 'http',
    });
  });

  it('defaults http to port 80', () => {
    expect(parseGateway('http://example.com').port).toBe(80);
  });
});
