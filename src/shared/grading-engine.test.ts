import { describe, expect, it } from 'vitest';
import {
  GRADE_ITEM_CODES,
  M_ASPECT_IDS,
  bandLabelOfScore,
  computeGradeScores,
  getHidranWajibStatus,
  type GradeInputs,
} from './grading-engine.js';

/** Semua jawaban default "terbaik" + konteks netral. */
function base(overrides: Partial<GradeInputs> = {}): GradeInputs {
  return {
    mAnswers: { m1: 'yes', m2: 'yes', m3: 'yes', m4: 'yes', m7: 'yes' },
    mChecklist: ['m1', 'm2', 'm3', 'm4', 'm7'],
    mKlaim: '0',
    mImprovement: 'no',
    mRekomendasi: 'no',
    cKelas: '8',
    cSandwich: 'no',
    cAcp: 'no',
    oHazard: '8',
    pApar: 'good',
    pHidran: 'good',
    pDetektor: 'good',
    pSprinkler: 'good',
    pDamkar: '8',
    exKondisi: '4',
    nhGempa: 'avg',
    nhBanjir: 'avg',
    nhPetir: 'avg',
    lePemisah: 'no',
    leJmlBangunan: '1',
    tsi: 50e9,
    cLantai: 2,
    spJenis: 'commercial',
    oHazardCat: '',
    ...overrides,
  };
}

function withAnswers(overrides: Partial<GradeInputs['mAnswers']>): GradeInputs {
  return base({ mAnswers: { ...base().mAnswers, ...overrides } });
}

describe('computeGradeScores — MANAGEMENT', () => {
  it('5/5 aspek yes → 8', () => {
    expect(computeGradeScores(base()).scores.management).toBe(8);
  });

  it('4/5 → 6, 3/5 → 4, ≤2/5 → 2', () => {
    expect(computeGradeScores(withAnswers({ m7: 'no' })).scores.management).toBe(6);
    expect(computeGradeScores(withAnswers({ m4: 'no', m7: 'no' })).scores.management).toBe(4);
    expect(computeGradeScores(withAnswers({ m3: 'no', m4: 'no', m7: 'no' })).scores.management).toBe(2);
  });

  it('aspek kosong dihitung setengah poin', () => {
    // 4 yes + 1 kosong = 4.5 → band Average (6)
    expect(computeGradeScores(withAnswers({ m7: '' })).scores.management).toBe(6);
    // 3 yes + 2 kosong = 4.0 → band Average (6)
    expect(computeGradeScores(withAnswers({ m4: '', m7: '' })).scores.management).toBe(6);
    // 5 yes-tidak + 0 kosong... 4 no + 1 kosong = 0.5 → Poor (2)
    expect(
      computeGradeScores(withAnswers({ m1: 'no', m2: 'no', m3: 'no', m4: 'no', m7: '' }))
        .scores.management,
    ).toBe(2);
  });

  it('kelima aspek kosong → base netral 4', () => {
    const r = computeGradeScores(base({ mAnswers: { m1: '', m2: '', m3: '', m4: '', m7: '' } }));
    expect(r.scores.management).toBe(4);
    expect(r.incompleteByItem.management).toEqual(
      expect.arrayContaining(['Kebersihan dan kerapihan', 'Aturan merokok']),
    );
  });

  it('payload lama tanpa mAnswers memakai mChecklist', () => {
    const legacy = { ...base(), mAnswers: undefined } as unknown as GradeInputs;
    expect(computeGradeScores(legacy).scores.management).toBe(8);
    const legacy4 = { ...base(), mAnswers: undefined, mChecklist: ['m1', 'm2', 'm3', 'm4'] } as unknown as GradeInputs;
    expect(computeGradeScores(legacy4).scores.management).toBe(6);
    const legacy2 = { ...base(), mAnswers: undefined, mChecklist: ['m1', 'm2'] } as unknown as GradeInputs;
    expect(computeGradeScores(legacy2).scores.management).toBe(2);
  });

  it('penalti klaim: 3+ → -2, 1-2 → -1', () => {
    expect(computeGradeScores(base({ mKlaim: '3+' })).scores.management).toBe(6);
    expect(computeGradeScores(base({ mKlaim: '1-2' })).scores.management).toBe(7);
    expect(computeGradeScores(base({ mKlaim: '0' })).scores.management).toBe(8);
  });

  it('risk improvement hanya mengompensasi penalti klaim', () => {
    expect(computeGradeScores(base({ mKlaim: '3+', mImprovement: 'yes' })).scores.management).toBe(8);
    expect(computeGradeScores(base({ mKlaim: '1-2', mImprovement: 'yes' })).scores.management).toBe(8);
    // tanpa klaim, improvement tidak menambah
    expect(computeGradeScores(base({ mKlaim: '0', mImprovement: 'yes' })).scores.management).toBe(8);
  });

  it('rekomendasi +2 tidak boleh menaikkan di atas base checklist', () => {
    expect(computeGradeScores(base({ mRekomendasi: 'yes' })).scores.management).toBe(8);
    // base 6 (4/5) → rekomendasi tidak menaikkan ke 8
    expect(
      computeGradeScores(
        base({
          mAnswers: { m1: 'yes', m2: 'yes', m3: 'yes', m4: 'yes', m7: 'no' },
          mRekomendasi: 'yes',
        }),
      ).scores.management,
    ).toBe(6);
  });

  it('skor management tidak pernah di bawah 2', () => {
    expect(
      computeGradeScores(
        base({
          mAnswers: { m1: 'no', m2: 'no', m3: 'no', m4: 'no', m7: 'no' },
          mKlaim: '3+',
        }),
      ).scores.management,
    ).toBe(2);
  });
});

