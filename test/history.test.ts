import { describe, expect, it } from 'vitest';
import { buildHistory, deriveSessions, normalizeEvents } from '../src/history.js';
import { resolveConfig } from '../src/config.js';
import type { WagerEvent } from '../src/schema.js';
import { AS_OF_MS, PLAYER, at, deposit, sessionEvent, steadyDays, wager } from './helpers.js';

const config = resolveConfig();

describe('normalizeEvents', () => {
  it('dedupes by eventId and drops events at/after asOf', () => {
    const w1 = wager(at(1, 720), 1000, 0);
    const dup = { ...wager(at(1, 721), 500, 0), eventId: w1.eventId };
    const future = wager(at(-1, 0), 1000, 0); // tomorrow
    const out = normalizeEvents([w1, dup, future], AS_OF_MS);
    expect(out).toHaveLength(1);
    expect((out[0] as WagerEvent).payload.stakeMinor).toBe(1000);
  });

  it('sorts ascending by occurredAt', () => {
    const a = wager(at(1, 100), 1, 0);
    const b = wager(at(2, 100), 2, 0);
    const out = normalizeEvents([a, b], AS_OF_MS);
    expect(out.map((e) => e.occurredAt)).toEqual([b.occurredAt, a.occurredAt]);
  });
});

describe('deriveSessions', () => {
  it('splits on gaps larger than the configured gap', () => {
    const wagers = [
      wager(at(1, 0), 100, 0),
      wager(at(1, 10), 100, 0),
      wager(at(1, 20), 100, 0),
      // 45-minute gap ⇒ new session
      wager(at(1, 65), 100, 0),
      wager(at(1, 70), 100, 0),
    ];
    const sessions = deriveSessions(wagers, 30);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]!.wagers).toHaveLength(3);
    expect(sessions[1]!.wagers).toHaveLength(2);
  });
});

describe('buildHistory', () => {
  it('aggregates wagers, deposits, and failed deposits per day', () => {
    const events = [
      wager(at(1, 720), 1000, 400),
      wager(at(1, 725), 2000, 0),
      deposit(at(1, 600), 10_000),
      deposit(at(1, 610), 5_000, 'declined'),
    ];
    const h = buildHistory(events, PLAYER, AS_OF_MS, config);
    const key = new Date(at(1, 0)).toISOString().slice(0, 10);
    const day = h.days.get(key)!;
    expect(day.stakeMinor).toBe(3000);
    expect(day.netLossMinor).toBe(2600);
    expect(day.wagerCount).toBe(2);
    expect(day.depositMinor).toBe(10_000);
    expect(day.depositCount).toBe(1);
    expect(day.failedDepositCount).toBe(1);
  });

  it('uses operator session events when present and groups uncovered wagers', () => {
    const events = [
      sessionEvent(at(1, 0), 'started', 's-1'),
      wager(at(1, 5), 100, 0, { sessionId: 's-1' }),
      sessionEvent(at(1, 60), 'ended', 's-1'),
      // wager with no session coverage → derived session
      wager(at(1, 300), 100, 0),
    ];
    const h = buildHistory(events, PLAYER, AS_OF_MS, config);
    expect(h.sessions).toHaveLength(2);
    const operator = h.sessions.find((s) => s.sessionId === 's-1')!;
    expect(Math.round((operator.endMs - operator.startMs) / 60_000)).toBe(60);
  });

  it('reports self baseline with enough active days, population otherwise', () => {
    const rich = buildHistory(steadyDays(60), PLAYER, AS_OF_MS, config);
    expect(rich.baselineSource).toBe('self');
    const thin = buildHistory(steadyDays(5), PLAYER, AS_OF_MS, config);
    expect(thin.baselineSource).toBe('population');
  });

  it('marks night minutes null when timezone is unknown', () => {
    const events = [wager(at(1, 120), 100, 0, { tz: null })];
    const h = buildHistory(events, PLAYER, AS_OF_MS, config);
    const day = [...h.days.values()].find((d) => d.wagerCount > 0)!;
    expect(day.nightMinutes).toBeNull();
  });

  it('counts night minutes for a 2am local session', () => {
    // Wagers every 4 minutes from 02:00 to 02:28 — one session per §3.6.
    const events = [];
    for (let m = 120; m <= 148; m += 4) events.push(wager(at(1, m), 100, 0));
    const h = buildHistory(events, PLAYER, AS_OF_MS, config);
    const day = [...h.days.values()].find((d) => d.wagerCount > 0)!;
    expect(day.nightMinutes).toBeGreaterThanOrEqual(28);
  });

  it('splits a midnight-spanning session across both days (§5.6.2 Method 1)', () => {
    // One session from 23:00 to 01:00: wagers every 4 minutes across midnight.
    const events = [];
    for (let m = 23 * 60; m <= 25 * 60; m += 4) events.push(wager(at(2, m), 100, 0));
    const h = buildHistory(events, PLAYER, AS_OF_MS, config);
    const days = [...h.days.values()].filter((d) => d.activeMinutes > 0);
    expect(days).toHaveLength(2);
    const [first, second] = days.sort((a, b) => a.dayKey.localeCompare(b.dayKey));
    expect(first!.activeMinutes).toBeGreaterThanOrEqual(59);
    expect(second!.activeMinutes).toBeGreaterThanOrEqual(59);
  });
});
