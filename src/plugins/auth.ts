import type { FastifyReply, FastifyRequest } from 'fastify';
import { Role } from '@prisma/client';
import type { AuthUser } from '../types';
import { AppError } from '../lib/http';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthUser;
    user: AuthUser;
  }
}

export function authenticate(): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
  };
}

export function requireRole(...roles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user || !roles.includes(request.user.role)) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
  };
}

/**
 * Otorisasi tingkat survey: admin boleh mengakses semua, surveyor hanya
 * survey miliknya sendiri. Lemparkan 403 kalau tidak berhak.
 */
export function assertSurveyAccess(user: AuthUser, surveyorId: string): void {
  if (user.role === Role.ADMIN) return;
  if (user.id !== surveyorId) {
    throw new AppError('Anda tidak memiliki akses ke survei ini', 403);
  }
}