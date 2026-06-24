import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { DaemonConfig } from '../config/index.js';

export interface ProcessingAsset {
  key: string;
  path: string;
  contentType: string;
}

export async function uploadProcessingAsset(
  config: DaemonConfig,
  documentId: string,
  claimToken: string,
  asset: ProcessingAsset
): Promise<string> {
  const data = await readFile(asset.path);
  const url = new URL(`${config.workerOrigin}/api/sync/object/${encodeURIComponent(documentId)}`);
  url.searchParams.set('claimToken', claimToken);
  url.searchParams.set('key', asset.key);
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${config.daemonSecret}`,
      'Content-Type': asset.contentType,
      'Content-Length': String(data.byteLength)
    },
    body: new Blob([data], { type: asset.contentType })
  });
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(`processing_upload_failed:${response.status}:${message.slice(0, 240)}`);
  }
  return asset.key;
}

export async function uploadProcessingAssets(
  config: DaemonConfig,
  documentId: string,
  claimToken: string,
  assets: ProcessingAsset[]
): Promise<void> {
  for (const asset of assets) {
    await uploadProcessingAsset(config, documentId, claimToken, asset);
  }
}

export function keyBasename(key: string): string {
  return path.basename(key);
}