describe('computeGradeScores — CONSTRUCTION', () => {
  it('kelas kebakaran menentukan skor dasar', () => {
    expect(computeGradeScores(base({ cKelas: '8' })).scores.construction).toBe(8);
    expect(computeGradeScores(base({ cKelas: '6' })).scores.construction).toBe(6);
    expect(computeGradeScores(base({ cKelas: '4' })).scores.construction).toBe(4);
    expect(computeGradeScores(base({ cKelas: '2' })).scores.construction).toBe(4); // tidak ada informasi
    expect(computeGradeScores(base({ cKelas: '' })).scores.construction).toBe(4); // belum dijawab → netral
    expect(computeGradeScores(base({ cKelas: '3' })).scores.construction).toBe(3);
  });

  it('sandwich panel menurunkan satu tingkat', () => {
    expect(computeGradeScores(base({ cSandwich: 'yes' })).scores.construction).toBe(6);
    expect(computeGradeScores(base({ cKelas: '6', cSandwich: 'yes' })).scores.construction).toBe(4);
    expect(computeGradeScores(base({ cKelas: '4', cSandwich: 'yes' })).scores.construction).toBe(3);
    expect(computeGradeScores(base({ cKelas: '3', cSandwich: 'yes' })).scores.construction).toBe(3);
  });

  it('sandwich + ACP menurunkan dua tingkat', () => {
    expect(computeGradeScores(base({ cSandwich: 'yes', cAcp: 'yes' })).scores.construction).toBe(4);
    expect(computeGradeScores(base({ cKelas: '6', cSandwich: 'yes', cAcp: 'yes' })).scores.construction).toBe(3);
  });
});

describe('computeGradeScores — OCCUPANCY', () => {
  it('memetakan band Breakdown Okupansi ASWATA', () => {
    expect(computeGradeScores(base({ oHazard: '8' })).scores.occupancy).toBe(8);
    expect(computeGradeScores(base({ oHazard: '6a' })).scores.occupancy).toBe(6);
    expect(computeGradeScores(base({ oHazard: '6b' })).scores.occupancy).toBe(6);
    expect(computeGradeScores(base({ oHazard: '4a' })).scores.occupancy).toBe(4);
    expect(computeGradeScores(base({ oHazard: '4b' })).scores.occupancy).toBe(4);
    expect(computeGradeScores(base({ oHazard: '4c' })).scores.occupancy).toBe(4);
    expect(computeGradeScores(base({ oHazard: '' })).scores.occupancy).toBe(6); // netral
  });
});

