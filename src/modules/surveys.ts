import type { FastifyInstance } from 'fastify';
import { Prisma, SurveyStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../plugins/prisma';
import { authenticate, requireRole, assertSurveyAccess } from '../plugins/auth';
import { ok, AppError } from '../lib/http';
import { notifyAdmins, notifyAdminsForStatusChange } from './notifications-helpers';
import { getQuestionIdsForOccupation } from './questions';
import { deleteObject } from '../plugins/storage';
import { computeGradeScores, GRADE_ITEM_CODES, TRANSITIONS } from '../shared/index.js';

// --------------- Zod schemas ---------------

const answerSchema = z.object({
  questionId: z.string().min(1),
  value: z.string().max(5000),
});

// Payload grading dari wizard surveyor (port prototipe revisi terbaru) — skor dihitung
// server-side via computeGradeScores agar authoritative. Bentuk input mengikuti
// revisi HTML: 5 aspek Management Y/N (mAnswers), Pemisah + Jumlah Bangunan di
// Loss Estimate, plus konteks (tsi/cLantai/spJenis/oHazardCat) untuk Syarat Wajib Hydrant.
// Semua pilihan BOLEH KOSONG ('') — validasi langkah dilonggarkan, jawaban yang
// belum diisi dinilai netral oleh engine dan ditandai "Belum dijawab" di catatan item.
const gradeInputsSchema = z.object({
  mAnswers: z.object({
    m1: z.enum(['yes', 'no', '']),
    m2: z.enum(['yes', 'no', '']),
    m3: z.enum(['yes', 'no', '']),
    m4: z.enum(['yes', 'no', '']),
    m7: z.enum(['yes', 'no', '']),
  }),
  mChecklist: z.array(z.string()),
  mKlaim: z.enum(['0', '1-2', '3+', '']),
  // Hanya wajib bila ada klaim (validasi di wizard) — bisa kosong
  mImprovement: z.enum(['yes', 'no', '']),
  mRekomendasi: z.enum(['yes', 'no', '']),
  cKelas: z.enum(['8', '6', '4', '3', '2', '']),
  cSandwich: z.enum(['yes', 'no', '']),
  cAcp: z.enum(['yes', 'no', '']),
  oHazard: z.enum(['8', '6a', '6b', '4a', '4b', '4c', '']),
  pApar: z.enum(['good', 'avg', 'none', '']),
  pHidran: z.enum(['good', 'avg', 'none', '']),
  pDetektor: z.enum(['good', 'avg', 'none', '']),
  pSprinkler: z.enum(['good', 'avg', 'none', '']),
  pDamkar: z.enum(['8', '6', '4', '2', '']),
  exKondisi: z.enum(['4', '3', '2', '1', '']),
  nhGempa: z.enum(['avg', 'marg', '']),
  nhBanjir: z.enum(['avg', 'marg', '']),
  nhPetir: z.enum(['avg', 'marg', '']),
  // Pemisah masih TBC — tidak wajib di wizard
  lePemisah: z.enum(['yes', 'no', '']),
  leJmlBangunan: z.enum(['1', 'gt1', '']),
  // Konteks Syarat Wajib Hydrant (bukan komponen skor)
  tsi: z.number().min(0),
  cLantai: z.number().min(0),
  spJenis: z.string(),
  oHazardCat: z.string(),
});

const gradeNotesSchema = z
  .object({
    management: z.string().optional(),
    construction: z.string().optional(),
    occupancy: z.string().optional(),
    protection: z.string().optional(),
    exposure: z.string().optional(),
    natural_hazards: z.string().optional(),
    other_peril: z.string().optional(),
    loss_estimate: z.string().optional(),
  })
  .optional();

const createSurveySchema = z.object({
  // Property (new property)
  property: z.object({
    name: z.string().min(1),
    address: z.string().min(1),
    ownerName: z.string().min(1),
    // Opsional — prototipe tidak punya pemilih Okupasi OJK; tanpa okupasi,
    // kuesioner dinamis dibatasi ke pertanyaan core.
    occupationId: z.string().min(1).optional(),
    extraData: z.record(z.unknown()).optional(),
  }),
  surveyDate: z.coerce.date().optional(),
  notes: z.string().optional(),
  answers: z.array(answerSchema).max(500),
  // Risk grading mandiri oleh surveyor (opsional untuk kompatibilitas alur lama)
  grading: z
    .object({
      inputs: gradeInputsSchema,
      notes: gradeNotesSchema,
    })
    .optional(),
}).superRefine((val, ctx) => {
  // Field wajib tab Survey Umum (poin review #1): frontend sudah mengunci
  // navigasi, tapi backend ikut menegakkan supaya isian kosong tidak lolos
  // lewat bypass. Hanya berlaku saat extraData dikirim (kompatibel alur lama).
  const extra = val.property.extraData;
  if (!extra) return;
  const fail = (message: string) =>
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['property', 'extraData'],
      message,
    });
  if (typeof extra.kota !== 'string' || !extra.kota.trim())
    fail('Kabupaten / Kota wajib diisi');
  if (typeof extra.gps !== 'string' || !extra.gps.trim())
    fail('Koordinat GPS wajib diisi');
  if (typeof extra.kodePos !== 'string' || !/^\d{5}$/.test(extra.kodePos.trim()))
    fail('Kode Pos harus 5 digit');
  if (typeof extra.tsi !== 'number' || !Number.isFinite(extra.tsi) || extra.tsi <= 0)
    fail('Nilai Pertanggungan (TSI) wajib diisi');
});

