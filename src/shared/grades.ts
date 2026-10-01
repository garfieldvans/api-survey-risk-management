import type { GradeCategory } from './statuses.js';

export const SCORE_MIN = 1;
export const SCORE_MAX = 8;

/** Total score thresholds — inclusive upper bound per category. */
export const GRADE_THRESHOLDS: Record<GradeCategory, number> = {
  POOR: 20,
  MARGINAL: 30,
  AVERAGE: 45,
  GOOD: 64,
};

const THRESHOLD_ORDER: GradeCategory[] = ['POOR', 'MARGINAL', 'AVERAGE', 'GOOD'];

export function categoryOfScore(total: number): GradeCategory {
  for (const cat of THRESHOLD_ORDER) {
    if (total <= GRADE_THRESHOLDS[cat]) return cat;
  }
  return 'GOOD';
}

export function labelOfCategory(cat: GradeCategory): string {
  return cat.charAt(0) + cat.slice(1).toLowerCase();
}

/** Score band label per item score. */
export function bandOfScore(score: number): GradeCategory {
  if (score <= 2) return 'POOR';
  if (score <= 4) return 'MARGINAL';
  if (score <= 6) return 'AVERAGE';
  return 'GOOD';
}