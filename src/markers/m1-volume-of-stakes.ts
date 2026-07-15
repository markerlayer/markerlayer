/**
 * M1 — Volume of Stakes (EN 18144:2025 §5.1).
 * §5.1.1 time spans: within sessions and over day, week, month, 90 and 180 days.
 * §5.1.2 measurement: cumulative bet amount AND number of stakes.
 */

import type { MarkerResult } from '../schema.js';
import { dailySeries, sumOverDays, trajectorySeries, type PlayerHistory } from '../history.js';
import { coefficientOfVariation, olsSlope } from '../stats.js';
import { thresholdsFor } from '../config.js';
import { DAY_MS } from '../time.js';
import { type MarkerCtx, fmt, insufficient, override, result, zState } from './shared.js';

/**
 * Trajectory over WEEKLY stake sums (%/week). Daily zero-filled series are
 * far too noisy for sparse players — which day of the week someone happened
 * to play would dominate the slope; weekly sums measure actual escalation.
 */
function weeklyTrajectory(history: PlayerHistory, weeksBack: number): number {
  const sums: number[] = [];
  for (let w = weeksBack + 3; w >= weeksBack; w--) {
    const upto = sumOverDays(history, w * 7, (d) => d.stakeMinor);
    const before = sumOverDays(history, (w - 1) * 7, (d) => d.stakeMinor);
    sums.push(upto - before);
  }
  const slope = olsSlope(sums.map((v) => Math.log1p(Math.max(0, v))));
  return (Math.exp(slope) - 1) * 100;
}

export function computeM1(ctx: MarkerCtx): MarkerResult {
  const { history } = ctx;
  if (history.wagers.length === 0) {
    return insufficient({}, ['wager events']);
  }
  const thresholds = thresholdsFor(history.config, 'M1_volume_of_stakes');

  const stake = dailySeries(history, 'dailyStakeMinor', (d) => d.stakeMinor);
  const count = dailySeries(history, 'dailyWagerCount', (d) => d.wagerCount);

  // §5.1: cumulative amount and stake count over the required time spans.
  const spans: Record<string, number> = {};
  for (const [label, days] of [['Day', 1], ['Week', 7], ['Month', 30], ['90d', 90], ['180d', 180]] as const) {
    spans[`stakeAmount${label}`] = sumOverDays(history, days, (d) => d.stakeMinor);
    spans[`stakeCount${label}`] = sumOverDays(history, days, (d) => d.wagerCount);
  }

  const stakeTrajectory = weeklyTrajectory(history, 1);
  const priorTrajectory = weeklyTrajectory(history, 2);
  const variabilityWindow = trajectorySeries(history, (d) => d.stakeMinor).filter((v) => v > 0);
  const stakeVariability = coefficientOfVariation(variabilityWindow);

  const rampThreshold = thresholds.overrides?.['stakeTrajectoryPctPerWeek'] ?? 50;
  // The ramp must be a real volume increase, not sparse-play noise: last
  // week's stake must also clear the player's typical week by 50%. With no
  // usable baseline (cold start) the override stays silent — growth from
  // zero is onboarding, not escalation.
  const typicalWeek = stake.stats && stake.stats.source === 'self' ? stake.stats.median * 7 : null;
  const volumeGate = typicalWeek !== null && spans['stakeAmountWeek']! >= 1.5 * typicalWeek;

  let s = zState([stake, count], thresholds);
  s = override(
    s,
    stakeTrajectory >= rampThreshold && priorTrajectory >= rampThreshold && volumeGate,
    'high',
    `stakeTrajectoryPctPerWeek=${fmt(stakeTrajectory)} ≥ ${fmt(rampThreshold)} for two consecutive weeks`,
  );

  const zs = stake.scrutiny.map((d) => d.z).filter((z): z is number => z !== null);
  const czs = count.scrutiny.map((d) => d.z).filter((z): z is number => z !== null);

  return result(
    s.state,
    {
      ...spans,
      stakeZ: zs.length > 0 ? Math.max(...zs) : null,
      wagerCountZ: czs.length > 0 ? Math.max(...czs) : null,
      stakePopulationZ: stake.populationZ,
      stakeTrajectoryPctPerWeek: stakeTrajectory,
      stakeVariability,
    },
    s.evidence,
    stake.stats === null ? ['sufficient baseline history (z-scores unavailable)'] : undefined,
  );
}