describe('computeGradeScores — PROTECTION', () => {
  it('bobot APAR 25% / Hidran 30% / Detektor 25% / Sprinkler 10% / Damkar 10%', () => {
    // 6*0.25 + 8*0.3 + 8*0.25 + 8*0.1 + 8*0.1 = 1.5+2.4+2+0.8+0.8 = 7.5 → 8
    expect(computeGradeScores(base()).scores.protection).toBe(8);
    // 4*0.25 + 6*0.3 + 6*0.25 + 6*0.1 + 4*0.1 = 1+1.8+1.5+0.6+0.4 = 5.3 → 5
    const avg = computeGradeScores(
      base({ pApar: 'avg', pHidran: 'avg', pDetektor: 'avg', pSprinkler: 'avg', pDamkar: '4' }),
    );
    expect(avg.scores.protection).toBe(5);
  });

  it('komponen kosong dinilai netral Average', () => {
    const empty = computeGradeScores(
      base({ pApar: '', pHidran: '', pDetektor: '', pSprinkler: '', pDamkar: '' }),
    );
    // 4*0.25 + 6*0.3 + 6*0.25 + 6*0.1 + 4*0.1 = 5.3 → 5, dan ditandai incomplete
    expect(empty.scores.protection).toBe(5);
    expect(empty.incompleteByItem.protection).toEqual(
      expect.arrayContaining(['APAR', 'Hidran', 'Detektor kebakaran', 'Sprinkler', 'Waktu respons pemadam']),
    );
  });

  it('Hydrant wajib tapi tidak tersedia → Proteksi dipaksa 2 (Poor)', () => {
    const r = computeGradeScores(base({ tsi: 150e9, cLantai: 6, pHidran: 'none' }));
    expect(r.scores.protection).toBe(2);
    expect(r.category).toBe('POOR');
  });

  it('Hydrant wajib tapi masih terpasang → tanpa override', () => {
    const r = computeGradeScores(base({ tsi: 150e9, cLantai: 6, pHidran: 'avg' }));
    // 1.5 + 1.8 + 2 + 0.8 + 0.8 = 6.9 → 7
    expect(r.scores.protection).toBe(7);
    expect(r.category).toBe('AVERAGE');
  });

  it('Hydrant tidak wajib → none tidak memaksa skor 2', () => {
    const r = computeGradeScores(base({ pHidran: 'none' }));
    // 1.5 + 0.6 + 2 + 0.8 + 0.8 = 5.7 → 6
    expect(r.scores.protection).toBe(6);
    expect(r.category).not.toBe('POOR');
  });
});

