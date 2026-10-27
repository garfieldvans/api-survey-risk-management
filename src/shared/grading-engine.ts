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
  /** '' = belum dijawab (wajib sebelum revisi ini; kini boleh kosong, dinilai netral). */
  mKlaim: '' | '0' | '1-2' | '3+';
  /** '' = belum dijawab (hanya wajib bila ada klaim). */
  mImprovement: '' | 'yes' | 'no';
  mRekomendasi: '' | 'yes' | 'no';

  // CONSTRUCTION — '' = belum dijawab
  /** '2' = Tidak ada informasi (nilai tetap 4, penanda agar kompatibel payload lama). */
  cKelas: '' | '8' | '6' | '4' | '3' | '2';
  cSandwich: '' | 'yes' | 'no';
  cAcp: '' | 'yes' | 'no';

  // OCCUPANCY (petakan skor Breakdown ASWATA: 8→'8', 6→'6a', 4→'4a') — '' = belum dijawab
  oHazard: '' | '8' | '6a' | '6b' | '4a' | '4b' | '4c';

  // PROTECTION — '' = belum dijawab
  pApar: '' | ProtectionChoice;
  pHidran: '' | ProtectionChoice;
  pDetektor: '' | ProtectionChoice;
  pSprinkler: '' | ProtectionChoice;
  pDamkar: '' | '8' | '6' | '4' | '2';

  // EXPOSURE — '' = belum dijawab
  exKondisi: '' | '4' | '3' | '2' | '1';

  // NATURAL HAZARDS — kombinasi Gempa + Banjir + Petir — '' = belum dijawab
  nhGempa: '' | 'avg' | 'marg';
  nhBanjir: '' | 'avg' | 'marg';
  nhPetir: '' | 'avg' | 'marg';

  // LOSS ESTIMATE — '' = Pemisah (TBC) belum dijawab / Jumlah bangunan belum dijawab
  lePemisah: '' | 'yes' | 'no';
  leJmlBangunan: '' | '1' | 'gt1';

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
  /**
   * Item yang punya jawaban kosong, beserta label field-nya — dipakai API untuk
   * menandai "Belum dijawab: …" pada catatan item di laporan (kirim tetap boleh).
   */
  incompleteByItem: Partial<Record<GradeItemCode, string[]>>;
}

/** Label pendek per input — dipakai pada penanda "Belum dijawab" di laporan. */
const FIELD_LABELS: Record<string, string> = {
  m1: 'Kebersihan dan kerapihan',
  m2: 'Aturan merokok',
  m3: 'Pelatihan kebakaran',
  m4: 'Perawatan rutin',
  m7: 'Izin Kerja Panas (Hot Work Permit)',
  mKlaim: 'Klaim 3 tahun terakhir',
  mImprovement: 'Risk improvement atas klaim',
  mRekomendasi: 'Rekomendasi perbaikan',
  cKelas: 'Kelas kebakaran bangunan',
  cSandwich: 'Sandwich panel',
  cAcp: 'ACP (material fasad)',
  oHazard: 'Kondisi kebakaran (Occupancy)',
  pApar: 'APAR',
  pHidran: 'Hidran',
  pDetektor: 'Detektor kebakaran',
  pSprinkler: 'Sprinkler',
  pDamkar: 'Waktu respons pemadam',
  exKondisi: 'Kondisi exposure',
  nhGempa: 'Gempa bumi',
  nhBanjir: 'Banjir',
  nhPetir: 'Petir',
  leJmlBangunan: 'Jumlah bangunan terdampak',
};

/**
 * Catatan desain (versi "required dilonggarkan"):
 * jawaban kosong TIDAK dinilai skor terburuk — tiap field kosong memakai
 * nilai netral berikut supaya formulir setengah terisi tidak melorotkan total
 * secara tak wajar, dan kekosongannya dilaporkan lewat `incompleteByItem`.
 */
