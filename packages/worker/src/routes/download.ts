import { Hono } from 'hono';
import type { Env, Variables } from '../types';
import { getDocument } from '../lib/documents';

export const downloadRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

downloadRoute.get('/:id', async (c) => {
  const row = await getDocument(c.env, c.req.param('id'));
  if (!row) return c.json({ error: 'document_not_found' }, 404);
  return r2KeyResponse(c.env.R2, row.r2_key_original, c.req.raw, {
    contentType: row.mime_type,
    downloadName: row.filename,
    cacheControl: 'private, max-age=300'
  });
});

export const previewRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

previewRoute.get('/:id/manifest', async (c) => {
  const row = await getDocument(c.env, c.req.param('id'));
  if (!row?.preview_manifest_key) return c.json({ error: 'preview_not_ready' }, 404);
  const object = await c.env.R2.get(row.preview_manifest_key);
  if (!object) return c.json({ error: 'object_not_found' }, 404);
  return r2ObjectResponse(object, { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=300' });
});

previewRoute.get('/:id/html', async (c) => {
  const row = await getDocument(c.env, c.req.param('id'));
  if (row?.preview_kind !== 'docx-html') return c.json({ error: 'preview_not_ready' }, 404);
  const object = await c.env.R2.get(`preview/${row.id}/doc.html`);
  if (!object) return c.json({ error: 'object_not_found' }, 404);
  return r2ObjectResponse(object, { contentType: 'text/html; charset=utf-8', cacheControl: 'public, max-age=300' });
});

previewRoute.get('/:id/sheet/:index', async (c) => {
  const row = await getDocument(c.env, c.req.param('id'));
  if (row?.preview_kind !== 'xlsx-table') return c.json({ error: 'preview_not_ready' }, 404);
  const index = Number.parseInt(c.req.param('index'), 10);
  if (!Number.isInteger(index) || index < 1 || (row.preview_count !== null && index > row.preview_count)) {
    return c.json({ error: 'invalid_sheet' }, 400);
  }
  const object = await c.env.R2.get(`preview/${row.id}/sheet-${index}.json`);
  if (!object) return c.json({ error: 'object_not_found' }, 404);
  return r2ObjectResponse(object, { contentType: 'application/json; charset=utf-8', cacheControl: 'public, max-age=300' });
});

previewRoute.get('/:id/thumb', async (c) => {
  const row = await getDocument(c.env, c.req.param('id'));
  if (!row?.r2_key_thumb) return c.json({ error: 'preview_not_ready' }, 404);
  const object = await c.env.R2.get(row.r2_key_thumb);
  if (!object) return c.json({ error: 'object_not_found' }, 404);
  return r2ObjectResponse(object, { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
});

previewRoute.get('/:id/page/:page', async (c) => {
  const row = await getDocument(c.env, c.req.param('id'));
  if (!row?.r2_key_web_prefix) return c.json({ error: 'preview_not_ready' }, 404);
  const page = Number.parseInt(c.req.param('page'), 10);
  if (!Number.isInteger(page) || page < 1 || (row.page_count !== null && page > row.page_count)) {
    return c.json({ error: 'invalid_page' }, 400);
  }
  const object = await c.env.R2.get(`${row.r2_key_web_prefix}/page-${page}.webp`);
  if (!object) return c.json({ error: 'object_not_found' }, 404);
  return r2ObjectResponse(object, { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' });
});

previewRoute.get('/:id/pdf', async (c) => {
  const row = await getDocument(c.env, c.req.param('id'));
  if (!row?.r2_key_pdf) return c.json({ error: 'pdf_not_ready' }, 404);
  return r2KeyResponse(c.env.R2, row.r2_key_pdf, c.req.raw, {
    contentType: 'application/pdf',
    downloadName: row.filename.replace(/\.[^.]+$/, '.pdf'),
    cacheControl: 'private, max-age=300'
  });
});

async function r2KeyResponse(
  bucket: R2Bucket,
  key: string,
  request: Request,
  options: { contentType?: string; downloadName?: string; cacheControl?: string } = {}
): Promise<Response> {
  const rangeHeader = request.headers.get('Range');
  if (!rangeHeader) {
    const object = await bucket.get(key);
    if (!object) return new Response(JSON.stringify({ error: 'object_not_found' }), jsonHeaders(404));
    return r2ObjectResponse(object, options);
  }

  const head = await bucket.head(key);
  if (!head) return new Response(JSON.stringify({ error: 'object_not_found' }), jsonHeaders(404));
  const range = parseByteRange(rangeHeader, head.size);
  if (!range) {
    return new Response(null, {
      status: 416,
      headers: {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes */${head.size}`
      }
    });
  }

  const object = await bucket.get(key, { range: { offset: range.start, length: range.length } });
  if (!object) return new Response(JSON.stringify({ error: 'object_not_found' }), jsonHeaders(404));
  return r2ObjectResponse(object, {
    ...options,
    range: { start: range.start, end: range.end, total: head.size, length: range.length }
  });
}

function r2ObjectResponse(
  object: R2ObjectBody,
  options: {
    contentType?: string;
    downloadName?: string;
    cacheControl?: string;
    range?: { start: number; end: number; total: number; length: number };
  } = {}
): Response {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Content-Length', String(options.range?.length ?? object.size));
  if (options.range) headers.set('Content-Range', `bytes ${options.range.start}-${options.range.end}/${options.range.total}`);
  if (options.contentType) headers.set('Content-Type', options.contentType);
  if (options.cacheControl) headers.set('Cache-Control', options.cacheControl);
  if (options.downloadName) headers.set('Content-Disposition', contentDisposition(options.downloadName));
  return new Response(object.body, { status: options.range ? 206 : 200, headers });
}

function parseByteRange(value: string, size: number): { start: number; end: number; length: number } | null {
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || size <= 0) return null;
  const [, startRaw, endRaw] = match;
  if (!startRaw && !endRaw) return null;
  let start: number;
  let end: number;
  if (!startRaw) {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw ? Number(endRaw) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return null;
  end = Math.min(end, size - 1);
  return { start, end, length: end - start + 1 };
}

function jsonHeaders(status: number): ResponseInit {
  return { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } };
}

function contentDisposition(filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]+/g, '_').replace(/["\\]/g, '_') || 'document';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
