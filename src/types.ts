import type { Role } from '@prisma/client';
import type { config } from './config';

export type AuthConfig = typeof config;

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}