import type { Env } from '../types';

export function allowedOrigins(env: Env): Set<string> {
  const values = [env.FRONTEND_ORIGIN, env.COMMENTS_ORIGIN || '', ...(env.FRONTEND_ORIGINS || '').split(',')];
  return new Set(values.map((origin) => origin.trim()).filter(Boolean));
}

export function corsHeaders(env: Env, requestOrOrigin: Request | string | null, methods = 'GET,POST,PUT,DELETE,OPTIONS'): HeadersInit {
  const origin = typeof requestOrOrigin === 'string'
    ? requestOrOrigin
    : requestOrOrigin?.headers.get('Origin') || null;
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': methods,
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Viewer-Id,X-Device-Id,X-Device-Name',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin'
  };
  if (origin && allowedOrigins(env).has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}
