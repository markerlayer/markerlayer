import { describe, expect, it } from 'vitest';
import { computeMarkers, computePlayerMarkers } from '../src/engine.js';
import type { MarkerEvent } from '../src/schema.js';
import {
  AS_OF,
  PLAYER,
  at,
  contact,
  deposit,
  safetyTool,
  steadyDays,
  wager,
  withdrawal,
} from './helpers.js';

const OPTS = { asOf: AS_OF };

function compute(events: MarkerEvent[]) {
  return computePlayerMarkers(events, PLAYER, OPTS);
}

describe('steady player', () => {
  const result = compute(steadyDays(120));

  it('uses a self baseline and flags nothing', () => {
    expect(result.baseline).toBe('self');
    expect(result.attention).toEqual([]);
    expect(result.markers.M1_volume_of_stakes.state).toBe('normal');
    expect(result.markers.M9_losses.state).toBe('normal');
  });

  it('always reports all nine markers', () => {
    expect(Object.keys(result.markers)).toHaveLength(9);
    // No withdrawal or contact events were ever sent → visible gaps, not silence.
    expect(result.markers.M4_cancelled_withdrawals.state).toBe('insufficient_data');
    expect(result.markers.M5_player_initiated_contact.state).toBe('insufficient_data');
  });
});

describe('M1 — stake escalation', () => {
  it('flags a player whose stake jumps 5× in the scrutiny week', () => {
    const events = [...steadyDays(113, 7), ...steadyDays(7, 0, 5000)];
    const r = compute(events);
    expect(r.markers.M1_volume_of_stakes.state).toBe('high');
    expect(r.attention).toContain('M1_volume_of_stakes');
    expect(r.markers.M1_volume_of_stakes.evidence.join(' ')).toMatch(/dailyStakeMinor/);
  });
});

describe('M3 — deposits', () => {
  it('flags repeated failed deposits via the absolute override', () => {
    const events = [
      ...steadyDays(120),
      deposit(at(2, 700), 10_000, 'failed'),
      deposit(at(2, 705), 10_000, 'declined'),
      deposit(at(1, 700), 10_000, 'failed'),
    ];
    const r = compute(events);
    expect(r.markers.M3_depositing_behaviour.state).toBe('high');
    expect(r.markers.M3_depositing_behaviour.evidence.join(' ')).toMatch(/declinedDepositCountWeek=3/);
  });
});

describe('M4 — withdrawals', () => {
  it('flags cancel-and-replay within the hour, twice', () => {
    const events = [
      ...steadyDays(120),
      withdrawal(at(5, 700), 'requested', 'w1'),
      withdrawal(at(5, 710), 'cancelled_by_player', 'w1'),
      wager(at(5, 730), 1000, 0),
      withdrawal(at(2, 700), 'requested', 'w2'),
      withdrawal(at(2, 705), 'cancelled_by_player', 'w2'),
      wager(at(2, 720), 1000, 0),
    ];
    const r = compute(events);
    expect(r.markers.M4_cancelled_withdrawals.state).toBe('high');
    expect(r.markers.M4_cancelled_withdrawals.features['cancelledCountMonth']).toBe(2);
  });
});

describe('M5 — player contact', () => {
  it('treats a responsible_gambling contact as high, always', () => {
    const events = [...steadyDays(120), contact(at(3, 700), 'responsible_gambling')];
    const r = compute(events);
    expect(r.markers.M5_player_initiated_contact.state).toBe('high');
  });
});

describe('M6 — session time', () => {
  it('flags a 400-minute marathon session', () => {
    // Wagers every 4 minutes — inside the EN 18144 §3.6 five-minute session
    // rule, so this stays one continuous 400-minute session.
    const marathon: MarkerEvent[] = [];
    for (let m = 0; m <= 400; m += 4) {
      marathon.push(wager(at(1, 600 + m), 1000, 1000));
    }
    const r = compute([...steadyDays(113, 7), ...marathon]);
    expect(r.markers.M6_gambling_time.state).toBe('high');
    expect(r.markers.M6_gambling_time.features['longestSessionMinutes7d']).toBeGreaterThanOrEqual(360);
  });

  it('reports the time-of-day gap when timezone is missing', () => {
    const events = steadyDays(120).map((e) => ({ ...e, tzOffsetMinutes: null }));
    const r = compute(events);
    expect(r.markers.M6_gambling_time.missing?.join(' ')).toMatch(/tzOffsetMinutes/);
  });
});

