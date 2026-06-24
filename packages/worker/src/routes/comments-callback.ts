import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { numberField, readJsonRecord, stringField } from '../lib/validation';

export const commentsCallbackRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

commentsCallbackRoute.post('/count', async (c) => {
  if (c.env.COMMENTS_CALLBACK_SECRET) {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (token !== c.env.COMMENTS_CALLBACK_SECRET) return c.json({ error: 'unauthorized' }, 401);
  }
  const body = await readJsonRecord(c.req.raw);
  const documentId = stringField(body, 'documentId', 6, 80);
  const commentCount = numberField(body, 'commentCount', 0, 1_000_000);
  await c.env.DB.prepare(
    `UPDATE documents SET comment_count = ? WHERE id = ?`
  ).bind(Math.trunc(commentCount), documentId).run();
  return c.json({ ok: true });
});
