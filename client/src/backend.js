export const API_BASE = (import.meta.env.VITE_API_URL || '/api').replace(/\/+$/, '');
export const REMOTE_BACKEND = /^https?:\/\//.test(API_BASE);
let token = sessionStorage.getItem('saos-access-token') || '';
export const getAccessToken = () => token;

export function setAccessToken(value) {
  token = value;
  if (value) sessionStorage.setItem('saos-access-token', value);
  else sessionStorage.removeItem('saos-access-token');
}

export function backendFetch(url, options = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  return fetch(url, { ...options, headers });
}

export async function backendBlob(apiPath) {
  const response = await backendFetch(API_BASE + apiPath.replace(/^\/api/, ''), { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  return response.blob();
}

export async function downloadFile(apiPath, filename) {
  const url = URL.createObjectURL(await backendBlob(apiPath));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