describe('computeGradeScores — EXPOSURE / NATURAL HAZARDS / OTHER PERIL / LOSS ESTIMATE', () => {
  it('exposure diambil langsung dari jawaban, kosong → default 2', () => {
    expect(computeGradeScores(base({ exKondisi: '4' })).scores.exposure).toBe(4);
    expect(computeGradeScores(base({ exKondisi: '3' })).scores.exposure).toBe(3);
    expect(computeGradeScores(base({ exKondisi: '1' })).scores.exposure).toBe(1);
    expect(computeGradeScores(base({ exKondisi: '' })).scores.exposure).toBe(2);
  });

  it('natural hazards: semua Average → 3, salah satu Marginal → 2', () => {
    expect(computeGradeScores(base()).scores.natural_hazards).toBe(3);
    expect(
      computeGradeScores(base({ nhGempa: 'marg' })).scores.natural_hazards,
    ).toBe(2);
    expect(
      computeGradeScores(base({ nhPetir: 'marg', nhBanjir: 'marg' })).scores.natural_hazards,
    ).toBe(2);
  });

  it('natural hazards belum lengkap → default 3 dan ditandai incomplete', () => {
    const r = computeGradeScores(base({ nhPetir: '' }));
    expect(r.scores.natural_hazards).toBe(3);
    expect(r.incompleteByItem.natural_hazards).toEqual(['Petir']);
  });

  it('other peril selalu 3 (Average)', () => {
    expect(computeGradeScores(base()).scores.other_peril).toBe(3);
    expect(computeGradeScores(base({ oHazard: '4a' })).scores.other_peril).toBe(3);
  });

  it('loss estimate: jumlah bangunan terjawab → 3, belum → 5', () => {
    expect(computeGradeScores(base({ leJmlBangunan: '1' })).scores.loss_estimate).toBe(3);
    expect(computeGradeScores(base({ leJmlBangunan: 'gt1' })).scores.loss_estimate).toBe(3);
    expect(computeGradeScores(base({ leJmlBangunan: '' })).scores.loss_estimate).toBe(5);
  });
});

describe('computeGradeScores — total & kategori', () => {
  it('total = jumlah ke-8 item dan selalu mengandung kode item yang sama', () => {
    const r = computeGradeScores(base());
    const sum = GRADE_ITEM_CODES.reduce((acc, code) => acc + r.scores[code], 0);
    expect(r.total).toBe(sum);
    expect(Object.keys(r.scores).sort()).toEqual([...GRADE_ITEM_CODES].sort());
  });

  it('jawaban terbaik → total 45 (AVERAGE)', () => {
    const r = computeGradeScores(base());
    expect(r.total).toBe(8 + 8 + 8 + 8 + 4 + 3 + 3 + 3);
    expect(r.category).toBe('AVERAGE');
  });

  it('total 21..30 → MARGINAL', () => {
    const r = computeGradeScores(
      base({
        mAnswers: { m1: 'no', m2: 'no', m3: 'no', m4: 'no', m7: 'no' },
        mKlaim: '0',
        cKelas: '3',
        oHazard: '4a',
        pApar: 'avg',
        pHidran: 'avg',
        pDetektor: 'avg',
        pSprinkler: 'avg',
        pDamkar: '6',
        exKondisi: '1',
        nhGempa: 'marg',
        nhBanjir: 'marg',
        nhPetir: 'marg',
        leJmlBangunan: '',
      }),
    );
    // 2 + 3 + 4 + 6 + 1 + 2 + 3 + 5 = 26
    expect(r.total).toBe(26);
    expect(r.category).toBe('MARGINAL');
  });

  it('total 31..45 → AVERAGE', () => {
    const r = computeGradeScores(base({ exKondisi: '1', nhGempa: 'marg', nhBanjir: 'marg', nhPetir: 'marg' }));
    // 8+8+8+8+1+2+3+3 = 41
    expect(r.total).toBe(41);
    expect(r.category).toBe('AVERAGE');
  });

  it('item yang belum dijawab tidak menurunkan skor, hanya ditandai', () => {
    const r = computeGradeScores(
      base({
        cKelas: '',
        oHazard: '',
        pApar: '',
        pHidran: '',
        pDetektor: '',
        pSprinkler: '',
        pDamkar: '',
        exKondisi: '',
        nhGempa: '',
        nhBanjir: '',
        nhPetir: '',
        leJmlBangunan: '',
        mKlaim: '',
        mRekomendasi: '',
        mAnswers: { m1: 'yes', m2: 'yes', m3: 'yes', m4: 'yes', m7: 'yes' },
      }),
    );
    expect(r.incompleteByItem.construction).toBeDefined();
    expect(r.incompleteByItem.occupancy).toEqual(['Kondisi kebakaran (Occupancy)']);
    expect(r.incompleteByItem.loss_estimate).toEqual(['Jumlah bangunan terdampak']);
    expect(r.scores.construction).toBe(4);
    expect(r.scores.occupancy).toBe(6);
  });

  it('lePemisah sengaja tidak ditandai incomplete (masih TBC)', () => {
    const r = computeGradeScores(base({ lePemisah: '' }));
    expect(r.incompleteByItem.loss_estimate).toBeUndefined();
  });
});

