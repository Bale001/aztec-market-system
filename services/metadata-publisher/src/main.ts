// Entry point: `yarn workspace @market/metadata-publisher start`
// Env: PUBLISHER_PORT (default 8788), PUBLISHER_STORE_DIR (default ./store)

import { createPublisherServer } from './server.js';
import { FileContentStore } from './store.js';

const port = Number(process.env.PUBLISHER_PORT ?? 8788);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  throw new Error(`PUBLISHER_PORT must be a valid port, got "${process.env.PUBLISHER_PORT}"`);
}
const dir = process.env.PUBLISHER_STORE_DIR ?? 'store';

const store = await FileContentStore.create(dir);
const server = createPublisherServer(store);
server.listen(port, () => {
  console.log(`metadata-publisher listening on :${port}, store dir: ${dir}`);
});
