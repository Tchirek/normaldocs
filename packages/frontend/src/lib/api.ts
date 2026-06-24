import type { DocumentItem, DocumentListResponse } from '../types/document';
import { getViewerId } from './viewer';

const API_ORIGIN = import.meta.env.VITE_NORMALDOCS_API_ORIGIN || '';
const DELETE_TOKEN_KEY = 'normaldocs_delete_token';

function apiUrl(path: string): string {
  return `${API_ORIGIN}${path}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      'X-Viewer-Id': getViewerId(),
      ...(init?.headers || {})
    }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(typeof body.error === 'string' ? body.error : `request_failed_${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function listDocuments(cursor: number | null, q: string): Promise<DocumentListResponse> {
  const params = new URLSearchParams({ limit: '36' });
  if (cursor) params.set('cursor', String(cursor));
  if (q.trim()) params.set('q', q.trim());
  return request<DocumentListResponse>(`/api/documents?${params}`);
}

export async function retryDocument(id: string): Promise<void> {
  await request(`/api/documents/${encodeURIComponent(id)}/retry`, { method: 'POST' });
}

export async function setLike(id: string, liked: boolean): Promise<{ likedByMe: boolean; likeCount: number }> {
  return request(`/api/likes/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ liked })
  });
}

export async function recordDocumentView(id: string): Promise<{ counted: boolean; viewCount: number }> {
  return request(`/api/documents/${encodeURIComponent(id)}/view`, { method: 'POST' });
}

export interface UploadHooks {
  onOptimistic?: (item: DocumentItem) => void;
  onFailed?: (item: DocumentItem) => void;
}

export async function uploadDocument(file: File, hooks: UploadHooks = {}): Promise<DocumentItem> {
  let optimistic: DocumentItem | null = null;
  const signed = await request<{ documentId: string; uploadUrl: string; mimeType: string; expiresIn: number }>('/api/upload/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size })
  });
  optimistic = optimisticDocument(file, signed.documentId, signed.mimeType);
  hooks.onOptimistic?.(optimistic);
  try {
    const directUploaded = await uploadOriginalBytes(file, signed);
    if (!directUploaded) {
      await request('/api/upload/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documentId: signed.documentId })
      });
    }
    const detail = await request<{ item: DocumentItem }>(`/api/documents/${encodeURIComponent(signed.documentId)}`);
    return detail.item;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'upload_failed';
    await reportUploadFailure(signed.documentId, message).catch(() => undefined);
    hooks.onFailed?.({ ...optimistic, status: 'failed', errorMessage: message });
    throw error;
  }
}

async function uploadOriginalBytes(
  file: File,
  signed: { documentId: string; uploadUrl: string; mimeType: string }
): Promise<boolean> {
  let r2Status = 'network';
  try {
    const put = await fetch(signed.uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': signed.mimeType },
      body: file
    });
    if (put.ok) return false;
    r2Status = String(put.status);
  } catch {
    r2Status = 'cors_or_network';
  }

  const fallback = await fetch(apiUrl(`/api/upload/direct/${encodeURIComponent(signed.documentId)}`), {
    method: 'PUT',
    headers: {
      'Content-Type': signed.mimeType,
      'X-Viewer-Id': getViewerId()
    },
    body: file
  });
  if (!fallback.ok) throw new Error(`r2_upload_failed_${r2Status}_fallback_${fallback.status}`);
  return true;
}

async function reportUploadFailure(documentId: string, message: string): Promise<void> {
  await request('/api/upload/fail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentId, message })
  });
}

export async function requestDeleteToken(pin: string): Promise<string> {
  const response = await request<{ token: string }>('/api/auth/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  localStorage.setItem(DELETE_TOKEN_KEY, response.token);
  return response.token;
}

export function getDeleteToken(): string | null {
  return localStorage.getItem(DELETE_TOKEN_KEY);
}

export function clearDeleteToken(): void {
  localStorage.removeItem(DELETE_TOKEN_KEY);
}

export async function deleteDocument(id: string): Promise<void> {
  const token = getDeleteToken();
  if (!token) throw new Error('delete_token_required');
  await request(`/api/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  });
}

export async function createPrintHandoff(documentId: string) {
  return request<{
    token: string;
    handoffToken: string;
    printOrigin: string;
    defaultMode: 'color';
    document: { filename: string; mimeType: string };
  }>(`/api/print/handoff?documentId=${encodeURIComponent(documentId)}`, { method: 'POST' });
}

export function absoluteApiUrl(path: string): string {
  return apiUrl(path);
}

function optimisticDocument(file: File, id: string, mimeType: string): DocumentItem {
  return {
    id,
    filename: file.name,
    mimeType,
    sizeBytes: file.size,
    status: 'uploading',
    aspectRatio: null,
    pageCount: null,
    previewKind: null,
    previewCount: null,
    previewManifestUrl: null,
    previewHtmlUrl: null,
    previewPdfUrl: null,
    blurUpBase64: null,
    thumbUrl: null,
    webPages: [],
    downloadUrl: `/api/download/${id}`,
    tags: [],
    folderId: null,
    commentCount: 0,
    likeCount: 0,
    likedByMe: false,
    viewCount: 0,
    uploadedAt: Date.now(),
    processedAt: null,
    errorMessage: null
  };
}
