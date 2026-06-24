import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { DaemonConfig } from '../config/index.js';
import { runCommand } from '../config/process.js';

export async function convertToPdf(config: DaemonConfig, inputPath: string, documentId: string): Promise<string> {
  if (inputPath.toLowerCase().endsWith('.pdf')) return inputPath;
  const outputDir = path.join(config.dataDir, 'work', documentId, 'pdf');
  const userInstallDir = path.join(config.dataDir, 'work', documentId, `lo-profile-${Date.now()}`);
  await mkdir(outputDir, { recursive: true });
  await mkdir(userInstallDir, { recursive: true });
  try {
    await runCommand(config.libreOfficeBin, [
      `-env:UserInstallation=${userInstallationUrl(userInstallDir)}`,
      '--headless',
      '--nologo',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      outputDir,
      inputPath
    ], 180_000);
    const files = await readdir(outputDir);
    const pdf = files.find((file) => file.toLowerCase().endsWith('.pdf'));
    if (!pdf) throw new Error('pdf_conversion_output_missing');
    return path.join(outputDir, pdf);
  } finally {
    await rm(userInstallDir, { recursive: true, force: true });
  }
}

function userInstallationUrl(dir: string): string {
  const normalized = path.resolve(dir).replace(/\\/g, '/');
  return `file:///${encodeURI(normalized)}`;
}
