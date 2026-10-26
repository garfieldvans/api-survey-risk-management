/**
 * Risk grading engine — port aturan kalkulasi dari prototipe revisi terbaru
 * `src/public/Surver_Report__Revisi_Terbaru.html` (SURVEY_HTML_B64, calcRiskGrading).
 *
 * Dipakai oleh:
 * - API (POST /surveys) untuk menyimpan skor authoritative dari payload wizard surveyor
 * - Web (wizard 12 langkah) untuk preview hasil sebelum kirim
 *
 * Aturan inti (revisi prototipe):
 * - 8 item dengan rentang skor 1..8 (natural_hazards & other_peril 2..3, other_peril tetap 3)
 * - Management: 5 aspek inti Y/N → 5/5=8, 4/5=6, 3/5=4, sisanya 2;
 *   kredit improvement/rekomendasi hanya mengompensasi penalti klaim
 *   (tidak boleh menaikkan skor di atas hasil checklist inti)
 * - Construction: downgrade satu tingkat per penalti (8→6, 6→4, 4→3, 3→3)
 * - Occupancy: skor otomatis dari Breakdown Okupansi ASWATA
 * - Protection: bobot APAR 25% / Hidran 30% / Detektor 25% / Sprinkler 10% / Damkar 10%;
 *   bila Hydrant WAJIB tapi tidak tersedia → skor Protection = 2 (Poor)
 * - Natural Hazards: kombinasi Gempa + Banjir + Petir — salah satu Marginal → overall 2 (Marginal)
 * - Loss Estimate: Jumlah Bangunan terjawab → 3 (Marginal), belum → 5
 * - Total / 55 → GOOD (>=46) | AVERAGE (>=31) | MARGINAL (>=21) | POOR (<21)
 * - Override: Protection Poor → overall POOR
 */

import type { GradeCategory } from './statuses.js';
import { HIDRAN_THRESHOLD, COMMERCIAL_RESIDENTIAL_TSI_THRESHOLD } from '../lib/occBreakdown.js';

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

/** 5 aspek inti Management (Y/N) — m1..m4 + m7, sesuai prototipe. */
export const M_ASPECT_IDS = ['m1', 'm2', 'm3', 'm4', 'm7'] as const;
export type MAspectId = (typeof M_ASPECT_IDS)[number];

export type ProtectionChoice = 'good' | 'avg' | 'none';

/**
 * Input wizard per section (nama field sama dengan prototipe).
 * Field bertanda konteks dipakai untuk logika Syarat Wajib Hydrant.
 */
export interface GradeInputs {
  // MANAGEMENT
  mAnswers: Record<MAspectId, '' | 'yes' | 'no'>;
  /** Id aspek yang berstatus "yes" — dipertahankan kompatibel dengan payload grading lama. */
  mChecklist: string[];
  mKlaim: '0' | '1-2' | '3+';
  /** '' = belum dijawab (hanya wajib bila ada klaim). */
  mImprovement: '' | 'yes' | 'no';
  mRekomendasi: 'yes' | 'no';

  // CONSTRUCTION
  /** '2' = Tidak ada informasi (nilai tetap 4, penanda agar kompatibel payload lama). */
  cKelas: '8' | '6' | '4' | '3' | '2';
  cSandwich: 'yes' | 'no';
  cAcp: 'yes' | 'no';

  // OCCUPANCY (petakan skor Breakdown ASWATA: 8→'8', 6→'6a', 4→'4a')
  oHazard: '8' | '6a' | '6b' | '4a' | '4b' | '4c';

  // PROTECTION
  pApar: ProtectionChoice;
  pHidran: ProtectionChoice;
  pDetektor: ProtectionChoice;
  pSprinkler: ProtectionChoice;
  pDamkar: '8' | '6' | '4' | '2';

  // EXPOSURE
  exKondisi: '4' | '3' | '2' | '1';

  // NATURAL HAZARDS — kombinasi Gempa + Banjir + Petir
  nhGempa: 'avg' | 'marg';
  nhBanjir: 'avg' | 'marg';
  nhPetir: 'avg' | 'marg';

