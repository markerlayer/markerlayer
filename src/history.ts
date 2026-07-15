/**
 * History layer: dedupe/sort raw events, resolve sessions, reduce to
 * per-player daily aggregates, and provide the shared baseline machinery
 * (SPEC.md §2.3–2.4). Everything downstream (the nine markers) reads only
 * from PlayerHistory.
 */

import type {
  BonusEvent,
  DepositEvent,
  EngineConfig,
  MarkerEvent,
  ProductVertical,
  SafetyToolEvent,
  SessionEvent,
  SupportContactEvent,
  WagerEvent,
  WithdrawalEvent,
} from './schema.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, dayKey, localHour, toMs } from './time.js';
import { type RobustStats, robustStats, robustZ } from './stats.js';

export interface SessionInterval {
  sessionId: string;
  startMs: number;
  endMs: number;
  tzOffsetMinutes: number | null;
  wagers: WagerEvent[];
  stakeMinor: number;
  payoutMinor: number;
}

export interface DayAgg {
  dayKey: string;
  stakeMinor: number;
  payoutMinor: number;
  wagerCount: number;
  /**
   * EN 18144 §5.9.2 Loss Calculation Method 2: stakes − winnings − bonuses
   * (settled bets only; forfeited/withdrawn bonuses count negatively).
   */
  netLossMinor: number;
  /** Bonus sum for the day (claimed +, forfeited −), per §5.9.2. */
  bonusMinor: number;
  depositMinor: number;
  depositCount: number;
  failedDepositCount: number;
  /** Completed withdrawals — for net deposits per §3.11 / §5.3.2. */
  withdrawalCompletedMinor: number;
  /**
   * Gambling time per EN 18144 §5.6.2 Method 1: sessions are split across
   * day boundaries; only the part inside this day is counted here.
   */
  activeMinutes: number;
  /** null ⇒ timezone unknown for this day's sessions (M6 degrades). */
  nightMinutes: number | null;
  /** §5.6.2 Method 2: count of one-hour slots with ≥1 wager (0–24). */
  hourSlotsWithActivity: number;
  longestSessionMinutes: number;
  contactCount: number;
  contactCategories: Record<string, number>;
  contactSentiments: Record<string, number>;
  stakeByProduct: Partial<Record<ProductVertical, number>>;
}

export interface PlayerHistory {
  playerId: string;
  asOfMs: number;
  config: EngineConfig;
  wagers: WagerEvent[];
  deposits: DepositEvent[];
  withdrawals: WithdrawalEvent[];
  contacts: SupportContactEvent[];
  safetyTools: SafetyToolEvent[];
  sessions: SessionInterval[];
  days: Map<string, DayAgg>;
  /** Wager-active days inside the baseline window. */
  baselineActiveDays: number;
  baselineSource: 'self' | 'population';
}

function emptyDay(key: string): DayAgg {
  return {
    dayKey: key,
    stakeMinor: 0,
    payoutMinor: 0,
    wagerCount: 0,
    netLossMinor: 0,
    bonusMinor: 0,
    depositMinor: 0,
    depositCount: 0,
    failedDepositCount: 0,
    withdrawalCompletedMinor: 0,
    activeMinutes: 0,
    nightMinutes: 0,
    hourSlotsWithActivity: 0,
    longestSessionMinutes: 0,
    contactCount: 0,
    contactCategories: {},
    contactSentiments: {},
    stakeByProduct: {},
  };
}

export function eventMs(e: MarkerEvent): number {
  return toMs(e.occurredAt);
}

/** Dedupe by eventId (first occurrence wins), drop events at/after asOf, sort ascending. */
export function normalizeEvents(events: MarkerEvent[], asOfMs: number): MarkerEvent[] {
  const seen = new Set<string>();
  const out: MarkerEvent[] = [];
  for (const e of events) {
    if (seen.has(e.eventId)) continue;
    seen.add(e.eventId);
    if (eventMs(e) >= asOfMs) continue;
    out.push(e);
  }
  return out.sort((a, b) => eventMs(a) - eventMs(b));
}

