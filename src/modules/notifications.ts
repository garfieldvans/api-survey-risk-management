import type { FastifyInstance } from 'fastify';
import { Role } from '@prisma/client';
import { prisma } from '../plugins/prisma';
import { authenticate } from '../plugins/auth';
import { ok, AppError } from '../lib/http';

export async function notificationRoutes(fastify: FastifyInstance) {
  /**
   * GET /notifications — poll endpoint. ?unread=true → only unread.
   */
  fastify.get('/notifications', { preHandler: [authenticate()] }, async (request) => {
    const user = request.user!;
    const query = request.query as Record<string, string | undefined>;
    const unreadOnly = query.unread === 'true';

    const notifications = await prisma.notification.findMany({
      where: {
        userId: user.id,
        ...(unreadOnly ? { readAt: null } : {}),
      },
      include: { survey: { include: { property: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return ok({ notifications });
  });

  /**
   * POST /notifications/:id/read — mark one as read.
   */
  fastify.post('/notifications/:id/read', { preHandler: [authenticate()] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const notif = await prisma.notification.findUnique({ where: { id } });
    if (!notif) throw new AppError('Notifikasi tidak ditemukan', 404);
    if (notif.userId !== user.id) throw new AppError('Forbidden', 403);

    const updated = await prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });

    return ok({ notification: updated });
  });

  /**
   * POST /notifications/read-all — mark all unread as read.
   */
  fastify.post('/notifications/read-all', { preHandler: [authenticate()] }, async (request) => {
    const user = request.user!;
    const result = await prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: { readAt: new Date() },
    });

    return ok({ updated: result.count });
  });
}