  // LOSS ESTIMATE — '' = Pemisah (TBC) belum dijawab
  lePemisah: '' | 'yes' | 'no';
  leJmlBangunan: '1' | 'gt1';

  // KONTEKS — syarat wajib Hydrant (bukan komponen skor)
  tsi: number;
  cLantai: number;
  spJenis: string;
  oHazardCat: string;
}

export interface GradeResult {
  scores: Record<GradeItemCode, number>;
  total: number;
  category: GradeCategory;
}

/**
 * Status Syarat Wajib Hydrant (port `getHidranWajibStatus` prototipe):
 * - Commercial/Residential + TSI ≥ 100M: wajib bila ≥ 6 lantai, atau
 *   (≥ 4 lantai / konstruksi combustible Kelas 2-3) + respons damkar > 30 menit
 * - Selain itu: respons damkar > 30 menit + TSI ≥ ambang kategori risiko
 */
export function getHidranWajibStatus(input: GradeInputs): { wajib: boolean; alasan: string[] } {
  const cat = input.oHazardCat || '';
  const tsi = input.tsi ?? 0;
  const responLebih30 = input.pDamkar === '2';
  const lantai = input.cLantai ?? 0;
  // Kelas 2 / Kelas 3 = konstruksi combustible (Tidak ada informasi '2' tidak dihitung)
  const kelasCombustible = input.cKelas === '4' || input.cKelas === '3';
  const isCommercialResidential = input.spJenis === 'commercial';

  const alasan: string[] = [];
  let wajib = false;

  if (isCommercialResidential && tsi >= COMMERCIAL_RESIDENTIAL_TSI_THRESHOLD) {
    if (lantai >= 6) {
      wajib = true;
      alasan.push(
        'Commercial/Residential Risk',
        'TSI >= 100M',
        'Bangunan ≥ 6 lantai — wajib terlepas dari waktu respons pemadam publik',
      );
    } else if ((lantai >= 4 || kelasCombustible) && responLebih30) {
      wajib = true;
      alasan.push(
        'Commercial/Residential Risk',
        'TSI >= 100M',
        lantai >= 4 ? 'Bangunan ≥ 4 lantai' : 'Konstruksi combustible Class 2/3',
        'Waktu respons pemadam kebakaran publik > 30 menit',
      );
    }
  } else if (!isCommercialResidential && cat && HIDRAN_THRESHOLD[cat] && responLebih30 && tsi >= HIDRAN_THRESHOLD[cat].amount) {
    wajib = true;
    alasan.push(
      'Waktu respons pemadam kebakaran publik > 30 menit',
      'Kategori risiko: ' + HIDRAN_THRESHOLD[cat].label,
      'TSI Rp ' + tsi.toLocaleString('id-ID') + ' ≥ Rp ' + HIDRAN_THRESHOLD[cat].amount.toLocaleString('id-ID'),
    );
  }

  return { wajib, alasan };
}

// Bobot proteksi revisi: APAR 25%, Hidran 30%, Detektor 25%, Sprinkler 10% + Damkar 10%.
const PROTECTION_WEIGHTS = {
  apar: 0.25,
  hidran: 0.3,
  detektor: 0.25,
  sprinkler: 0.1,
} as const;

// Nilai skor per komponen proteksi — 1:1 prototipe:
// APAR max Average (6), komponen lain max Good (8).
const PROTECTION_SCORES: Record<'apar' | 'hidran' | 'detektor' | 'sprinkler', Record<ProtectionChoice, number>> = {
  apar: { good: 6, avg: 4, none: 2 },
  hidran: { good: 8, avg: 6, none: 2 },
  detektor: { good: 8, avg: 6, none: 2 },
  sprinkler: { good: 8, avg: 6, none: 2 },
};

/** Downgrade satu tingkat (8→6, 6→4, 4→3, 3→3) — penalti sandwich/ACP. */
function downgradeConstructionOneTier(score: number): number {
  if (score >= 8) return 6;
  if (score >= 6) return 4;
  if (score >= 4) return 3;
  return 3;
}

