/**
 * M5 — Player Initiated Contact (EN 18144:2025 §5.5).
 * §5.5.1 time spans: day, week, month. §5.5.2 measurement: contact counts
 * with categorization so contacts do not fall into the same category —
 * positive, neutral and negative.
 */

import type { MarkerResult } from '../schema.js';
import { baselineWindow, eventMs, windowEvents } from '../history.js';
import { thresholdsFor } from '../config.js';
import { DAY_MS } from '../time.js';
import { type MarkerCtx, fmt, override, result, insufficient } from './shared.js';

export function computeM5(ctx: MarkerCtx): MarkerResult {
  const { history } = ctx;
  if (history.contacts.length === 0) {
    // Without any contact events ever we cannot distinguish "no contacts"
    // from "stream not supplied" — degrade visibly.
    return insufficient({}, ['support_contact events']);
  }
  const thresholds = thresholdsFor(history.config, 'M5_player_initiated_contact');

  const countIn = (days: number) => windowEvents(history.contacts, history.asOfMs, days);
  const contactCountDay = countIn(1).length;
  const contactCountWeek = countIn(7).length;
  const c30 = countIn(30);
  const contactCountMonth = c30.length;

  // §5.5.2 sentiment categorization (positive / neutral / negative).
  const bySentiment = (s: 'positive' | 'neutral' | 'negative') =>
    c30.filter((c) => (c.payload.sentiment ?? 'neutral') === s).length;
  const positiveContactCountMonth = bySentiment('positive');
  const neutralContactCountMonth = bySentiment('neutral');
  const negativeContactCountMonth = bySentiment('negative');

  const paymentsContactCountMonth = c30.filter((c) => c.payload.category === 'payments').length;
  const rgContactCountMonth = c30.filter(
    (c) => c.payload.category === 'responsible_gambling',
  ).length;

  // Contacts are sparse count data, so a rate-based z is used instead of the
  // daily median/MAD machinery: expected 30d count from the baseline window,
  // z = (observed − expected) / sqrt(expected) (Poisson approximation).
  const { baselineFromMs, baselineToMs } = baselineWindow(history.asOfMs, history.config);
  const baselineContacts = history.contacts.filter(
    (c) => eventMs(c) >= baselineFromMs && eventMs(c) < baselineToMs,
  ).length;
  const baselineDays = (baselineToMs - baselineFromMs) / DAY_MS;
  const expected30d = baselineDays > 0 ? (baselineContacts / baselineDays) * 30 : 0;
  const contactZ = expected30d > 0 ? (contactCountMonth - expected30d) / Math.sqrt(expected30d) : null;

  let s: { state: MarkerResult['state']; evidence: string[] } = { state: 'normal', evidence: [] };
  if (contactZ !== null) {
    s = override(
      s,
      contactZ >= thresholds.elevatedZ,
      'elevated',
      `contactZ=${fmt(contactZ)} ≥ ${fmt(thresholds.elevatedZ)} (${contactCountMonth} contacts in 30d vs ~${fmt(expected30d)} expected)`,
    );
    s = override(s, contactZ >= thresholds.highZ, 'high', `contactZ=${fmt(contactZ)} ≥ ${fmt(thresholds.highZ)}`);
  }
  const negativeThreshold = thresholds.overrides?.['negativeContactCountMonth'] ?? 3;
  s = override(
    s,
    negativeContactCountMonth >= negativeThreshold,
    'elevated',
    `negativeContactCountMonth=${negativeContactCountMonth} ≥ ${negativeThreshold}`,
  );
  // An explicit responsible-gambling contact is never "normal".
  s = override(
    s,
    rgContactCountMonth >= 1,
    'high',
    `${rgContactCountMonth} responsible_gambling-category contact(s) in 30 days`,
  );

  return result(
    s.state,
    {
      contactCountDay,
      contactCountWeek,
      contactCountMonth,
      positiveContactCountMonth,
      neutralContactCountMonth,
      negativeContactCountMonth,
      paymentsContactCountMonth,
      rgContactCountMonth,
      contactZ,
    },
    s.evidence,
  );
}
