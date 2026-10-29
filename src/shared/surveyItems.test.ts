import { describe, expect, it } from 'vitest';
import { GRADE_ITEM_CODES } from './grading-engine.js';
import { SURVEY_ITEMS, SURVEY_ITEM_CODES } from './surveyItems.js';

describe('SURVEY_ITEMS', () => {
  it('memuat tepat 8 item penilaian', () => {
    expect(SURVEY_ITEMS).toHaveLength(8);
  });

  it('urutan 1..8 tanpa duplikat', () => {
    expect(SURVEY_ITEMS.map((i) => i.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const codes = new Set(SURVEY_ITEM_CODES);
    expect(codes.size).toBe(SURVEY_ITEMS.length);
  });

  it('kode item identik dengan yang dipakai grading engine', () => {
    expect([...SURVEY_ITEM_CODES].sort()).toEqual([...GRADE_ITEM_CODES].sort());
  });

  it('tiap item punya nama', () => {
    for (const item of SURVEY_ITEMS) {
      expect(item.name.trim().length).toBeGreaterThan(0);
    }
  });
});
