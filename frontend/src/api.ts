import type { ApiErrorBody } from '@kachnadocs/shared';

const TOKEN_KEY = 'kachnadocs.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * One place that attaches the bearer token and unwraps our uniform error body,
 * so a view never has to remember either. Relative `/api` keeps the dev proxy in
 * play and avoids a second origin in production.
 */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const res = await fetch(`/api${path}`, { ...init, headers });

  if (res.ok) return (await res.json()) as T;

  // Denial and absence both arrive as 404 with the same body (PLAN §3); the UI
  // must not infer from the status alone whether a resource exists.
  let code = 'internal';
  let message = res.statusText;
  try {
    const body = (await res.json()) as ApiErrorBody;
    code = body.error.code;
    message = body.error.message;
  } catch {
    // Non-JSON error page (proxy down, gateway): keep statusText.
  }
  throw new ApiError(res.status, code, message);
}
