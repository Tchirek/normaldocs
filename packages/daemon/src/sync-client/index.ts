import type { DaemonConfig } from '../config/index.js';

export interface ClaimedDocument {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  r2KeyOriginal: string;
  claimToken: string;
}

export interface ConfirmPayload {
  documentId: string;
  claimToken: string;
  previewKind: 'pdf' | 'docx-html' | 'xlsx-table' | 'pptx-pdf' | 'office-pdf';
  previewManifestKey: string;
  previewCount: number;
  pageCount?: number;
  aspectRatio: number;
  thumbKey: string;
  r2KeyWebPrefix?: string | null;
  r2KeyPdf?: string | null;
  blurUpBase64: string;
  textSummary: string;
  tags: string[];
  folderId?: string | null;
}

export class SyncClient {
  constructor(private readonly config: DaemonConfig) {}

  private headers() {
    return {
      Authorization: `Bearer ${this.config.daemonSecret}`,
      'Content-Type': 'application/json'
    };
  }

  async claim(limit = 1): Promise<ClaimedDocument[]> {
    const response = await fetch(`${this.config.workerOrigin}/api/sync/claim`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ deviceId: this.config.deviceId, limit })
    });
    if (!response.ok) throw new Error(`claim_failed:${response.status}`);
    const body = await response.json() as { items?: ClaimedDocument[] };
    return Array.isArray(body.items) ? body.items : [];
  }

  async repairMissingPreviews(): Promise<number> {
    const response = await fetch(`${this.config.workerOrigin}/api/sync/repair-previews`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ deviceId: this.config.deviceId })
    });
    if (!response.ok) throw new Error(`repair_previews_failed:${response.status}`);
    const body = await response.json() as { repaired?: number };
    return Number.isFinite(body.repaired) ? Number(body.repaired) : 0;
  }

  downloadUrl(id: string, claimToken: string): string {
    return `${this.config.workerOrigin}/api/sync/download/${encodeURIComponent(id)}?claimToken=${encodeURIComponent(claimToken)}`;
  }

  async confirm(payload: ConfirmPayload): Promise<void> {
    const response = await fetch(`${this.config.workerOrigin}/api/sync/confirm`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ ...payload, deviceId: this.config.deviceId })
    });
    if (!response.ok) throw new Error(`confirm_failed:${response.status}:${await response.text()}`);
  }

  async fail(documentId: string, claimToken: string, message: string): Promise<void> {
    const response = await fetch(`${this.config.workerOrigin}/api/sync/fail`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ documentId, claimToken, deviceId: this.config.deviceId, message: message.slice(0, 500) })
    });
    if (!response.ok) throw new Error(`fail_report_failed:${response.status}`);
  }

  async listen(onWake: () => void): Promise<void> {
    const response = await fetch(`${this.config.workerOrigin}/api/sync/stream`, { headers: this.headers() });
    if (!response.ok || !response.body) throw new Error(`stream_failed:${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (decoder.decode(chunk.value, { stream: true }).includes('document:')) onWake();
    }
  }
}
