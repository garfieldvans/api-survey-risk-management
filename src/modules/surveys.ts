import type { FastifyInstance } from 'fastify';
import { Prisma, SurveyStatus, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../plugins/prisma';
import { authenticate, requireRole } from '../plugins/auth';
import { ok, AppError } from '../lib/http';
import { notifyAdmins, notifyAdminsForStatusChange } from './notifications-helpers';
import { getQuestionIdsForOccupation } from './questions';
import { deleteObject } from '../plugins/storage';
import { computeGradeScores, GRADE_ITEM_CODES } from '../shared/index.js';

// --------------- Zod schemas ---------------

const answerSchema = z.object({
  questionId: z.string().min(1),
  value: z.string().max(5000),
});

// Payload grading dari wizard surveyor (port reff.html) — skor dihitung server-side
// via computeGradeScores agar authoritative.
const gradeInputsSchema = z.object({
  mChecklist: z.array(z.enum(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'])),
  mKlaim: z.enum(['0', '1-2', '3+']),
  mImprovement: z.enum(['yes', 'no']),
  mRekomendasi: z.enum(['yes', 'no']),
  cKelas: z.enum(['8', '6', '4', '2']),
  cSandwich: z.enum(['yes', 'no']),
  cAcp: z.enum(['yes', 'no']),
  oHazard: z.enum(['8', '6a', '6b', '4a', '4b', '4c']),
  pApar: z.enum(['good', 'avg', 'none']),
  pHidran: z.enum(['good', 'avg', 'none']),
  pDetektor: z.enum(['good', 'avg', 'none']),
  pSprinkler: z.enum(['good', 'avg', 'none']),
  pDamkar: z.enum(['8', '6', '4', '2']),
  exKondisi: z.enum(['4', '3', '2', '1']),
  nhGempa: z.enum(['avg', 'marg']),
  nhTsunami: z.enum(['avg', 'marg']),
  nhPetir: z.enum(['avg_low', 'avg_high', 'marg']),
  nhBanjir: z.enum(['avg', 'marg']),
  nhLongsor: z.enum(['avg', 'marg']),
  nhHistory: z.enum(['none', 'improved', 'none_improved']),
  leMfl: z.enum(['7', '7b', '5', '3']),
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
    occupationId: z.string().min(1),
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
});

const TRANSITIONS: Record<SurveyStatus, SurveyStatus[]> = {
  ONBOARD: ['REVIEW'],
  REVIEW: ['GRADING', 'CLOSED', 'REJECTED'],
  GRADING: ['DONE', 'CLOSED', 'REJECTED'],
  DONE: ['CLOSED'],
  CLOSED: [],
  REJECTED: [],
};

const CLOSE_STATUSES: SurveyStatus[] = ['CLOSED', 'REJECTED'];

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
  occupationId: string,
) {
  const allowedIds = new Set(await getQuestionIdsForOccupation(occupationId));
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
    return ok({ survey: await getSurveyOrThrow(id) });
  });

  /**
   * POST /surveys — create property + survey + answers atomically.
   */
  fastify.post('/surveys', { preHandler: [authenticate()] }, async (request, reply) => {
    const user = request.user!;
    const body = createSurveySchema.parse(request.body);

    const occupation = await prisma.occupation.findUnique({
      where: { id: body.property.occupationId },
      include: { children: { take: 1 } },
    });
    if (!occupation) throw new AppError('Okupasi tidak ditemukan', 400);
    if (occupation.children.length > 0) throw new AppError('Okupasi harus node daun (tanpa anak)', 400);

    await validateAnswers(body.answers, occupation.id);

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
          occupationId: body.property.occupationId,
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
          data: GRADE_ITEM_CODES.map((code) => ({
            surveyId: s.id,
            itemId: itemByCode!.get(code)!,
            score: gradeResult.scores[code],
            notes: notesMap[code as keyof typeof notesMap] ?? null,
          })),
        });

        // adminId null = grading otomatis dari surveyor; admin dapat override
        // lewat POST /surveys/:id/grade pada tahap GRADING.
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
   * DELETE /surveys/:id — only when status is CLOSED or REJECTED. Also deletes R2 files.
   */
  fastify.delete('/surveys/:id', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request) => {
    const { id } = request.params as { id: string };

    const survey = await prisma.survey.findUnique({
      where: { id },
      include: { attachments: true, grade: true, responses: true, notifications: true },
    });

    if (!survey) throw new AppError('Survei tidak ditemukan', 404);
    if (!CLOSE_STATUSES.includes(survey.status)) {
      throw new AppError(`Hanya survei CLOSED atau REJECTED yang bisa dihapus (status: ${survey.status})`, 400);
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
}