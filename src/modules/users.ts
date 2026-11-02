import type { FastifyInstance } from 'fastify';
import { Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../plugins/prisma';
import { authenticate, requireRole } from '../plugins/auth';
import { ok, AppError } from '../lib/http';

// Pembaruan user oleh admin — semua field opsional; password dikirim hanya
// saat ganti password (min 6, sama dengan aturan register).
const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.nativeEnum(Role).optional(),
  password: z.string().min(6).optional(),
});

export async function userRoutes(fastify: FastifyInstance) {
  /**
   * GET /users — daftar semua user (admin saja), termasuk jumlah survei
   * sebagai `_count.surveys` (dilapiskan jadi `surveyCount`).
   */
  fastify.get('/users', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async () => {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        createdAt: true,
        _count: { select: { surveys: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return ok({
      users: users.map(({ _count, ...u }) => ({ ...u, surveyCount: _count.surveys })),
    });
  });

  /**
   * PATCH /users/:id — ubah nama / email / role / password (admin saja).
   * Pengaman: role admin terakhir tidak bisa diturunkan (mencegah dashboard
   * kehilangan akses admin selamanya); email unik dicek ulang di sini karena
   * jalur ini tidak lewat register.
   */
  fastify.patch('/users/:id', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = updateUserSchema.parse(request.body);

    const target = await prisma.user.findUnique({ where: { id } });
    if (!target) throw new AppError('User tidak ditemukan', 404);

    if (body.email && body.email !== target.email) {
      const exists = await prisma.user.findUnique({ where: { email: body.email } });
      if (exists) throw new AppError('Email sudah terdaftar', 409);
    }

    if (body.role && body.role !== target.role && target.role === Role.ADMIN) {
      const adminCount = await prisma.user.count({ where: { role: Role.ADMIN } });
      if (adminCount <= 1) {
        throw new AppError('Tidak bisa menurunkan role admin terakhir — buat admin lain dulu', 400);
      }
    }

    const data: { name?: string; email?: string; role?: Role; passwordHash?: string } = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.email !== undefined ? { email: body.email } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
      ...(body.password ? { passwordHash: await bcrypt.hash(body.password, 10) } : {}),
    };

    const user = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });

    return ok({ user });
  });

  /**
   * DELETE /users/:id — hapus user (admin saja).
   * Pengaman:
   *  - tidak bisa menghapus akun sendiri;
   *  - admin terakhir tidak bisa dihapus;
   *  - user yang masih punya survei ditolak — relasi Survey → Surveyor bersifat
   *    Restrict di DB (hapus paksa akan gagal FK), dan menghapusnya berarti
   *    membuang data survei miliknya.
   * Notifikasi & draft ikut terhapus otomatis (onDelete: Cascade di skema).
   */
  fastify.delete('/users/:id', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request) => {
    const { id } = request.params as { id: string };

    if (id === request.user!.id) {
      throw new AppError('Tidak bisa menghapus akun sendiri', 400);
    }

    const target = await prisma.user.findUnique({
      where: { id },
      include: { _count: { select: { surveys: true } } },
    });
    if (!target) throw new AppError('User tidak ditemukan', 404);

    if (target._count.surveys > 0) {
      throw new AppError(
        `User masih memiliki ${target._count.surveys} survei — hapus atau transfer surveinya dulu sebelum menghapus akun`,
        400,
      );
    }

    if (target.role === Role.ADMIN) {
      const adminCount = await prisma.user.count({ where: { role: Role.ADMIN } });
      if (adminCount <= 1) {
        throw new AppError('Tidak bisa menghapus admin terakhir', 400);
      }
    }

    await prisma.user.delete({ where: { id } });
    return ok({ message: 'User dihapus' });
  });
}
