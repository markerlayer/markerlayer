/**
 * Engine orchestration: build a PlayerHistory, run the nine markers,
 * assemble the PlayerMarkers output (SPEC.md §4).
 */

import type {
  EngineConfig,
  MarkerEvent,
  MarkerId,
  MarkerResult,
  PlayerMarkers,
} from './schema.js';
import { resolveConfig } from './config.js';
import { computeComposite, resolveComposite } from './composite.js';
import { buildHistory } from './history.js';
import { toMs } from './time.js';
import { type MarkerCtx, isAttention } from './markers/shared.js';
import { computeM1 } from './markers/m1-volume-of-stakes.js';
import { computeM2 } from './markers/m2-speed-of-play.js';
import { computeM3 } from './markers/m3-depositing.js';
import { computeM4 } from './markers/m4-cancelled-withdrawals.js';
import { computeM5 } from './markers/m5-player-contact.js';
import { computeM6 } from './markers/m6-gambling-time.js';
import { computeM7 } from './markers/m7-gambling-products.js';
import { computeM8, protectiveSignals } from './markers/m8-rg-tools.js';
import { computeM9 } from './markers/m9-losses.js';

export interface ComputeOptions {
  /** Deterministic "now" (ISO 8601 UTC). Events at/after asOf are ignored. */
  asOf: string;
  config?: Partial<EngineConfig>;
}

/** M1–M9 mirror EN 18144:2025 §5.1–§5.9 in name and order. */
const MARKER_FNS: Record<MarkerId, (ctx: MarkerCtx) => MarkerResult> = {
  M1_volume_of_stakes: computeM1,
  M2_speed_of_play: computeM2,
  M3_depositing_behaviour: computeM3,
  M4_cancelled_withdrawals: computeM4,
  M5_player_initiated_contact: computeM5,
  M6_gambling_time: computeM6,
  M7_gambling_products: computeM7,
  M8_responsible_gambling_tools: computeM8,
  M9_losses: computeM9,
};

const SEVERITY: Record<string, number> = { high: 2, elevated: 1 };

/** Compute the nine markers for one player from that player's events. */
export function computePlayerMarkers(
  events: MarkerEvent[],
  playerId: string,
  options: ComputeOptions,
): PlayerMarkers {
  const config = resolveConfig(options.config);
  const asOfMs = toMs(options.asOf);
  const history = buildHistory(events, playerId, asOfMs, config);
  const ctx: MarkerCtx = { history };

  const markers = {} as Record<MarkerId, MarkerResult>;
  for (const id of Object.keys(MARKER_FNS) as MarkerId[]) {
    markers[id] = MARKER_FNS[id](ctx);
  }

  const attention = (Object.keys(markers) as MarkerId[])
    .filter((id) => isAttention(markers[id].state))
    .sort((a, b) => {
      const sev = (SEVERITY[markers[b].state] ?? 0) - (SEVERITY[markers[a].state] ?? 0);
      return sev !== 0 ? sev : a.localeCompare(b);
    });

  return {
    playerId,
    computedAt: options.asOf,
    windowDays: config.scrutinyDays,
    baseline: history.baselineSource,
    markers,
    attention,
    composite: computeComposite(markers, resolveComposite(config.composite)),
    protectiveSignals: protectiveSignals(ctx),
  };
}

/** Compute markers for every player present in a mixed event batch. */
export function computeMarkers(events: MarkerEvent[], options: ComputeOptions): PlayerMarkers[] {
  const playerIds = [...new Set(events.map((e) => e.playerId))].sort();
  return playerIds.map((id) => computePlayerMarkers(events, id, options));
}
