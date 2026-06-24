import type { DocumentRow, Env } from '../types';
import { documentLikeViewerKey } from './security';

export const ALLOWED_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx']);
export const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
]);
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);
const MIME_BY_EXT = new Map([
  ['pdf', 'application/pdf'],
  ['doc', 'application/msword'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['ppt', 'application/vnd.ms-powerpoint'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['xls', 'application/vnd.ms-excel'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']
]);

export function safeFilename(value: string): string {
  return value
    .replace(/[\\/\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180) || 'document';
}

export function extensionFromFilename(filename: string): string {
  const match = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || '';
}

export function mimeForExtension(ext: string): string | null {
  return MIME_BY_EXT.get(ext) || null;
}

export function normalizeUploadMime(ext: string, declaredMime: string): string | null {
  const normalized = declaredMime.trim().toLowerCase();
  const byExt = mimeForExtension(ext);
  if (!byExt) return null;
  if (GENERIC_MIME.has(normalized)) return byExt;
  return ALLOWED_MIME.has(normalized) ? normalized : null;
}

export function normalizeTags(tags: string[] | null | undefined): string | null {
  if (!tags) return null;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of tags) {
    const tag = raw
      .trim()
      .replace(/^#+/, '')
      .replace(/[\s#,.;:，。、；：]+/gu, '')
      .slice(0, 32);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    normalized.push(tag);
    if (normalized.length >= 12) break;
  }
  return normalized.length > 0 ? JSON.stringify(normalized) : null;
}

export function parseTags(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export async function getDocument(env: Env, id: string): Promise<DocumentRow | null> {
  return env.DB.prepare('SELECT * FROM documents WHERE id = ?').bind(id).first<DocumentRow>();
}

export async function serializeDocument(env: Env, row: DocumentRow, viewerId?: string | null) {
  const likeInfo = await documentLikeInfo(env, [row.id], viewerId);
  const like = likeInfo.get(row.id) || { count: 0, likedByMe: false };
  const viewInfo = await documentViewInfo(env, [row.id]);
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
    viewCount: viewInfo.get(row.id) || 0,
    uploadedAt: row.uploaded_at,
    processedAt: row.processed_at,
    errorMessage: row.error_message
  };
}

export async function documentViewInfo(env: Env, ids: string[]): Promise<Map<string, number>> {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  const map = new Map(unique.map((id) => [id, 0]));
  if (unique.length === 0) return map;
  const placeholders = unique.map(() => '?').join(',');
  const counts = await env.DB.prepare(
    `SELECT document_id, count FROM document_view_counts WHERE document_id IN (${placeholders})`
  ).bind(...unique).all<{ document_id: string; count: number }>();
  for (const row of counts.results || []) map.set(row.document_id, Number(row.count || 0));
  return map;
}

export async function documentLikeInfo(env: Env, ids: string[], viewerId?: string | null): Promise<Map<string, { count: number; likedByMe: boolean }>> {
  const unique = Array.from(new Set(ids)).filter(Boolean);
  const map = new Map(unique.map((id) => [id, { count: 0, likedByMe: false }]));
  if (unique.length === 0) return map;
  const placeholders = unique.map(() => '?').join(',');
  const counts = await env.DB.prepare(
    `SELECT document_id, SUM(count) AS count
     FROM (
       SELECT document_id, COUNT(*) AS count FROM document_likes WHERE document_id IN (${placeholders}) GROUP BY document_id
       UNION ALL
       SELECT document_id, count FROM document_like_counts WHERE document_id IN (${placeholders})
     )
     GROUP BY document_id`
  ).bind(...unique, ...unique).all<{ document_id: string; count: number }>();
  for (const row of counts.results || []) {
    const current = map.get(row.document_id);
    if (current) current.count = Number(row.count || 0);
  }
  if (viewerId) {
    const keys = await Promise.all(unique.map((id) => documentLikeViewerKey(env.JWT_SECRET, id, viewerId)));
    const liked = await env.DB.prepare(
      `SELECT document_id FROM document_likes
       WHERE document_id IN (${placeholders}) AND viewer_key IN (${placeholders})`
    ).bind(...unique, ...keys).all<{ document_id: string }>();
    for (const row of liked.results || []) {
      const current = map.get(row.document_id);
      if (current) current.likedByMe = true;
    }
  }
  return map;
}
