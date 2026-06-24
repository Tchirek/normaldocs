import type { Env } from '../types';

export async function emitRuntimeEvent(env: Env, type: string, payload: Record<string, unknown>): Promise<void> {
  const now = Date.now();
  const value = JSON.stringify({ type, payload, createdAt: now });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO runtime_events(key, value, updated_at)
     VALUES (?, ?, ?)`
  ).bind(`event:${type}:${now}`, value, now).run();
  await env.KV.put('sync:last-event', value, { expirationTtl: 3600 }).catch(() => undefined);
}

export async function latestRuntimeEvent(env: Env): Promise<string> {
  const fromKv = await env.KV.get('sync:last-event').catch(() => null);
  if (fromKv) return fromKv;
  const row = await env.DB.prepare(
    `SELECT value FROM runtime_events ORDER BY updated_at DESC LIMIT 1`
  ).first<{ value: string }>();
  return row?.value || JSON.stringify({ type: 'hello', payload: {}, createdAt: Date.now() });
}