const NEUTRAL = {
  /** Default netral Management bila kelima aspek kosong (mid rentang 2..8 ≈ 4). */
  managementBase: 4,
  /** Default netral Occupancy (band Average). */
  occupancy: 6,
  /** Default netral komponen Protection (band Average). */
  protectionChoice: 'avg' as ProtectionChoice,
  /** Default netral waktu respons damkar (mid rentang 2..8). */
  pDamkar: 4,
} as const;

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
      'TSI Rp ' + tsi.toLocaleString('en-US') + ' ≥ Rp ' + HIDRAN_THRESHOLD[cat].amount.toLocaleString('en-US'),
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
  // Aspek yang belum dijawab dihitung setengah poin (bukan otomatis "tidak"),
  // dan bila kelima aspek kosong → base netral NEUTRAL.managementBase.
  const answers = input.mAnswers;
  let mBase: number;
  if (!answers) {
    // Payload lama tanpa mAnswers — pakai mChecklist seperti sebelumnya.
    const mChecked = input.mChecklist?.length ?? 0;
    mBase = mChecked === 5 ? 8 : mChecked === 4 ? 6 : mChecked === 3 ? 4 : 2;
  } else {
    const mYes = M_ASPECT_IDS.filter((id) => answers[id] === 'yes').length;
    const mEmpty = M_ASPECT_IDS.filter((id) => answers[id] === '').length;
    if (mEmpty === M_ASPECT_IDS.length) {
      mBase = NEUTRAL.managementBase;
    } else {
      const scored = mYes + 0.5 * mEmpty;
      mBase = scored >= 5 ? 8 : scored >= 4 ? 6 : scored >= 3 ? 4 : 2;
    }
  }

  let mAdj = 0;
  if (input.mKlaim === '3+') mAdj -= 2;
  else if (input.mKlaim === '1-2') mAdj -= 1;
  if (input.mKlaim !== '' && input.mKlaim !== '0' && input.mImprovement === 'yes') mAdj += 2;
  if (input.mRekomendasi === 'yes') mAdj += 2;
  // Kredit hanya mengompensasi penalti klaim — tidak boleh menaikkan di atas mBase.
  const management = Math.max(2, Math.min(mBase, mBase + mAdj));

  // ---- CONSTRUCTION ----
  // '' (belum dijawab) jatuh ke 4 — netral, sama seperti '2' (tanpa informasi).
  const cBase =
    input.cKelas === '8' ? 8 : input.cKelas === '6' ? 6 : input.cKelas === '3' ? 3 : 4; // '4' & '2' (noinfo) = 4
  let construction = cBase;
  if (input.cSandwich === 'yes') construction = downgradeConstructionOneTier(construction);
  if (input.cAcp === 'yes') construction = downgradeConstructionOneTier(construction);

  // ---- OCCUPANCY — otomatis dari Breakdown Okupansi ASWATA ----
  // '' (belum dijawab) → netral Average (6), bukan skor terendah.
  const occupancy =
    input.oHazard === '8'
      ? 8
      : input.oHazard === '6a' || input.oHazard === '6b'
        ? 6
        : input.oHazard === '4a' || input.oHazard === '4b' || input.oHazard === '4c'
          ? 4
          : NEUTRAL.occupancy;

  // ---- PROTECTION ----
  // '' (belum dijawab) → netral Average; waktu respons kosong → mid rentang.
  const pApar = input.pApar || NEUTRAL.protectionChoice;
  const pHidran = input.pHidran || NEUTRAL.protectionChoice;
  const pDetektor = input.pDetektor || NEUTRAL.protectionChoice;
  const pSprinkler = input.pSprinkler || NEUTRAL.protectionChoice;
  const pDamkar = input.pDamkar ? Number(input.pDamkar) : NEUTRAL.pDamkar;

  let pTotal = 0;
  pTotal += PROTECTION_SCORES.apar[pApar] * PROTECTION_WEIGHTS.apar;
  pTotal += PROTECTION_SCORES.hidran[pHidran] * PROTECTION_WEIGHTS.hidran;
  pTotal += PROTECTION_SCORES.detektor[pDetektor] * PROTECTION_WEIGHTS.detektor;
  pTotal += PROTECTION_SCORES.sprinkler[pSprinkler] * PROTECTION_WEIGHTS.sprinkler;
  pTotal += pDamkar * 0.1;
  let protection = Math.round(pTotal);

  // Override: Hydrant wajib tapi JELAS tidak tersedia ('none') → skor otomatis 2 (Poor).
  // Belum dijawab ('') tidak memicu override — hanya ditandai incomplete.
  const hidran = getHidranWajibStatus(input);
  if (hidran.wajib && pHidran === 'none') {
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

  // ---- Field yang belum dijawab (ditandai di laporan, bukan skor terburuk) ----
  const incompleteByItem: Partial<Record<GradeItemCode, string[]>> = {};
  const flagMissing = (item: GradeItemCode, field: string, isMissing: boolean) => {
    if (!isMissing) return;
    const label = FIELD_LABELS[field] ?? field;
    const list = (incompleteByItem[item] = incompleteByItem[item] ?? []);
    list.push(label);
  };
  if (answers) {
    for (const id of M_ASPECT_IDS) flagMissing('management', id, answers[id] === '');
  }
  flagMissing('management', 'mKlaim', !input.mKlaim);
  flagMissing(
    'management',
    'mImprovement',
    !!input.mKlaim && input.mKlaim !== '0' && input.mImprovement === '',
  );
  flagMissing('management', 'mRekomendasi', !input.mRekomendasi);
  flagMissing('construction', 'cKelas', !input.cKelas);
  flagMissing('construction', 'cSandwich', !input.cSandwich);
  flagMissing('construction', 'cAcp', !input.cAcp);
  flagMissing('occupancy', 'oHazard', !input.oHazard);
  flagMissing('protection', 'pApar', !input.pApar);
  flagMissing('protection', 'pHidran', !input.pHidran);
  flagMissing('protection', 'pDetektor', !input.pDetektor);
  flagMissing('protection', 'pSprinkler', !input.pSprinkler);
  flagMissing('protection', 'pDamkar', !input.pDamkar);
  flagMissing('exposure', 'exKondisi', !input.exKondisi);
  flagMissing('natural_hazards', 'nhGempa', !input.nhGempa);
  flagMissing('natural_hazards', 'nhBanjir', !input.nhBanjir);
  flagMissing('natural_hazards', 'nhPetir', !input.nhPetir);
  flagMissing('loss_estimate', 'leJmlBangunan', !input.leJmlBangunan);
  // lePemisah sengaja tidak ditandai — masih TBC di prototipe (tidak wajib).

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

  return { scores, total, category, incompleteByItem };
}

/** Band label per skor item (untuk tabel detail hasil). */
export function bandLabelOfScore(score: number): string {
  if (score <= 2) return 'Poor';
  if (score <= 4) return 'Marginal';
  if (score <= 6) return 'Average';
  return 'Good';
}
