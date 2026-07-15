/**
 * M6 — Gambling Time (EN 18144:2025 §5.6).
 * §5.6.1 time spans: within sessions and over day, week, month.
 * §5.6.2 measurement — both methods are complementary and SHALL be used:
 *   Method 1: combined session length within the time span, sessions split
 *   across day boundaries (implemented in the history layer's minute walk).
 *   Method 2: count of one-hour slots with at least one gambling activity
 *   per 24h (DayAgg.hourSlotsWithActivity).
 */

import type { MarkerResult } from '../schema.js';
import { baselineWindow, dailySeries, sumOverDays } from '../history.js';
import { robustStats, robustZ } from '../stats.js';
import { thresholdsFor } from '../config.js';
import { DAY_MS, toMs } from '../time.js';
import { type MarkerCtx, fmt, insufficient, override, result, zState } from './shared.js';

export function computeM6(ctx: MarkerCtx): MarkerResult {
  const { history } = ctx;
  if (history.sessions.length === 0) {
    return insufficient({}, ['session events or wagers to derive sessions from']);
  }
  const thresholds = thresholdsFor(history.config, 'M6_gambling_time');

  const active = dailySeries(history, 'dailyActiveMinutes', (d) => d.activeMinutes);
  const slots = dailySeries(history, 'hourSlotsWithActivity', (d) => d.hourSlotsWithActivity);

  // §5.6 Method 1 totals over the standard's time spans.
  const gamblingTimeMinutesDay = sumOverDays(history, 1, (d) => d.activeMinutes);
  const gamblingTimeMinutesWeek = sumOverDays(history, 7, (d) => d.activeMinutes);
  const gamblingTimeMinutesMonth = sumOverDays(history, 30, (d) => d.activeMinutes);
  // §5.6 Method 2: hour-slot counts.
  const hourSlotsWeek = sumOverDays(history, 7, (d) => d.hourSlotsWithActivity);
  const maxHourSlotsPerDayWeek = (() => {
    let max = 0;
    for (const e of slots.scrutiny) max = Math.max(max, e.value);
    return max;
  })();

  let longestSessionMinutes7d = 0;
  for (const s of history.sessions) {
    if (s.startMs >= history.asOfMs - 7 * DAY_MS && s.startMs < history.asOfMs) {
      longestSessionMinutes7d = Math.max(longestSessionMinutes7d, Math.round((s.endMs - s.startMs) / 60_000));
    }
  }

  // Night share over the trailing 28 days, player-local. Days with unknown
  // timezone are excluded; if none are known the component degrades.
  const from28 = history.asOfMs - 28 * DAY_MS;
  let night28 = 0;
  let activeKnownTz28 = 0;
  const baselineNightShares: number[] = [];
  const { baselineFromMs, baselineToMs } = baselineWindow(history.asOfMs, history.config);
  for (const d of history.days.values()) {
    const ms = toMs(`${d.dayKey}T00:00:00Z`);
    if (d.nightMinutes === null || d.activeMinutes === 0) continue;
    if (ms >= from28 && ms < history.asOfMs) {
      night28 += d.nightMinutes;
      activeKnownTz28 += d.activeMinutes;
    }
    if (ms >= baselineFromMs && ms < baselineToMs) {
      baselineNightShares.push(d.nightMinutes / d.activeMinutes);
    }
  }
  const nightShare28d = activeKnownTz28 > 0 ? night28 / activeKnownTz28 : null;
  let nightShareZ: number | null = null;
  if (nightShare28d !== null && baselineNightShares.length >= history.config.minBaselineActiveDays) {
    nightShareZ = robustZ(nightShare28d, robustStats(baselineNightShares));
  }

  const longSessionThreshold = thresholds.overrides?.['longestSessionMinutes'] ?? 360;
  const nightShareThreshold = thresholds.overrides?.['nightShare'] ?? 0.3;

  let s = zState([active, slots], thresholds);
  s = override(
    s,
    longestSessionMinutes7d >= longSessionThreshold,
    'high',
    `longestSessionMinutes7d=${longestSessionMinutes7d} ≥ ${longSessionThreshold}`,
  );
  s = override(
    s,
    nightShare28d !== null && nightShareZ !== null && nightShare28d >= nightShareThreshold && nightShareZ >= 2,
    'high',
    `nightShare28d=${fmt(nightShare28d ?? 0)} ≥ ${fmt(nightShareThreshold)} with nightShareZ=${fmt(nightShareZ ?? 0)} ≥ 2`,
  );

  const zs = active.scrutiny.map((d) => d.z).filter((z): z is number => z !== null);
  const missing: string[] = [];
  if (active.stats === null) missing.push('sufficient baseline history (z-scores unavailable)');
  if (nightShare28d === null) missing.push('tzOffsetMinutes on events (time-of-day analysis suppressed)');

  return result(
    s.state,
    {
      gamblingTimeMinutesDay,
      gamblingTimeMinutesWeek,
      gamblingTimeMinutesMonth,
      hourSlotsWeek,
      maxHourSlotsPerDayWeek,
      activeMinutesZ: zs.length > 0 ? Math.max(...zs) : null,
      longestSessionMinutes7d,
      nightShare28d,
      nightShareZ,
      daysActivePerWeek: active.scrutiny.filter((d) => d.value > 0).length,
    },
    s.evidence,
    missing.length > 0 ? missing : undefined,
  );
}
