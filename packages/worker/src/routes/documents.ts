import { Hono } from 'hono';
import type { DocumentRow, Env, Variables } from '../types';
import { documentLikeInfo, documentViewInfo, getDocument, parseTags, serializeDocument } from '../lib/documents';
import { emitRuntimeEvent } from '../lib/runtime';
import { documentViewViewerKey, viewerIdFromHeader } from '../lib/security';
import { requireDeleteToken } from './auth';

export const documentsRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

const UPLOAD_SESSION_TTL_MS = 15 * 60 * 1000;

function clampLimit(value: string | null): number {
  const parsed = value ? Number.parseInt(value, 10) : 36;
  if (!Number.isFinite(parsed)) return 36;
  return Math.max(1, Math.min(parsed, 72));
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function filenameSearchParts(query: string): string[] {
  return query
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8);
}

async function searchDocumentsByFilename(env: Env, q: string, limit: number, offset: number): Promise<{ rows: DocumentRow[]; total: number }> {
  const parts = filenameSearchParts(q);
  if (parts.length === 0) return { rows: [], total: 0 };
  const compact = parts.join('');
  const tokenClauses = parts.map(() => `LOWER(filename) LIKE ? ESCAPE '\\'`).join(' AND ');
  const tokenParams = parts.map((part) => `%${escapeLike(part)}%`);
  const compactParam = `%${escapeLike(compact)}%`;
  const where = compact && compact !== parts[0]
    ? `((${tokenClauses}) OR LOWER(filename) LIKE ? ESCAPE '\\')`
    : `(${tokenClauses})`;
  const params = compact && compact !== parts[0] ? [...tokenParams, compactParam] : tokenParams;
  const [result, count] = await Promise.all([
    env.DB.prepare(
      `SELECT * FROM documents
       WHERE ${where}
       ORDER BY
         CASE
           WHEN LOWER(filename) = ? THEN 0
           WHEN LOWER(filename) LIKE ? ESCAPE '\\' THEN 1
           ELSE 2
         END,
         uploaded_at DESC,
         id DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, compact, `${escapeLike(compact)}%`, limit, offset).all<DocumentRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS total FROM documents WHERE ${where}`).bind(...params).first<{ total: number }>()
  ]);
  return { rows: result.results || [], total: count?.total || 0 };
}

async function serializeRows(env: Env, rows: DocumentRow[], viewerId: string | null) {
  const likeMap = await documentLikeInfo(env, rows.map((row) => row.id), viewerId);
  const viewMap = await documentViewInfo(env, rows.map((row) => row.id));
  return rows.map((row) => {
    const like = likeMap.get(row.id) || { count: 0, likedByMe: false };
    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      status: row.status,
      aspectRatio: row.aspect_ratio,
      pageCount: row.page_count,
      previewKind: row.preview_kind,
      previewCount: row.preview_count ?? row.page_count,
      previewManifestUrl: row.preview_manifest_key ? `/api/preview/${row.id}/manifest` : null,
      previewHtmlUrl: row.preview_kind === 'docx-html' ? `/api/preview/${row.id}/html` : null,
      previewPdfUrl: row.r2_key_pdf
        ? `/api/preview/${row.id}/pdf`
        : row.preview_kind === 'pdf'
          ? `/api/download/${row.id}`
          : null,
      blurUpBase64: row.blur_up_base64,
      thumbUrl: row.r2_key_thumb ? `/api/preview/${row.id}/thumb` : null,
      webPages: row.r2_key_web_prefix && row.page_count
        ? Array.from({ length: row.page_count }, (_, index) => `/api/preview/${row.id}/page/${index + 1}`)
        : [],
      downloadUrl: `/api/download/${row.id}`,
      tags: parseTags(row.tags),
      folderId: row.folder_id,
      commentCount: row.comment_count || 0,
      likeCount: like.count,
      likedByMe: like.likedByMe,
      viewCount: viewMap.get(row.id) || 0,
      uploadedAt: row.uploaded_at,
      processedAt: row.processed_at,
      errorMessage: row.error_message
    };
  });
}

