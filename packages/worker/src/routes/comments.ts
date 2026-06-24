import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { Env, Variables } from '../types';
import { commentLikeViewerKey, viewerIdFromHeader } from '../lib/security';
import { booleanField, optionalStringField, readJsonRecord, stringField } from '../lib/validation';

interface CommentRow {
  id: string;
  document_id: string;
  root_id: string;
  parent_id: string | null;
  nickname: string;
  content: string;
  html: string;
  created_at: number;
  like_count: number;
}

export const commentsRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

function contextIdFromUrl(url: URL): string {
  return url.searchParams.get('documentId') || url.searchParams.get('imageId') || '';
}

function safeHtml(markdown: string): string {
  const escaped = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
  return escaped.split(/\n{2,}/).map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`).join('');
}

async function refreshCount(env: Env, documentId: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM document_comments WHERE document_id = ? AND status = 'visible'`
  ).bind(documentId).first<{ count: number }>();
  const count = Number(row?.count || 0);
  await env.DB.prepare(`UPDATE documents SET comment_count = ? WHERE id = ?`).bind(count, documentId).run();
  return count;
}

commentsRoute.get('/', async (c) => {
  const documentId = contextIdFromUrl(new URL(c.req.url));
  if (!documentId) return c.json({ error: 'documentId_required' }, 400);
  const viewerId = viewerIdFromHeader(c.req.raw);
  const rows = await c.env.DB.prepare(
    `SELECT c.*,
            COUNT(l.viewer_key) AS like_count
     FROM document_comments c
     LEFT JOIN document_comment_likes l ON l.comment_id = c.id
     WHERE c.document_id = ? AND c.status = 'visible'
     GROUP BY c.id
     ORDER BY like_count DESC, c.created_at DESC`
  ).bind(documentId).all<CommentRow>();
  const liked = new Set<string>();
  const comments = rows.results || [];
  if (viewerId && comments.length > 0) {
    const keys = await Promise.all(comments.map((row) => commentLikeViewerKey(c.env.JWT_SECRET, row.id, viewerId)));
    const placeholders = keys.map(() => '?').join(',');
    const likedRows = await c.env.DB.prepare(
      `SELECT comment_id FROM document_comment_likes WHERE viewer_key IN (${placeholders})`
    ).bind(...keys).all<{ comment_id: string }>();
    for (const row of likedRows.results || []) liked.add(row.comment_id);
  }
  return c.json({
    items: comments.map((row) => ({
      id: row.id,
      imageId: row.document_id,
      documentId: row.document_id,
      rootId: row.root_id,
      parentId: row.parent_id,
      nickname: row.nickname,
      content: row.content,
      html: row.html,
      createdAt: row.created_at,
      likeCount: Number(row.like_count || 0),
      likedByMe: liked.has(row.id)
    })),
    commentedByMe: false
  });
});

commentsRoute.post('/', async (c) => {
  const body = await readJsonRecord(c.req.raw);
  const documentId = optionalStringField(body, 'documentId', 80) || optionalStringField(body, 'imageId', 80);
  if (!documentId) return c.json({ error: 'documentId_required' }, 400);
  const content = stringField(body, 'content', 1, 2000);
  const nickname = (optionalStringField(body, 'nickname', 32) || 'Anonymous').replace(/\s+/g, ' ').trim() || 'Anonymous';
  const parentId = optionalStringField(body, 'parentId', 80);
  const documentRow = await c.env.DB.prepare('SELECT id FROM documents WHERE id = ?').bind(documentId).first<{ id: string }>();
  if (!documentRow) return c.json({ error: 'document_not_found' }, 404);

  let rootId = '';
  if (parentId) {
    const parent = await c.env.DB.prepare(
      `SELECT id, root_id FROM document_comments WHERE id = ? AND document_id = ? AND status = 'visible'`
    ).bind(parentId, documentId).first<{ id: string; root_id: string }>();
    if (!parent) return c.json({ error: 'invalid_parent' }, 400);
    rootId = parent.root_id || parent.id;
  }

  const id = nanoid(18);
  rootId ||= id;
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO document_comments(id, document_id, root_id, parent_id, nickname, content, html, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'visible')`
  ).bind(id, documentId, rootId, parentId, nickname, content, safeHtml(content), now).run();
  const count = await refreshCount(c.env, documentId);
  return c.json({ ok: true, id, commentCount: count });
});

commentsRoute.put('/:id', async (c) => {
  const viewerId = viewerIdFromHeader(c.req.raw);
  if (!viewerId) return c.json({ error: 'viewer_required' }, 401);
  const id = c.req.param('id');
  const body = await readJsonRecord(c.req.raw);
  const liked = booleanField(body, 'liked');
  const row = await c.env.DB.prepare('SELECT id FROM document_comments WHERE id = ? AND status = ?').bind(id, 'visible').first<{ id: string }>();
  if (!row) return c.json({ error: 'comment_not_found' }, 404);
  const viewerKey = await commentLikeViewerKey(c.env.JWT_SECRET, id, viewerId);
  if (liked) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO document_comment_likes(comment_id, viewer_key, created_at) VALUES (?, ?, ?)`
    ).bind(id, viewerKey, Date.now()).run();
  } else {
    await c.env.DB.prepare(
      `DELETE FROM document_comment_likes WHERE comment_id = ? AND viewer_key = ?`
    ).bind(id, viewerKey).run();
  }
  const count = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM document_comment_likes WHERE comment_id = ?`
  ).bind(id).first<{ count: number }>();
  return c.json({ ok: true, likedByMe: liked, likeCount: Number(count?.count || 0) });
});

commentsRoute.delete('/:id', async (c) => {
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token || token !== c.env.JWT_SECRET) return c.json({ error: 'unauthorized' }, 401);
  const id = c.req.param('id');
  const row = await c.env.DB.prepare('SELECT document_id FROM document_comments WHERE id = ?').bind(id).first<{ document_id: string }>();
  if (!row) return c.json({ error: 'comment_not_found' }, 404);
  await c.env.DB.prepare(
    `UPDATE document_comments SET status = 'deleted' WHERE id = ? OR root_id = ?`
  ).bind(id, id).run();
  await c.env.DB.prepare(
    `DELETE FROM document_comment_likes WHERE comment_id NOT IN (SELECT id FROM document_comments WHERE status = 'visible')`
  ).run();
  const count = await refreshCount(c.env, row.document_id);
  return c.json({ ok: true, commentCount: count });
});
