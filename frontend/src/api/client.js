// Central fetch wrapper: resolves the backend base URL, attaches the stored JWT, normalizes
// error handling, and forces a re-login on any 401 (the token expired or was never valid) so no
// page has to hand-roll that check itself.

const STORAGE_KEY = 'cc_auth';

export function resolveApiBaseUrl() {
  return import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';
}

export function getStoredAuth() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function setStoredAuth(auth) {
  if (auth) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(auth));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function getToken() {
  return getStoredAuth()?.token || null;
}

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

// On a 401 (invalid/expired token), every caller must go straight to the login screen with
// nothing else rendered first - no flash of "Invalid or expired access token" scattered across
// dashboard cards while a `window.location.href` navigation is still in flight (that navigation
// is asynchronous; JS execution and React's re-render keep running until the browser actually
// unloads the page). So this clears storage, kicks off the redirect, and then returns a promise
// that never resolves - every `await apiGet(...)` call site just hangs at that line instead of
// falling into its catch block and calling setError/setState, which is what caused the flash.
function handleUnauthorized() {
  setStoredAuth(null);
  const onAdminPortal = window.location.pathname.startsWith('/admin');
  const loginPath = onAdminPortal ? '/admin/login' : '/login';
  if (window.location.pathname !== loginPath) {
    window.location.href = loginPath;
  }
  return new Promise(() => {});
}

// `body`: a plain object (sent as JSON) or a FormData instance (sent as-is, letting the browser
// set its own multipart boundary - never set Content-Type manually for file uploads).
async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const token = getToken();
  const finalHeaders = { ...headers };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  let finalBody = body;
  if (body && !(body instanceof FormData)) {
    finalHeaders['Content-Type'] = 'application/json';
    finalBody = JSON.stringify(body);
  }

  const res = await fetch(`${resolveApiBaseUrl()}${path}`, {
    method,
    headers: finalHeaders,
    body: finalBody
  });

  // /api/auth/login is the one endpoint where a 401 never means "your session died" - it means
  // invalid credentials, which must flow through to the normal error path below so the login
  // form's catch block can show it. Excluding it by path (not just "was a token attached") also
  // covers a stale/leftover token still sitting in storage from a previous session while
  // attempting a fresh login - login() doesn't consume that token to decide its response at all,
  // so its presence is irrelevant here. Treating every 401 as a dead session made the login form
  // hang on "Signing in..." forever on a wrong password/portal, since handleUnauthorized() never
  // resolves.
  if (res.status === 401 && path !== '/api/auth/login') {
    return handleUnauthorized();
  }

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const message = (data && typeof data === 'object' && data.error) || `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

export const apiGet = (path) => request(path, { method: 'GET' });
export const apiPost = (path, body) => request(path, { method: 'POST', body });
export const apiPut = (path, body) => request(path, { method: 'PUT', body });
export const apiDelete = (path) => request(path, { method: 'DELETE' });

// Like apiPost, but for an endpoint that responds with a raw audio blob (e.g. a TTS pronunciation
// preview) instead of JSON - returns the Blob directly for the caller to play, rather than
// triggering a file-save like apiDownload does.
export async function apiPostAudioBlob(path, body) {
  const token = getToken();
  const finalHeaders = { 'Content-Type': 'application/json' };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  const res = await fetch(`${resolveApiBaseUrl()}${path}`, {
    method: 'POST',
    headers: finalHeaders,
    body: JSON.stringify(body)
  });

  if (res.status === 401 && token) {
    return handleUnauthorized();
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const message = (data && typeof data === 'object' && data.error) || `Request failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }
  return res.blob();
}

// A plain `<a href>` can't carry the Bearer auth header, so file downloads that require auth
// (like CSV exports) need to fetch the blob themselves and trigger the save via a temporary
// object URL instead.
export async function apiDownload(path, filename) {
  const token = getToken();
  const finalHeaders = {};
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  const res = await fetch(`${resolveApiBaseUrl()}${path}`, { headers: finalHeaders });

  if (res.status === 401 && token) {
    return handleUnauthorized();
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const message = (data && typeof data === 'object' && data.error) || `Download failed (${res.status})`;
    throw new ApiError(message, res.status, data);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
