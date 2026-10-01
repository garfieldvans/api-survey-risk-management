import type { FastifyInstance } from 'fastify';
import { prisma } from '../plugins/prisma';
import { authenticate, assertSurveyAccess } from '../plugins/auth';
import { ok, AppError } from '../lib/http';
import { categoryOfScore, GRADES_LABEL_MAP } from './report-shared';

export async function reportRoutes(fastify: FastifyInstance) {
  /**
   * GET /reports/:surveyId — structured payload for the printable report.
   */
  fastify.get('/reports/:surveyId', { preHandler: [authenticate()] }, async (request) => {
    const { surveyId } = request.params as { surveyId: string };

    const survey = await prisma.survey.findUnique({
      where: { id: surveyId },
      include: {
        property: { include: { occupation: { include: { parent: { include: { parent: true } } } } } },
        surveyor: true,
        responses: { include: { item: true }, orderBy: { item: { order: 'asc' } } },
        answers: { include: { question: true } },
        attachments: true,
        grade: { include: { admin: true } },
      },
    });

    if (!survey) throw new AppError('Survei tidak ditemukan', 404);
    assertSurveyAccess(request.user!, survey.surveyorId);

    // Group answers by section, preserving question order
    const answersBySection: Record<string, Array<{ question: string; answerType: string; value: string }>> = {};
    for (const a of survey.answers.sort((x, y) => x.question.order - y.question.order)) {
      (answersBySection[a.question.section] ??= []).push({
        question: a.question.text,
        answerType: a.question.answerType,
        value: a.value,
      });
    }

    const totalScore = survey.responses.reduce((sum, r) => sum + r.score, 0);
    const category = survey.grade?.category ?? categoryOfScore(totalScore);
    const gradeBelumDinasilkan = !survey.grade;

    const report = {
      id: survey.id,
      status: survey.status,
      surveyDate: survey.surveyDate,
      notes: survey.notes,
      createdAt: survey.createdAt,
      property: {
        name: survey.property.name,
        address: survey.property.address,
        ownerName: survey.property.ownerName,
        extraData: survey.property.extraData,
        occupation: {
          code: survey.property.occupation.code,
          name: survey.property.occupation.name,
          level1: survey.property.occupation.parent?.parent?.name
            ? `${survey.property.occupation.parent.parent.name} (${survey.property.occupation.parent.parent.code})`
            : null,
          level2: survey.property.occupation.parent?.name
            ? `${survey.property.occupation.parent.name} (${survey.property.occupation.parent.code})`
            : null,
          level3: `${survey.property.occupation.name} (${survey.property.occupation.code})`,
        },
      },
      surveyor: {
        name: survey.surveyor.name,
        email: survey.surveyor.email,
      },
      answers: Object.entries(answersBySection).map(([section, list]) => ({ section, items: list })),
      items: survey.responses.map((r) => ({
        code: r.item.code,
        name: r.item.name,
        order: r.item.order,
        score: r.score,
        notes: r.notes,
      })),
      attachments: survey.attachments.map((a) => ({
        fileName: a.fileName,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        kind: a.kind,
      })),
      grading: survey.grade
        ? {
            gradeBelumDinasilkan: false,
            totalScore: survey.grade.totalScore,
            category: survey.grade.category,
            categoryLabel: GRADES_LABEL_MAP[survey.grade.category],
            notes: survey.grade.notes,
            // null = grading otomatis dari surveyor (belum di-override admin)
            adminName: survey.grade.admin?.name ?? null,
            gradedAt: survey.grade.gradedAt,
            recommendedCategory: category, // what the threshold says, for transparency
          }
        : {
            gradeBelumDinasilkan: true,
            totalScore: null,
            category: null,
            categoryLabel: null,
            notes: null,
            adminName: null,
            gradedAt: null,
            recommendedCategory: null,
          },
    };

    return ok({ report });
  });
}