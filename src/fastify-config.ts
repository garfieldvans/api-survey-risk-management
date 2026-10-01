import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from './types';

declare module 'fastify' {
  interface FastifyInstance {
    config: AuthConfig;
  }
}