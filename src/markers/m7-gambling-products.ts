/**
 * M7 — Gambling Products (EN 18144:2025 §5.7).
 * §5.7.1 time spans: within sessions and over day, week, month.
 * §5.7.2 measurement: number of different gambling products used during a
 * session and during the time spans. (What counts as a distinct product is
 * the operator's discretion — here, the ProductVertical enum.)
 */

import type { MarkerResult, ProductVertical } from '../schema.js';
import { eventMs, windowEvents } from '../history.js';
import { shannonEntropy } from '../stats.js';
import { thresholdsFor } from '../config.js';
import { DAY_MS } from '../time.js';
import { type MarkerCtx, insufficient, override, result } from './shared.js';

const LIVE_PRODUCTS: ProductVertical[] = ['sports_live', 'live_casino'];

export function computeM7(ctx: MarkerCtx): MarkerResult {
  const { history } = ctx;
  if (history.wagers.length === 0) {
    return insufficient({}, ['wager events']);
  }
  const thresholds = thresholdsFor(history.config, 'M7_gambling_products');

  // §5.7.2 distinct-product counts over the standard's time spans.
  const distinctIn = (days: number): number =>
    new Set(windowEvents(history.wagers, history.asOfMs, days).map((w) => w.payload.product)).size;
  const distinctProductsDay = distinctIn(1);
  const distinctProductsWeek = distinctIn(7);
  const distinctProductsMonth = distinctIn(30);

  // ... and within sessions (max per session over the last 7 days).
  let maxProductsPerSessionWeek = 0;
  for (const s of history.sessions) {
    if (s.startMs < history.asOfMs - 7 * DAY_MS || s.startMs >= history.asOfMs) continue;
    const products = new Set(s.wagers.map((w) => w.payload.product));
    maxProductsPerSessionWeek = Math.max(maxProductsPerSessionWeek, products.size);
  }

  const w28 = windowEvents(history.wagers, history.asOfMs, 28);
  const stakeByProduct = new Map<ProductVertical, number>();
  for (const w of w28) {
    stakeByProduct.set(w.payload.product, (stakeByProduct.get(w.payload.product) ?? 0) + w.payload.stakeMinor);
  }
  const totalStake28 = [...stakeByProduct.values()].reduce((a, b) => a + b, 0);
  const distinctProducts28d = stakeByProduct.size;
  const productEntropy28d =
    totalStake28 > 0 ? shannonEntropy([...stakeByProduct.values()].map((v) => v / totalStake28)) : 0;
  const liveStake = LIVE_PRODUCTS.reduce((a, p) => a + (stakeByProduct.get(p) ?? 0), 0);
  const liveProductShare28d = totalStake28 > 0 ? liveStake / totalStake28 : 0;

  // New-product adoptions: first-ever wager in a vertical within the last
  // 90 days; only meaningful when history extends beyond 90 days.
  const oldestWagerMs = eventMs(history.wagers[0]!);
  const from90 = history.asOfMs - 90 * DAY_MS;
  let newProductAdoptions90d: number | null = null;
  if (oldestWagerMs < from90) {
    const before = new Set<ProductVertical>();
    const adopted = new Set<ProductVertical>();
    for (const w of history.wagers) {
      if (eventMs(w) < from90) before.add(w.payload.product);
      else if (!before.has(w.payload.product)) adopted.add(w.payload.product);
    }
    newProductAdoptions90d = adopted.size;
  }

  const distinctElevated = thresholds.overrides?.['distinctProductsElevated'] ?? 4;
  const distinctHigh = thresholds.overrides?.['distinctProductsHigh'] ?? 5;
  const adoptionsElevated = thresholds.overrides?.['newProductAdoptions'] ?? 2;

  let s: { state: MarkerResult['state']; evidence: string[] } = { state: 'normal', evidence: [] };
  s = override(
    s,
    distinctProducts28d >= distinctElevated,
    'elevated',
    `distinctProducts28d=${distinctProducts28d} ≥ ${distinctElevated}`,
  );
  s = override(
    s,
    newProductAdoptions90d !== null && newProductAdoptions90d >= adoptionsElevated,
    'elevated',
    `newProductAdoptions90d=${newProductAdoptions90d} ≥ ${adoptionsElevated}`,
  );
  s = override(
    s,
    distinctProducts28d >= distinctHigh ||
      (distinctProducts28d >= distinctElevated &&
        newProductAdoptions90d !== null &&
        newProductAdoptions90d >= adoptionsElevated),
    'high',
    `broad multi-product engagement (distinctProducts28d=${distinctProducts28d}, newProductAdoptions90d=${newProductAdoptions90d ?? 'n/a'})`,
  );

  return result(
    s.state,
    {
      distinctProductsDay,
      distinctProductsWeek,
      distinctProductsMonth,
      maxProductsPerSessionWeek,
      distinctProducts28d,
      productEntropy28d,
      newProductAdoptions90d,
      liveProductShare28d,
    },
    s.evidence,
  );
}
