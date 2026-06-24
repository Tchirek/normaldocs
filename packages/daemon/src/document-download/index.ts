import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DaemonConfig } from '../config/index.js';
import type { ClaimedDocument, SyncClient } from '../sync-client/index.js';

export async function downloadOriginal(config: DaemonConfig, client: SyncClient, doc: ClaimedDocument): Promise<string> {
  const target = path.join(config.dataDir, 'downloads', `${doc.id}-${doc.filename}`);
  const part = `${target}.part`;
  await rm(part, { force: true });
  const response = await fetch(client.downloadUrl(doc.id, doc.claimToken), {
    headers: { Authorization: `Bearer ${config.daemonSecret}` },
    redirect: 'follow'
  });
  if (!response.ok || !response.body) throw new Error(`download_failed:${response.status}`);
  await new Promise<void>((resolve, reject) => {
    const file = createWriteStream(part);
    response.body!.pipeTo(new WritableStream({
      write(chunk) {
        return new Promise<void>((done, fail) => file.write(Buffer.from(chunk), (error) => error ? fail(error) : done()));
      },
      close() {
        file.end(resolve);
      },
      abort(reason) {
        file.destroy();
        reject(reason);
      }
    })).catch(reject);
  });
  await rename(part, target);
  return target;
}