async function markStaleUploads(env: Env): Promise<void> {
  const now = Date.now();
  const uploading = await env.DB.prepare(
    `SELECT * FROM documents
     WHERE status = 'uploading' AND uploaded_at < ?
     ORDER BY uploaded_at ASC
     LIMIT 12`
  ).bind(now - 2000).all<DocumentRow>();

  for (const row of uploading.results || []) {
    const object = await env.R2.head(row.r2_key_original);
    if (object && object.size === row.size_bytes) {
      await env.DB.prepare(
        `UPDATE documents
         SET status = 'pending',
             error_message = NULL,
             claim_device_id = NULL,
             claim_token = NULL,
             claim_expires_at = NULL
         WHERE id = ? AND status = 'uploading'`
      ).bind(row.id).run();
      await emitRuntimeEvent(env, 'document:pending', { documentId: row.id });
    }
  }

  await env.DB.prepare(
    `UPDATE documents
     SET status = 'failed',
         error_message = 'upload session expired before R2 confirmation'
     WHERE status = 'uploading' AND uploaded_at < ?`
  ).bind(now - UPLOAD_SESSION_TTL_MS).run();
}

function r2KeysForDocument(row: DocumentRow): string[] {
  const keys = new Set<string>();
  keys.add(row.r2_key_original);
  if (row.r2_key_thumb) keys.add(row.r2_key_thumb);
  if (row.r2_key_pdf) keys.add(row.r2_key_pdf);
  if (row.preview_manifest_key) keys.add(row.preview_manifest_key);
  if (row.preview_kind === 'docx-html') keys.add(`preview/${row.id}/doc.html`);
  if (row.preview_kind === 'xlsx-table' && row.preview_count) {
    for (let sheet = 1; sheet <= row.preview_count; sheet += 1) keys.add(`preview/${row.id}/sheet-${sheet}.json`);
  }
  if (row.r2_key_web_prefix && row.page_count) {
    for (let page = 1; page <= row.page_count; page += 1) keys.add(`${row.r2_key_web_prefix}/page-${page}.webp`);
  }
  return Array.from(keys).filter(Boolean);
}