describe('getHidranWajibStatus', () => {
  it('Commercial/Residential + TSI >= 100e9 + >= 6 lantai → wajib', () => {
    const r = getHidranWajibStatus(base({ tsi: 150e9, cLantai: 6 }));
    expect(r.wajib).toBe(true);
    expect(r.alasan).toContain('Bangunan ≥ 6 lantai — wajib terlepas dari waktu respons pemadam publik');
  });

  it('Commercial/Residential < 6 lantai tanpa respons > 30 menit → tidak wajib', () => {
    expect(getHidranWajibStatus(base({ tsi: 150e9, cLantai: 4 })).wajib).toBe(false);
    expect(getHidranWajibStatus(base({ tsi: 150e9, cLantai: 6, pDamkar: '8' })).wajib).toBe(true);
  });

  it('Commercial/Residential >= 4 lantai + respons > 30 menit → wajib', () => {
    const r = getHidranWajibStatus(base({ tsi: 150e9, cLantai: 4, pDamkar: '2' }));
    expect(r.wajib).toBe(true);
    expect(r.alasan).toContain('Bangunan ≥ 4 lantai');
  });

  it('konstruksi combustible (Kelas 2/3) + respons > 30 menit → wajib', () => {
    const r = getHidranWajibStatus(base({ tsi: 150e9, cLantai: 1, cKelas: '3', pDamkar: '2' }));
    expect(r.wajib).toBe(true);
    expect(r.alasan).toContain('Konstruksi combustible Class 2/3');
  });

  it('TSI di bawah ambang Commercial → tidak wajib walau 8 lantai', () => {
    expect(getHidranWajibStatus(base({ tsi: 50e9, cLantai: 8, pDamkar: '2' })).wajib).toBe(false);
  });

  it('non-Commercial: wajib bila respons > 30 menit dan TSI >= ambang kategori risiko', () => {
    const ctx = { spJenis: 'industrial', oHazardCat: 'high', cLantai: 2, tsi: 60e9 };
    expect(getHidranWajibStatus(base({ ...ctx, pDamkar: '2' })).wajib).toBe(true);
    expect(getHidranWajibStatus(base({ ...ctx, tsi: 10e9, pDamkar: '2' })).wajib).toBe(false);
    expect(getHidranWajibStatus(base({ ...ctx, pDamkar: '8' })).wajib).toBe(false);
  });
});

describe('bandLabelOfScore', () => {
  it('memetakan skor item ke label band', () => {
    expect(bandLabelOfScore(1)).toBe('Poor');
    expect(bandLabelOfScore(2)).toBe('Poor');
    expect(bandLabelOfScore(3)).toBe('Marginal');
    expect(bandLabelOfScore(4)).toBe('Marginal');
    expect(bandLabelOfScore(5)).toBe('Average');
    expect(bandLabelOfScore(6)).toBe('Average');
    expect(bandLabelOfScore(7)).toBe('Good');
    expect(bandLabelOfScore(8)).toBe('Good');
  });
});

describe('invarian', () => {
  it('aspek Management yang dites selalu m1..m4 + m7', () => {
    expect([...M_ASPECT_IDS]).toEqual(['m1', 'm2', 'm3', 'm4', 'm7']);
  });

  it('skor tiap item selalu dalam rentang 1..8', () => {
    const r = computeGradeScores(
      base({ cKelas: '3', exKondisi: '1', leJmlBangunan: '', pHidran: 'none', tsi: 150e9, cLantai: 6 }),
    );
    for (const code of GRADE_ITEM_CODES) {
      expect(r.scores[code]).toBeGreaterThanOrEqual(1);
      expect(r.scores[code]).toBeLessThanOrEqual(8);
    }
  });
});
