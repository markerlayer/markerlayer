/**
 * M8 — Responsible Gambling Tools (EN 18144:2025 §5.8).
 * §5.8.1 time spans: day, week, month. §5.8.2 measurement: the quantity of
 * modifications made within the player management tools — ALL changes are
 * counted; increases and reductions may be distinguished; self-exclusion is
 * counted separately and includes the number of activations in the account
 * history since account opening.
 */

import type { MarkerResult, SafetyToolEvent } from '../schema.js';
import { eventMs, windowEvents } from '../history.js';
import { thresholdsFor } from '../config.js';
import { DAY_MS, HOUR_MS } from '../time.js';
import { type MarkerCtx, fmt, override, result } from './shared.js';

const MONETARY_LIMITS = new Set(['deposit_limit', 'loss_limit']);
const EXCLUSION_TOOLS = new Set(['time_out', 'self_exclusion']);

export function computeM8(ctx: MarkerCtx): MarkerResult {
  const { history } = ctx;
  // Absence of safety_tool events is meaningful here (no changes made), so
  // this marker never reports insufficient_data on an otherwise-active player.
  const thresholds = thresholdsFor(history.config, 'M8_responsible_gambling_tools');

  // §5.8.2: all changes counted, over the standard's time spans.
  const changesIn = (days: number) => windowEvents(history.safetyTools, history.asOfMs, days);
  const rgChangeCountDay = changesIn(1).length;
  const rgChangeCountWeek = changesIn(7).length;
  const rgChangeCountMonth = changesIn(30).length;

  const st90 = changesIn(90);
  const limitRaiseCount90d = st90.filter((e) => e.payload.action === 'raised').length;
  const limitRemovalCount90d = st90.filter((e) => e.payload.action === 'removed').length;
  const protectiveActionCount90d = st90.filter(
    (e) => e.payload.action === 'set' || e.payload.action === 'lowered',
  ).length;

  // §5.8.2: self-exclusion counted separately, over the whole account history.
  const selfExclusionActivationsLifetime = history.safetyTools.filter(
    (e) => e.payload.tool === 'self_exclusion' && e.payload.action === 'set',
  ).length;

  // Post-exclusion play: latency from a time_out/self_exclusion expiring or
  // being revoked to the first subsequent wager.
  let postExclusionPlayLatencyHours: number | null = null;
  for (const e of history.safetyTools) {
    if (!EXCLUSION_TOOLS.has(e.payload.tool)) continue;
    if (e.payload.action !== 'expired' && e.payload.action !== 'revoked') continue;
    const t = eventMs(e);
    const next = history.wagers.find((w) => eventMs(w) > t);
    if (next) {
      const hours = (eventMs(next) - t) / HOUR_MS;
      postExclusionPlayLatencyHours =
        postExclusionPlayLatencyHours === null ? hours : Math.min(postExclusionPlayLatencyHours, hours);
    }
  }

  // Near-limit weakening: a monetary limit raised/removed within 24h of the
  // player's deposits reaching ≥80% of the last known limit value.
  let nearLimitWeakening = false;
  const lastValue = new Map<string, number>();
  for (const e of history.safetyTools) {
    const { tool, action, valueMinor } = e.payload;
    if (!MONETARY_LIMITS.has(tool)) continue;
    if ((action === 'set' || action === 'lowered' || action === 'raised') && valueMinor !== undefined) {
      if (action === 'raised' && withinLimitPressure(ctx, e, lastValue.get(tool))) {
        nearLimitWeakening = true;
      }
      lastValue.set(tool, valueMinor);
    } else if (action === 'removed') {
      if (withinLimitPressure(ctx, e, lastValue.get(tool))) nearLimitWeakening = true;
      lastValue.delete(tool);
    }
  }

  const raiseThreshold = thresholds.overrides?.['limitRaiseCount90d'] ?? 2;
  const postExclusionThreshold = thresholds.overrides?.['postExclusionPlayLatencyHours'] ?? 24;

  let s: { state: MarkerResult['state']; evidence: string[] } = { state: 'normal', evidence: [] };
  s = override(
    s,
    limitRaiseCount90d >= raiseThreshold,
    'elevated',
    `limitRaiseCount90d=${limitRaiseCount90d} ≥ ${raiseThreshold}`,
  );
  s = override(
    s,
    nearLimitWeakening,
    'high',
    'monetary limit raised/removed within 24h of deposits reaching ≥80% of the limit',
  );
  s = override(
    s,
    postExclusionPlayLatencyHours !== null && postExclusionPlayLatencyHours <= postExclusionThreshold,
    'high',
    `postExclusionPlayLatencyHours=${fmt(postExclusionPlayLatencyHours ?? 0)} ≤ ${postExclusionThreshold}`,
  );

  return result(
    s.state,
    {
      rgChangeCountDay,
      rgChangeCountWeek,
      rgChangeCountMonth,
      limitRaiseCount90d,
      limitRemovalCount90d,
      protectiveActionCount90d,
      selfExclusionActivationsLifetime,
      postExclusionPlayLatencyHours,
    },
    s.evidence,
  );
}

/** Deposits in the 24h before the change ≥ 80% of the previous limit value. */
function withinLimitPressure(ctx: MarkerCtx, e: SafetyToolEvent, previousLimitMinor?: number): boolean {
  if (previousLimitMinor === undefined || previousLimitMinor <= 0) return false;
  const t = eventMs(e);
  const deposits24h = ctx.history.deposits
    .filter(
      (d) => d.payload.status === 'succeeded' && eventMs(d) >= t - DAY_MS && eventMs(d) < t,
    )
    .reduce((a, d) => a + d.payload.amountMinor, 0);
  return deposits24h >= 0.8 * previousLimitMinor;
}

/** Human-readable protective signals for the top-level output (SPEC §4). */
export function protectiveSignals(ctx: MarkerCtx): string[] {
  const out: string[] = [];
  for (const e of windowEvents(ctx.history.safetyTools, ctx.history.asOfMs, 90)) {
    if (e.payload.action === 'set' || e.payload.action === 'lowered') {
      out.push(`M8: ${e.payload.tool} ${e.payload.action} ${e.occurredAt.slice(0, 10)}`);
    }
  }
  return out;
}
