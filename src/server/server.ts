/**
 * Ingestion & scoring API. Zero runtime dependencies — Node http + crypto.
 *
 *   POST /v1/events                       ingest a batch (auth required)
 *   GET  /v1/players                      list ingested players (auth)
 *   GET  /v1/players/:id/markers[?asOf=]  nine markers + composite (auth)
 *   GET  /health                          liveness (no auth)
 *
 * Auth: `Authorization: Bearer <key>` checked against configured API keys
 * with constant-time comparison (keys are sha256-hashed before comparing so
 * timingSafeEqual sees equal-length buffers).
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { EngineConfig } from '../schema.js';
import { computePlayerMarkers } from '../engine.js';
import type { EventStore } from './store.js';
import { validateEvents } from './validate.js';

export interface ServerOptions {
  store: EventStore;
  /** Plaintext API keys; each client gets its own so keys can be rotated. */
  apiKeys: string[];
  config?: Partial<EngineConfig>;
  /** Max request body in bytes (default 10 MiB). */
  maxBodyBytes?: number;
  /** Deterministic clock override for tests; defaults to wall clock. */
  now?: () => string;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

function authorized(req: IncomingMessage, keyHashes: Buffer[]): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const presented = sha256(header.slice('Bearer '.length));
  let ok = false;
  // Compare against every key so timing does not reveal which key matched.
  for (const hash of keyHashes) {
    if (timingSafeEqual(presented, hash)) ok = true;
  }
  return ok;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
  });
  res.end(json);
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createServer(options: ServerOptions): Server {
  if (options.apiKeys.length === 0 || options.apiKeys.some((k) => k.length < 16)) {
    throw new Error('At least one API key of ≥16 characters is required');
  }
  const keyHashes = options.apiKeys.map(sha256);
  const maxBodyBytes = options.maxBodyBytes ?? 10 * 1024 * 1024;
  const now = options.now ?? (() => new Date().toISOString());

  return createHttpServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'internal error';
      if (!res.headersSent) send(res, message === 'body too large' ? 413 : 500, { error: message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'GET' && path === '/health') {
      send(res, 200, { status: 'ok' });
      return;
    }

    if (!authorized(req, keyHashes)) {
      send(res, 401, { error: 'missing or invalid API key' });
      return;
    }

    if (req.method === 'POST' && path === '/v1/events') {
      const raw = await readBody(req, maxBodyBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        send(res, 400, { error: 'body must be valid JSON' });
        return;
      }
      const { events, errors } = validateEvents(parsed);
      if (errors.length > 0) {
        send(res, 400, { error: 'invalid events', details: errors });
        return;
      }
      const result = options.store.ingest(events);
      send(res, 202, result);
      return;
    }

    if (req.method === 'GET' && path === '/v1/players') {
      send(res, 200, { players: options.store.playerIds() });
      return;
    }

    const markersMatch = /^\/v1\/players\/([^/]+)\/markers$/.exec(path);
    if (req.method === 'GET' && markersMatch) {
      const playerId = decodeURIComponent(markersMatch[1]!);
      const events = options.store.eventsFor(playerId);
      if (events.length === 0) {
        send(res, 404, { error: `no events for player ${playerId}` });
        return;
      }
      const asOf = url.searchParams.get('asOf') ?? now();
      if (Number.isNaN(Date.parse(asOf))) {
        send(res, 400, { error: 'asOf must be an ISO 8601 timestamp' });
        return;
      }
      send(res, 200, computePlayerMarkers(events, playerId, { asOf, config: options.config }));
      return;
    }

    send(res, 404, { error: 'not found' });
  }
}
