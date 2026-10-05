import type { ErrorCode, ErrorDetails } from '@paiban/shared';

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
export async function api<T>(method: Method, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Requested-With'] = 'paiban';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiFailure('NETWORK', 0, 'network error');
  }
  if (res.status === 204) return null as T;
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: { code?: ErrorCode; message?: string; details?: ErrorDetails } } | null)?.error;
    if (res.status === 401 && path !== '/api/auth/login') window.dispatchEvent(new Event('paiban:unauthenticated'));
    throw new ApiFailure(err?.code ?? 'INTERNAL', res.status, err?.message ?? res.statusText, err?.details);
  }
  return data as T;
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
