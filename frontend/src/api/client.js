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

  if (res.status === 401) {
    setStoredAuth(null);
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    throw new ApiError('Session expired - please log in again', 401, null);
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

  if (res.status === 401) {
    setStoredAuth(null);
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    throw new ApiError('Session expired - please log in again', 401, null);
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

  if (res.status === 401) {
    setStoredAuth(null);
    if (window.location.pathname !== '/login') {
      window.location.href = '/login';
    }
    throw new ApiError('Session expired - please log in again', 401, null);
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
