import { describe, expect, it } from 'vitest';
import { DEFAULT_COMPOSITE, computeComposite, resolveComposite } from '../src/composite.js';
import { computePlayerMarkers } from '../src/engine.js';
import type { MarkerId, MarkerResult } from '../src/schema.js';
import { AS_OF, PLAYER, at, deposit, steadyDays, wager } from './helpers.js';

function markerSet(states: Partial<Record<MarkerId, MarkerResult['state']>>): Record<MarkerId, MarkerResult> {
  const ids: MarkerId[] = [
    'M1_volume_of_stakes',
    'M2_speed_of_play',
    'M3_depositing_behaviour',
    'M4_cancelled_withdrawals',
    'M5_player_initiated_contact',
    'M6_gambling_time',
    'M7_gambling_products',
    'M8_responsible_gambling_tools',
    'M9_losses',
  ];
  const out = {} as Record<MarkerId, MarkerResult>;
  for (const id of ids) {
    out[id] = { state: states[id] ?? 'normal', features: {}, evidence: [] };
  }
  return out;
}

describe('computeComposite', () => {
  it('scores 0 / low for an all-normal player', () => {
    const c = computeComposite(markerSet({}), DEFAULT_COMPOSITE);
    expect(c.score).toBe(0);
    expect(c.band).toBe('low');
    expect(c.points).toEqual([]);
  });

  it('one elevated marker stays low; one high marker is moderate', () => {
    expect(computeComposite(markerSet({ M1_volume_of_stakes: 'elevated' }), DEFAULT_COMPOSITE).band).toBe('low');
    const c = computeComposite(markerSet({ M1_volume_of_stakes: 'high' }), DEFAULT_COMPOSITE);
    expect(c.score).toBe(2);
    expect(c.band).toBe('moderate');
  });

  it('adds interaction points when both paired markers are active (§4.2)', () => {
    const c = computeComposite(
      markerSet({ M9_losses: 'high', M3_depositing_behaviour: 'high' }),
      DEFAULT_COMPOSITE,
    );
    // 2 + 2 marker points + 2 interaction points
    expect(c.score).toBe(6);
    expect(c.band).toBe('high');
    expect(c.points.map((p) => p.source).join(' ')).toMatch(/interaction: losses × depositing/);
  });

  it('does not add interaction points when only one member is active', () => {
    const c = computeComposite(markerSet({ M9_losses: 'high' }), DEFAULT_COMPOSITE);
    expect(c.points.some((p) => p.source.startsWith('interaction'))).toBe(false);
  });

  it('reports insufficient_data markers as coverage gaps, contributing 0', () => {
    const c = computeComposite(
      markerSet({ M5_player_initiated_contact: 'insufficient_data' }),
      DEFAULT_COMPOSITE,
    );
    expect(c.score).toBe(0);
    expect(c.coverageGaps).toEqual(['M5_player_initiated_contact']);
  });

  it('the point breakdown sums to the score', () => {
    const c = computeComposite(
      markerSet({
        M9_losses: 'high',
        M3_depositing_behaviour: 'elevated',
        M6_gambling_time: 'elevated',
        M2_speed_of_play: 'elevated',
      }),
      DEFAULT_COMPOSITE,
    );
    expect(c.points.reduce((s, p) => s + p.points, 0)).toBe(c.score);
  });

  it('honors marker weights and custom bands', () => {
    const config = resolveComposite({
      markerWeights: { M9_losses: 3 },
      bands: { moderate: 5, high: 10 },
    });
    const c = computeComposite(markerSet({ M9_losses: 'high' }), config);
    expect(c.score).toBe(6);
    expect(c.band).toBe('moderate');
  });
});

describe('composite in the engine output', () => {
  it('steady player is low; escalating player is high with interactions', () => {
    const steady = computePlayerMarkers(steadyDays(120), PLAYER, { asOf: AS_OF });
    expect(steady.composite.band).toBe('low');

    // Escalation week: 5× stakes, all lost (M1 + M9 high, M3 high via failed
    // deposits → losses × depositing interaction fires).
    const blowUp = [];
    for (let d = 7; d > 0; d--) {
      for (let i = 0; i < 20; i++) blowUp.push(wager(at(d, 720 + i), 5000, 0));
    }
    const risky = computePlayerMarkers(
      [
        ...steadyDays(113, 7),
        ...blowUp,
        deposit(at(2, 700), 10_000, 'failed'),
        deposit(at(2, 705), 10_000, 'failed'),
        deposit(at(1, 700), 10_000, 'failed'),
      ],
      PLAYER,
      { asOf: AS_OF },
    );
    expect(risky.composite.band).toBe('high');
    expect(risky.composite.points.reduce((s, p) => s + p.points, 0)).toBe(risky.composite.score);
    expect(risky.composite.coverageGaps).toContain('M4_cancelled_withdrawals');
  });
});