// Aturan transisi status tinggal di shared/transitions.ts (TRANSITIONS diimpor di atas)
// supaya bisa di-unit-test tanpa menyentuh route.

// --------------- Helpers ---------------

async function getSurveyOrThrow(id: string) {
  const survey = await prisma.survey.findUnique({
    where: { id },
    include: {
      property: { include: { occupation: true } },
      surveyor: true,
      answers: { include: { question: true }, orderBy: { createdAt: 'asc' } },
      responses: { include: { item: true }, orderBy: { createdAt: 'asc' } },
      attachments: true,
      grade: true,
    },
  });
  if (!survey) throw new AppError('Survei tidak ditemukan', 404);
  return survey;
}

async function cleanupSurveyR2Files(attachments: Array<{ fileKey: string }>): Promise<void> {
  for (const att of attachments) {
    try {
      await deleteObject(att.fileKey);
    } catch {
      // best-effort: log but don't fail the whole delete
      console.warn(`Gagal hapus file R2: ${att.fileKey}`);
    }
  }
}

async function validateAnswers(
  answers: Array<{ questionId: string; value: string }>,
  occupationId: string | null,
) {
  const allowedIds = new Set(
    occupationId
      ? await getQuestionIdsForOccupation(occupationId)
      : // Tanpa okupasi OJK (sesuai prototipe) hanya pertanyaan core yang sah
        (await prisma.question.findMany({ where: { occupationId: null }, select: { id: true } })).map((q) => q.id),
  );
  const seen = new Set<string>();

  for (const a of answers) {
    if (seen.has(a.questionId)) {
      throw new AppError(`Jawaban duplikat untuk pertanyaan ${a.questionId}`, 400);
    }
    seen.add(a.questionId);
    if (!allowedIds.has(a.questionId)) {
      throw new AppError('Ada pertanyaan yang tidak berlaku untuk okupasi ini', 400);
    }
  }

  const dbQuestions = await prisma.question.findMany({
    where: { id: { in: answers.map((a) => a.questionId) } },
  });
  const map = new Map(dbQuestions.map((q) => [q.id, q]));

  for (const a of answers) {
    const q = map.get(a.questionId);
    if (!q) throw new AppError(`Pertanyaan tidak ditemukan: ${a.questionId}`, 400);
    if (q.answerType === 'YES_NO' && !['ya', 'tidak', 'Y', 'N', 'yes', 'no'].includes(a.value.toLowerCase())) {
      throw new AppError(`Jawaban untuk "${q.text}" harus Ya/Tidak`, 400);
    }
    if (q.answerType === 'NUMBER' && !/^\d+(\.\d+)?$/.test(a.value.trim())) {
      throw new AppError(`Jawaban untuk "${q.text}" harus angka`, 400);
    }
    if (q.answerType === 'CHOICE') {
      const opts = q.options ?? [];
      if (!opts.includes(a.value)) {
        throw new AppError(`Jawaban untuk "${q.text}" harus salah satu opsi yang tersedia`, 400);
      }
    }
    if (q.answerType === 'MULTI') {
      const opts = q.options ?? [];
      const parts = a.value.split(',').map((s) => s.trim()).filter(Boolean);
      const unique = new Set(parts);
      if (unique.size !== parts.length) {
        throw new AppError(`Jawaban untuk "${q.text}" tidak boleh berisi opsi ganda`, 400);
      }
      for (const p of parts) {
        if (!opts.includes(p)) {
          throw new AppError(`Jawaban untuk "${q.text}" berisi opsi yang tidak valid`, 400);
        }
      }
    }
  }
}

