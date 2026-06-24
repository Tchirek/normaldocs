const KEY = 'normaldocs.viewerId.v1';

export function getViewerId(): string {
  const existing = localStorage.getItem(KEY);
  if (existing && /^[A-Za-z0-9_-]{16,96}$/.test(existing)) return existing;
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  const id = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  localStorage.setItem(KEY, id);
  return id;
}
