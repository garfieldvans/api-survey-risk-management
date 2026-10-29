import { describe, expect, it } from 'vitest';
import {
  GRADE_THRESHOLDS,
  SCORE_MAX,
  SCORE_MIN,
  bandOfScore,
  categoryOfScore,
  labelOfCategory,
} from './grades.js';

describe('konstanta skor', () => {
  it('rentang skor item 1..8', () => {
    expect(SCORE_MIN).toBe(1);
    expect(SCORE_MAX).toBe(8);
  });
});

describe('categoryOfScore', () => {
  it('mengelompokkan total sesuai batas atas per kategori', () => {
    expect(categoryOfScore(0)).toBe('POOR');
    expect(categoryOfScore(GRADE_THRESHOLDS.POOR)).toBe('POOR');
    expect(categoryOfScore(GRADE_THRESHOLDS.POOR + 1)).toBe('MARGINAL');
    expect(categoryOfScore(GRADE_THRESHOLDS.MARGINAL)).toBe('MARGINAL');
    expect(categoryOfScore(GRADE_THRESHOLDS.MARGINAL + 1)).toBe('AVERAGE');
    expect(categoryOfScore(GRADE_THRESHOLDS.AVERAGE)).toBe('AVERAGE');
    expect(categoryOfScore(GRADE_THRESHOLDS.AVERAGE + 1)).toBe('GOOD');
    expect(categoryOfScore(64)).toBe('GOOD');
  });

  it('total sangat besar tetap GOOD', () => {
    expect(categoryOfScore(999)).toBe('GOOD');
  });
});

describe('bandOfScore', () => {
  it('2=Poor, 4=Marginal, 6=Average, 8=Good', () => {
    expect(bandOfScore(1)).toBe('POOR');
    expect(bandOfScore(2)).toBe('POOR');
    expect(bandOfScore(3)).toBe('MARGINAL');
    expect(bandOfScore(4)).toBe('MARGINAL');
    expect(bandOfScore(5)).toBe('AVERAGE');
    expect(bandOfScore(6)).toBe('AVERAGE');
    expect(bandOfScore(7)).toBe('GOOD');
    expect(bandOfScore(8)).toBe('GOOD');
  });
});

describe('labelOfCategory', () => {
  it('mengubah enum kategori menjadi label manusia', () => {
    expect(labelOfCategory('POOR')).toBe('Poor');
    expect(labelOfCategory('MARGINAL')).toBe('Marginal');
    expect(labelOfCategory('AVERAGE')).toBe('Average');
    expect(labelOfCategory('GOOD')).toBe('Good');
  });
});
