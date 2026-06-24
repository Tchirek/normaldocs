import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { Env, Variables } from '../types';
import { ALLOWED_EXTS, extensionFromFilename, MAX_UPLOAD_BYTES, normalizeUploadMime, safeFilename } from '../lib/documents';
import { presignedPut } from '../lib/r2';
import { emitRuntimeEvent } from '../lib/runtime';
import { numberField, readJsonRecord, stringField } from '../lib/validation';

export const uploadRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

async function markUploadReady(env: Env, documentId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE documents
     SET status = CASE WHEN status = 'uploading' THEN 'pending' ELSE status END,
         error_message = NULL,
         claim_device_id = NULL,
         claim_token = NULL,
         claim_expires_at = NULL
     WHERE id = ?`
  ).bind(documentId).run();
  await emitRuntimeEvent(env, 'document:pending', { documentId });
}

uploadRoute.post('/sign', async (c) => {
  const body = await readJsonRecord(c.req.raw);
  const rawFilename = stringField(body, 'filename', 1, 220);
  const declaredMime = stringField(body, 'mimeType', 0, 160);
  const sizeBytes = numberField(body, 'sizeBytes', 1, MAX_UPLOAD_BYTES);
  const filename = safeFilename(rawFilename);
  const ext = extensionFromFilename(filename);

  if (!ALLOWED_EXTS.has(ext)) return c.json({ error: 'unsupported_extension' }, 400);
  const mimeType = normalizeUploadMime(ext, declaredMime);
  if (!mimeType) return c.json({ error: 'unsupported_mime' }, 400);

  const id = nanoid(18);
  const uploadedAt = Date.now();
  const r2Key = `orig/${id}/${filename}`;
  const uploadUrl = await presignedPut(c.env, r2Key, mimeType, 600);
  await c.env.DB.prepare(
    `INSERT INTO documents(
      id, filename, ext, mime_type, size_bytes, status, r2_key_original, uploaded_at
    ) VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?)`
  ).bind(id, filename, ext, mimeType, Math.trunc(sizeBytes), r2Key, uploadedAt).run();

  return c.json({ documentId: id, uploadUrl, r2Key, mimeType, expiresIn: 600 });
});

uploadRoute.post('/notify', async (c) => {
  const body = await readJsonRecord(c.req.raw);
  const documentId = stringField(body, 'documentId', 6, 80);
  const row = await c.env.DB.prepare(
    `SELECT id, size_bytes, status, r2_key_original FROM documents WHERE id = ?`
  ).bind(documentId).first<{ id: string; size_bytes: number; status: string; r2_key_original: string }>();
  if (!row) return c.json({ error: 'document_not_found' }, 404);

  const object = await c.env.R2.head(row.r2_key_original);
  if (!object) {
    await c.env.DB.prepare(
      `UPDATE documents
       SET status = 'failed',
           error_message = 'upload object was not found in R2'
       WHERE id = ? AND status = 'uploading'`
    ).bind(documentId).run();
    return c.json({ error: 'object_not_found' }, 409);
  }
  if (object.size <= 0 || object.size > MAX_UPLOAD_BYTES) return c.json({ error: 'invalid_object_size' }, 400);
  if (object.size !== row.size_bytes) return c.json({ error: 'size_mismatch', actualSize: object.size }, 409);

  await markUploadReady(c.env, documentId);
  return c.json({ ok: true, documentId });
});

uploadRoute.post('/fail', async (c) => {
  const body = await readJsonRecord(c.req.raw);
  const documentId = stringField(body, 'documentId', 6, 80);
  const message = typeof body.message === 'string' ? body.message.slice(0, 500) : 'upload failed before R2 confirmation';
  const result = await c.env.DB.prepare(
    `UPDATE documents
     SET status = 'failed',
         error_message = ?
     WHERE id = ? AND status = 'uploading'`
  ).bind(message, documentId).run();
  return c.json({ ok: true, documentId, changed: result.meta.changes || 0 });
});

uploadRoute.put('/direct/:id', async (c) => {
  const documentId = c.req.param('id');
  const row = await c.env.DB.prepare(
    `SELECT id, mime_type, size_bytes, status, r2_key_original FROM documents WHERE id = ?`
  ).bind(documentId).first<{ id: string; mime_type: string; size_bytes: number; status: string; r2_key_original: string }>();
  if (!row) return c.json({ error: 'document_not_found' }, 404);
  if (row.status !== 'uploading') return c.json({ error: 'invalid_upload_state' }, 409);

  const contentLength = Number(c.req.header('content-length') || '0');
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength !== row.size_bytes) {
    return c.json({ error: 'size_mismatch', expectedSize: row.size_bytes, actualSize: contentLength }, 409);
  }
  if (!c.req.raw.body) return c.json({ error: 'body_required' }, 400);

  await c.env.R2.put(row.r2_key_original, c.req.raw.body, {
    httpMetadata: { contentType: row.mime_type }
  });
  await markUploadReady(c.env, documentId);
  return c.json({ ok: true, documentId });
});
