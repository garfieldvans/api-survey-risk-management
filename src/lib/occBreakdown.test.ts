import { describe, expect, it } from 'vitest';
import {
  COMMERCIAL_RESIDENTIAL_TSI_THRESHOLD,
  HIDRAN_THRESHOLD,
  OCC_BREAKDOWN,
} from './occBreakdown.js';

describe('OCC_BREAKDOWN', () => {
  it('tidak kosong', () => {
    expect(OCC_BREAKDOWN.length).toBeGreaterThan(0);
  });

  it('kode okupansi unik — duplikat hanya boleh bila skor & riskKey sama', () => {
    // Catatan: kode 27112 muncul 2x di data sumber (Cane Sugar plant & Cold Storage),
    // keduanya ber-skor/riskKey identik sehingga hasil lookup tidak berbeda.
    const byCode = new Map<string, Array<{ score: number; riskKey: string }>>();
    for (const item of OCC_BREAKDOWN) {
      const list = byCode.get(item.code) ?? [];
      list.push({ score: item.score, riskKey: item.riskKey });
      byCode.set(item.code, list);
    }
    for (const [, list] of byCode) {
      const distinct = new Set(list.map((x) => `${x.riskKey}:${x.score}`));
      expect(distinct.size).toBe(1);
    }
  });

  it('skor berada di rentang 1..8 dan rating konsisten dengan skor', () => {
    const ratingOf: Record<number, string> = {
      8: 'Good',
      6: 'Average',
      4: 'Marginal',
      2: 'Poor',
    };
    for (const item of OCC_BREAKDOWN) {
      expect(item.score).toBeGreaterThanOrEqual(1);
      expect(item.score).toBeLessThanOrEqual(8);
      expect(item.rating).toBe(ratingOf[item.score]);
    }
  });

  it('tiap baris punya riskKey/riskLabel yang terisi', () => {
    for (const item of OCC_BREAKDOWN) {
      expect(item.riskKey.length).toBeGreaterThan(0);
      expect(item.riskLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('HIDRAN_THRESHOLD', () => {
  it('memuat ambang per kategori risiko dengan amount positif', () => {
    const keys = Object.keys(HIDRAN_THRESHOLD);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(HIDRAN_THRESHOLD[key].amount).toBeGreaterThan(0);
      expect(HIDRAN_THRESHOLD[key].label.length).toBeGreaterThan(0);
    }
  });

  it('ambang Commercial/Residential 100e9', () => {
    expect(COMMERCIAL_RESIDENTIAL_TSI_THRESHOLD).toBe(100e9);
  });
});