/** Group wagers into sessions by inter-wager gap (SPEC §2.2 "session"). */
export function deriveSessions(wagers: WagerEvent[], gapMinutes: number): SessionInterval[] {
  const sessions: SessionInterval[] = [];
  let current: WagerEvent[] = [];
  const flush = () => {
    if (current.length === 0) return;
    const first = current[0]!;
    const last = current[current.length - 1]!;
    sessions.push(buildInterval(`derived-${eventMs(first)}`, eventMs(first), eventMs(last) + MINUTE_MS, current));
    current = [];
  };
  for (const w of wagers) {
    const prev = current[current.length - 1];
    if (prev && eventMs(w) - eventMs(prev) > gapMinutes * MINUTE_MS) flush();
    current.push(w);
  }
  flush();
  return sessions;
}

function buildInterval(sessionId: string, startMs: number, endMs: number, wagers: WagerEvent[]): SessionInterval {
  return {
    sessionId,
    startMs,
    endMs: Math.max(endMs, startMs + MINUTE_MS),
    tzOffsetMinutes: wagers[0]?.tzOffsetMinutes ?? null,
    wagers,
    stakeMinor: wagers.reduce((a, w) => a + w.payload.stakeMinor, 0),
    payoutMinor: wagers.reduce((a, w) => a + w.payload.payoutMinor, 0),
  };
}

/**
 * Resolve sessions: operator-sent session events are used when present
 * (paired started/ended by sessionId; unclosed sessions end at their last
 * wager); wagers not covered by any operator session are grouped into
 * derived gap-sessions so no activity is silently dropped.
 */
export function resolveSessions(
  sessionEvents: SessionEvent[],
  wagers: WagerEvent[],
  gapMinutes: number,
): SessionInterval[] {
  if (sessionEvents.length === 0) return deriveSessions(wagers, gapMinutes);

  const wagersBySession = new Map<string, WagerEvent[]>();
  const uncovered: WagerEvent[] = [];
  const started = new Map<string, SessionEvent>();
  const bounds = new Map<string, { startMs: number; endMs: number | null; tz: number | null }>();

  for (const s of sessionEvents) {
    const id = s.payload.sessionId;
    if (s.payload.status === 'started') {
      started.set(id, s);
      bounds.set(id, { startMs: eventMs(s), endMs: null, tz: s.tzOffsetMinutes });
    } else {
      const b = bounds.get(id);
      if (b) b.endMs = eventMs(s);
      else bounds.set(id, { startMs: eventMs(s), endMs: eventMs(s), tz: s.tzOffsetMinutes });
    }
  }
  for (const w of wagers) {
    const sid = w.payload.sessionId;
    if (sid && bounds.has(sid)) {
      const list = wagersBySession.get(sid) ?? [];
      list.push(w);
      wagersBySession.set(sid, list);
    } else {
      uncovered.push(w);
    }
  }

  const sessions: SessionInterval[] = [];
  for (const [id, b] of bounds) {
    const ws = wagersBySession.get(id) ?? [];
    const lastWagerMs = ws.length > 0 ? eventMs(ws[ws.length - 1]!) : b.startMs;
    const interval = buildInterval(id, b.startMs, b.endMs ?? lastWagerMs + MINUTE_MS, ws);
    interval.tzOffsetMinutes = interval.tzOffsetMinutes ?? b.tz;
    sessions.push(interval);
  }
  sessions.push(...deriveSessions(uncovered, gapMinutes));
  return sessions.sort((a, b) => a.startMs - b.startMs);
}

