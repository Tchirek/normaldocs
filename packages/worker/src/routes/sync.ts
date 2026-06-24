import { Hono } from 'hono';
import type { DocumentRow, Env, PreviewKind, Variables } from '../types';
import { normalizeTags } from '../lib/documents';
import { emitRuntimeEvent, latestRuntimeEvent } from '../lib/runtime';
import { randomToken, requireDaemon } from '../lib/security';
import { numberField, optionalStringField, readJsonRecord, stringArrayField, stringField } from '../lib/validation';

export const syncRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

function isAllowedProcessingObject(documentId: string, key: string): boolean {
  if (key === `thumb/${documentId}.webp`) return true;
  if (key === `pdf/${documentId}.pdf`) return true;
  if (key === `preview/${documentId}/manifest.json`) return true;
  if (key === `preview/${documentId}/doc.html`) return true;
  const sheetPrefix = `preview/${documentId}/sheet-`;
  if (key.startsWith(sheetPrefix) && key.endsWith('.json')) {
    const sheetNumber = key.slice(sheetPrefix.length, -'.json'.length);
    return /^[1-9]\d{0,3}$/.test(sheetNumber);
  }
  const pagePrefix = `web/${documentId}/page-`;
  if (!key.startsWith(pagePrefix) || !key.endsWith('.webp')) return false;
  const pageNumber = key.slice(pagePrefix.length, -'.webp'.length);
  return /^[1-9]\d{0,4}$/.test(pageNumber);
}

function processingContentTypeForKey(key: string): string | null {
  if (key.endsWith('.webp')) return 'image/webp';
  if (key.endsWith('.pdf')) return 'application/pdf';
  if (key.endsWith('.json')) return 'application/json; charset=utf-8';
  if (key.endsWith('.html')) return 'text/html; charset=utf-8';
  return null;
}

function previewKindField(value: string): PreviewKind | null {
  if (value === 'pdf' || value === 'docx-html' || value === 'xlsx-table' || value === 'pptx-pdf' || value === 'office-pdf') {
    return value;
  }
  return null;
}

syncRoute.get('/stream', async (c) => {
  const unauthorized = await requireDaemon(c.req.raw, c.env.DAEMON_SECRET);
  if (unauthorized) return unauthorized;
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: string, data: string) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
      };
      send('hello', await latestRuntimeEvent(c.env));
      const timer = setInterval(() => send('heartbeat', JSON.stringify({ now: Date.now() })), 20_000);
      c.req.raw.signal.addEventListener('abort', () => {
        clearInterval(timer);
        controller.close();
      }, { once: true });
    }
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive'
    }
  });
});

syncRoute.post('/claim', async (c) => {
  const unauthorized = await requireDaemon(c.req.raw, c.env.DAEMON_SECRET);
  if (unauthorized) return unauthorized;
  const body = await readJsonRecord(c.req.raw);
  const deviceId = stringField(body, 'deviceId', 2, 120);
  const limit = Math.max(1, Math.min(Number(body.limit || 1), 4));
  const now = Date.now();
  const leaseMs = 10 * 60 * 1000;
  const candidates = await c.env.DB.prepare(
    `SELECT * FROM documents
     WHERE status IN ('pending', 'failed', 'processing')
       AND (claim_expires_at IS NULL OR claim_expires_at < ?)
     ORDER BY uploaded_at ASC
     LIMIT ?`
  ).bind(now, limit).all<DocumentRow>();

  const items: Array<Record<string, unknown>> = [];
  for (const row of candidates.results || []) {
    const claimToken = await randomToken(24);
    const result = await c.env.DB.prepare(
      `UPDATE documents
       SET status = 'processing',
           claim_device_id = ?,
           claim_token = ?,
           claim_expires_at = ?,
           error_message = NULL
       WHERE id = ?
         AND status IN ('pending', 'failed', 'processing')
         AND (claim_expires_at IS NULL OR claim_expires_at < ?)`
    ).bind(deviceId, claimToken, now + leaseMs, row.id, now).run();
    if ((result.meta.changes || 0) > 0) {
      items.push({
        id: row.id,
        filename: row.filename,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        r2KeyOriginal: row.r2_key_original,
        claimToken
      });
    }
  }
  return c.json({ items });
});