documentsRoute.get('/', async (c) => {
  await markStaleUploads(c.env);
  const url = new URL(c.req.url);
  const limit = clampLimit(url.searchParams.get('limit'));
  const cursor = Number.parseInt(url.searchParams.get('cursor') || '0', 10);
  const offset = Number.isFinite(cursor) && cursor > 0 ? cursor : 0;
  const q = (url.searchParams.get('q') || '').trim();
  const viewerId = viewerIdFromHeader(c.req.raw);

  let rows: DocumentRow[] = [];
  let total = 0;
  if (q) {
    const filenameResult = await searchDocumentsByFilename(c.env, q, limit, offset);
    rows = filenameResult.rows;
    total = filenameResult.total;
    const parts = q.replace(/["*]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 6);
    const ftsQuery = parts.map((part) => `${part}*`).join(' ') || q;
    if (rows.length < limit) {
      const seen = new Set(rows.map((row) => row.id));
      const remaining = limit - rows.length;
      const fts = await c.env.DB.prepare(
        `SELECT d.* FROM document_fts f
         JOIN documents d ON d.id = f.document_id
         WHERE document_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      ).bind(ftsQuery, remaining + seen.size).all<DocumentRow>().catch(() => ({ results: [] as DocumentRow[] }));
      for (const row of fts.results || []) {
        if (seen.has(row.id)) continue;
        rows.push(row);
        seen.add(row.id);
        if (rows.length >= limit) break;
      }
      total = Math.max(total, rows.length);
    }
  } else {
    const [result, count] = await Promise.all([
      c.env.DB.prepare(
      `SELECT * FROM documents
       ORDER BY uploaded_at DESC, id DESC
       LIMIT ? OFFSET ?`
      ).bind(limit, offset).all<DocumentRow>(),
      c.env.DB.prepare('SELECT COUNT(*) AS total FROM documents').first<{ total: number }>()
    ]);
    rows = result.results || [];
    total = count?.total || 0;
  }

  return c.json({
    items: await serializeRows(c.env, rows, viewerId),
    nextCursor: rows.length === limit ? offset + rows.length : null,
    total
  });
});

documentsRoute.post('/:id/view', async (c) => {
  const documentId = c.req.param('id');
  const viewerId = viewerIdFromHeader(c.req.raw);
  if (!viewerId) return c.json({ error: 'viewer_required' }, 401);
  const row = await getDocument(c.env, documentId);
  if (!row) return c.json({ error: 'document_not_found' }, 404);
  if (row.status !== 'ready') {
    const current = await documentViewInfo(c.env, [documentId]);
    return c.json({ ok: true, counted: false, viewCount: current.get(documentId) || 0 });
  }

  const viewerKey = await documentViewViewerKey(c.env.JWT_SECRET, documentId, viewerId);
  const insert = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO document_views(document_id, viewer_key, created_at) VALUES (?, ?, ?)`
  ).bind(documentId, viewerKey, Date.now()).run();
  const counted = (insert.meta.changes || 0) > 0;
  if (counted) {
    await c.env.DB.prepare(
      `INSERT INTO document_view_counts(document_id, count)
       VALUES (?, 1)
       ON CONFLICT(document_id) DO UPDATE SET count = count + 1`
    ).bind(documentId).run();
  }
  const count = await c.env.DB.prepare(
    `SELECT count FROM document_view_counts WHERE document_id = ?`
  ).bind(documentId).first<{ count: number }>();
  return c.json({ ok: true, counted, viewCount: Number(count?.count || 0) });
});

documentsRoute.get('/:id', async (c) => {
  await markStaleUploads(c.env);
  const viewerId = viewerIdFromHeader(c.req.raw);
  const row = await getDocument(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'document_not_found' }, 404);
  const recs = await c.env.DB.prepare(
    `SELECT * FROM documents
     WHERE id <> ? AND status = 'ready'
     ORDER BY
       CASE WHEN folder_id IS NOT NULL AND folder_id = ? THEN 0 ELSE 1 END,
       ABS(uploaded_at - ?)
     LIMIT 8`
  ).bind(row.id, row.folder_id, row.uploaded_at).all<DocumentRow>();
  return c.json({
    item: await serializeDocument(c.env, row, viewerId),
    recommendations: await serializeRows(c.env, recs.results || [], viewerId)
  });
});

documentsRoute.post('/:id/retry', async (c) => {
  const documentId = c.req.param('id');
  const result = await c.env.DB.prepare(
    `UPDATE documents
     SET status = 'pending',
         error_message = NULL,
         claim_device_id = NULL,
         claim_token = NULL,
         claim_expires_at = NULL
     WHERE id = ? AND status = 'failed'`
  ).bind(documentId).run();
  if ((result.meta.changes || 0) === 0) return c.json({ error: 'not_retryable' }, 409);
  await emitRuntimeEvent(c.env, 'document:pending', { documentId });
  return c.json({ ok: true });
});

documentsRoute.delete('/:id', async (c) => {
  const authError = await requireDeleteToken(c.env, c.req.raw);
  if (authError) return authError;

  const documentId = c.req.param('id');
  const row = await getDocument(c.env, documentId);
  if (!row) return c.json({ error: 'document_not_found' }, 404);

  const keys = r2KeysForDocument(row);
  if (keys.length > 0) await c.env.R2.delete(keys);

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM document_comment_likes WHERE comment_id IN (SELECT id FROM document_comments WHERE document_id = ?)').bind(documentId),
    c.env.DB.prepare('DELETE FROM document_comments WHERE document_id = ?').bind(documentId),
    c.env.DB.prepare('DELETE FROM document_likes WHERE document_id = ?').bind(documentId),
    c.env.DB.prepare('DELETE FROM document_like_counts WHERE document_id = ?').bind(documentId),
    c.env.DB.prepare('DELETE FROM document_views WHERE document_id = ?').bind(documentId),
    c.env.DB.prepare('DELETE FROM document_view_counts WHERE document_id = ?').bind(documentId),
    c.env.DB.prepare('DELETE FROM document_fts WHERE document_id = ?').bind(documentId),
    c.env.DB.prepare('DELETE FROM print_handoffs WHERE document_id = ?').bind(documentId),
    c.env.DB.prepare('DELETE FROM documents WHERE id = ?').bind(documentId)
  ]);

  return c.json({ ok: true, id: documentId });
});
