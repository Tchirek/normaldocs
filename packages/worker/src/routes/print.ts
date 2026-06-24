import { Hono } from 'hono';
import { nanoid } from 'nanoid';
import type { Env, Variables } from '../types';
import { getDocument } from '../lib/documents';
import { uploadR2ObjectTo609 } from '../lib/print609';

export const printRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

printRoute.post('/handoff', async (c) => {
  const documentId = c.req.query('documentId') || '';
  const row = await getDocument(c.env, documentId);
  if (!row) return c.json({ error: 'document_not_found' }, 404);
  if (row.status !== 'ready') return c.json({ error: 'document_not_ready' }, 409);
  const tokenId = nanoid(32);
  const expiresAt = Date.now() + 5 * 60 * 1000;
  await c.env.DB.prepare(
    `INSERT INTO print_handoffs(token_id, document_id, expires_at) VALUES (?, ?, ?)`
  ).bind(tokenId, row.id, expiresAt).run();
  const sourceKey = row.r2_key_pdf || row.r2_key_original;
  const isPdf = Boolean(row.r2_key_pdf);
  const filename = isPdf ? row.filename.replace(/\.[^.]+$/, '.pdf') : row.filename;
  const mimeType = isPdf ? 'application/pdf' : row.mime_type;
  const handoff = await uploadR2ObjectTo609(c.env, sourceKey, filename, mimeType).catch((error) => error instanceof Error ? error : new Error(String(error)));
  if (handoff instanceof Error) return c.json({ error: handoff.message }, handoff.message.includes('configured') ? 503 : 502);
  return c.json({
    token: tokenId,
    expiresAt,
    handoffToken: handoff.handoffToken,
    printOrigin: handoff.printOrigin,
    defaultMode: 'color',
    document: {
      id: row.id,
      filename,
      mimeType,
      sizeBytes: handoff.sizeBytes
    }
  });
});