// --------------- Routes ---------------

export async function surveyRoutes(fastify: FastifyInstance) {
  /**
   * GET /surveys
   * Surveyor → own surveys only. Admin → all. Filter by status.
   */
  fastify.get('/surveys', { preHandler: [authenticate()] }, async (request) => {
    const user = request.user!;
    const query = request.query as Record<string, string | undefined>;
    const status = query.status as SurveyStatus | undefined;

    const where: Prisma.SurveyWhereInput = {
      ...(user.role === Role.SURVEYOR ? { surveyorId: user.id } : {}),
      ...(status ? { status } : {}),
    };

    const surveys = await prisma.survey.findMany({
      where,
      include: {
        property: { include: { occupation: true } },
        grade: true,
        attachments: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return ok({ surveys });
  });

  /**
   * GET /surveys/:id
   */
  fastify.get('/surveys/:id', { preHandler: [authenticate()] }, async (request) => {
    const { id } = request.params as { id: string };
    const survey = await getSurveyOrThrow(id);
    assertSurveyAccess(request.user!, survey.surveyorId);
    return ok({ survey });
  });

  /**
   * POST /surveys — create property + survey + answers atomically.
   */
  fastify.post('/surveys', { preHandler: [authenticate()] }, async (request, reply) => {
    const user = request.user!;
    const body = createSurveySchema.parse(request.body);

    if (body.property.occupationId) {
      const occupation = await prisma.occupation.findUnique({
        where: { id: body.property.occupationId },
        include: { children: { take: 1 } },
      });
      if (!occupation) throw new AppError('Okupasi tidak ditemukan', 400);
      if (occupation.children.length > 0) throw new AppError('Okupasi harus node daun (tanpa anak)', 400);
    }

    await validateAnswers(body.answers, body.property.occupationId ?? null);

    // Prefetch data grading SEKALI di luar transaksi supaya jumlah query di
    // dalam transaksi seminimal mungkin (lihat catatan timeout di bawah).
    let itemByCode: Map<string, string> | null = null;
    if (body.grading) {
      const dbItems = await prisma.surveyItem.findMany();
      itemByCode = new Map(dbItems.map((i) => [i.code, i.id]));
      const missingItems = GRADE_ITEM_CODES.filter((c) => !itemByCode!.has(c));
      if (missingItems.length > 0) {
        throw new AppError(`SurveyItem belum di-seed: ${missingItems.join(', ')}`, 500);
      }
    }

    // Create in a single transaction.
    // PENTING: di serverless (Vercel + Neon), latency per query bisa ~1 detik.
    // Default timeout interactive transaction Prisma hanya 5 detik — kalau
    // kelebihan muncul error P2028 "Transaction already closed" → 500 di FE.
    // Naikkan timeoutnya dan jaga isi transaksi tetap ringkas.
    const createdSurveyId: string = await prisma.$transaction(async (tx) => {
      const property = await tx.property.create({
        data: {
          name: body.property.name,
          address: body.property.address,
          ownerName: body.property.ownerName,
          occupationId: body.property.occupationId ?? null,
          extraData: (body.property.extraData as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        },
      });

      const s = await tx.survey.create({
        data: {
          propertyId: property.id,
          surveyorId: user.id,
          status: 'ONBOARD',
          surveyDate: body.surveyDate ?? null,
          notes: body.notes,
        },
      });

      if (body.answers.length > 0) {
        await tx.surveyAnswer.createMany({
          data: body.answers.map((a) => ({
            surveyId: s.id,
            questionId: a.questionId,
            value: a.value.trim(),
          })),
        });
      }

      // Risk grading mandiri surveyor — skor dihitung ulang server-side (authoritative)
      if (body.grading) {
        const gradeResult = computeGradeScores(body.grading.inputs);
        const notesMap = body.grading.notes ?? {};
        await tx.surveyResponse.deleteMany({ where: { surveyId: s.id } });
        await tx.surveyResponse.createMany({
          data: GRADE_ITEM_CODES.map((code) => {
            const baseTrim = (notesMap[code as keyof typeof notesMap] ?? '').trim();
            // Penanda "belum dijawab" — kirim tetap boleh, tapi item yang
            // kosong harus terlihat jelas di laporan / review admin.
            const missing = gradeResult.incompleteByItem[code];
            const flag = missing?.length ? `Belum dijawab: ${missing.join(', ')}.` : '';
            const notes = flag
              ? baseTrim
                ? `${baseTrim}${/[.!?]$/.test(baseTrim) ? ' ' : '. '}${flag}`
                : flag
              : baseTrim || null;
            return {
              surveyId: s.id,
              itemId: itemByCode!.get(code)!,
              score: gradeResult.scores[code],
              notes,
            };
          }),
        });

        // adminId null = grading otomatis dari surveyor; admin dapat override
        // lewat POST /surveys/:id/grade pada tahap REVIEW.
        await tx.riskGrade.create({
          data: {
            surveyId: s.id,
            totalScore: gradeResult.total,
            category: gradeResult.category,
          },
        });
      }

      return s.id;
    }, { timeout: 15000, maxWait: 10000 });

    // Read final SETELAH transaksi commit — query berat dengan banyak include
    // tidak perlu memakan budget timeout transaksi.
    const survey = await prisma.survey.findUnique({
      where: { id: createdSurveyId },
      include: {
        property: { include: { occupation: true } },
        surveyor: true,
        answers: { include: { question: true } },
        attachments: true,
        grade: true,
      },
    });

    // Notify admins (best-effort)
    await notifyAdmins(survey!.id, `Survei baru masuk: "${survey!.property.name}" dari ${user.name}`);

    return reply.code(201).send(ok({ survey }));
  });

  /**
   * PUT /surveys/:id — edit data survei (surveyor pemilik atau admin).
   * Bentuk body sama dengan POST /surveys (property, surveyDate, notes,
   * answers, grading). REPLACE semantics: field yang dikirim menimpa data lama.
   * `grading` opsional — bila tidak dikirim, penilaian lama dipertahankan utuh
   * (dipakai untuk survei lama yang input penilaianannya belum tersimpan).
   */
  fastify.put('/surveys/:id', { preHandler: [authenticate()] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = createSurveySchema.parse(request.body);

    const existing = await prisma.survey.findUnique({
      where: { id },
      include: { property: { select: { id: true } } },
    });
    if (!existing) throw new AppError('Survei tidak ditemukan', 404);
    assertSurveyAccess(user, existing.surveyorId);

    if (body.property.occupationId) {
      const occupation = await prisma.occupation.findUnique({
        where: { id: body.property.occupationId },
        include: { children: { take: 1 } },
      });
      if (!occupation) throw new AppError('Okupasi tidak ditemukan', 400);
      if (occupation.children.length > 0) throw new AppError('Okupasi harus node daun (tanpa anak)', 400);
    }

    await validateAnswers(body.answers, body.property.occupationId ?? null);

    // Grade resmi admin (adminId terisi) dijaga tetap — tidak ditimpa edit surveyor.
    const existingGrade = await prisma.riskGrade.findUnique({
      where: { surveyId: id },
      select: { adminId: true },
    });
    const adminGraded = !!existingGrade?.adminId;

    // Prefetch data grading SEKALI di luar transaksi (lihat catatan timeout di POST).
    let itemByCode: Map<string, string> | null = null;
    let gradeResult: ReturnType<typeof computeGradeScores> | null = null;
    if (body.grading && !adminGraded) {
      const dbItems = await prisma.surveyItem.findMany();
      itemByCode = new Map(dbItems.map((i) => [i.code, i.id]));
      const missingItems = GRADE_ITEM_CODES.filter((c) => !itemByCode!.has(c));
      if (missingItems.length > 0) {
        throw new AppError(`SurveyItem belum di-seed: ${missingItems.join(', ')}`, 500);
      }
      gradeResult = computeGradeScores(body.grading.inputs);
    }

    await prisma.$transaction(async (tx) => {
      await tx.property.update({
        where: { id: existing.propertyId },
        data: {
          name: body.property.name,
          address: body.property.address,
          ownerName: body.property.ownerName,
          occupationId: body.property.occupationId ?? null,
          extraData: (body.property.extraData as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
        },
      });

      await tx.survey.update({
        where: { id },
        data: {
          surveyDate: body.surveyDate ?? existing.surveyDate,
          notes: body.notes,
          // Submit ulang saat masih berstatus REQUEST_REVISE = surveyor telah
          // mengerjakan revisi → tandai REVISED supaya masuk antrean review lagi.
          ...(existing.status === 'REQUEST_REVISE' ? { status: 'REVISED' as const } : {}),
        },
      });

      await tx.surveyAnswer.deleteMany({ where: { surveyId: id } });
      if (body.answers.length > 0) {
        await tx.surveyAnswer.createMany({
          data: body.answers.map((a) => ({
            surveyId: id,
            questionId: a.questionId,
            value: a.value.trim(),
          })),
        });
      }

      if (body.grading && gradeResult && itemByCode && !adminGraded) {
        const notesMap = body.grading.notes ?? {};
        await tx.surveyResponse.deleteMany({ where: { surveyId: id } });
        await tx.surveyResponse.createMany({
          data: GRADE_ITEM_CODES.map((code) => {
            const baseTrim = (notesMap[code as keyof typeof notesMap] ?? '').trim();
            const missing = gradeResult!.incompleteByItem[code];
            const flag = missing?.length ? `Belum dijawab: ${missing.join(', ')}.` : '';
            const notes = flag
              ? baseTrim
                ? `${baseTrim}${/[.!?]$/.test(baseTrim) ? ' ' : '. '}${flag}`
                : flag
              : baseTrim || null;
            return {
              surveyId: id,
              itemId: itemByCode!.get(code)!,
              score: gradeResult!.scores[code],
              notes,
            };
          }),
        });

        await tx.riskGrade.upsert({
          where: { surveyId: id },
          update: { totalScore: gradeResult.total, category: gradeResult.category },
          create: { surveyId: id, totalScore: gradeResult.total, category: gradeResult.category },
        });
      }
    }, { timeout: 15000, maxWait: 10000 });

    const survey = await getSurveyOrThrow(id);
    return ok({ survey });
  });

  /**
   * PATCH /surveys/:id/status — transition status with validation.
   */
  fastify.patch('/surveys/:id/status', { preHandler: [authenticate()] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { status: newStatus } = z.object({ status: z.nativeEnum(SurveyStatus) }).parse(request.body) as { status: SurveyStatus };

    const survey = await prisma.survey.findUnique({ where: { id }, include: { property: true } });
    if (!survey) throw new AppError('Survei tidak ditemukan', 404);

    // Only admin can move status; surveyor can only view own
    if (user.role === Role.SURVEYOR) throw new AppError('Hanya admin yang bisa mengubah status', 403);

    // Saat REQUEST_REVISE survey menunggu surveyor mengirim revisi (PUT /surveys/:id)
    // — admin tidak boleh menyetel statusnya secara manual.
    if (survey.status === 'REQUEST_REVISE') {
      throw new AppError('Survei sedang menunggu revisi surveyor', 400);
    }

    const allowed = TRANSITIONS[survey.status];
    if (!allowed.includes(newStatus)) {
      throw new AppError(`Transisi dari ${survey.status} ke ${newStatus} tidak valid`, 400);
    }

    const updated = await prisma.survey.update({
      where: { id },
      data: { status: newStatus },
      include: { property: true },
    });

    await notifyAdminsForStatusChange(id, updated.property.name, newStatus);

    return ok({ survey: updated });
  });

  /**
   * DELETE /surveys/:id — admin saja, tanpa batasan status. Juga menghapus
   * file lampiran di R2.
   */
  fastify.delete('/surveys/:id', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request) => {
    const { id } = request.params as { id: string };

    const survey = await prisma.survey.findUnique({
      where: { id },
      include: { attachments: true, grade: true, responses: true, notifications: true },
    });

    if (!survey) throw new AppError('Survei tidak ditemukan', 404);

    // Hanya survei yang di-reject yang boleh dihapus (poin review file).
    if (survey.status !== 'REJECTED') {
      throw new AppError('Hanya survei berstatus REJECTED yang bisa dihapus', 400);
    }

    // Cleanup R2 files
    await cleanupSurveyR2Files(survey.attachments);

    // Delete in reverse dependency order. Bentuk batch array dikirim sebagai
    // SATU round-trip ke DB (bukan callback per-query), jadi aman dari error
    // P2028 "Transaction already closed" — tidak perlu timeout ekstra.
    await prisma.$transaction([
      prisma.notification.deleteMany({ where: { surveyId: id } }),
      prisma.surveyAttachment.deleteMany({ where: { surveyId: id } }),
      prisma.surveyResponse.deleteMany({ where: { surveyId: id } }),
      prisma.surveyAnswer.deleteMany({ where: { surveyId: id } }),
      prisma.riskGrade.deleteMany({ where: { surveyId: id } }),
      prisma.survey.delete({ where: { id } }),
      prisma.property.delete({ where: { id: survey.propertyId } }),
    ]);

    return ok({ message: 'Survei dan properti dihapus permanen' });
  });

  // --------------- Draft: isian form sementara surveyor ---------------
  // Payload wizard disimpan utuh sebagai JSON (belum ada Property/Survey yang
  // dibuat) sehingga surveyor bisa berhenti di tengah jalan dan melanjutkan
  // nanti. Masa berlaku 30 hari sejak simpan terakhir (geser tiap simpan) dan
  // dihapus lazily — tanpa cron — karena API berjalan serverless.

  const DRAFT_TTL_DAYS = 30;

  const draftBodySchema = z.object({
    // id opsional: ada → update draft itu (harus milik surveyor yang sama)
    id: z.string().min(1).max(64).optional(),
    // bentuk payload bebas — yang memahami strukturnya adalah wizard FE
    data: z.record(z.string(), z.unknown()),
  });

  function draftExpiry() {
    const d = new Date();
    d.setDate(d.getDate() + DRAFT_TTL_DAYS);
    return d;
  }

  /** Hapus draft kedaluwarsa milik surveyor (dipanggil sebelum list/simpan). */
  async function purgeExpiredDrafts(surveyorId: string) {
    await prisma.surveyDraft.deleteMany({
      where: { surveyorId, expiresAt: { lte: new Date() } },
    });
  }

  /**
   * GET /surveys/drafts — daftar draft aktif milik surveyor login.
   */
  fastify.get('/surveys/drafts', { preHandler: [authenticate()] }, async (request) => {
    const user = request.user!;
    await purgeExpiredDrafts(user.id);
    const drafts = await prisma.surveyDraft.findMany({
      where: { surveyorId: user.id },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, data: true, expiresAt: true, createdAt: true, updatedAt: true },
    });
    return ok({ drafts });
  });

  /**
   * GET /surveys/drafts/:id — isi satu draft (untuk melanjutkan mengisi).
   */
  fastify.get('/surveys/drafts/:id', { preHandler: [authenticate()] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    await purgeExpiredDrafts(user.id);
    const draft = await prisma.surveyDraft.findFirst({
      where: { id, surveyorId: user.id },
      select: { id: true, data: true, expiresAt: true, createdAt: true, updatedAt: true },
    });
    if (!draft) throw new AppError('Draft tidak ditemukan atau sudah kedaluwarsa', 404);
    return ok({ draft });
  });

  /**
   * POST /surveys/drafts — buat atau perbarui draft (upsert per surveyor+id).
   * Setiap simpan me-reset masa berlaku 30 hari sejak terakhir disimpan.
   */
  fastify.post('/surveys/drafts', { preHandler: [authenticate()] }, async (request, reply) => {
    const user = request.user!;
    const body = draftBodySchema.parse(request.body);
    await purgeExpiredDrafts(user.id);

    const data = body.data as Prisma.InputJsonValue;
    const expiresAt = draftExpiry();

    let draft;
    if (body.id) {
      // Hanya boleh menimpa draft milik sendiri — id asing diabaikan (buat baru).
      const owned = await prisma.surveyDraft.findFirst({
        where: { id: body.id, surveyorId: user.id },
        select: { id: true },
      });
      if (owned) {
        draft = await prisma.surveyDraft.update({
          where: { id: owned.id },
          data: { data, expiresAt },
          select: { id: true, data: true, expiresAt: true, createdAt: true, updatedAt: true },
        });
        return ok({ draft });
      }
    }

    draft = await prisma.surveyDraft.create({
      data: { surveyorId: user.id, data, expiresAt },
      select: { id: true, data: true, expiresAt: true, createdAt: true, updatedAt: true },
    });
    return reply.code(201).send(ok({ draft }));
  });

  /**
   * DELETE /surveys/drafts/:id — buang draft (mis. setelah survei berhasil dikirim).
   */
  fastify.delete('/surveys/drafts/:id', { preHandler: [authenticate()] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { count } = await prisma.surveyDraft.deleteMany({
      where: { id, surveyorId: user.id },
    });
    if (count === 0) throw new AppError('Draft tidak ditemukan', 404);
    return ok({ message: 'Draft dihapus' });
  });
}