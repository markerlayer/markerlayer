import type { EngineConfig, MarkerThresholds } from './schema.js';

export const DEFAULT_THRESHOLDS: MarkerThresholds = {
  elevatedZ: 1.5,
  highZ: 2.5,
  sustainedDays: 2,
};

/**
 * Documented, conservative defaults (SPEC.md §5). These are operator policy,
 * not clinical claims; operators are expected to review and own them.
 */
export const DEFAULT_CONFIG: EngineConfig = {
  baselineDays: 90,
  scrutinyDays: 7,
  trajectoryDays: 28,
  minBaselineActiveDays: 14,
  // EN 18144 §3.6: two bets belong to the same session if no 5-minute span
  // without a bet passes between them.
  sessionGapMinutes: 5,
  nightHours: [0, 6],
  thresholds: {},
  retentionDays: 35,
};

export function resolveConfig(partial?: Partial<EngineConfig>): EngineConfig {
  return { ...DEFAULT_CONFIG, ...partial };
}

export function thresholdsFor(
  config: EngineConfig,
  markerId: keyof EngineConfig['thresholds'],
): MarkerThresholds {
  return { ...DEFAULT_THRESHOLDS, ...config.thresholds[markerId] };
}
