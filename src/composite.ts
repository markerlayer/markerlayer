/**
 * Point-based composite per EN 18144:2025 §4.2: "Markers of harm shall be
 * considered together rather than in isolation and any model should
 * incorporate the interactions between them. Any explicit method should be
 * point-based or incorporate a similar approach."
 *
 * The composite is behavioural review pressure, not a clinical measure.
 * Point values, weights, interactions, and bands are operator policy;
 * the defaults below are documented and conservative.
 */

import type {
  CompositeConfig,
  CompositeResult,
  MarkerId,
  MarkerResult,
} from './schema.js';

export const DEFAULT_COMPOSITE: CompositeConfig = {
  statePoints: { elevated: 1, high: 2 },
  // Interactions score when BOTH markers are ≥ elevated. Pairs reflect
  // compounding dynamics documented in the standard's Annex A literature:
  interactions: [
    {
      markers: ['M9_losses', 'M3_depositing_behaviour'],
      points: 2,
      label: 'losses × depositing (chasing: money in motion while losing)',
    },
    {
      markers: ['M9_losses', 'M4_cancelled_withdrawals'],
      points: 2,
      label: 'losses × cancelled withdrawals (re-gambling money on its way out)',
    },
    {
      markers: ['M1_volume_of_stakes', 'M8_responsible_gambling_tools'],
      points: 2,
      label: 'stake escalation × weakened protections',
    },
    {
      markers: ['M6_gambling_time', 'M2_speed_of_play'],
      points: 1,
      label: 'long × fast play',
    },
    {
      markers: ['M9_losses', 'M5_player_initiated_contact'],
      points: 1,
      label: 'losses × player contact',
    },
  ],
  bands: { moderate: 2, high: 5 },
};

export function resolveComposite(partial?: Partial<CompositeConfig>): CompositeConfig {
  return {
    ...DEFAULT_COMPOSITE,
    ...partial,
    statePoints: { ...DEFAULT_COMPOSITE.statePoints, ...partial?.statePoints },
    bands: { ...DEFAULT_COMPOSITE.bands, ...partial?.bands },
  };
}

export function computeComposite(
  markers: Record<MarkerId, MarkerResult>,
  config: CompositeConfig,
): CompositeResult {
  const points: CompositeResult['points'] = [];
  const coverageGaps: MarkerId[] = [];

  for (const id of Object.keys(markers) as MarkerId[]) {
    const m = markers[id];
    if (m.state === 'insufficient_data') {
      coverageGaps.push(id);
      continue;
    }
    if (m.state === 'normal') continue;
    const base = config.statePoints[m.state];
    const weight = config.markerWeights?.[id] ?? 1;
    const value = base * weight;
    if (value > 0) points.push({ source: `${id}: ${m.state}`, points: value });
  }

  const isActive = (id: MarkerId) => {
    const state = markers[id]?.state;
    return state === 'elevated' || state === 'high';
  };
  for (const interaction of config.interactions) {
    const [a, b] = interaction.markers;
    if (isActive(a) && isActive(b)) {
      points.push({ source: `interaction: ${interaction.label}`, points: interaction.points });
    }
  }

  const score = points.reduce((sum, p) => sum + p.points, 0);
  const band: CompositeResult['band'] =
    score >= config.bands.high ? 'high' : score >= config.bands.moderate ? 'moderate' : 'low';

  return { score, band, points, coverageGaps };
}
