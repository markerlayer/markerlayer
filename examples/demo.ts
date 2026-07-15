/**
 * Demo: a synthetic player who is fine for three months, then escalates —
 * stake jumps, failed deposits, a cancelled withdrawal, night marathons.
 *
 *   npx tsx examples/demo.ts
 */

import { computePlayerMarkers } from '../src/index.js';
import type { MarkerEvent } from '../src/index.js';

const AS_OF = '2026-07-10T00:00:00.000Z';
const AS_OF_MS = Date.parse(AS_OF);
const DAY = 86_400_000;
const MIN = 60_000;

let id = 0;
const base = { playerId: 'demo-player', tzOffsetMinutes: 180 };
const at = (daysAgo: number, minuteOfDay: number) =>
  new Date(AS_OF_MS - daysAgo * DAY + minuteOfDay * MIN).toISOString();

const events: MarkerEvent[] = [];

// 100 quiet days: one midday session, modest stakes, small losses.
for (let d = 107; d > 7; d--) {
  events.push({
    eventId: `e${id++}`, type: 'deposit', ...base, occurredAt: at(d, 600),
    payload: { amountMinor: 10_000, currency: 'RON', status: 'succeeded' },
  });
  for (let i = 0; i < 15; i++) {
    events.push({
      eventId: `e${id++}`, type: 'wager', ...base, occurredAt: at(d, 720 + i * 2),
      payload: { stakeMinor: 500, payoutMinor: 480, currency: 'RON', product: 'slots' },
    });
  }
}

// The last week: escalation.
for (let d = 7; d > 0; d--) {
  // Night sessions starting 1am local, bigger stakes, everything lost.
  // Wagers every 4 minutes keep this one session under the §3.6 rule.
  for (let i = 0; i < 30; i++) {
    events.push({
      eventId: `e${id++}`, type: 'wager', ...base, occurredAt: at(d, 60 + i * 4),
      payload: { stakeMinor: 5_000, payoutMinor: 0, currency: 'RON', product: d % 2 ? 'slots' : 'live_casino' },
    });
  }
  // Chasing: re-deposit mid-session.
  events.push({
    eventId: `e${id++}`, type: 'deposit', ...base, occurredAt: at(d, 200),
    payload: { amountMinor: 50_000, currency: 'RON', status: 'succeeded' },
  });
}
// Failed deposits and a cancelled withdrawal.
for (const [d, m] of [[3, 210], [2, 205], [2, 215]] as const) {
  events.push({
    eventId: `e${id++}`, type: 'deposit', ...base, occurredAt: at(d, m),
    payload: { amountMinor: 100_000, currency: 'RON', status: 'declined' },
  });
}
events.push({
  eventId: `e${id++}`, type: 'withdrawal', ...base, occurredAt: at(5, 220),
  payload: { amountMinor: 80_000, currency: 'RON', status: 'requested', withdrawalId: 'w1' },
});
events.push({
  eventId: `e${id++}`, type: 'withdrawal', ...base, occurredAt: at(5, 230),
  payload: { amountMinor: 80_000, currency: 'RON', status: 'cancelled_by_player', withdrawalId: 'w1' },
});

const result = computePlayerMarkers(events, 'demo-player', { asOf: AS_OF });

console.log(`baseline: ${result.baseline}`);
console.log(`composite: ${result.composite.score} points → ${result.composite.band}`);
for (const p of result.composite.points) console.log(`  + ${p.points}  ${p.source}`);
console.log(`attention: ${result.attention.join(', ') || '(none)'}\n`);
for (const [markerId, marker] of Object.entries(result.markers)) {
  console.log(`${markerId}: ${marker.state}`);
  for (const line of marker.evidence) console.log(`  · ${line}`);
  if (marker.missing) console.log(`  missing: ${marker.missing.join('; ')}`);
}
if (result.protectiveSignals.length > 0) {
  console.log(`\nprotective: ${result.protectiveSignals.join('; ')}`);
}
