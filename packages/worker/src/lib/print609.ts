import type { Env } from '../types';
import { isRecord } from './validation';

export interface Print609Handoff {
  handoffToken: string;
  printOrigin: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export async function uploadR2ObjectTo609(
  env: Env,
  key: string,
  filename: string,
  mimeType: string
): Promise<Print609Handoff> {
  const sourceObject = await env.R2.get(key);
  if (!sourceObject) throw new Error('document_source_not_found');
  const printOrigin = env.PRINT_609_BASE_URL?.trim().replace(/\/$/, '') || 'https://print.example.com';
  const printSecret = env.PRINT_609_HANDOFF_SECRET?.trim();
  if (!printSecret) throw new Error('print_handoff_not_configured');
  const sessionResponse = await fetch(`${printOrigin}/api/photohost/handoff`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${printSecret}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      source_type: 'normaldocs',
      file_name: filename,
      mime_type: mimeType,
      size_bytes: sourceObject.size
    })
  });
  const rawSession: unknown = await sessionResponse.json().catch(() => ({ error: `print_handoff_${sessionResponse.status}` }));
  const session = isRecord(rawSession) ? rawSession : { error: `print_handoff_${sessionResponse.status}` };
  if (!sessionResponse.ok) {
    const detail = typeof session.error === 'string' ? session.error : `status_${sessionResponse.status}`;
    throw new Error(`print_session_failed:${detail}`);
  }
  const uploadUrl = typeof session.upload_url === 'string' ? session.upload_url : '';
  const notifyUrl = typeof session.notify_url === 'string' ? session.notify_url : '';
  const handoffToken = typeof session.handoff_token === 'string' ? session.handoff_token : '';
  const documentToken = typeof session.upload_token === 'string' ? session.upload_token : '';
  const printDocumentId = typeof session.document_id === 'string' ? session.document_id : '';
  const uploadHeaders = isRecord(session.upload_headers) ? session.upload_headers : { 'Content-Type': mimeType };
  if (!uploadUrl || !notifyUrl || !handoffToken || !documentToken || !printDocumentId) {
    throw new Error('print_session_failed:payload_invalid');
  }
  const uploadResponse = await fetch(uploadUrl, {
    method: 'PUT',
    headers: Object.fromEntries(
      Object.entries(uploadHeaders).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    ),
    body: sourceObject.body
  });
  if (!uploadResponse.ok) throw new Error(`print_upload_failed:${uploadResponse.status}`);
  const notifyResponse = await fetch(notifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      document_id: printDocumentId,
      document_token: documentToken
    })
  });
  if (!notifyResponse.ok) throw new Error(`print_notify_failed:${notifyResponse.status}`);
  return {
    handoffToken,
    printOrigin,
    filename,
    mimeType,
    sizeBytes: sourceObject.size
  };
}
