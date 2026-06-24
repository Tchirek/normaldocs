export type DocumentStatus = 'uploading' | 'pending' | 'processing' | 'ready' | 'failed';
export type PreviewKind = 'pdf' | 'docx-html' | 'xlsx-table' | 'pptx-pdf' | 'office-pdf';

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  KV: KVNamespace;
  ASSETS?: Fetcher;
  FRONTEND_ORIGIN: string;
  FRONTEND_ORIGINS?: string;
  COMMENTS_ORIGIN?: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  JWT_SECRET: string;
  DAEMON_SECRET: string;
  DELETE_PIN_HASH?: string;
  PRINT_609_BASE_URL?: string;
  PRINT_609_HANDOFF_SECRET?: string;
  COMMENTS_CALLBACK_SECRET?: string;
}

export interface Variables {
  requestId: string;
}

export interface DocumentRow {
  id: string;
  filename: string;
  ext: string;
  mime_type: string;
  size_bytes: number;
  status: DocumentStatus;
  aspect_ratio: number | null;
  page_count: number | null;
  preview_kind: PreviewKind | null;
  preview_manifest_key: string | null;
  preview_count: number | null;
  blur_up_base64: string | null;
  r2_key_original: string;
  r2_key_thumb: string | null;
  r2_key_web_prefix: string | null;
  r2_key_pdf: string | null;
  text_summary: string | null;
  error_message: string | null;
  folder_id: string | null;
  tags: string | null;
  comment_count: number;
  uploaded_at: number;
  processed_at: number | null;
  claim_device_id: string | null;
  claim_token: string | null;
  claim_expires_at: number | null;
}
