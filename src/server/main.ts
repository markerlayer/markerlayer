/**
 * Entrypoint:  MARKERLAYER_API_KEYS=key1,key2 npm run serve
 *
 * Env:
 *   MARKERLAYER_API_KEYS  comma-separated API keys (each ≥16 chars) — required
 *   PORT                listen port (default 3200)
 *   DATA_DIR            JSONL persistence dir (default ./data; "memory" for none)
 */

import { JsonlStore, MemoryStore } from './store.js';
import { createServer } from './server.js';

const apiKeys = (process.env['MARKERLAYER_API_KEYS'] ?? '')
  .split(',')
  .map((k) => k.trim())
  .filter(Boolean);
if (apiKeys.length === 0) {
  console.error('MARKERLAYER_API_KEYS is required (comma-separated, each ≥16 chars)');
  process.exit(1);
}

const port = Number(process.env['PORT'] ?? 3200);
const dataDir = process.env['DATA_DIR'] ?? './data';
const store = dataDir === 'memory' ? new MemoryStore() : new JsonlStore(dataDir);

createServer({ store, apiKeys }).listen(port, () => {
  console.log(`markerlayer API listening on :${port} (storage: ${dataDir})`);
});
