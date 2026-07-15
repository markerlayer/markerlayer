/** Robust statistics shared by all markers (SPEC.md §2.4). */

export interface RobustStats {
  median: number;
  mad: number;
  n: number;
  source: 'self' | 'population';
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

export function mad(xs: number[], med = median(xs)): number {
  if (xs.length === 0) return 0;
  return median(xs.map((x) => Math.abs(x - med)));
}

export function robustStats(xs: number[]): RobustStats {
  const med = median(xs);
  return { median: med, mad: mad(xs, med), n: xs.length, source: 'self' };
}

/**
 * Robust z-score: (x − median) / (1.4826 × MAD).
 * When MAD = 0 (perfectly regular history) the denominator falls back to
 * max(|median| × 0.1, 1) so a genuine departure still registers while
 * x = median stays exactly 0. Deterministic and documented — see SPEC §2.4.
 */
export function robustZ(x: number, stats: Pick<RobustStats, 'median' | 'mad'>): number {
  const denom = 1.4826 * stats.mad;
  const safe = denom > 0 ? denom : Math.max(Math.abs(stats.median) * 0.1, 1);
  return (x - stats.median) / safe;
}

/** OLS slope of ys against x = 0..n−1 (per-step units). */
export function olsSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const xMean = (n - 1) / 2;
  const yMean = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (i - xMean) * (ys[i]! - yMean);
    den += (i - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/**
 * Trajectory as %/week: OLS slope over log(1 + max(0, x)) of daily values,
 * exponentiated back to a weekly growth rate (SPEC §2.4).
 */
export function trajectoryPctPerWeek(dailyValues: number[]): number {
  const logs = dailyValues.map((v) => Math.log1p(Math.max(0, v)));
  const slopePerDay = olsSlope(logs);
  return (Math.exp(slopePerDay * 7) - 1) * 100;
}

/** Shannon entropy (bits) of a share distribution; zero-shares are skipped. */
export function shannonEntropy(shares: number[]): number {
  let h = 0;
  for (const p of shares) {
    if (p > 0) h -= p * Math.log2(p);
  }
  return h;
}

/** Coefficient of variation (SD / mean); 0 when mean is 0. */
export function coefficientOfVariation(xs: number[]): number {
  if (xs.length === 0) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean === 0) return 0;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / mean;
}
