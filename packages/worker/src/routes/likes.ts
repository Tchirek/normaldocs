import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { getDocument } from '../lib/documents';
import { documentLikeViewerKey, viewerIdFromHeader } from '../lib/security';
import { booleanField, readJsonRecord } from '../lib/validation';

export const likesRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

likesRoute.put('/:id', async (c) => {
  const documentId = c.req.param('id');
  const viewerId = viewerIdFromHeader(c.req.raw);
  if (!viewerId) return c.json({ error: 'viewer_required' }, 401);
  const row = await getDocument(c.env, documentId);
  if (!row) return c.json({ error: 'document_not_found' }, 404);
  const body = await readJsonRecord(c.req.raw);
  const liked = booleanField(body, 'liked');
  const viewerKey = await documentLikeViewerKey(c.env.JWT_SECRET, documentId, viewerId);
  if (liked) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO document_likes(document_id, viewer_key, created_at) VALUES (?, ?, ?)`
    ).bind(documentId, viewerKey, Date.now()).run();
  } else {
    await c.env.DB.prepare(
      `DELETE FROM document_likes WHERE document_id = ? AND viewer_key = ?`
    ).bind(documentId, viewerKey).run();
  }
  const count = await c.env.DB.prepare(
    `SELECT SUM(count) AS count
     FROM (
       SELECT COUNT(*) AS count FROM document_likes WHERE document_id = ?
       UNION ALL
       SELECT count FROM document_like_counts WHERE document_id = ?
     )`
  ).bind(documentId, documentId).first<{ count: number }>();
  return c.json({ ok: true, likedByMe: liked, likeCount: Number(count?.count || 0) });
});
