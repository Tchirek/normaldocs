import { loadConfig } from './config/index.js';
import { downloadOriginal } from './document-download/index.js';
import { startLocalServer } from './local-server/index.js';
import { generatePreview } from './preview-generator/index.js';
import { uploadProcessingAssets, type ProcessingAsset } from './r2-upload/index.js';
import { SyncClient, type ClaimedDocument } from './sync-client/index.js';

async function processDocument(client: SyncClient, config: Awaited<ReturnType<typeof loadConfig>>, doc: ClaimedDocument): Promise<void> {
  try {
    const originalPath = await downloadOriginal(config, client, doc);
    const preview = await generatePreview(config, originalPath, doc.id);
    const keys = previewKeys(doc.id, preview);
    await uploadProcessingAssets(config, doc.id, doc.claimToken, assetsForPreview(preview, keys));
    await client.confirm({
      documentId: doc.id,
      claimToken: doc.claimToken,
      previewKind: preview.kind,
      previewManifestKey: keys.manifestKey,
      previewCount: preview.previewCount,
      pageCount: preview.previewCount,
      aspectRatio: preview.aspectRatio,
      thumbKey: keys.thumbKey,
      r2KeyWebPrefix: null,
      r2KeyPdf: keys.pdfKey,
      blurUpBase64: preview.blurUpBase64,
      textSummary: preview.textSummary,
      tags: []
    });
    console.log(`[normaldocs] ready ${doc.id} (${preview.kind}, ${preview.previewCount})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[normaldocs] failed ${doc.id}`, message);
    await client.fail(doc.id, doc.claimToken, message).catch((reportError) => console.error('[normaldocs] fail report failed', reportError));
  }
}

function previewKeys(documentId: string, preview: Awaited<ReturnType<typeof generatePreview>>) {
  return {
    thumbKey: `thumb/${documentId}.webp`,
    manifestKey: `preview/${documentId}/manifest.json`,
    htmlKey: preview.htmlPath ? `preview/${documentId}/doc.html` : null,
    sheetKeys: preview.sheetPaths.map((_, index) => `preview/${documentId}/sheet-${index + 1}.json`),
    pdfKey: preview.pdfPath && preview.kind !== 'pdf' ? `pdf/${documentId}.pdf` : null
  };
}

function assetsForPreview(
  preview: Awaited<ReturnType<typeof generatePreview>>,
  keys: ReturnType<typeof previewKeys>
): ProcessingAsset[] {
  const assets: ProcessingAsset[] = [
    { key: keys.thumbKey, path: preview.thumbPath, contentType: 'image/webp' },
    { key: keys.manifestKey, path: preview.manifestPath, contentType: 'application/json; charset=utf-8' }
  ];
  if (preview.htmlPath && keys.htmlKey) {
    assets.push({ key: keys.htmlKey, path: preview.htmlPath, contentType: 'text/html; charset=utf-8' });
  }
  for (const [index, sheetPath] of preview.sheetPaths.entries()) {
    assets.push({ key: keys.sheetKeys[index]!, path: sheetPath, contentType: 'application/json; charset=utf-8' });
  }
  if (preview.pdfPath && keys.pdfKey) {
    assets.push({ key: keys.pdfKey, path: preview.pdfPath, contentType: 'application/pdf' });
  }
  return assets;
}

async function catchUp(client: SyncClient, config: Awaited<ReturnType<typeof loadConfig>>): Promise<void> {
  const docs = await client.claim(2);
  for (const doc of docs) await processDocument(client, config, doc);
}

async function main() {
  const config = await loadConfig();
  startLocalServer(config);
  const client = new SyncClient(config);
  console.log(`[normaldocs] daemon online as ${config.deviceId}`);
  let running = false;
  const wake = async () => {
    if (running) return;
    running = true;
    try {
      await catchUp(client, config);
    } catch (error) {
      console.warn('[normaldocs] sync catch-up failed', error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  };
  try {
    const repaired = await client.repairMissingPreviews();
    if (repaired > 0) console.log(`[normaldocs] queued ${repaired} documents for preview repair`);
  } catch (error) {
    console.warn('[normaldocs] preview repair scan failed', error instanceof Error ? error.message : error);
  }
  await wake();
  setInterval(() => void wake(), 30_000);
  for (;;) {
    try {
      await client.listen(() => void wake());
    } catch (error) {
      console.warn('[normaldocs] sync stream reconnecting', error instanceof Error ? error.message : error);
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

void main().catch((error) => {
  console.error('[normaldocs] fatal', error);
  process.exitCode = 1;
});
