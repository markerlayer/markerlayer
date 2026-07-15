import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from '../src/server/server.js';
import { MemoryStore } from '../src/server/store.js';
import { AS_OF, steadyDays, wager, at } from './helpers.js';

const API_KEY = 'test-key-0123456789abcdef';
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer({
    store: new MemoryStore(),
    apiKeys: [API_KEY],
    now: () => AS_OF,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => void server.close(() => resolve())));

const auth = { authorization: `Bearer ${API_KEY}` };
const json = { 'content-type': 'application/json' };

describe('auth', () => {
  it('rejects missing and wrong keys with 401', async () => {
    expect((await fetch(`${base}/v1/players`)).status).toBe(401);
    const wrong = await fetch(`${base}/v1/players`, {
      headers: { authorization: 'Bearer wrong-key-0123456789abcdef' },
    });
    expect(wrong.status).toBe(401);
  });

  it('refuses to start with weak keys', () => {
    expect(() => createServer({ store: new MemoryStore(), apiKeys: ['short'] })).toThrow(/16/);
    expect(() => createServer({ store: new MemoryStore(), apiKeys: [] })).toThrow(/16/);
  });

  it('health needs no auth', async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
  });
});

describe('ingestion', () => {
  it('rejects invalid events with indexed details', async () => {
    const res = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { ...auth, ...json },
      body: JSON.stringify([{ eventId: 'x', type: 'wager' }]),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details: { index: number; error: string }[] };
    expect(body.details[0]!.index).toBe(0);
  });

  it('rejects non-JSON bodies', async () => {
    const res = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { ...auth, ...json },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });

  it('accepts a valid batch and dedupes on re-ingest', async () => {
    const events = steadyDays(30);
    const first = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { ...auth, ...json },
      body: JSON.stringify(events),
    });
    expect(first.status).toBe(202);
    const r1 = (await first.json()) as { accepted: number; duplicates: number };
    expect(r1.accepted).toBe(events.length);
    expect(r1.duplicates).toBe(0);

    const second = await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { ...auth, ...json },
      body: JSON.stringify(events),
    });
    const r2 = (await second.json()) as { accepted: number; duplicates: number };
    expect(r2.accepted).toBe(0);
    expect(r2.duplicates).toBe(events.length);
  });
});

describe('markers endpoint', () => {
  it('lists players and returns full marker output with composite', async () => {
    const players = (await (await fetch(`${base}/v1/players`, { headers: auth })).json()) as {
      players: string[];
    };
    expect(players.players).toContain('p1');

    const res = await fetch(`${base}/v1/players/p1/markers?asOf=${encodeURIComponent(AS_OF)}`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      playerId: string;
      markers: Record<string, unknown>;
      composite: { band: string };
    };
    expect(body.playerId).toBe('p1');
    expect(Object.keys(body.markers)).toHaveLength(9);
    expect(body.composite.band).toBe('low');
  });

  it('404s for unknown players and 400s for bad asOf', async () => {
    expect((await fetch(`${base}/v1/players/ghost/markers`, { headers: auth })).status).toBe(404);
    expect(
      (await fetch(`${base}/v1/players/p1/markers?asOf=yesterday`, { headers: auth })).status,
    ).toBe(400);
  });

  it('supports a second player via the same batch endpoint', async () => {
    const other = [wager(at(1, 720), 1000, 900, { playerId: 'p2' })];
    await fetch(`${base}/v1/events`, {
      method: 'POST',
      headers: { ...auth, ...json },
      body: JSON.stringify(other),
    });
    const res = await fetch(`${base}/v1/players/p2/markers?asOf=${encodeURIComponent(AS_OF)}`, {
      headers: auth,
    });
    expect(res.status).toBe(200);
  });
});
