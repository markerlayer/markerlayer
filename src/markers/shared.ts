import type { MarkerResult, MarkerState, MarkerThresholds } from '../schema.js';
import type { DailySeries, PlayerHistory } from '../history.js';

export interface MarkerCtx {
  history: PlayerHistory;
}

export function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

const STATE_RANK: Record<MarkerState, number> = {
  insufficient_data: 0,
  normal: 1,
  elevated: 2,
  high: 3,
};

export function maxState(a: MarkerState, b: MarkerState): MarkerState {
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

export function isAttention(state: MarkerState): boolean {
  return state === 'elevated' || state === 'high';
}

/**
 * Default state mapping (SPEC §2.4): elevated/high when the daily robust z
 * exceeds the threshold on ≥ sustainedDays of the scrutiny window.
 * Returns state + evidence naming the feature, threshold, and day count.
 */
export function zState(
  series: DailySeries[],
  thresholds: MarkerThresholds,
): { state: MarkerState; evidence: string[] } {
  let state: MarkerState = 'normal';
  const evidence: string[] = [];
  let anyZ = false;

  for (const s of series) {
    const zs = s.scrutiny.map((d) => d.z).filter((z): z is number => z !== null);
    if (zs.length === 0) continue;
    anyZ = true;
    const days = s.scrutiny.length;
    const highDays = zs.filter((z) => z >= thresholds.highZ).length;
    const elevatedDays = zs.filter((z) => z >= thresholds.elevatedZ).length;
    const maxZ = Math.max(...zs);
    if (highDays >= thresholds.sustainedDays) {
      state = maxState(state, 'high');
      evidence.push(`${s.featureName} z≥${fmt(thresholds.highZ)} on ${highDays}/${days} days (max z=${fmt(maxZ)})`);
    } else if (elevatedDays >= thresholds.sustainedDays) {
      state = maxState(state, 'elevated');
      evidence.push(`${s.featureName} z≥${fmt(thresholds.elevatedZ)} on ${elevatedDays}/${days} days (max z=${fmt(maxZ)})`);
    }
  }

  if (!anyZ) return { state: 'normal', evidence: [] };
  return { state, evidence };
}

/** Apply an absolute override rule, escalating state and recording evidence. */
export function override(
  current: { state: MarkerState; evidence: string[] },
  condition: boolean,
  toState: MarkerState,
  reason: string,
): { state: MarkerState; evidence: string[] } {
  if (!condition) return current;
  return {
    state: maxState(current.state, toState),
    evidence: [...current.evidence, reason],
  };
}

export function result(
  state: MarkerState,
  features: MarkerResult['features'],
  evidence: string[],
  missing?: string[],
): MarkerResult {
  const r: MarkerResult = { state, features, evidence };
  if (missing && missing.length > 0) r.missing = missing;
  return r;
}

export function insufficient(features: MarkerResult['features'], missing: string[]): MarkerResult {
  return { state: 'insufficient_data', features, evidence: [], missing };
}
