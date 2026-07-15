/**
 * M2 — Speed of Play (EN 18144:2025 §5.2).
 * §5.2.2 measurement: for each stake, the time since the previous stake in
 * the same session (the first stake of a session has no measured time); the
 * measured times are summed and divided by the number of stakes that have a
 * measured time — i.e. the MEAN inter-bet interval, reported per day, week,
 * and month (§5.2.1).
 */

import type { MarkerResult } from '../schema.js';
import { dailySeries, eventMs, windowEvents } from '../history.js';
import { thresholdsFor } from '../config.js';
import { DAY_MS, MINUTE_MS } from '../time.js';
import { type MarkerCtx, fmt, insufficient, override, result, zState } from './shared.js';

export function computeM2(ctx: MarkerCtx): MarkerResult {
  const { history } = ctx;
  if (history.wagers.length === 0) {
    return insufficient({}, ['wager events']);
  }
  const thresholds = thresholdsFor(history.config, 'M2_speed_of_play');

  const intensity = dailySeries(history, 'betsPerActiveHour', (d) =>
    // Days with under 10 active minutes are sliver days (e.g. the tail of a
    // midnight-spanning session) — their bets-per-hour is meaningless noise.
    d.activeMinutes >= 10 ? d.wagerCount / (d.activeMinutes / 60) : 0,
  );

  // Mean inter-bet interval per §5.2.2, over a [from, to) window.
  const meanInterBet = (fromMs: number, toMs: number): number | null => {
    let sum = 0;
    let n = 0;
    for (const s of history.sessions) {
      for (let i = 1; i < s.wagers.length; i++) {
        const t = eventMs(s.wagers[i]!);
        if (t < fromMs || t >= toMs) continue;
        sum += (t - eventMs(s.wagers[i - 1]!)) / 1000;
        n += 1;
      }
    }
    return n > 0 ? sum / n : null;
  };
  const meanInterBetSecondsDay = meanInterBet(history.asOfMs - DAY_MS, history.asOfMs);
  const meanInterBetSecondsWeek = meanInterBet(history.asOfMs - 7 * DAY_MS, history.asOfMs);
  const meanInterBetSecondsMonth = meanInterBet(history.asOfMs - 30 * DAY_MS, history.asOfMs);
  const baselineTo = history.asOfMs - history.config.scrutinyDays * DAY_MS;
  const meanInterBetBaseline = meanInterBet(
    baselineTo - history.config.baselineDays * DAY_MS,
    baselineTo,
  );
  // Speed-up ratio: baseline mean gap ÷ recent mean gap (>1 = faster play).
  const speedUpRatioWeek =
    meanInterBetSecondsWeek !== null && meanInterBetBaseline !== null && meanInterBetSecondsWeek > 0
      ? meanInterBetBaseline / meanInterBetSecondsWeek
      : null;

  // In-session top-ups (chasing dynamic per §4.3): succeeded deposits between
  // first and last wager of a session.
  const topUpBySession = new Map<string, number>();
  const deposits7d = windowEvents(history.deposits, history.asOfMs, 7).filter(
    (d) => d.payload.status === 'succeeded',
  );
  for (const dep of deposits7d) {
    const t = eventMs(dep);
    for (const s of history.sessions) {
      if (s.wagers.length === 0) continue;
      const first = eventMs(s.wagers[0]!);
      const last = eventMs(s.wagers[s.wagers.length - 1]!);
      if (t >= first && t <= last + MINUTE_MS) {
        topUpBySession.set(s.sessionId, (topUpBySession.get(s.sessionId) ?? 0) + 1);
        break;
      }
    }
  }
  const topUpCounts = [...topUpBySession.values()];
  const topUpPerSessionThreshold = thresholds.overrides?.['inSessionTopUpCount'] ?? 3;
  const heavyTopUpSessions7d = topUpCounts.filter((c) => c >= topUpPerSessionThreshold).length;

  const speedUpThreshold = thresholds.overrides?.['speedUpRatio'] ?? 2;

  let s = zState([intensity], thresholds);
  s = override(
    s,
    heavyTopUpSessions7d >= 2,
    'high',
    `${heavyTopUpSessions7d} sessions with ≥${fmt(topUpPerSessionThreshold)} in-session top-ups in 7 days`,
  );
  s = override(
    s,
    speedUpRatioWeek !== null && speedUpRatioWeek >= speedUpThreshold,
    'elevated',
    `play speed ${fmt(speedUpRatioWeek ?? 0)}× faster than baseline (mean inter-bet ${fmt(meanInterBetSecondsWeek ?? 0)}s vs ${fmt(meanInterBetBaseline ?? 0)}s)`,
  );

  const zs = intensity.scrutiny.map((d) => d.z).filter((z): z is number => z !== null);

  return result(
    s.state,
    {
      meanInterBetSecondsDay,
      meanInterBetSecondsWeek,
      meanInterBetSecondsMonth,
      speedUpRatioWeek,
      betsPerActiveHour:
        intensity.scrutiny.reduce((a, d) => a + d.value, 0) / intensity.scrutiny.length,
      betsPerActiveHourZ: zs.length > 0 ? Math.max(...zs) : null,
      inSessionTopUpCount7d: topUpCounts.reduce((a, b) => a + b, 0),
    },
    s.evidence,
    intensity.stats === null ? ['sufficient baseline history (z-scores unavailable)'] : undefined,
  );
}