export function buildHistory(
  rawEvents: MarkerEvent[],
  playerId: string,
  asOfMs: number,
  config: EngineConfig,
): PlayerHistory {
  const events = normalizeEvents(
    rawEvents.filter((e) => e.playerId === playerId),
    asOfMs,
  );

  const wagers = events.filter((e): e is WagerEvent => e.type === 'wager');
  const deposits = events.filter((e): e is DepositEvent => e.type === 'deposit');
  const withdrawals = events.filter((e): e is WithdrawalEvent => e.type === 'withdrawal');
  const sessionEvents = events.filter((e): e is SessionEvent => e.type === 'session');
  const contacts = events.filter((e): e is SupportContactEvent => e.type === 'support_contact');
  const safetyTools = events.filter((e): e is SafetyToolEvent => e.type === 'safety_tool');
  const bonuses = events.filter((e): e is BonusEvent => e.type === 'bonus');

  const sessions = resolveSessions(sessionEvents, wagers, config.sessionGapMinutes);
  const days = new Map<string, DayAgg>();
  const day = (key: string): DayAgg => {
    let d = days.get(key);
    if (!d) {
      d = emptyDay(key);
      days.set(key, d);
    }
    return d;
  };

  const hourSlots = new Map<string, Set<number>>();
  for (const w of wagers) {
    const key = dayKey(eventMs(w), w.tzOffsetMinutes);
    const d = day(key);
    d.stakeMinor += w.payload.stakeMinor;
    d.payoutMinor += w.payload.payoutMinor;
    d.netLossMinor += w.payload.stakeMinor - w.payload.payoutMinor;
    d.wagerCount += 1;
    d.stakeByProduct[w.payload.product] = (d.stakeByProduct[w.payload.product] ?? 0) + w.payload.stakeMinor;
    // §5.6.2 Method 2: one-hour slots with at least one gambling activity.
    const hour = localHour(eventMs(w), w.tzOffsetMinutes);
    if (hour !== null) {
      const slots = hourSlots.get(key) ?? new Set<number>();
      slots.add(Math.floor(hour));
      hourSlots.set(key, slots);
    }
  }
  for (const [key, slots] of hourSlots) day(key).hourSlotsWithActivity = slots.size;

  for (const dep of deposits) {
    const d = day(dayKey(eventMs(dep), dep.tzOffsetMinutes));
    if (dep.payload.status === 'succeeded') {
      d.depositMinor += dep.payload.amountMinor;
      d.depositCount += 1;
    } else {
      d.failedDepositCount += 1;
    }
  }
  for (const w of withdrawals) {
    if (w.payload.status === 'completed') {
      day(dayKey(eventMs(w), w.tzOffsetMinutes)).withdrawalCompletedMinor += w.payload.amountMinor;
    }
  }
  // §5.9.2: bonuses subtract from losses; forfeited/withdrawn bonuses count
  // negatively toward the bonus sum.
  for (const b of bonuses) {
    const amount = b.payload.amountMinor ?? 0;
    const d = day(dayKey(eventMs(b), b.tzOffsetMinutes));
    const signed = b.payload.action === 'forfeited' ? -amount : b.payload.action === 'claimed' ? amount : 0;
    d.bonusMinor += signed;
    d.netLossMinor -= signed;
  }
  for (const c of contacts) {
    const d = day(dayKey(eventMs(c), c.tzOffsetMinutes));
    d.contactCount += 1;
    const cat = c.payload.category ?? 'other';
    d.contactCategories[cat] = (d.contactCategories[cat] ?? 0) + 1;
    const sentiment = c.payload.sentiment ?? 'neutral';
    d.contactSentiments[sentiment] = (d.contactSentiments[sentiment] ?? 0) + 1;
  }
  // Gambling time per §5.6.2 Method 1: sessions split across day boundaries —
  // each minute is attributed to the (player-local) day it falls in. The
  // walk is capped at 48h per session defensively.
  for (const s of sessions) {
    const startDay = day(dayKey(s.startMs, s.tzOffsetMinutes));
    const minutes = Math.max(1, Math.round((s.endMs - s.startMs) / MINUTE_MS));
    startDay.longestSessionMinutes = Math.max(startDay.longestSessionMinutes, minutes);
    const cappedEnd = Math.min(s.endMs, s.startMs + 48 * HOUR_MS);
    const [nightStart, nightEnd] = config.nightHours;
    for (let t = s.startMs; t < cappedEnd; t += MINUTE_MS) {
      const d = day(dayKey(t, s.tzOffsetMinutes));
      d.activeMinutes += 1;
      const hour = localHour(t, s.tzOffsetMinutes);
      if (hour === null) d.nightMinutes = null;
      else if (d.nightMinutes !== null && hour >= nightStart && hour < nightEnd) d.nightMinutes += 1;
    }
  }

  const { baselineFromMs, baselineToMs } = baselineWindow(asOfMs, config);
  let baselineActiveDays = 0;
  for (const d of days.values()) {
    const ms = toMs(`${d.dayKey}T00:00:00Z`);
    if (ms >= baselineFromMs && ms < baselineToMs && d.wagerCount > 0) baselineActiveDays += 1;
  }

  return {
    playerId,
    asOfMs,
    config,
    wagers,
    deposits,
    withdrawals,
    contacts,
    safetyTools,
    sessions,
    days,
    baselineActiveDays,
    baselineSource: baselineActiveDays >= config.minBaselineActiveDays ? 'self' : 'population',
  };
}

