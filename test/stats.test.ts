import { describe, expect, it } from 'vitest';
import {
  median,
  mad,
  olsSlope,
  robustZ,
  shannonEntropy,
  trajectoryPctPerWeek,
} from '../src/stats.js';

describe('median / mad', () => {
  it('computes odd and even medians', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
  });

  it('computes MAD around the median', () => {
    expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1);
  });
});

describe('robustZ', () => {
  it('is 0 at the median', () => {
    expect(robustZ(10, { median: 10, mad: 2 })).toBe(0);
  });

  it('scales by 1.4826 × MAD', () => {
    expect(robustZ(13, { median: 10, mad: 2 })).toBeCloseTo(3 / (1.4826 * 2), 5);
  });

  it('falls back deterministically when MAD = 0', () => {
    // denom = max(|median| × 0.1, 1) = 2000
    expect(robustZ(100_000, { median: 20_000, mad: 0 })).toBeCloseTo(40, 5);
    // and x = median stays exactly 0
    expect(robustZ(20_000, { median: 20_000, mad: 0 })).toBe(0);
  });
});

describe('olsSlope / trajectory', () => {
  it('slope of a linear series is its step', () => {
    expect(olsSlope([0, 2, 4, 6])).toBeCloseTo(2, 10);
    expect(olsSlope([5])).toBe(0);
  });

  it('flat series has 0 %/week trajectory', () => {
    expect(trajectoryPctPerWeek(Array(28).fill(1000))).toBeCloseTo(0, 5);
  });

  it('doubling weekly reads as ~100 %/week', () => {
    const values: number[] = [];
    for (let d = 0; d < 28; d++) values.push(1000 * 2 ** (d / 7));
    expect(trajectoryPctPerWeek(values)).toBeGreaterThan(80);
    expect(trajectoryPctPerWeek(values)).toBeLessThan(120);
  });

  it('clamps negative daily values to 0 instead of NaN', () => {
    expect(Number.isFinite(trajectoryPctPerWeek([-5, 3, -2, 8]))).toBe(true);
  });
});

describe('shannonEntropy', () => {
  it('is 0 for a single product and max for uniform shares', () => {
    expect(shannonEntropy([1])).toBe(0);
    expect(shannonEntropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(2, 10);
    expect(shannonEntropy([0.5, 0.5, 0])).toBeCloseTo(1, 10);
  });
});
