/**
 * M9 — Losses (EN 18144:2025 §5.9).
 * §5.9.1 time spans: within sessions and over day, week, month, 90 and 180
 * days. §5.9.2: losses are computed per Loss Calculation Method 2 — sum of
 * stakes minus winnings minus bonuses, settled bets only, with forfeited or
 * withdrawn bonuses counting negatively toward the bonus sum (implemented in
 * the history layer's DayAgg.netLossMinor). The result may be negative.
 */

import type { MarkerResult } from '../schema.js';
import { dailySeries, sumOverDays, trajectorySeries } from '../history.js';
import { trajectoryPctPerWeek } from '../stats.js';
import { thresholdsFor } from '../config.js';
import { DAY_MS, toMs } from '../time.js';
import { type MarkerCtx, fmt, insufficient, override, result, zState } from './shared.js';

export function computeM9(ctx: MarkerCtx): MarkerResult {
  const { history } = ctx;
  if (history.wagers.length === 0) {
    return insufficient({}, ['wager events']);
  }
  const thresholds = thresholdsFor(history.config, 'M9_losses');

  const loss = dailySeries(history, 'dailyNetLossMinor', (d) => d.netLossMinor);

  // §5.9 loss totals over the standard's time spans.
  const netLossMinorDay = sumOverDays(history, 1, (d) => d.netLossMinor);
  const netLossMinorWeek = sumOverDays(history, 7, (d) => d.netLossMinor);
  const netLossMinorMonth = sumOverDays(history, 30, (d) => d.netLossMinor);
  const netLossMinor90d = sumOverDays(history, 90, (d) => d.netLossMinor);
  const netLossMinor180d = sumOverDays(history, 180, (d) => d.netLossMinor);

  // Trajectory over losses only (wins clamp to 0 inside trajectoryPctPerWeek).
  const lossTrajectoryPctPerWeek = trajectoryPctPerWeek(
    trajectorySeries(history, (d) => d.netLossMinor),
  );

  // Escalation: current 30d net loss vs the mean 30-day net loss of the
  // prior 90 days. Capped at 99 to stay JSON-safe; null when there is no
  // meaningful prior-loss base to compare against.
  const priorFrom = history.asOfMs - 120 * DAY_MS;
  const priorTo = history.asOfMs - 30 * DAY_MS;
  let prior = 0;
  for (const d of history.days.values()) {
    const ms = toMs(`${d.dayKey}T00:00:00Z`);
    if (ms >= priorFrom && ms < priorTo) prior += d.netLossMinor;
  }
  const priorMean30d = prior / 3;
  const lossEscalationRatio =
    priorMean30d > 0 ? Math.min(netLossMinorMonth / priorMean30d, 99) : null;

  const deposits30d = sumOverDays(history, 30, (d) => d.depositMinor);
  const lostDepositShare30d =
    deposits30d > 0 ? Math.min(Math.max(netLossMinorMonth / deposits30d, 0), 1) : null;

  const escalationThreshold = thresholds.overrides?.['lossEscalationRatio'] ?? 2;

  let s = zState([loss], thresholds);
  s = override(
    s,
    lossEscalationRatio !== null && lossEscalationRatio >= escalationThreshold && lossTrajectoryPctPerWeek > 0,
    'high',
    `lossEscalationRatio=${fmt(lossEscalationRatio ?? 0)} ≥ ${fmt(escalationThreshold)} with rising trajectory (${fmt(lossTrajectoryPctPerWeek)}%/week)`,
  );

  const zs = loss.scrutiny.map((d) => d.z).filter((z): z is number => z !== null);

  return result(
    s.state,
    {
      netLossMinorDay,
      netLossMinorWeek,
      netLossMinorMonth,
      netLossMinor90d,
      netLossMinor180d,
      lossZ: zs.length > 0 ? Math.max(...zs) : null,
      lossPopulationZ: loss.populationZ,
      lossTrajectoryPctPerWeek,
      lossEscalationRatio,
      lostDepositShare30d,
    },
    s.evidence,
    loss.stats === null ? ['sufficient baseline history (z-scores unavailable)'] : undefined,
  );
}
