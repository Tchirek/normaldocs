import { existsSync, readFileSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import dotenv from 'dotenv';
import { runCommand } from './process.js';

export interface DaemonConfig {
  workerOrigin: string;
  daemonSecret: string;
  deviceId: string;
  dataDir: string;
  libreOfficeBin: string;
  localPort: number;
  allowLowFidelityOfficeFallback: boolean;
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] || aliasEnv(name) || configValue(name) || fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(name: string, fallback = ''): string {
  return process.env[name] || aliasEnv(name) || configValue(name) || fallback;
}

function aliasEnv(name: string): string {
  const aliases: Record<string, string[]> = {
    NORMALDOCS_DAEMON_SECRET: ['DAEMON_SECRET'],
    NORMALDOCS_WORKER_ORIGIN: ['WORKER_ORIGIN'],
    NORMALDOCS_DATA_DIR: ['DATA_DIR'],
    NORMALDOCS_LOCAL_PORT: ['LOCAL_PORT'],
    NORMALDOCS_DEVICE_ID: ['NORMALDOCS_DAEMON_DEVICE_ID', 'DEVICE_ID'],
    NORMALDOCS_RESOURCES_PATH: ['RESOURCES_PATH']
  };
  for (const key of aliases[name] || []) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return '';
}

let portableConfig: Record<string, unknown> = {};

function configValue(name: string): string {
  const aliases: Record<string, string[]> = {
    NORMALDOCS_DAEMON_SECRET: ['NORMALDOCS_DAEMON_SECRET', 'DAEMON_SECRET', 'daemonSecret', 'daemon_secret'],
    NORMALDOCS_WORKER_ORIGIN: ['NORMALDOCS_WORKER_ORIGIN', 'WORKER_ORIGIN', 'workerOrigin', 'worker_origin'],
    NORMALDOCS_DATA_DIR: ['NORMALDOCS_DATA_DIR', 'DATA_DIR', 'dataDir', 'data_dir'],
    NORMALDOCS_LOCAL_PORT: ['NORMALDOCS_LOCAL_PORT', 'LOCAL_PORT', 'localPort', 'local_port'],
    NORMALDOCS_DEVICE_ID: ['NORMALDOCS_DEVICE_ID', 'NORMALDOCS_DAEMON_DEVICE_ID', 'DEVICE_ID', 'deviceId', 'device_id'],
    LIBREOFFICE_BIN: ['LIBREOFFICE_BIN', 'libreOfficeBin', 'libreoffice_bin'],
    NORMALDOCS_RESOURCES_PATH: ['NORMALDOCS_RESOURCES_PATH', 'resourcesPath', 'resources_path'],
    NORMALDOCS_ALLOW_LOW_FIDELITY_OFFICE_FALLBACK: [
      'NORMALDOCS_ALLOW_LOW_FIDELITY_OFFICE_FALLBACK',
      'allowLowFidelityOfficeFallback',
      'allow_low_fidelity_office_fallback'
    ]
  };
  for (const key of aliases[name] || [name]) {
    const value = portableConfig[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return '';
}

function findWorkspaceRoot(start: string): string {
  let current = path.resolve(start);
  for (;;) {
    const candidate = path.join(current, 'package.json');
    try {
      const text = readFileSync(candidate, 'utf8');
      if (text.includes('"workspaces"') && text.includes('packages/daemon')) return current;
    } catch {
      // Keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(start);
    current = parent;
  }
}

function loadEnvFiles(): string {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  for (const envPath of [path.join(workspaceRoot, '.env'), path.join(process.cwd(), '.env')]) {
    dotenv.config({ path: envPath });
  }
  portableConfig = loadPortableConfig(workspaceRoot);
  return workspaceRoot;
}

function loadPortableConfig(workspaceRoot: string): Record<string, unknown> {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    path.join(process.cwd(), 'normaldocs-daemon.config.json'),
    path.join(workspaceRoot, 'normaldocs-daemon.config.json'),
    resourcesPath ? path.join(resourcesPath, 'normaldocs-daemon.config.json') : '',
    path.join(path.dirname(process.execPath), 'normaldocs-daemon.config.json')
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, unknown>;
    } catch {
      // Portable config is optional.
    }
  }
  return {};
}

const workspaceRoot = loadEnvFiles();

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function commandPath(command: string): Promise<string | null> {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  try {
    const result = await runCommand(finder, [command], 5_000);
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
  } catch {
    return null;
  }
}

async function resolveLibreOffice(configured: string): Promise<string> {
  if (configured && configured !== 'soffice' && await exists(configured)) return configured;
  const vendor = vendorLibreOfficeBin();
  if (vendor && await exists(vendor)) return vendor;
  const fromPath = await commandPath(configured || 'soffice');
  if (fromPath) return fromPath;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
      ]
    : ['/usr/bin/soffice', '/usr/local/bin/soffice'];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return configured || 'soffice';
}

function vendorLibreOfficeBin(): string | null {
  if (process.platform !== 'win32') return null;
  const roots = uniquePaths([
    optionalEnv('NORMALDOCS_RESOURCES_PATH')
      ? path.join(path.resolve(optionalEnv('NORMALDOCS_RESOURCES_PATH')), 'vendor', 'libreoffice', 'win')
      : '',
    path.resolve(workspaceRoot, 'packages', 'daemon', 'vendor', 'libreoffice', 'win'),
    path.resolve(workspaceRoot, 'vendor', 'libreoffice', 'win'),
    path.join(path.dirname(process.execPath), 'resources', 'vendor', 'libreoffice', 'win')
  ].filter(Boolean));
  const candidates = roots.flatMap((root) => [
    path.join(root, 'LibreOfficePortable', 'App', 'libreoffice', 'program', 'soffice.exe'),
    path.join(root, 'LibreOffice', 'program', 'soffice.exe'),
    path.join(root, 'program', 'soffice.exe')
  ]);
  return candidates.find((candidate) => existsSync(candidate)) || candidates[0];
}

function uniquePaths(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = path.resolve(value).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function resolveDeviceId(dataDir: string): Promise<string> {
  const configured = process.env.NORMALDOCS_DEVICE_ID || process.env.NORMALDOCS_DAEMON_DEVICE_ID;
  if (configured && configured.trim()) return configured.trim();
  const deviceFile = path.join(dataDir, 'device-id');
  try {
    const existing = (await readFile(deviceFile, 'utf8')).trim();
    if (/^[A-Za-z0-9_.:-]{6,120}$/.test(existing)) return existing;
  } catch {
    // First launch on this machine.
  }
  const created = `normaldocs-${crypto.randomUUID()}`;
  await writeFile(deviceFile, `${created}\n`, 'utf8');
  return created;
}

export async function loadConfig(): Promise<DaemonConfig> {
  const dataDir = path.resolve(env('NORMALDOCS_DATA_DIR', path.join(workspaceRoot, '.normaldocs-data')));
  await mkdir(dataDir, { recursive: true });
  await mkdir(path.join(dataDir, 'downloads'), { recursive: true });
  await mkdir(path.join(dataDir, 'work'), { recursive: true });
  const libreOfficeBin = await resolveLibreOffice(env('LIBREOFFICE_BIN', 'soffice'));
  return {
    workerOrigin: env('NORMALDOCS_WORKER_ORIGIN', 'https://api.docs.example.com').replace(/\/+$/, ''),
    daemonSecret: env('NORMALDOCS_DAEMON_SECRET'),
    deviceId: await resolveDeviceId(dataDir),
    dataDir,
    libreOfficeBin,
    localPort: Number(process.env.NORMALDOCS_LOCAL_PORT || configValue('NORMALDOCS_LOCAL_PORT') || 8792),
    allowLowFidelityOfficeFallback: optionalEnv('NORMALDOCS_ALLOW_LOW_FIDELITY_OFFICE_FALLBACK', 'false').toLowerCase() === 'true'
  };
}
