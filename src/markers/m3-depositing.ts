/**
 * M3 — Depositing Behaviour (EN 18144:2025 §5.3).
 * §5.3.1 time spans: within sessions and over day, week, month, 90 and 180 days.
 * §5.3.2 measurement: number of successful AND declined deposits, total
 * amount successfully deposited, deposit methods employed, and NET deposits
 * (deposits − withdrawals, §3.11) over the same time frames.
 */

import type { MarkerResult } from '../schema.js';
import { dailySeries, eventMs, sumOverDays, windowEvents } from '../history.js';
import { median } from '../stats.js';
import { thresholdsFor } from '../config.js';
import { HOUR_MS, MINUTE_MS } from '../time.js';
import { type MarkerCtx, insufficient, override, result, zState } from './shared.js';

export function computeM3(ctx: MarkerCtx): MarkerResult {
  const { history } = ctx;
  if (history.deposits.length === 0) {
    return insufficient({}, ['deposit events']);
  }
  const thresholds = thresholdsFor(history.config, 'M3_depositing_behaviour');

  const depCount = dailySeries(history, 'dailyDepositCount', (d) => d.depositCount);
  const depAmount = dailySeries(history, 'dailyDepositMinor', (d) => d.depositMinor);

  // §5.3.2 required measurements over the standard's time spans.
  const spans: Record<string, number> = {};
  for (const [label, days] of [['Day', 1], ['Week', 7], ['Month', 30], ['90d', 90], ['180d', 180]] as const) {
    spans[`depositCount${label}`] = sumOverDays(history, days, (d) => d.depositCount);
    spans[`depositAmount${label}`] = sumOverDays(history, days, (d) => d.depositMinor);
    spans[`declinedDepositCount${label}`] = sumOverDays(history, days, (d) => d.failedDepositCount);
    spans[`netDeposits${label}`] = sumOverDays(
      history,
      days,
      (d) => d.depositMinor - d.withdrawalCompletedMinor,
    );
  }
  const methodsUsed30d = new Set(
    windowEvents(history.deposits, history.asOfMs, 30)
      .map((d) => d.payload.methodClass)
      .filter((m): m is NonNullable<typeof m> => m !== undefined),
  ).size;

  const failedDepositCount7d = spans['declinedDepositCountWeek']!;

  // Deposit velocity: max attempts in any sliding 60-minute window, 7 days.
  const deposits7d = windowEvents(history.deposits, history.asOfMs, 7);
  const times = deposits7d.map(eventMs).sort((a, b) => a - b);
  let maxDepositsInAnyHour7d = 0;
  for (let i = 0; i < times.length; i++) {
    let j = i;
    while (j < times.length && times[j]! - times[i]! <= HOUR_MS) j++;
    maxDepositsInAnyHour7d = Math.max(maxDepositsInAnyHour7d, j - i);
  }

  // Chase deposits (chasing dynamic per §4.3): succeeded deposit within
  // 30 min of a wager while the session's running net loss ≥ 1× baseline
  // median daily stake.
  const baselineStake = dailySeries(history, 'dailyStakeMinor', (d) => d.stakeMinor).stats;
  const chaseThresholdMinor = baselineStake ? Math.max(baselineStake.median, 1) : null;
  let chaseDepositCount7d = 0;
  const redepositLatencies: number[] = [];
  if (chaseThresholdMinor !== null) {
    for (const dep of deposits7d) {
      if (dep.payload.status !== 'succeeded') continue;
      const t = eventMs(dep);
      const session = history.sessions.find(
        (s) => s.wagers.length > 0 && t >= s.startMs && t <= s.endMs + 30 * MINUTE_MS,
      );
      if (!session) continue;
      let runningLoss = 0;
      let lastWagerMs: number | null = null;
      for (const w of session.wagers) {
        if (eventMs(w) > t) break;
        runningLoss += w.payload.stakeMinor - w.payload.payoutMinor;
        lastWagerMs = eventMs(w);
      }
      if (lastWagerMs === null) continue;
      const latency = (t - lastWagerMs) / 1000;
      if (latency >= 0 && latency <= 30 * 60) {
        redepositLatencies.push(latency);
        if (runningLoss >= chaseThresholdMinor) chaseDepositCount7d += 1;
      }
    }
  }

  const failedThreshold = thresholds.overrides?.['failedDepositCount7d'] ?? 3;
  const chaseThreshold = thresholds.overrides?.['chaseDepositCount7d'] ?? 3;

  let s = zState([depCount, depAmount], thresholds);
  s = override(
    s,
    failedDepositCount7d >= failedThreshold,
    'high',
    `declinedDepositCountWeek=${failedDepositCount7d} ≥ ${failedThreshold}`,
  );
  s = override(
    s,
    chaseDepositCount7d >= chaseThreshold,
    'high',
    `chaseDepositCount7d=${chaseDepositCount7d} ≥ ${chaseThreshold} (re-deposits within 30min of session losses ≥ baseline median daily stake)`,
  );

  const countZ = depCount.scrutiny.map((d) => d.z).filter((z): z is number => z !== null);
  const amountZ = depAmount.scrutiny.map((d) => d.z).filter((z): z is number => z !== null);

  return result(
    s.state,
    {
      ...spans,
      methodsUsed30d,
      depositCountZ: countZ.length > 0 ? Math.max(...countZ) : null,
      depositAmountZ: amountZ.length > 0 ? Math.max(...amountZ) : null,
      depositPopulationZ: depAmount.populationZ,
      maxDepositsInAnyHour7d,
      chaseDepositCount7d: chaseThresholdMinor !== null ? chaseDepositCount7d : null,
      medianRedepositLatencySeconds: redepositLatencies.length > 0 ? median(redepositLatencies) : null,
    },
    s.evidence,
    depCount.stats === null ? ['sufficient baseline history (z-scores unavailable)'] : undefined,
  );
}