describe('M7 — multiple products', () => {
  it('flags five distinct products in 28 days', () => {
    const events = [
      ...steadyDays(120),
      wager(at(3, 700), 1000, 0, { product: 'sports_live' }),
      wager(at(3, 705), 1000, 0, { product: 'live_casino' }),
      wager(at(3, 710), 1000, 0, { product: 'poker' }),
      wager(at(3, 715), 1000, 0, { product: 'casino_table' }),
    ];
    const r = compute(events);
    expect(r.markers.M7_gambling_products.state).toBe('high');
    expect(r.markers.M7_gambling_products.features['distinctProducts28d']).toBe(5);
  });
});

describe('M8 — loss trajectory', () => {
  it('flags escalating, accelerating losses', () => {
    // Baseline: mild daily loss. Scrutiny week: total loss ~100× baseline.
    const baseline: MarkerEvent[] = [];
    for (let d = 120; d > 7; d--) {
      for (let i = 0; i < 20; i++) baseline.push(wager(at(d, 720 + i), 1000, 950));
    }
    const blowUp: MarkerEvent[] = [];
    for (let d = 7; d > 0; d--) {
      for (let i = 0; i < 20; i++) blowUp.push(wager(at(d, 720 + i), 5000, 0));
    }
    const r = compute([...baseline, ...blowUp]);
    expect(r.markers.M9_losses.state).toBe('high');
    expect(r.markers.M9_losses.evidence.join(' ')).toMatch(/lossEscalationRatio/);
  });
});

describe('M9 — safety tools', () => {
  it('flags play shortly after a self-exclusion ends', () => {
    const events = [
      ...steadyDays(30),
      safetyTool(at(2, 600), 'self_exclusion', 'expired'),
      // steadyDays already wagers daily; the next wager comes within 24h
    ];
    const r = compute(events);
    expect(r.markers.M8_responsible_gambling_tools.state).toBe('high');
    expect(r.markers.M8_responsible_gambling_tools.evidence.join(' ')).toMatch(/postExclusionPlayLatencyHours/);
  });

  it('reports protective actions separately without raising state', () => {
    const events = [...steadyDays(120), safetyTool(at(10, 600), 'deposit_limit', 'set', 100_000)];
    const r = compute(events);
    expect(r.markers.M8_responsible_gambling_tools.state).toBe('normal');
    expect(r.protectiveSignals.join(' ')).toMatch(/deposit_limit set/);
  });

  it('escalates repeated limit raises', () => {
    const events = [
      ...steadyDays(120),
      safetyTool(at(20, 600), 'deposit_limit', 'set', 50_000),
      safetyTool(at(15, 600), 'deposit_limit', 'raised', 100_000),
      safetyTool(at(5, 600), 'deposit_limit', 'raised', 200_000),
    ];
    const r = compute(events);
    expect(r.markers.M8_responsible_gambling_tools.state).toBe('elevated');
  });
});

describe('cold start', () => {
  it('reports population baseline and stays conservative', () => {
    const r = compute(steadyDays(5));
    expect(r.baseline).toBe('population');
    expect(r.markers.M1_volume_of_stakes.state).toBe('normal');
    expect(r.markers.M1_volume_of_stakes.missing?.length).toBeGreaterThan(0);
  });
});

describe('multi-player batches', () => {
  it('separates players and orders attention by severity', () => {
    const other = steadyDays(120).map((e, i) => ({
      ...e,
      eventId: `other-${i}`,
      playerId: 'p2',
    }));
    const risky = [
      ...steadyDays(113, 7),
      ...steadyDays(7, 0, 5000),
      deposit(at(2, 700), 10_000, 'failed'),
      deposit(at(2, 705), 10_000, 'failed'),
      deposit(at(1, 700), 10_000, 'failed'),
    ];
    const results = computeMarkers([...other, ...risky], OPTS);
    expect(results).toHaveLength(2);
    const p1 = results.find((r) => r.playerId === PLAYER)!;
    const p2 = results.find((r) => r.playerId === 'p2')!;
    expect(p2.attention).toEqual([]);
    expect(p1.attention.length).toBeGreaterThanOrEqual(2);
    // all "high" markers come before any "elevated"
    const states = p1.attention.map((id) => p1.markers[id].state);
    expect([...states].sort().reverse()).toEqual(states);
  });
});
