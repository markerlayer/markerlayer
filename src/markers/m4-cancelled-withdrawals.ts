/**
 * M4 — Cancelled Withdrawals (EN 18144:2025 §5.4).
 * §5.4.1 time spans: day, week, month. §5.4.2 measurement: the number of
 * cancelled withdrawals counted in the relevant time frames.
 */

import type { MarkerResult } from '../schema.js';
import { dailySeries, eventMs, windowEvents } from '../history.js';
import { median } from '../stats.js';
import { thresholdsFor } from '../config.js';
import { DAY_MS } from '../time.js';
import { type MarkerCtx, fmt, insufficient, override, result } from './shared.js';

export function computeM4(ctx: MarkerCtx): MarkerResult {
  const { history } = ctx;
  if (history.withdrawals.length === 0) {
    return insufficient({}, ['withdrawal events']);
  }
  const thresholds = thresholdsFor(history.config, 'M4_cancelled_withdrawals');

  const cancelledIn = (days: number) =>
    windowEvents(history.withdrawals, history.asOfMs, days).filter(
      (w) => w.payload.status === 'cancelled_by_player',
    );

  // §5.4.2 required counts.
  const cancelledCountDay = cancelledIn(1).length;
  const cancelledCountWeek = cancelledIn(7).length;
  const cancelledCountMonth = cancelledIn(30).length;

  const w90 = windowEvents(history.withdrawals, history.asOfMs, 90);
  const requested90 = w90.filter((w) => w.payload.status === 'requested').length;
  const cancelled90 = w90.filter((w) => w.payload.status === 'cancelled_by_player').length;
  const withdrawalCancelRatio90d = requested90 > 0 ? cancelled90 / requested90 : null;

  // Latency from each cancellation to the player's next wager.
  const cancels30 = cancelledIn(30);
  const latencies: number[] = [];
  let rapidReplays30d = 0;
  for (const c of cancels30) {
    const t = eventMs(c);
    const next = history.wagers.find((w) => eventMs(w) > t);
    if (next) {
      const latency = (eventMs(next) - t) / 1000;
      latencies.push(latency);
      if (latency <= 3600) rapidReplays30d += 1;
    }
  }

  // Stake in the 24h after the most severe recent cancel vs baseline daily stake.
  const baselineStake = dailySeries(history, 'dailyStakeMinor', (d) => d.stakeMinor).stats;
  let postCancelStakeMultiple: number | null = null;
  if (baselineStake && baselineStake.median > 0 && cancels30.length > 0) {
    let maxMultiple = 0;
    for (const c of cancels30) {
      const t = eventMs(c);
      const stake24h = history.wagers
        .filter((w) => eventMs(w) > t && eventMs(w) <= t + DAY_MS)
        .reduce((a, w) => a + w.payload.stakeMinor, 0);
      maxMultiple = Math.max(maxMultiple, stake24h / baselineStake.median);
    }
    postCancelStakeMultiple = maxMultiple;
  }

  const elevatedRatio = thresholds.overrides?.['cancelRatioElevated'] ?? 0.25;
  const highRatio = thresholds.overrides?.['cancelRatioHigh'] ?? 0.5;
  const minRequests = thresholds.overrides?.['cancelRatioMinRequests'] ?? 4;

  let s: { state: MarkerResult['state']; evidence: string[] } = { state: 'normal', evidence: [] };
  s = override(
    s,
    withdrawalCancelRatio90d !== null && requested90 >= minRequests && withdrawalCancelRatio90d >= elevatedRatio,
    'elevated',
    `withdrawalCancelRatio90d=${fmt(withdrawalCancelRatio90d ?? 0)} ≥ ${fmt(elevatedRatio)} (${cancelled90}/${requested90} requests)`,
  );
  s = override(
    s,
    withdrawalCancelRatio90d !== null && requested90 >= minRequests && withdrawalCancelRatio90d >= highRatio,
    'high',
    `withdrawalCancelRatio90d=${fmt(withdrawalCancelRatio90d ?? 0)} ≥ ${fmt(highRatio)}`,
  );
  s = override(
    s,
    rapidReplays30d >= 2,
    'high',
    `${rapidReplays30d} withdrawal cancellations followed by wagering within 1h in 30 days`,
  );

  return result(
    s.state,
    {
      cancelledCountDay,
      cancelledCountWeek,
      cancelledCountMonth,
      withdrawalCancelRatio90d,
      cancelToWagerLatencySeconds: latencies.length > 0 ? median(latencies) : null,
      postCancelStakeMultiple,
    },
    s.evidence,
  );
}
