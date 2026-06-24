import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { constantTimeEqual, randomToken, sha256Hex } from '../lib/security';
import { readJsonRecord, stringField } from '../lib/validation';

export const authRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

const DELETE_TOKEN_TTL_SECONDS = 60 * 60 * 8;

function configuredHash(env: Env): string | null {
  const value = env.DELETE_PIN_HASH?.trim();
  if (!value) return null;
  return value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
}

authRoute.post('/delete', async (c) => {
  const hash = configuredHash(c.env);
  if (!hash) return c.json({ error: 'delete_auth_not_configured' }, 503);
  const body = await readJsonRecord(c.req.raw);
  const pin = stringField(body, 'pin', 1, 256);
  const provided = await sha256Hex(pin);
  if (!constantTimeEqual(provided, hash)) return c.json({ error: 'unauthorized' }, 401);

  const token = randomToken(32);
  await c.env.KV.put(`delete-token:${token}`, '1', { expirationTtl: DELETE_TOKEN_TTL_SECONDS });
  return c.json({ token, expiresIn: DELETE_TOKEN_TTL_SECONDS });
});

export async function requireDeleteToken(env: Env, request: Request): Promise<Response | null> {
  if (!configuredHash(env)) return Response.json({ error: 'delete_auth_not_configured' }, { status: 503 });
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const ok = await env.KV.get(`delete-token:${token}`);
  if (!ok) return Response.json({ error: 'unauthorized' }, { status: 401 });
  return null;
}
