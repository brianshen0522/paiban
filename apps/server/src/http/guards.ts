import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { AuthedUser } from './context.js';
import { ApiError } from './errors.js';

export function requireUser(req: FastifyRequest): AuthedUser {
  if (!req.user) throw new ApiError('UNAUTHENTICATED', 'sign in first');
  return req.user;
}

export function requireAdmin(req: FastifyRequest): AuthedUser {
  const user = requireUser(req);
  if (user.role !== 'admin') throw new ApiError('FORBIDDEN', 'administrators only');
  return user;
}

/** Parses with zod; failures become 422 VALIDATION with a code per field. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const fields: Record<string, string> = {};
  for (const issue of r.error.issues) {
    const key = issue.path.join('.') || '_';
    fields[key] ??= issue.code.toUpperCase();
  }
  throw new ApiError('VALIDATION', 'request does not match the schema', { fields });
}
