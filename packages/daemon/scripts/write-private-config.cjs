const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '..', '..');

function parseEnv(filePath) {
  try {
    const result = {};
    for (const line of readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      if (/^\s*(#|$)/.test(line) || !line.includes('=')) continue;
      const index = line.indexOf('=');
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

const env = {
  ...parseEnv(path.join(workspaceRoot, '.env')),
  ...parseEnv(path.join(packageRoot, '.env')),
  ...process.env
};

const daemonSecret = env.NORMALDOCS_DAEMON_SECRET || env.DAEMON_SECRET || '';
if (!daemonSecret.trim()) {
  throw new Error('NORMALDOCS_DAEMON_SECRET is required to build the private daemon package config.');
}

const config = {
  NORMALDOCS_WORKER_ORIGIN: env.NORMALDOCS_WORKER_ORIGIN || 'https://api.docs.example.com',
  NORMALDOCS_DAEMON_SECRET: daemonSecret,
  NORMALDOCS_DEVICE_ID: env.NORMALDOCS_DEVICE_ID || env.NORMALDOCS_DAEMON_DEVICE_ID || '',
  NORMALDOCS_DATA_DIR: env.NORMALDOCS_DATA_DIR || path.join(workspaceRoot, '.normaldocs-data'),
  NORMALDOCS_LOCAL_PORT: env.NORMALDOCS_LOCAL_PORT || '8792',
  LIBREOFFICE_BIN: env.LIBREOFFICE_BIN || 'soffice',
  NORMALDOCS_QUICK_TUNNEL: env.NORMALDOCS_QUICK_TUNNEL || 'true',
  NORMALDOCS_CLOUDFLARED_BIN: env.NORMALDOCS_CLOUDFLARED_BIN || '',
  NORMALDOCS_ALLOW_LOW_FIDELITY_OFFICE_FALLBACK: env.NORMALDOCS_ALLOW_LOW_FIDELITY_OFFICE_FALLBACK || 'false'
};

const outDir = path.join(packageRoot, 'private');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, 'normaldocs-daemon.config.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
console.log('Wrote private daemon package config with secrets redacted from output.');
