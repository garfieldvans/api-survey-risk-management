import type { FastifyInstance } from 'fastify';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../plugins/prisma';
import { authenticate, requireRole, assertSurveyAccess } from '../plugins/auth';
import { ok, AppError } from '../lib/http';
import { SURVEY_ITEM_CODES, SCORE_MIN, SCORE_MAX, categoryOfScore } from '../shared/index.js';

const gradeSchema = z.object({
  // 8 item scores — total & category are computed server-side from these.
  items: z.array(
    z.object({
      itemCode: z.enum(SURVEY_ITEM_CODES as [string, ...string[]]),
      score: z.number().int().min(SCORE_MIN).max(SCORE_MAX),
    }),
  ).min(8).max(8),
  notes: z.string().optional(),
});

export async function gradingRoutes(fastify: FastifyInstance) {
  fastify.get('/surveys/:id/grade', { preHandler: [authenticate()] }, async (request) => {
    const { id } = request.params as { id: string };

    const survey = await prisma.survey.findUnique({ where: { id }, select: { surveyorId: true } });
    if (!survey) throw new AppError('Survei tidak ditemukan', 404);
    assertSurveyAccess(request.user!, survey.surveyorId);

    const grade = await prisma.riskGrade.findUnique({
      where: { surveyId: id },
      include: { admin: { select: { id: true, name: true, email: true } } },
    });

    if (!grade) return ok({ grade: null });

    return ok({ grade });
  });

  fastify.post('/surveys/:id/grade', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = gradeSchema.parse(request.body);

    const survey = await prisma.survey.findUnique({ where: { id } });
    if (!survey) throw new AppError('Survei tidak ditemukan', 404);
    if (survey.status !== 'GRADING') {
      throw new AppError(`Survei harus dalam status GRADING untuk diberi grade (status: ${survey.status})`, 400);
    }

    // All 8 items must exist; compute total & category authoritative from scores
    const dbItems = await prisma.surveyItem.findMany();
    const dbItemMap = new Map(dbItems.map((i) => [i.code, i.id]));
    const missing = body.items.filter((r) => !dbItemMap.get(r.itemCode));
    if (missing.length) {
      throw new AppError(`Item codes tidak valid: ${missing.map((r) => r.itemCode).join(', ')}`, 400);
    }

    const totalScore = body.items.reduce((sum, r) => sum + r.score, 0);
    const category = categoryOfScore(totalScore);

    // Upsert 8 SurveyResponse rows + RiskGrade, move status to DONE in one
    // transaction. Timeout dinaikkan: di serverless + Neon, per-query latency
    // tinggi membuat default 5s Prisma sering expired (error P2028 → 500).
    const grade = await prisma.$transaction(async (tx) => {
      await tx.surveyResponse.deleteMany({ where: { surveyId: id } });
      await tx.surveyResponse.createMany({
        data: body.items.map((r) => ({
          surveyId: id,
          itemId: dbItemMap.get(r.itemCode)!,
          score: r.score,
        })),
      });

      await tx.survey.update({
        where: { id },
        data: { status: 'DONE' },
      });

      return tx.riskGrade.upsert({
        where: { surveyId: id },
        update: {
          adminId: user.id,
          totalScore,
          category: category as any,
          notes: body.notes,
          gradedAt: new Date(),
        },
        create: {
          surveyId: id,
          adminId: user.id,
          totalScore,
          category: category as any,
          notes: body.notes,
        },
      });
    }, { timeout: 15000, maxWait: 10000 });

    return ok({ grade });
  });
}