import type { FastifyInstance } from 'fastify';
import { Role, SurveyStatus } from '@prisma/client';
import { prisma } from '../plugins/prisma';
import { authenticate, requireRole } from '../plugins/auth';
import { ok } from '../lib/http';
import { SURVEY_STATUSES } from '../shared/index.js';

export async function statsRoutes(fastify: FastifyInstance) {
  fastify.get('/stats', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async () => {
    const [grouped, totalSurveys, totalProperties, surveys] = await Promise.all([
      prisma.survey.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.survey.count(),
      prisma.property.count(),
      // Untuk agregat per properti: ambil semua survey terurut terbaru dulu,
      // lalu ambil survey terbaru per properti (memiliki grade atau tidak).
      prisma.survey.findMany({
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          propertyId: true,
          property: { select: { name: true } },
          grade: { select: { totalScore: true, category: true } },
        },
      }),
    ]);

    const statusCounts = grouped.reduce<Record<string, number>>((acc, g) => {
      acc[g.status] = g._count._all;
      return acc;
    }, {});

    const byStatus = SURVEY_STATUSES.map((s) => ({
      status: s as SurveyStatus,
      count: statusCounts[s] ?? 0,
    }));

    // Latest survey per property → dasar distribusi risk & ranking
    const latestPerProperty = new Map<string, (typeof surveys)[number]>();
    for (const s of surveys) {
      if (!latestPerProperty.has(s.propertyId)) latestPerProperty.set(s.propertyId, s);
    }
    const graded = [...latestPerProperty.values()].filter((s) => s.grade);

    const distribution = { GOOD: 0, AVERAGE: 0, MARGINAL: 0, POOR: 0 };
    for (const s of graded) distribution[s.grade!.category]++;

    const highRisk = distribution.MARGINAL + distribution.POOR;
    const avgScore = graded.length
      ? Math.round(graded.reduce((sum, s) => sum + s.grade!.totalScore, 0) / graded.length)
      : null;

    // Top risk = skor terendah dulu (semakin kecil semakin berisiko)
    const rankings = graded
      .slice()
      .sort((a, b) => a.grade!.totalScore - b.grade!.totalScore)
      .slice(0, 5)
      .map((s) => ({
        surveyId: s.id,
        propertyId: s.propertyId,
        name: s.property.name,
        score: s.grade!.totalScore,
        category: s.grade!.category,
        status: s.status,
      }));

    return ok({
      stats: {
        byStatus,
        totalSurveys,
        totalProperties,
        highRisk,
        avgScore,
        critical: distribution.POOR,
        distribution,
        rankings,
      },
    });
  });
}