syncRoute.post('/repair-previews', async (c) => {
  const unauthorized = await requireDaemon(c.req.raw, c.env.DAEMON_SECRET);
  if (unauthorized) return unauthorized;
  const now = Date.now();
  const rows = await c.env.DB.prepare(
    `SELECT * FROM documents
     WHERE status IN ('ready', 'failed')
       AND (
         status = 'failed'
         OR preview_kind IS NULL
         OR preview_manifest_key IS NULL
         OR preview_count IS NULL
         OR aspect_ratio IS NULL
         OR r2_key_thumb IS NULL
       )
     ORDER BY uploaded_at ASC
     LIMIT 120`
  ).all<DocumentRow>();

  const repairIds: string[] = [];
  for (const row of rows.results || []) {
    if (row.status === 'ready' && row.r2_key_thumb && row.preview_manifest_key) {
      const [thumb, manifest] = await Promise.all([
        c.env.R2.head(row.r2_key_thumb).catch(() => null),
        c.env.R2.head(row.preview_manifest_key).catch(() => null)
      ]);
      if (thumb && manifest) continue;
    }
    repairIds.push(row.id);
  }

  for (const id of repairIds) {
    await c.env.DB.prepare(
      `UPDATE documents
       SET status = 'pending',
           error_message = NULL,
           claim_device_id = NULL,
           claim_token = NULL,
           claim_expires_at = NULL,
           preview_kind = NULL,
           preview_manifest_key = NULL,
           preview_count = NULL,
           r2_key_thumb = NULL,
           r2_key_web_prefix = NULL,
           r2_key_pdf = NULL,
           blur_up_base64 = NULL,
           processed_at = NULL
       WHERE id = ?`
    ).bind(id).run();
  }

  if (repairIds.length > 0) {
    await emitRuntimeEvent(c.env, 'document:repair-previews', { count: repairIds.length, at: now });
  }
  return c.json({ ok: true, repaired: repairIds.length, ids: repairIds });
});

syncRoute.get('/download/:id', async (c) => {
  const unauthorized = await requireDaemon(c.req.raw, c.env.DAEMON_SECRET);
  if (unauthorized) return unauthorized;
  const id = c.req.param('id');
  const claimToken = c.req.query('claimToken') || '';
  const row = await c.env.DB.prepare(
    `SELECT * FROM documents WHERE id = ? AND claim_token = ? AND claim_expires_at > ?`
  ).bind(id, claimToken, Date.now()).first<DocumentRow>();
  if (!row) return c.json({ error: 'claim_not_found' }, 404);
  const object = await c.env.R2.get(row.r2_key_original);
  if (!object) return c.json({ error: 'object_not_found' }, 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Content-Length', String(object.size));
  headers.set('Content-Type', row.mime_type);
  headers.set('Cache-Control', 'private, max-age=60');
  return new Response(object.body, { headers });
});

syncRoute.put('/object/:id', async (c) => {
  const unauthorized = await requireDaemon(c.req.raw, c.env.DAEMON_SECRET);
  if (unauthorized) return unauthorized;
  const id = c.req.param('id');
  const claimToken = c.req.query('claimToken') || '';
  const key = (c.req.query('key') || '').trim();
  if (!claimToken || !key || !isAllowedProcessingObject(id, key)) {
    return c.json({ error: 'invalid_processing_object' }, 400);
  }
  const expectedContentType = processingContentTypeForKey(key);
  if (!expectedContentType) return c.json({ error: 'invalid_content_type' }, 400);
  const lengthHeader = c.req.header('Content-Length');
  const length = lengthHeader ? Number(lengthHeader) : null;
  if (length !== null && (!Number.isFinite(length) || length <= 0 || length > 120 * 1024 * 1024)) {
    return c.json({ error: 'object_too_large' }, 413);
  }
  const row = await c.env.DB.prepare(
    `SELECT id FROM documents WHERE id = ? AND claim_token = ? AND claim_expires_at > ?`
  ).bind(id, claimToken, Date.now()).first<{ id: string }>();
  if (!row) return c.json({ error: 'claim_not_found' }, 404);
  if (!c.req.raw.body) return c.json({ error: 'body_required' }, 400);
  await c.env.R2.put(key, c.req.raw.body, {
    httpMetadata: { contentType: expectedContentType }
  });
  return c.json({ ok: true, key });
});

syncRoute.post('/confirm', async (c) => {
  const unauthorized = await requireDaemon(c.req.raw, c.env.DAEMON_SECRET);
  if (unauthorized) return unauthorized;
  const body = await readJsonRecord(c.req.raw);
  const documentId = stringField(body, 'documentId', 6, 80);
  const deviceId = stringField(body, 'deviceId', 2, 120);
  const claimToken = stringField(body, 'claimToken', 10, 200);
  const previewKind = previewKindField(stringField(body, 'previewKind', 2, 40));
  if (!previewKind) return c.json({ error: 'invalid_preview_kind' }, 400);
  const previewCount = Math.trunc(numberField(body, 'previewCount', 1, 10_000));
  const pageCount = typeof body.pageCount === 'number' || typeof body.pageCount === 'string'
    ? Math.trunc(numberField(body, 'pageCount', 1, 10_000))
    : previewCount;
  const aspectRatio = numberField(body, 'aspectRatio', 0.05, 20);
  const r2KeyThumb = stringField(body, 'thumbKey', 1, 400);
  const previewManifestKey = stringField(body, 'previewManifestKey', 1, 400);
  const r2KeyWebPrefix = optionalStringField(body, 'r2KeyWebPrefix', 400)?.replace(/\/+$/, '') || null;
  const blurUpBase64 = stringField(body, 'blurUpBase64', 1, 2800);
  const textSummary = typeof body.textSummary === 'string' ? body.textSummary.slice(0, 20_000) : '';
  const folderId = typeof body.folderId === 'string' ? body.folderId.slice(0, 80) : null;
  const tags = normalizeTags(stringArrayField(body, 'tags'));
  const r2KeyPdf = typeof body.r2KeyPdf === 'string' && body.r2KeyPdf.length > 0 ? body.r2KeyPdf.slice(0, 400) : null;
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `UPDATE documents
     SET status = 'ready',
         page_count = ?,
         preview_kind = ?,
         preview_manifest_key = ?,
         preview_count = ?,
         aspect_ratio = ?,
         r2_key_thumb = ?,
         r2_key_web_prefix = ?,
         r2_key_pdf = ?,
         blur_up_base64 = ?,
         text_summary = ?,
         folder_id = ?,
         tags = ?,
         processed_at = ?,
         error_message = NULL,
         claim_device_id = NULL,
         claim_token = NULL,
         claim_expires_at = NULL
     WHERE id = ?
       AND claim_device_id = ?
       AND claim_token = ?
       AND claim_expires_at > ?`
  ).bind(pageCount, previewKind, previewManifestKey, previewCount, aspectRatio, r2KeyThumb, r2KeyWebPrefix, r2KeyPdf, blurUpBase64, textSummary, folderId, tags, now, documentId, deviceId, claimToken, now).run();
  if ((result.meta.changes || 0) === 0) return c.json({ error: 'claim_not_current' }, 409);

  const doc = await c.env.DB.prepare('SELECT filename FROM documents WHERE id = ?').bind(documentId).first<{ filename: string }>();
  await c.env.DB.prepare('DELETE FROM document_fts WHERE document_id = ?').bind(documentId).run();
  await c.env.DB.prepare(
    `INSERT INTO document_fts(document_id, filename, text_summary, tags) VALUES (?, ?, ?, ?)`
  ).bind(documentId, doc?.filename || '', textSummary, tags || '').run();
  await emitRuntimeEvent(c.env, 'document:ready', { documentId });
  return c.json({ ok: true });
});

