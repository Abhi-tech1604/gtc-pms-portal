/** Thin API client. The token is kept in localStorage so the session survives a reload. */

const TOKEN_KEY = 'pms.token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown, isForm = false): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
  });

  if (res.status === 401) {
    setToken(null);
    if (!location.pathname.startsWith('/login')) location.assign('/login');
  }

  // A 403 means the server just enforced a permission this session's local
  // copy (lib/auth.tsx's `user` object) hasn't caught up with yet — e.g. an
  // Admin revoked it mid-session. Broadcasting lets AuthProvider re-pull
  // /auth/me immediately, so the UI (buttons, sidebar, route guards) falls
  // in line with what the server just enforced, without the user having to
  // navigate or reload. The error itself still propagates below as normal.
  if (res.status === 403) {
    window.dispatchEvent(new Event('pms:permission-denied'));
  }

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const message = (data as { error?: string })?.error || `Request failed (${res.status}).`;
    throw new ApiError(res.status, message, (data as { details?: unknown })?.details);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 300) }; }
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
  form: <T>(path: string, form: FormData) => request<T>('POST', path, form, true),
};

/** Triggers a browser download for an authenticated endpoint. */
export async function download(path: string, fallbackName: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, safeMessage(text, res.status), null);
  }
  const blob = await res.blob();
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = disposition.match(/filename="?([^"]+)"?/);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = match ? match[1] : fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function safeMessage(text: string, status: number): string {
  try { return (JSON.parse(text) as { error?: string }).error ?? `Download failed (${status}).`; }
  catch { return `Download failed (${status}).`; }
}
