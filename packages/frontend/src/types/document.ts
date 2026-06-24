export type DocumentStatus = 'uploading' | 'pending' | 'processing' | 'ready' | 'failed';
export type PreviewKind = 'pdf' | 'docx-html' | 'xlsx-table' | 'pptx-pdf' | 'office-pdf';

export interface PaperInfo {
  widthMm: number;
  heightMm: number;
  orientation: 'portrait' | 'landscape';
}

export interface PreviewManifestPage {
  index: number;
  widthPt: number;
  heightPt: number;
}

export interface PreviewManifest {
  version: number;
  kind: PreviewKind;
  previewCount: number;
  paper?: PaperInfo;
  pages?: PreviewManifestPage[];
  sheets?: Array<{ index: number; name: string; rows: number; cols: number }>;
}

export interface DocumentItem {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  status: DocumentStatus;
  aspectRatio: number | null;
  pageCount: number | null;
  previewKind: PreviewKind | null;
  previewCount: number | null;
  previewManifestUrl: string | null;
  previewHtmlUrl: string | null;
  previewPdfUrl: string | null;
  blurUpBase64: string | null;
  thumbUrl: string | null;
  webPages: string[];
  downloadUrl: string;
  tags: string[];
  folderId: string | null;
  commentCount: number;
  likeCount: number;
  likedByMe: boolean;
  viewCount: number;
  uploadedAt: number;
  processedAt: number | null;
  errorMessage: string | null;
}

export interface DocumentListResponse {
  items: DocumentItem[];
  nextCursor: number | null;
  total: number;
}

export type LightboxPhase = 'closed' | 'opening' | 'reader-loading' | 'open' | 'closing' | 'handoff';
