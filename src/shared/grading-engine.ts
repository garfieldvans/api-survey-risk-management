/**
 * Risk grading engine — port 1:1 dari aturan kalkulasi di apps/api/data/reff.html.
 *
 * Dipakai oleh:
 * - API (POST /surveys) untuk menyimpan skor authoritative dari payload wizard surveyor
 * - Web (wizard 12 langkah) untuk preview hasil sebelum kirim
 *
 * Aturan inti (reff.html calcRiskGrading):
 * - 8 item dengan rentang skor 1..8 (kecuali natural_hazards 2..3 dan other_peril tetap 3)
 * - Total / 55 → GOOD (>=46) | AVERAGE (>=31) | MARGINAL (>=21) | POOR (<21)
 * - Skala band per item: <=2 POOR, <=4 MARGINAL, <=6 AVERAGE, >6 GOOD
 */

import type { GradeCategory } from './statuses.js';

export const GRADE_ITEM_CODES = [
  'management',
  'construction',
  'occupancy',
  'protection',
  'exposure',
  'natural_hazards',
  'other_peril',
  'loss_estimate',
] as const;

export type GradeItemCode = (typeof GRADE_ITEM_CODES)[number];

/** Input wizard per section (field name sama dengan reff.html). */
export interface GradeInputs {
  // MANAGEMENT
  mChecklist: string[]; // id checklist terpenuhi dari ['m1'..'m6']
  mKlaim: '0' | '1-2' | '3+'; // riwayat klaim 5 tahun
  mImprovement: 'yes' | 'no';
  mRekomendasi: 'yes' | 'no';

  // CONSTRUCTION
  cKelas: '8' | '6' | '4' | '2';
  cSandwich: 'yes' | 'no';
  cAcp: 'yes' | 'no';

  // OCCUPANCY
  oHazard: '8' | '6a' | '6b' | '4a' | '4b' | '4c';

  // PROTECTION
  pApar: ProtectionChoice;
  pHidran: ProtectionChoice;
  pDetektor: ProtectionChoice;
  pSprinkler: ProtectionChoice;
  pDamkar: '8' | '6' | '4' | '2';

  // EXPOSURE
  exKondisi: '4' | '3' | '2' | '1';

  // NATURAL HAZARDS
  nhGempa: 'avg' | 'marg';
  nhTsunami: 'avg' | 'marg';
  nhPetir: 'avg_low' | 'avg_high' | 'marg';
  nhBanjir: 'avg' | 'marg';
  nhLongsor: 'avg' | 'marg';
  nhHistory: 'none' | 'improved' | 'none_improved';

  // LOSS ESTIMATE
  leMfl: '7' | '7b' | '5' | '3';
}

type ProtectionChoice = 'good' | 'avg' | 'none';

export interface GradeResult {
  scores: Record<GradeItemCode, number>;
  total: number;
  category: GradeCategory;
}

const PROTECTION_WEIGHTS = {
  apar: 0.2,
  hidran: 0.3,
  detektor: 0.25,
  sprinkler: 0.15,
} as const;

// Nilai skor per komponen proteksi — 1:1 dari reff.html:
// APAR max Average (6), komponen lain max Good (8).
const PROTECTION_SCORES: Record<'apar' | 'hidran' | 'detektor' | 'sprinkler', Record<ProtectionChoice, number>> = {
  apar: { good: 6, avg: 4, none: 2 },
  hidran: { good: 8, avg: 6, none: 2 },
  detektor: { good: 8, avg: 6, none: 2 },
  sprinkler: { good: 8, avg: 6, none: 2 },
};

function clampScore(v: number): number {
  return Math.max(1, Math.min(8, Math.round(v)));
}

export function computeGradeScores(input: GradeInputs): GradeResult {
  // MANAGEMENT: checklist 6 item → base, lalu penalti/kredit, clamp 2..8
  const mChecked = input.mChecklist.length;
  let mBase = mChecked >= 5 ? 8 : mChecked >= 3 ? 6 : mChecked >= 1 ? 4 : 2;
  let mAdj = 0;
  if (input.mKlaim === '3+') mAdj -= 2;
  else if (input.mKlaim === '1-2') mAdj -= 1;
  if (input.mImprovement === 'yes') mAdj += 2;
  if (input.mRekomendasi === 'yes') mAdj += 2;
  const management = Math.max(2, Math.min(8, mBase + mAdj));

  // CONSTRUCTION: kelas dasar, penalti sandwich/ACP masing-masing -2, clamp 2..8
  let construction = Number(input.cKelas);
  if (input.cSandwich === 'yes') construction = Math.max(2, construction - 2);
  if (input.cAcp === 'yes') construction = Math.max(2, construction - 2);

  // OCCUPANCY: 8 | 6 | 4 berdasarkan kategori hazard
  const occupancy =
    input.oHazard === '8' ? 8 : input.oHazard === '6a' || input.oHazard === '6b' ? 6 : 4;

  // PROTECTION: weighted average 0.2/0.3/0.25/0.15 + damkar 0.1, bulatkan
  let pTotal = 0;
  pTotal += PROTECTION_SCORES.apar[input.pApar] * PROTECTION_WEIGHTS.apar;
  pTotal += PROTECTION_SCORES.hidran[input.pHidran] * PROTECTION_WEIGHTS.hidran;
  pTotal += PROTECTION_SCORES.detektor[input.pDetektor] * PROTECTION_WEIGHTS.detektor;
  pTotal += PROTECTION_SCORES.sprinkler[input.pSprinkler] * PROTECTION_WEIGHTS.sprinkler;
  pTotal += Number(input.pDamkar) * 0.1;
  const protection = clampScore(pTotal);

  // EXPOSURE: langsung dari pilihan (4/3/2/1)
  const exposure = Number(input.exKondisi);

  // NATURAL HAZARDS: default 3 (Average), turun ke 2 jika ada indikasi risiko tinggi
  const nhRisky =
    input.nhGempa === 'marg' ||
    input.nhTsunami === 'marg' ||
    input.nhPetir === 'marg' ||
    input.nhBanjir === 'marg' ||
    input.nhLongsor === 'marg' ||
    input.nhHistory === 'none_improved';
  const naturalHazards = nhRisky ? 2 : 3;

  // OTHER PERIL: tetap 3 (Average) sesuai prototype
  const otherPeril = 3;

  // LOSS ESTIMATE: 7 | 5 | 3 (7b juga 7)
  const lossEstimate = input.leMfl === '7' || input.leMfl === '7b' ? 7 : input.leMfl === '5' ? 5 : 3;

  const scores: Record<GradeItemCode, number> = {
    management,
    construction,
    occupancy,
    protection,
    exposure,
    natural_hazards: naturalHazards,
    other_peril: otherPeril,
    loss_estimate: lossEstimate,
  };

  const total = GRADE_ITEM_CODES.reduce((sum, c) => sum + scores[c], 0);

  // Threshold reff.html: 46 GOOD, 31 AVERAGE, 21 MARGINAL, sisanya POOR
  const category: GradeCategory =
    total >= 46 ? 'GOOD' : total >= 31 ? 'AVERAGE' : total >= 21 ? 'MARGINAL' : 'POOR';

  return { scores, total, category };
}

/** Band label per skor item (untuk tabel detail hasil). */
export function bandLabelOfScore(score: number): string {
  if (score <= 2) return 'Poor';
  if (score <= 4) return 'Marginal';
  if (score <= 6) return 'Average';
  return 'Good';
}
