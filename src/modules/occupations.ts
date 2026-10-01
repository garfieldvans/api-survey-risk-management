import type { FastifyInstance } from 'fastify';
import { Role } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../plugins/prisma';
import { authenticate, requireRole } from '../plugins/auth';
import { ok, AppError } from '../lib/http';

const createSchema = z.object({
  code: z.string().min(1),
  name: z.string().min(1),
  level: z.number().int().min(1).max(3),
  parentCode: z.string().optional(),
  parentLevel: z.number().int().min(1).max(2).optional(),
});

const updateSchema = createSchema.partial();

export async function occupationRoutes(fastify: FastifyInstance) {
  fastify.get('/occupations', { preHandler: [authenticate()] }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const level = query.level ? Number(query.level) : undefined;
    const parentId = query.parentId ?? undefined;

    const occupations = await prisma.occupation.findMany({
      where: { level, parentId },
      orderBy: [{ level: 'asc' }, { code: 'asc' }],
    });

    return ok({ occupations });
  });

  fastify.get('/occupations/:id', { preHandler: [authenticate()] }, async (request) => {
    const { id } = request.params as { id: string };
    const occupation = await prisma.occupation.findUnique({
      where: { id },
      include: {
        parent: true,
        children: { include: { children: true }, orderBy: { code: 'asc' } },
      },
    });
    if (!occupation) throw new AppError('Okupasi tidak ditemukan', 404);
    return ok({ occupation });
  });

  fastify.post('/occupations', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request) => {
    const body = createSchema.parse(request.body);

    const existing = await prisma.occupation.findUnique({
      where: { code_level: { code: body.code, level: body.level } },
    });
    if (existing) throw new AppError(`Kode ${body.code} sudah ada di level ${body.level}`, 409);

    let parentId: string | undefined;
    if (body.parentCode) {
      if (!body.parentLevel) throw new AppError('parentLevel wajib diisi bersama parentCode', 400);
      const parent = await prisma.occupation.findUnique({
        where: { code_level: { code: body.parentCode, level: body.parentLevel } },
      });
      if (!parent) throw new AppError('Parent okupasi tidak ditemukan', 400);
      parentId = parent.id;
    }

    const occupation = await prisma.occupation.create({
      data: { code: body.code, name: body.name, level: body.level, parentId },
    });

    return ok({ occupation });
  });

  fastify.patch('/occupations/:id', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateSchema.parse(request.body);

    const existing = await prisma.occupation.findUnique({ where: { id } });
    if (!existing) throw new AppError('Okupasi tidak ditemukan', 404);

    if (body.level !== undefined && body.level < existing.level) {
      throw new AppError('Tidak bisa menurunkan level okupasi yang sudah punya children', 400);
    }

    let parentId: string | undefined;
    if (body.parentCode) {
      if (!body.parentLevel) throw new AppError('parentLevel wajib diisi bersama parentCode', 400);
      if (body.level !== undefined && body.parentLevel >= body.level) {
        throw new AppError('Parent harus berada di level di atas okupasi ini', 400);
      }
      const parent = await prisma.occupation.findUnique({
        where: { code_level: { code: body.parentCode, level: body.parentLevel } },
      });
      if (!parent) throw new AppError('Parent okupasi tidak ditemukan', 400);
      parentId = parent.id;
    }

    const occupation = await prisma.occupation.update({
      where: { id },
      data: {
        code: body.code,
        name: body.name,
        level: body.level,
        ...(body.parentCode ? { parentId } : {}),
      },
    });

    return ok({ occupation });
  });

  fastify.delete('/occupations/:id', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request) => {
    const { id } = request.params as { id: string };

    const [children, propertyCount, questionCount] = await Promise.all([
      prisma.occupation.count({ where: { parentId: id } }),
      prisma.property.count({ where: { occupationId: id } }),
      prisma.question.count({ where: { occupationId: id } }),
    ]);
    if (children > 0) throw new AppError('Okupasi masih punya anak, tidak bisa dihapus', 409);
    if (propertyCount > 0) throw new AppError('Okupasi sedang dipakai oleh properti, tidak bisa dihapus', 409);
    if (questionCount > 0) throw new AppError('Okupasi dipakai oleh pertanyaan, tidak bisa dihapus', 409);

    await prisma.occupation.delete({ where: { id } });
    return ok({ message: 'Okupasi dihapus' });
  });
}