import { describe, it, expect } from 'vitest';
const { evaluatePriceChange } = require('./price-agent.js');

describe('evaluatePriceChange', () => {
  it('returns no anomaly for a small, normal price change', () => {
    const result = evaluatePriceChange(100, 105);
    expect(result.isAnomaly).toBe(false);
    expect(result.pctChange).toBeCloseTo(5, 1);
  });

  it('flags a price increase above the threshold as an anomaly', () => {
    const result = evaluatePriceChange(100, 140);
    expect(result.isAnomaly).toBe(true);
    expect(result.pctChange).toBeCloseTo(40, 1);
  });

  it('flags a price drop above the threshold as an anomaly (agent bug protection)', () => {
    const result = evaluatePriceChange(100, 50);
    expect(result.isAnomaly).toBe(true);
    expect(result.pctChange).toBeCloseTo(-50, 1);
  });

  it('does not flag a change exactly at the threshold boundary', () => {
    const result = evaluatePriceChange(100, 130);
    expect(result.isAnomaly).toBe(false);
  });

  it('treats missing old price (new material) as "no anomaly, nothing to compare")', () => {
    const result = evaluatePriceChange(null, 75);
    expect(result.isAnomaly).toBe(false);
    expect(result.pctChange).toBeNull();
  });

  it('treats old price of 0 the same way (avoids division by zero)', () => {
    const result = evaluatePriceChange(0, 75);
    expect(result.isAnomaly).toBe(false);
    expect(result.pctChange).toBeNull();
  });

  it('respects a custom threshold when provided', () => {
    const result = evaluatePriceChange(100, 110, 5);
    expect(result.isAnomaly).toBe(true);
  });
});