// ---------------------------------------------------------------------------
// Baseline machinery (SPEC §2.4)
// ---------------------------------------------------------------------------

export function baselineWindow(asOfMs: number, config: EngineConfig): {
  baselineFromMs: number;
  baselineToMs: number;
} {
  const baselineToMs = asOfMs - config.scrutinyDays * DAY_MS;
  return { baselineFromMs: baselineToMs - config.baselineDays * DAY_MS, baselineToMs };
}

export interface DailySeries {
  featureName: string;
  /** One entry per calendar day of the scrutiny window (missing day = 0). */
  scrutiny: { dayKey: string; value: number; z: number | null }[];
  baselineValues: number[];
  /** null ⇒ no self baseline and no population reference: z unavailable. */
  stats: RobustStats | null;
  /**
   * Standing population comparison per EN 18144 §4.1 ("compare both to the
   * population and to the player themself"): max scrutiny-day z against
   * config.populationRef, independent of the self baseline. null when no
   * population reference is configured for this feature.
   */
  populationZ: number | null;
}

/**
 * Daily series for one feature: scrutiny-window values (zero-filled) plus
 * robust stats from wager-active baseline days, falling back to
 * config.populationRef[featureName] and finally to null.
 */
export function dailySeries(
  history: PlayerHistory,
  featureName: string,
  feature: (d: DayAgg) => number,
): DailySeries {
  const { config, asOfMs } = history;
  const { baselineFromMs, baselineToMs } = baselineWindow(asOfMs, config);

  const baselineValues: number[] = [];
  for (const d of history.days.values()) {
    const ms = toMs(`${d.dayKey}T00:00:00Z`);
    if (ms >= baselineFromMs && ms < baselineToMs && d.wagerCount > 0) {
      baselineValues.push(feature(d));
    }
  }

  const pop = config.populationRef?.[featureName];
  let stats: RobustStats | null = null;
  if (baselineValues.length >= config.minBaselineActiveDays) {
    stats = robustStats(baselineValues);
  } else if (pop) {
    stats = { median: pop.median, mad: pop.mad, n: 0, source: 'population' };
  }

  const scrutiny: DailySeries['scrutiny'] = [];
  let populationZ: number | null = null;
  for (let i = config.scrutinyDays; i >= 1; i--) {
    const key = new Date(asOfMs - i * DAY_MS).toISOString().slice(0, 10);
    const value = feature(history.days.get(key) ?? emptyDay(key));
    scrutiny.push({ dayKey: key, value, z: stats ? robustZ(value, stats) : null });
    if (pop) {
      const zPop = robustZ(value, pop);
      populationZ = populationZ === null ? zPop : Math.max(populationZ, zPop);
    }
  }

  return { featureName, scrutiny, baselineValues, stats, populationZ };
}

/** Sum of a daily feature over [asOf − days, asOf) — the EN 18144 time spans. */
export function sumOverDays(
  history: PlayerHistory,
  days: number,
  feature: (d: DayAgg) => number,
): number {
  const from = history.asOfMs - days * DAY_MS;
  let total = 0;
  for (const d of history.days.values()) {
    const ms = toMs(`${d.dayKey}T00:00:00Z`);
    if (ms >= from && ms < history.asOfMs) total += feature(d);
  }
  return total;
}

/** Values of a feature over the trailing trajectoryDays (zero-filled). */
export function trajectorySeries(
  history: PlayerHistory,
  feature: (d: DayAgg) => number,
): number[] {
  const out: number[] = [];
  for (let i = history.config.trajectoryDays; i >= 1; i--) {
    const key = new Date(history.asOfMs - i * DAY_MS).toISOString().slice(0, 10);
    out.push(feature(history.days.get(key) ?? emptyDay(key)));
  }
  return out;
}

/** Events of a type within [asOf − days, asOf). */
export function windowEvents<T extends MarkerEvent>(events: T[], asOfMs: number, days: number): T[] {
  const fromMs = asOfMs - days * DAY_MS;
  return events.filter((e) => eventMs(e) >= fromMs && eventMs(e) < asOfMs);
}
