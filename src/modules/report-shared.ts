import type { GradeCategory } from '../shared/index.js';

export { categoryOfScore } from '../shared/index.js';

export const GRADES_LABEL_MAP: Record<GradeCategory, string> = {
  POOR: 'Poor',
  MARGINAL: 'Marginal',
  AVERAGE: 'Average',
  GOOD: 'Good',
};