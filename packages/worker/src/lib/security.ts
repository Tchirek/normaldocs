const encoder = new TextEncoder();

export async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = encoder.encode(a);
  const right = encoder.encode(b);
  let diff = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    diff |= (left[index] || 0) ^ (right[index] || 0);
  }
  return diff === 0;
}

export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function randomToken(bytes = 24): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return base64Url(data);
}

export async function documentLikeViewerKey(secret: string, documentId: string, viewerId: string): Promise<string> {
  return hmacHex(secret, `document-like:${documentId}:${viewerId}`);
}

export async function documentViewViewerKey(secret: string, documentId: string, viewerId: string): Promise<string> {
  return hmacHex(secret, `document-view:${documentId}:${viewerId}`);
}

export async function commentLikeViewerKey(secret: string, commentId: string, viewerId: string): Promise<string> {
  return hmacHex(secret, `comment-like:${commentId}:${viewerId}`);
}

export function viewerIdFromHeader(request: Request): string | null {
  const viewer = (request.headers.get('X-Viewer-Id') || '').trim();
  return /^[A-Za-z0-9_-]{16,96}$/.test(viewer) ? viewer : null;
}

export async function requireDaemon(request: Request, secret: string): Promise<Response | null> {
  const header = request.headers.get('Authorization') || '';
  if (header === `Bearer ${secret}`) return null;
  return Response.json({ error: 'daemon_unauthorized' }, { status: 401 });
}
