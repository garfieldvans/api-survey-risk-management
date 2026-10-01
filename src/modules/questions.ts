import type { FastifyInstance } from 'fastify';
import { AnswerType, Prisma, Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../plugins/prisma';
import { authenticate, requireRole } from '../plugins/auth';
import { ok, AppError } from '../lib/http';

// --------------- Zod schemas ---------------

const questionSchema = z.object({
  text: z.string().min(1).max(500),
  answerType: z.nativeEnum(AnswerType),
  options: z.array(z.string().min(1).max(200)).max(50).default([]),
  section: z.string().min(1),
  order: z.number().int().default(0),
  required: z.boolean().default(false),
  occupationId: z.string().optional(),
});

const questionUpdateSchema = questionSchema.partial();

// --------------- Helpers ---------------

/** Walk the parent chain of an occupation and return its own + all ancestor ids. */
export async function getOccupationAncestorIds(occupationId: string): Promise<string[]> {
  const ids: string[] = [];
  let current: { id: string; parentId: string | null } | null = await prisma.occupation.findUnique({
    where: { id: occupationId },
    select: { id: true, parentId: true },
  });
  let guard = 0;
  while (current && guard < 10) {
    ids.push(current.id);
    if (!current.parentId) break;
    current = await prisma.occupation.findUnique({
      where: { id: current.parentId },
      select: { id: true, parentId: true },
    });
    guard++;
  }
  return ids;
}

/** Question ids applicable to an occupation: core + questions on the ancestor path. */
export async function getQuestionIdsForOccupation(occupationId: string): Promise<string[]> {
  const ancestorIds = await getOccupationAncestorIds(occupationId);
  const questions = await prisma.question.findMany({
    where: {
      OR: [{ occupationId: { in: ancestorIds } }, { occupationId: null }],
    },
    select: { id: true },
  });
  return questions.map((q) => q.id);
}

/** Kumpulan id okupasi: node itu sendiri + seluruh keturunannya (BFS). */
async function getOccupationWithDescendantIds(occupationId: string): Promise<string[]> {
  const all = await prisma.occupation.findMany({ select: { id: true, parentId: true } });
  const childrenMap = new Map<string, string[]>();
  for (const o of all) {
    if (!o.parentId) continue;
    const list = childrenMap.get(o.parentId) ?? [];
    list.push(o.id);
    childrenMap.set(o.parentId, list);
  }
  const ids: string[] = [occupationId];
  const queue = [occupationId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childrenMap.get(current) ?? []) {
      ids.push(child);
      queue.push(child);
    }
  }
  return ids;
}

// --------------- Routes ---------------

export async function questionRoutes(fastify: FastifyInstance) {
  /**
   * GET /questions — two modes:
   *  - surveyor wizard: ?occupationId= → core questions + ancestor-path questions
   *  - admin master data: no occupationId → all questions, optional ?core=true / ?occupationId= filter
   */
  fastify.get('/questions', { preHandler: [authenticate()] }, async (request) => {
    const { occupationId, core, scope } = request.query as {
      occupationId?: string;
      core?: string;
      scope?: string;
    };

    if (occupationId && scope !== 'admin') {
      // Wizard path — any authenticated user can fetch for a chosen occupation
      const ancestorIds = await getOccupationAncestorIds(occupationId);
      const questions = await prisma.question.findMany({
        where: { OR: [{ occupationId: { in: ancestorIds } }, { occupationId: null }] },
        orderBy: [{ section: 'asc' }, { order: 'asc' }],
      });
      return ok({ questions, ancestorIds });
    }

    // Admin master-data path
    if (request.user!.role !== Role.ADMIN) throw new AppError('Akses terbatas untuk admin', 403);

    const where: Prisma.QuestionWhereInput = {};
    if (core === 'true') where.occupationId = null;
    else if (occupationId) {
      // Sertakan pertanyaan yang menempel di okupasi ini DAN semua turunannya,
      // supaya filter di level atas (mis. "29 Transport and traffic") tetap
      // menampilkan pertanyaan yang ditempel di node anak/cucu.
      const ids = await getOccupationWithDescendantIds(occupationId);
      where.occupationId = { in: ids };
    }

    const questions = await prisma.question.findMany({
      where,
      include: { occupation: { select: { id: true, code: true, name: true, level: true } } },
      orderBy: [{ section: 'asc' }, { order: 'asc' }],
    });

    return ok({ questions });
  });

  /**
   * POST /questions — create.
   */
  fastify.post('/questions', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request, reply) => {
    const body = questionSchema.parse(request.body);

    if (body.occupationId) {
      const occ = await prisma.occupation.findUnique({ where: { id: body.occupationId } });
      if (!occ) throw new AppError('Okupasi tidak ditemukan', 400);
    }

    const question = await prisma.question.create({
      data: {
        text: body.text,
        answerType: body.answerType,
        options: body.options,
        section: body.section,
        order: body.order,
        required: body.required,
        occupationId: body.occupationId ?? null,
      },
    });

    return reply.code(201).send(ok({ question }));
  });

  /**
   * PATCH /questions/:id — update.
   */
  fastify.patch('/questions/:id', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = questionUpdateSchema.parse(request.body);

    const existing = await prisma.question.findUnique({ where: { id } });
    if (!existing) throw new AppError('Pertanyaan tidak ditemukan', 404);

    if (body.occupationId !== undefined) {
      const occ = await prisma.occupation.findUnique({ where: { id: body.occupationId } });
      if (!occ) throw new AppError('Okupasi tidak ditemukan', 400);
    }

    const question = await prisma.question.update({
      where: { id },
      data: {
        text: body.text,
        answerType: body.answerType,
        options: body.options === undefined ? undefined : body.options,
        section: body.section,
        order: body.order,
        required: body.required,
        occupationId: body.occupationId === undefined ? undefined : body.occupationId ?? null,
      },
    });

    return ok({ question });
  });

  /**
   * DELETE /questions/:id — blocked if the question already has answers.
   */
  fastify.delete('/questions/:id', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request) => {
    const { id } = request.params as { id: string };

    const existing = await prisma.question.findUnique({ where: { id } });
    if (!existing) throw new AppError('Pertanyaan tidak ditemukan', 404);

    const answerCount = await prisma.surveyAnswer.count({ where: { questionId: id } });
    if (answerCount > 0) {
      throw new AppError('Pertanyaan sudah digunakan dalam survei dan tidak bisa dihapus', 400);
    }

    await prisma.question.delete({ where: { id } });
    return ok({ message: 'Pertanyaan dihapus' });
  });
}