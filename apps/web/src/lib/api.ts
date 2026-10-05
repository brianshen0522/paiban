import type { ErrorCode, ErrorDetails, SyncDoc, UserRef } from '@paiban/shared';

/** A failed request: the API's code and details, or NETWORK when the server could not be reached. */
export class ApiFailure extends Error {
  readonly code: ErrorCode | 'NETWORK';
  readonly status: number;
  readonly details: ErrorDetails | undefined;
  constructor(code: ErrorCode | 'NETWORK', status: number, message: string, details?: ErrorDetails) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Every request to our own server (D30: the page never contacts anyone else). Writes carry the
 * anti-CSRF header; the session is the HttpOnly cookie.
 */
export async function api<T>(method: Method, path: string, body?: unknown, init?: { keepalive?: boolean }): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Requested-With'] = 'paiban';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(init?.keepalive ? { keepalive: true } : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiFailure('NETWORK', 0, 'network error');
  }
  if (res.status === 204) return null as T;
  if (!res.ok) throw await failure(res, path);
  return (await res.json().catch(() => null)) as T;
}

async function failure(res: Response, path: string): Promise<ApiFailure> {
  const data: unknown = await res.json().catch(() => null);
  const err = (data as { error?: { code?: ErrorCode; message?: string; details?: ErrorDetails } } | null)?.error;
  if (res.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event('paiban:unauthenticated'));
  return new ApiFailure(err?.code ?? 'INTERNAL', res.status, err?.message ?? res.statusText, err?.details);
}

/** A file to our own server as multipart/form-data with one field, "file" (POST /api/torrents/:id/uploads). */
export async function upload<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'X-Requested-With': 'paiban' },
      credentials: 'same-origin',
      body: form,
    });
  } catch {
    throw new ApiFailure('NETWORK', 0, 'network error');
  }
  if (!res.ok) throw await failure(res, path);
  return (await res.json()) as T;
}

/** Binary GET (the waveform). */
export async function getBytes(path: string): Promise<ArrayBuffer> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin' });
  } catch {
    throw new ApiFailure('NETWORK', 0, 'network error');
  }
  if (!res.ok) throw await failure(res, path);
  return res.arrayBuffer();
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body);
export const put = <T>(path: string, body?: unknown) => api<T>('PUT', path, body);
export const patch = <T>(path: string, body?: unknown) => api<T>('PATCH', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

export function isSpaceError(
  e: unknown,
): e is ApiFailure & { details: { needBytes: number; freeBytes: number; shortBytes: number; previewBytes: number } } {
  return (
    e instanceof ApiFailure &&
    (e.code === 'STORAGE_LIMIT' || e.code === 'DISK_FULL') &&
    !!e.details &&
    'needBytes' in e.details
  );
}

/** VALIDATION / SETTING_INVALID / INVALID_FILENAME: the per-field codes. */
export function fieldCodes(e: unknown): Record<string, string> {
  return e instanceof ApiFailure && e.details && 'fields' in e.details ? e.details.fields : {};
}

export type Conflict = { rev: number; doc: SyncDoc; updatedBy: UserRef | null };

/** REVISION_CONFLICT: what is stored now. */
export function conflictOf(e: unknown): Conflict | null {
  return e instanceof ApiFailure && e.code === 'REVISION_CONFLICT' && e.details && 'rev' in e.details
    ? e.details
    : null;
}

/** CANDIDATE_UNAVAILABLE: why. */
export function candidateReason(e: unknown): string | null {
  return e instanceof ApiFailure && e.code === 'CANDIDATE_UNAVAILABLE' && e.details && 'reason' in e.details
    ? e.details.reason
    : null;
}

export const asFailure = (e: unknown): ApiFailure =>
  e instanceof ApiFailure ? e : new ApiFailure('INTERNAL', 500, e instanceof Error ? e.message : 'unexpected');