export function computeGradeScores(input: GradeInputs): GradeResult {
  // ---- MANAGEMENT ----
  // 5 aspek inti: Good hanya bila 5/5 terpenuhi (4/5=Average, 3/5=Marginal, 0–2/5=Poor).
  const answers = input.mAnswers;
  const mChecked = answers
    ? M_ASPECT_IDS.filter((id) => answers[id] === 'yes').length
    : (input.mChecklist?.length ?? 0);
  const mBase = mChecked === 5 ? 8 : mChecked === 4 ? 6 : mChecked === 3 ? 4 : 2;

  let mAdj = 0;
  if (input.mKlaim === '3+') mAdj -= 2;
  else if (input.mKlaim === '1-2') mAdj -= 1;
  if (input.mKlaim !== '0' && input.mImprovement === 'yes') mAdj += 2;
  if (input.mRekomendasi === 'yes') mAdj += 2;
  // Kredit hanya mengompensasi penalti klaim — tidak boleh menaikkan di atas mBase.
  const management = Math.max(2, Math.min(mBase, mBase + mAdj));

  // ---- CONSTRUCTION ----
  const cBase =
    input.cKelas === '8' ? 8 : input.cKelas === '6' ? 6 : input.cKelas === '3' ? 3 : 4; // '4' & '2' (noinfo) = 4
  let construction = cBase;
  if (input.cSandwich === 'yes') construction = downgradeConstructionOneTier(construction);
  if (input.cAcp === 'yes') construction = downgradeConstructionOneTier(construction);

  // ---- OCCUPANCY — otomatis dari Breakdown Okupansi ASWATA ----
  const occupancy =
    input.oHazard === '8' ? 8 : input.oHazard === '6a' || input.oHazard === '6b' ? 6 : 4;

  // ---- PROTECTION ----
  let pTotal = 0;
  pTotal += PROTECTION_SCORES.apar[input.pApar] * PROTECTION_WEIGHTS.apar;
  pTotal += PROTECTION_SCORES.hidran[input.pHidran] * PROTECTION_WEIGHTS.hidran;
  pTotal += PROTECTION_SCORES.detektor[input.pDetektor] * PROTECTION_WEIGHTS.detektor;
  pTotal += PROTECTION_SCORES.sprinkler[input.pSprinkler] * PROTECTION_WEIGHTS.sprinkler;
  pTotal += Number(input.pDamkar) * 0.1;
  let protection = Math.round(pTotal);

  // Override: Hydrant wajib tapi tidak tersedia → skor otomatis 2 (Poor).
  const hidran = getHidranWajibStatus(input);
  if (hidran.wajib && (input.pHidran === 'none' || !input.pHidran)) {
    protection = 2;
  }

  // ---- EXPOSURE ----
  const exposure = Number(input.exKondisi) || 2;

  // ---- NATURAL HAZARDS — kombinasi Gempa + Banjir + Petir ----
  const nhComplete = !!input.nhGempa && !!input.nhBanjir && !!input.nhPetir;
  const naturalHazards = nhComplete
    ? input.nhGempa === 'avg' && input.nhBanjir === 'avg' && input.nhPetir === 'avg'
      ? 3
      : 2
    : 3; // preview sebelum lengkap = default Average

  // ---- OTHER PERILS — tetap 3 (Average) sesuai prototipe ----
  const otherPeril = 3;

  // ---- LOSS ESTIMATE — Jumlah Bangunan (semua jawaban rating Marginal) ----
  const lossEstimate = input.leJmlBangunan ? 3 : 5;

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

  // Threshold: 46 GOOD, 31 AVERAGE, 21 MARGINAL, sisanya POOR.
  let category: GradeCategory =
    total >= 46 ? 'GOOD' : total >= 31 ? 'AVERAGE' : total >= 21 ? 'MARGINAL' : 'POOR';

  // Override: Protection Poor → overall POOR (hanya rating final; skor kategori tetap).
  if (protection <= 2) {
    category = 'POOR';
  }

  return { scores, total, category };
}

/** Band label per skor item (untuk tabel detail hasil). */
export function bandLabelOfScore(score: number): string {
  if (score <= 2) return 'Poor';
  if (score <= 4) return 'Marginal';
  if (score <= 6) return 'Average';
  return 'Good';
}
