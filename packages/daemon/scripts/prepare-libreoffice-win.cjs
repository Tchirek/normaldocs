const { createWriteStream, existsSync, mkdirSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');

const DEFAULT_MSI_URL = 'https://download.documentfoundation.org/libreoffice/stable/26.2.4/win/x86_64/LibreOffice_26.2.4_Win_x86-64.msi';
const packageRoot = path.resolve(__dirname, '..');
const vendorRoot = path.join(packageRoot, 'vendor', 'libreoffice', 'win');
const soffice = path.join(vendorRoot, 'program', 'soffice.exe');
const msiUrl = process.env.NORMALDOCS_LIBREOFFICE_MSI_URL || DEFAULT_MSI_URL;
const cacheDir = path.join(tmpdir(), 'normaldocs-libreoffice-msi');
const msiPath = path.join(cacheDir, path.basename(new URL(msiUrl).pathname));

if (process.platform !== 'win32') {
  throw new Error('This helper prepares the Windows LibreOffice vendor bundle and must run on Windows.');
}

if (existsSync(soffice) && process.argv[2] !== '--force') {
  console.log(`LibreOffice already prepared: ${soffice}`);
  process.exit(0);
}

mkdirSync(cacheDir, { recursive: true });
mkdirSync(vendorRoot, { recursive: true });

(async () => {
  if (!existsSync(msiPath) || statSync(msiPath).size < 300 * 1024 * 1024) {
    console.log(`Downloading ${msiUrl}`);
    await download(msiUrl, msiPath);
  }

  console.log(`Extracting ${msiPath}`);
  const result = spawnSync('msiexec.exe', ['/a', msiPath, `TARGETDIR=${vendorRoot}`, '/qn', '/norestart'], {
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error(`msiexec failed with exit code ${result.status}`);
  }
  if (!existsSync(soffice)) {
    throw new Error(`LibreOffice extraction finished, but soffice.exe was not found at ${soffice}`);
  }
  console.log(`Prepared LibreOffice: ${soffice}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

function download(url, target, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error('Too many redirects while downloading LibreOffice.'));
  const transport = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        resolve(download(nextUrl, target, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        return;
      }
      const file = createWriteStream(target);
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });
    request.on('error', reject);
  });
}