syncRoute.post('/fail', async (c) => {
  const unauthorized = await requireDaemon(c.req.raw, c.env.DAEMON_SECRET);
  if (unauthorized) return unauthorized;
  const body = await readJsonRecord(c.req.raw);
  const documentId = stringField(body, 'documentId', 6, 80);
  const deviceId = stringField(body, 'deviceId', 2, 120);
  const claimToken = stringField(body, 'claimToken', 10, 200);
  const message = stringField(body, 'message', 1, 500);
  const result = await c.env.DB.prepare(
    `UPDATE documents
     SET status = 'failed',
         error_message = ?,
         claim_device_id = NULL,
         claim_token = NULL,
         claim_expires_at = NULL
     WHERE id = ?
       AND claim_device_id = ?
       AND claim_token = ?`
  ).bind(message, documentId, deviceId, claimToken).run();
  if ((result.meta.changes || 0) === 0) return c.json({ error: 'claim_not_current' }, 409);
  await emitRuntimeEvent(c.env, 'document:failed', { documentId });
  return c.json({ ok: true });
});

syncRoute.post('/tunnel-url', async (c) => {
  const unauthorized = await requireDaemon(c.req.raw, c.env.DAEMON_SECRET);
  if (unauthorized) return unauthorized;
  const body = await readJsonRecord(c.req.raw);
  const url = stringField(body, 'url', 8, 400).trim().replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+\.trycloudflare\.com$/i.test(url) && !/^https:\/\/[a-z0-9.-]+$/i.test(url)) {
    return c.json({ error: 'invalid_tunnel_url' }, 400);
  }
  const now = Date.now();
  await c.env.KV.put('config:daemon_tunnel_url', JSON.stringify({ url, updatedAt: now }), { expirationTtl: 7 * 24 * 60 * 60 });
  await emitRuntimeEvent(c.env, 'daemon:tunnel-url', { url });
  return c.json({ ok: true, url, updatedAt: now });
});

syncRoute.get('/daemon-status', async (c) => {
  const raw = await c.env.KV.get('config:daemon_tunnel_url');
  let tunnelUrl: string | null = null;
  let updatedAt: number | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { url?: unknown; updatedAt?: unknown };
      tunnelUrl = typeof parsed.url === 'string' ? parsed.url : null;
      updatedAt = typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null;
    } catch {
      tunnelUrl = null;
      updatedAt = null;
    }
  }
  return c.json({ tunnelUrl, updatedAt });
});
