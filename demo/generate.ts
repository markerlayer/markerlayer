/**
 * Demo dataset generator — a synthetic operator with ~80 players across
 * realistic behavioural archetypes (steady casuals, weekend regulars, a
 * loss-chaser, a reverse-withdrawal player, night marathons, limit
 * weakening, cold starts, a big winner), scored by the real engine.
 * Deterministic: seeded PRNG, fixed asOf.
 *
 *   npx tsx demo/generate.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { computePlayerMarkers } from '../src/index.js';
import type { MarkerEvent, ProductVertical } from '../src/index.js';

const AS_OF = '2026-07-12T00:00:00.000Z';
const AS_OF_MS = Date.parse(AS_OF);
const DAY = 86_400_000;
const MIN = 60_000;
const TZ = 180; // Romania (EEST)

// ---------- deterministic PRNG ----------
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(18144);
const pick = <T,>(arr: T[]) => arr[Math.floor(rng() * arr.length)]!;
const ri = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));

let eid = 0;
// `minute` is player-LOCAL time of day; convert to UTC via the fixed offset
// so a "20:00 session" is 20:00 in Bucharest, not 23:00.
const at = (daysAgo: number, minute: number) =>
  new Date(AS_OF_MS - daysAgo * DAY + (minute - TZ) * MIN).toISOString();

function ev(type: MarkerEvent['type'], playerId: string, occurredAt: string, payload: object): MarkerEvent {
  return { eventId: `e${eid++}`, type, playerId, occurredAt, tzOffsetMinutes: TZ, payload } as MarkerEvent;
}

interface Profile { id: string; archetype: string; note: string; events: MarkerEvent[] }

// ---------- building blocks ----------
function session(p: MarkerEvent[], id: string, day: number, startMin: number, wagers: number,
  stake: number, rtp: number, product: ProductVertical = 'slots', gapMin = 2) {
  let netLoss = 0;
  for (let i = 0; i < wagers; i++) {
    const payout = rng() < rtp ? Math.round(stake * (0.3 + rng() * 1.6)) : 0;
    netLoss += stake - payout;
    p.push(ev('wager', id, at(day, startMin + i * gapMin), {
      stakeMinor: stake, payoutMinor: payout, currency: 'RON', product,
    }));
  }
  return netLoss;
}
const deposit = (p: MarkerEvent[], id: string, day: number, min: number, amount: number,
  status: 'succeeded' | 'declined' = 'succeeded') =>
  p.push(ev('deposit', id, at(day, min), { amountMinor: amount, currency: 'RON', status, methodClass: 'card' }));

// ---------- archetypes ----------
function casual(id: string): Profile {
  const p: MarkerEvent[] = [];
  const stake = pick([300, 500, 800, 1000]);
  const perWeek = ri(2, 4);
  for (let d = 125; d > 0; d--) {
    if (rng() < perWeek / 7) {
      deposit(p, id, d, 17 * 60, stake * ri(15, 25));
      session(p, id, d, 19 * 60 + ri(0, 90), ri(10, 22), stake, 0.94);
    }
  }
  return { id, archetype: 'casual', note: 'Steady recreational player.', events: p };
}

function weekend(id: string): Profile {
  const p: MarkerEvent[] = [];
  const stake = pick([1500, 2000, 3000]);
  for (let d = 125; d > 0; d--) {
    const dow = new Date(AS_OF_MS - d * DAY).getUTCDay();
    if ((dow === 5 || dow === 6) && rng() < 0.85) {
      deposit(p, id, d, 18 * 60, stake * ri(20, 30));
      session(p, id, d, 20 * 60 + ri(0, 60), ri(18, 30), stake, 0.94, pick(['slots', 'sports_prematch']));
    }
  }
  return { id, archetype: 'weekend', note: 'Friday/Saturday regular; stable pattern.', events: p };
}

function highroller(id: string): Profile {
  const p: MarkerEvent[] = [];
  for (let d = 125; d > 0; d--) {
    if (rng() < 0.55) {
      deposit(p, id, d, 16 * 60, 400_000);
      session(p, id, d, 21 * 60, ri(20, 35), 15_000, 0.95, pick(['live_casino', 'casino_table']), 3);
    }
  }
  return { id, archetype: 'highroller', note: 'Large but stable stakes — self-baseline keeps him normal.', events: p };
}

function payday(id: string): Profile {
  const p: MarkerEvent[] = [];
  for (let d = 125; d > 0; d--) {
    const dom = new Date(AS_OF_MS - d * DAY).getUTCDate();
    if (dom >= 26 && dom <= 28) {
      deposit(p, id, d, 18 * 60, 60_000);
      session(p, id, d, 19 * 60, ri(25, 40), 2000, 0.94);
    } else if (rng() < 0.18) {
      session(p, id, d, 20 * 60, ri(8, 14), 500, 0.94);
    }
  }
  return { id, archetype: 'payday', note: 'Monthly salary-day spike — should stay NORMAL.', events: p };
}

function chaser(id: string): Profile {
  const p: MarkerEvent[] = [];
  // long calm baseline
  for (let d = 125; d > 21; d--) {
    if (rng() < 0.5) {
      deposit(p, id, d, 18 * 60, 15_000);
      session(p, id, d, 20 * 60, ri(12, 18), 800, 0.94);
    }
  }
  // three-week escalation: stakes ramp, losses, in-session re-deposits, declines
  for (let d = 21; d > 0; d--) {
    const ramp = 1 + (21 - d) / 6;
    const stake = Math.round(800 * ramp);
    deposit(p, id, d, 19 * 60, stake * 15);
    const start = 20 * 60;
    session(p, id, d, start, 14, stake, 0.80);
    // chase: re-deposits mid-session after losses
    deposit(p, id, d, start + 16, stake * 12);
    session(p, id, d, start + 20, 12, stake, 0.78);
    if (d < 8) {
      deposit(p, id, d, start + 40, stake * 20, 'declined');
      if (rng() < 0.6) deposit(p, id, d, start + 44, stake * 15, 'declined');
      deposit(p, id, d, start + 50, stake * 10);
      session(p, id, d, start + 54, 10, stake, 0.75);
    }
  }
  return { id, archetype: 'chaser', note: 'classic chase: ramping stakes, in-session top-ups, card declines.', events: p };
}

function canceller(id: string): Profile {
  const p = casual(id).events;
  for (const [d, wid] of [[9, 'w1'], [3, 'w2']] as const) {
    p.push(ev('withdrawal', id, at(d, 14 * 60), { amountMinor: 80_000, currency: 'RON', status: 'requested', withdrawalId: wid }));
    p.push(ev('withdrawal', id, at(d, 20 * 60), { amountMinor: 80_000, currency: 'RON', status: 'cancelled_by_player', withdrawalId: wid }));
    session(p, id, d, 20 * 60 + 35, 15, 1500, 0.85);
  }
  return { id, archetype: 'canceller', note: 'reverse withdrawals: cancels cash-out, bets within the hour.', events: p };
}

function night(id: string): Profile {
  const p: MarkerEvent[] = [];
  for (let d = 125; d > 30; d--) {
    if (rng() < 0.5) session(p, id, d, 20 * 60, ri(12, 18), 700, 0.94);
  }
  for (let d = 30; d > 0; d--) {
    if (rng() < 0.75) {
      const len = ri(60, 110); // wagers, 4-min gaps → 4-7h sessions into the night
      session(p, id, d, 60 + ri(0, 40), len, 700, 0.93, 'slots', 4);
    }
  }
  return { id, archetype: 'night', note: 'sessions migrated to 01:00–06:00 and stretched past 6h; stakes unchanged.', events: p };
}

function limitweakener(id: string, relapse: boolean): Profile {
  const p = casual(id).events;
  p.push(ev('safety_tool', id, at(80, 12 * 60), { tool: 'deposit_limit', action: 'set', valueMinor: 50_000 }));
  // pressure day: deposits reach 90% of limit, limit raised hours later, then removed
  deposit(p, id, 12, 10 * 60, 25_000); deposit(p, id, 12, 13 * 60, 20_000);
  p.push(ev('safety_tool', id, at(12, 19 * 60), { tool: 'deposit_limit', action: 'raised', valueMinor: 200_000 }));
  p.push(ev('safety_tool', id, at(10, 11 * 60), { tool: 'deposit_limit', action: 'removed' }));
  deposit(p, id, 9, 12 * 60, 120_000);
  session(p, id, 9, 20 * 60, 25, 3000, 0.85);
  if (relapse) {
    p.push(ev('safety_tool', id, at(60, 9 * 60), { tool: 'self_exclusion', action: 'set', valueMinutes: 30 * 24 * 60 }));
    p.push(ev('safety_tool', id, at(25, 9 * 60), { tool: 'self_exclusion', action: 'expired' }));
    session(p, id, 24, 18 * 60, 20, 1500, 0.88); // betting within 24h of expiry
  }
  return { id, archetype: 'limitweakener', note: 'dismantled deposit limit under pressure' + (relapse ? '; back betting <24h after self-exclusion expired.' : '.'), events: p };
}

function coldstart(id: string): Profile {
  const p: MarkerEvent[] = [];
  for (let d = 9; d > 0; d--) {
    deposit(p, id, d, 18 * 60, 40_000);
    session(p, id, d, 20 * 60, ri(20, 30), 2000, 0.92);
  }
  return { id, archetype: 'coldstart', note: 'registered 9 days ago; scored on population baseline.', events: p };
}

function winner(id: string): Profile {
  const p = casual(id).events;
  // one big hit 12 days ago, mid-session
  session(p, id, 12, 19 * 60, 10, 2000, 0.94);
  p.push(ev('wager', id, at(12, 19 * 60 + 24), { stakeMinor: 2000, payoutMinor: 900_000, currency: 'RON', product: 'slots' }));
  return { id, archetype: 'winner', note: 'big win; negative net losses handled per §5.9.2.', events: p };
}

function bonushunter(id: string): Profile {
  const p = casual(id).events;
  for (let d = 60; d > 0; d -= ri(6, 10)) {
    p.push(ev('bonus', id, at(d, 17 * 60), { action: 'claimed', amountMinor: 10_000 }));
    if (rng() < 0.4) p.push(ev('bonus', id, at(d - 1, 17 * 60), { action: 'forfeited', amountMinor: 6_000 }));
  }
  return { id, archetype: 'bonushunter', note: 'heavy bonus cycle; Loss Method 2 keeps losses honest.', events: p };
}

function multiproduct(id: string): Profile {
  const p: MarkerEvent[] = [];
  const prods: ProductVertical[] = ['slots', 'sports_prematch', 'sports_live', 'live_casino', 'poker'];
  for (let d = 125; d > 28; d--) {
    if (rng() < 0.5) session(p, id, d, 20 * 60, ri(10, 16), 900, 0.94, 'slots');
  }
  for (let d = 28; d > 0; d--) {
    if (rng() < 0.8) session(p, id, d, 19 * 60 + ri(0, 120), ri(10, 16), 1100, 0.92, prods[Math.min(4, Math.floor((28 - d) / 6))]);
  }
  return { id, archetype: 'multiproduct', note: 'Breadth spike — adopted 4 new verticals in a month (§5.7).', events: p };
}

function rgcontact(id: string): Profile {
  const p = casual(id).events;
  for (const [d, cat, sent] of [[20, 'payments', 'negative'], [14, 'complaint', 'negative'], [8, 'payments', 'negative'], [4, 'responsible_gambling', 'negative']] as const) {
    p.push(ev('support_contact', id, at(d, 15 * 60), { channel: 'chat', category: cat, sentiment: sent }));
  }
  return { id, archetype: 'rgcontact', note: 'Escalating negative contacts, then an explicit RG-support request.', events: p };
}

// ---------- assemble population ----------
const profiles: Profile[] = [];
let n = 0;
const add = (f: (id: string) => Profile, count: number) => {
  for (let i = 0; i < count; i++) profiles.push(f(`player-${String(++n).padStart(3, '0')}`));
};
add(casual, 42);
add(weekend, 12);
add(highroller, 4);
add(payday, 3);
add(chaser, 3);
add(canceller, 2);
add(night, 2);
add((id) => limitweakener(id, false), 1);
add((id) => limitweakener(id, true), 1);
add(coldstart, 3);
add(winner, 1);
add(bonushunter, 1);
add(multiproduct, 2);
add(rgcontact, 1);

// ---------- score with the real engine + build series ----------
const out: object[] = [];
let totalEvents = 0;
for (const prof of profiles) {
  totalEvents += prof.events.length;
  const markers = computePlayerMarkers(prof.events, prof.id, { asOf: AS_OF });
  // 90-day daily series for sparklines
  const stakeS: number[] = new Array(90).fill(0);
  const lossS: number[] = new Array(90).fill(0);
  for (const e of prof.events) {
    if (e.type !== 'wager') continue;
    const idx = 89 - Math.floor((AS_OF_MS - Date.parse(e.occurredAt)) / DAY);
    if (idx < 0 || idx > 89) continue;
    const pl = e.payload as { stakeMinor: number; payoutMinor: number };
    stakeS[idx] += pl.stakeMinor;
    lossS[idx] += pl.stakeMinor - pl.payoutMinor;
  }
  out.push({ ...markers, archetype: prof.archetype, note: prof.note, eventCount: prof.events.length, series: { stake: stakeS, loss: lossS } });
}

mkdirSync('demo/data', { recursive: true });
const payload = { operator: 'Demo Operator', asOf: AS_OF, generated: 'seed 18144, deterministic', players: out };
writeFileSync('demo/data/results.js', 'window.DEMO_DATA = ' + JSON.stringify(payload) + ';\n');
writeFileSync('demo/data/results.json', JSON.stringify(payload, null, 1));

const bands = { high: 0, moderate: 0, low: 0 };
for (const p of out) bands[(p as { composite: { band: keyof typeof bands } }).composite.band]++;
console.log(`players: ${out.length}, events: ${totalEvents}`);
console.log('bands:', bands);
for (const p of out as { playerId: string; archetype: string; composite: { band: string; score: number } }[]) {
  if (p.composite.band !== 'low') console.log(` ${p.composite.band.padEnd(8)} ${String(p.composite.score).padStart(2)}  ${p.playerId}  (${p.archetype})`);
}
