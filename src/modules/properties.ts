import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../plugins/prisma';
import { authenticate } from '../plugins/auth';
import { ok, AppError } from '../lib/http';

const createSchema = z.object({
  name: z.string().min(1),
  address: z.string().min(1),
  ownerName: z.string().min(1),
  occupationId: z.string().min(1),
  extraData: z.record(z.unknown()).optional(),
});

export async function propertyRoutes(fastify: FastifyInstance) {
  fastify.get('/properties', { preHandler: [authenticate()] }, async (request) => {
    const query = request.query as Record<string, string | undefined>;
    const surveyorId = query.surveyorId ?? undefined;
    const occupationId = query.occupationId ?? undefined;

    const properties = await prisma.property.findMany({
      where: { occupationId, surveys: surveyorId ? { some: { surveyorId } } : undefined },
      include: {
        occupation: true,
        surveys: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: { createdAt: 'desc' },
    });

    return ok({ properties });
  });

  fastify.get('/properties/:id', { preHandler: [authenticate()] }, async (request) => {
    const { id } = request.params as { id: string };
    const property = await prisma.property.findUnique({
      where: { id },
      include: {
        occupation: { include: { parent: { include: { parent: true } } } },
        surveys: { include: { surveyor: true, grade: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!property) throw new AppError('Properti tidak ditemukan', 404);
    return ok({ property });
  });

  fastify.post('/properties', { preHandler: [authenticate()] }, async (request) => {
    const body = createSchema.parse(request.body);

    const occupation = await prisma.occupation.findUnique({
      where: { id: body.occupationId },
    });
    if (!occupation) throw new AppError('Okupasi tidak ditemukan', 400);
    if (occupation.level !== 3) {
      throw new AppError('Okupasi harus level 3 (paling spesifik)', 400);
    }

    const property = await prisma.property.create({
      data: {
        name: body.name,
        address: body.address,
        ownerName: body.ownerName,
        occupationId: body.occupationId,
        extraData: body.extraData as Prisma.InputJsonValue | undefined,
      },
    });

    return ok({ property });
  });
}