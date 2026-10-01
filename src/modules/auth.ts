import type { FastifyInstance } from 'fastify';
import { Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../plugins/prisma';
import { authenticate, requireRole } from '../plugins/auth';
import { ok, AppError } from '../lib/http';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  name: z.string().min(1),
  role: z.nativeEnum(Role).optional(),
});

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/auth/login', async (request, reply) => {
    const body = loginSchema.parse(request.body);

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      throw new AppError('Email atau password salah', 401);
    }

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) {
      throw new AppError('Email atau password salah', 401);
    }

    const token = fastify.jwt.sign({
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    });

    reply.setCookie(fastify.config.jwtCookieName, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 7 days
    });

    return ok({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  });

  fastify.post('/auth/register', { preHandler: [authenticate(), requireRole(Role.ADMIN)] }, async (request, _reply) => {
    const body = registerSchema.parse(request.body);

    const exists = await prisma.user.findUnique({ where: { email: body.email } });
    if (exists) {
      throw new AppError('Email sudah terdaftar', 409);
    }

    const passwordHash = await bcrypt.hash(body.password, 10);
    const role = body.role ?? Role.SURVEYOR;

    const user = await prisma.user.create({
      data: { email: body.email, passwordHash, name: body.name, role },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });

    return ok({ user });
  });

  fastify.post('/auth/logout', async (_request, reply) => {
    reply.clearCookie(fastify.config.jwtCookieName, { path: '/' });
    return ok({ message: 'Logged out' });
  });

  fastify.get('/auth/me', { preHandler: [authenticate()] }, async (request) => {
    const { id } = request.user!;
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) throw new AppError('User tidak ditemukan', 404);

    return ok({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    });
  });
}