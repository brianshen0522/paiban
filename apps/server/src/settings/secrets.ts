import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { SecretName } from '@paiban/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { one, tx } from '../db/pool.js';
import type { Deps } from '../http/context.js';
import { ApiError } from '../http/errors.js';
import { parse, requireAdmin } from '../http/guards.js';

/**
 * The three keys an administrator types in (docs/12-auth.md, "Keys"; docs/13-settings.md, "Keys"):
 * AES-256-GCM with a key derived from SECRET_KEY, a random 12-byte nonce per value, the name as
 * associated data so a value cannot be moved to another name. Only the api has SECRET_KEY. The
 * API says whether a key is set and never what it is; values never reach a log.
 */
export const SECRET_NAMES = ['tmdbKey', 'subdlKey', 'assrtToken'] as const satisfies readonly SecretName[];

function keyFrom(secretKey: string): Buffer {
  if (!secretKey) throw new ApiError('INTERNAL', 'SECRET_KEY is not set');
  return Buffer.from(hkdfSync('sha256', secretKey, 'paiban', 'paiban secrets v1', 32));
}

/**
 * nonce and ciphertext (with the 16-byte tag at the end), as stored. `name` is the associated
 * data: a secret's name, or `llm:<profile id>` for a language-model profile's key (docs/18-llm.md).
 */
export function sealSecret(secretKey: string, name: string, value: string): { nonce: Buffer; ciphertext: Buffer } {
  const nonce = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(secretKey), nonce);
  c.setAAD(Buffer.from(name));
  const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
  return { nonce, ciphertext: Buffer.concat([body, c.getAuthTag()]) };
}

export function openSecret(secretKey: string, name: string, nonce: Buffer, ciphertext: Buffer): string {
  const d = createDecipheriv('aes-256-gcm', keyFrom(secretKey), nonce);
  d.setAAD(Buffer.from(name));
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([d.update(ciphertext.subarray(0, ciphertext.length - 16)), d.final()]).toString('utf8');
}

/**
 * The value of a key, or null when it is not set. A value that cannot be opened (SECRET_KEY was
 * changed) also reads as not set; the administrator enters it again.
 */
export async function readSecret(
  deps: Pick<Deps, 'pool' | 'config' | 'log'>,
  name: SecretName,
): Promise<string | null> {
  const row = await one<{ nonce: Buffer; ciphertext: Buffer }>(
    deps.pool,
    'select nonce, ciphertext from secrets where name = $1',
    [name],
  );
  if (!row) return null;
  try {
    return openSecret(deps.config.secretKey, name, row.nonce, row.ciphertext);
  } catch {
    deps.log.warn({ name }, 'a stored key cannot be decrypted with this SECRET_KEY; treating it as not set');
    return null;
  }
}

const NameParams = z.object({ name: z.enum(SECRET_NAMES) });
const ValueBody = z.object({ value: z.string().trim().min(1).max(4096) });

export function secretRoutes(app: FastifyInstance, deps: Deps): void {
  app.put('/api/admin/secrets/:name', async (req, reply) => {
    const user = requireAdmin(req);
    const { name } = parse(NameParams, req.params);
    const { value } = parse(ValueBody, req.body);
    const sealed = sealSecret(deps.config.secretKey, name, value);
    await tx(deps.pool, async (c) => {
      await c.query(
        `insert into secrets (name, nonce, ciphertext, updated_by, updated_at) values ($1, $2, $3, $4, now())
         on conflict (name) do update set nonce = excluded.nonce, ciphertext = excluded.ciphertext,
           updated_by = excluded.updated_by, updated_at = now()`,
        [name, sealed.nonce, sealed.ciphertext, user.id],
      );
      await audit(c, user, 'admin.secret.set', { name }, req.ip);
    });
    deps.events.toAdmins({ type: 'admin', what: 'settings' });
    return reply.status(204).send();
  });

  app.delete('/api/admin/secrets/:name', async (req, reply) => {
    const user = requireAdmin(req);
    const { name } = parse(NameParams, req.params);
    await tx(deps.pool, async (c) => {
      const r = await c.query('delete from secrets where name = $1', [name]);
      if (r.rowCount) await audit(c, user, 'admin.secret.clear', { name }, req.ip);
    });
    deps.events.toAdmins({ type: 'admin', what: 'settings' });
    return reply.status(204).send();
  });
}
