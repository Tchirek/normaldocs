const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const isBuilt = path.basename(path.dirname(__dirname)) === 'dist';
const projectRoot = isBuilt ? path.resolve(__dirname, '..', '..') : path.resolve(__dirname, '..');
const workspaceRoot = findWorkspaceRoot(projectRoot);
const resourcesRoot = resolveResourcesRoot();
let portableConfig = loadPortableConfig();
for (const envPath of [path.join(workspaceRoot, '.env'), path.join(projectRoot, '.env')]) {
  require('dotenv').config({ path: envPath });
}
applyPortableEnv();

let win = null;
let child = null;
let tunnel = null;
let quitting = false;
const lines = [];

function findWorkspaceRoot(start) {
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
    if (parent === current) return path.resolve(start, '..', '..');
    current = parent;
  }
}

function loadPortableConfig() {
  for (const candidate of portableConfigCandidates()) {
    try {
      return JSON.parse(readFileSync(candidate, 'utf8'));
    } catch {
      // Optional private config.
    }
  }
  return {};
}

function portableConfigCandidates() {
  return [
    path.join(path.dirname(process.execPath), 'normaldocs-daemon.config.json'),
    path.join(resourcesRoot, 'normaldocs-daemon.config.json'),
    path.join(projectRoot, 'normaldocs-daemon.config.json'),
    path.join(workspaceRoot, 'normaldocs-daemon.config.json')
  ].filter(Boolean);
}

function resolveResourcesRoot() {
  if (process.resourcesPath) return process.resourcesPath;
  if (isBuilt) return path.join(path.dirname(process.execPath), 'resources');
  return projectRoot;
}

function writableConfigPath() {
  return isBuilt
    ? path.join(path.dirname(process.execPath), 'normaldocs-daemon.config.json')
    : path.join(workspaceRoot, 'normaldocs-daemon.config.json');
}

function savePortableConfig(next) {
  portableConfig = { ...portableConfig, ...next };
  const target = writableConfigPath();
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(portableConfig, null, 2)}\n`, 'utf8');
  applyPortableEnv();
  return target;
}

function applyPortableEnv() {
  for (const [key, value] of Object.entries(portableConfig)) {
    if (value === undefined || value === null || value === '') continue;
    const envKey = envNameForConfigKey(key);
    process.env[envKey] = String(value);
  }
  setEnvIfMissing('NORMALDOCS_DAEMON_SECRET', portableConfig.daemonSecret);
  setEnvIfMissing('NORMALDOCS_DAEMON_SECRET', portableConfig.DAEMON_SECRET);
}

function setEnvIfMissing(key, value) {
  if (value && !process.env[key]) {
    process.env[key] = String(value);
  }
}

function envNameForConfigKey(key) {
  const known = {
    workerOrigin: 'NORMALDOCS_WORKER_ORIGIN',
    daemonSecret: 'NORMALDOCS_DAEMON_SECRET',
    dataDir: 'NORMALDOCS_DATA_DIR',
    deviceId: 'NORMALDOCS_DEVICE_ID',
    localPort: 'NORMALDOCS_LOCAL_PORT',
    libreOfficeBin: 'LIBREOFFICE_BIN',
    cloudflaredBin: 'NORMALDOCS_CLOUDFLARED_BIN',
    quickTunnel: 'NORMALDOCS_QUICK_TUNNEL'
  };
  if (known[key]) return known[key];
  return /^[A-Z0-9_]+$/.test(key) ? key : `NORMALDOCS_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

function env(name, fallback = '') {
  const value = process.env[name]
    || aliasEnv(name)
    || configValue(name);
  const text = value === undefined || value === null ? '' : String(value);
  return text.trim() ? text.trim() : fallback;
}

function aliasEnv(name) {
  const aliases = {
    NORMALDOCS_DAEMON_SECRET: ['DAEMON_SECRET'],
    NORMALDOCS_WORKER_ORIGIN: ['WORKER_ORIGIN'],
    NORMALDOCS_DATA_DIR: ['DATA_DIR'],
    NORMALDOCS_LOCAL_PORT: ['LOCAL_PORT'],
    NORMALDOCS_DEVICE_ID: ['DAEMON_DEVICE_ID', 'DEVICE_ID']
  }[name] || [];
  for (const key of aliases) {
    if (process.env[key]) return process.env[key];
  }
  return '';
}

function configValue(name) {
  const aliases = {
    NORMALDOCS_DAEMON_SECRET: ['NORMALDOCS_DAEMON_SECRET', 'DAEMON_SECRET', 'daemonSecret', 'daemon_secret'],
    NORMALDOCS_WORKER_ORIGIN: ['NORMALDOCS_WORKER_ORIGIN', 'WORKER_ORIGIN', 'workerOrigin', 'worker_origin'],
    NORMALDOCS_DATA_DIR: ['NORMALDOCS_DATA_DIR', 'DATA_DIR', 'dataDir', 'data_dir'],
    NORMALDOCS_LOCAL_PORT: ['NORMALDOCS_LOCAL_PORT', 'LOCAL_PORT', 'localPort', 'local_port'],
    NORMALDOCS_DEVICE_ID: ['NORMALDOCS_DEVICE_ID', 'NORMALDOCS_DAEMON_DEVICE_ID', 'DEVICE_ID', 'deviceId', 'device_id'],
    NORMALDOCS_CLOUDFLARED_BIN: ['NORMALDOCS_CLOUDFLARED_BIN', 'cloudflaredBin', 'cloudflared_bin'],
    NORMALDOCS_RESOURCES_PATH: ['NORMALDOCS_RESOURCES_PATH', 'resourcesPath', 'resources_path'],
    NORMALDOCS_QUICK_TUNNEL: ['NORMALDOCS_QUICK_TUNNEL', 'quickTunnel', 'quick_tunnel'],
    LIBREOFFICE_BIN: ['LIBREOFFICE_BIN', 'libreOfficeBin', 'libreoffice_bin']
  }[name] || [name, name.replace(/^NORMALDOCS_/, '').toLowerCase()];
  for (const key of aliases) {
    if (portableConfig[key] !== undefined && portableConfig[key] !== null && String(portableConfig[key]).trim()) {
      return portableConfig[key];
    }
  }
  return '';
}

function resolvedDataDir() {
  return path.resolve(workspaceRoot, env('NORMALDOCS_DATA_DIR', '.normaldocs-data'));
}

function commandPath(command) {
  const finder = process.platform === 'win32' ? 'where.exe' : 'which';
  const result = spawnSync(finder, [command], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || null;
}

function resolveLibreOfficeLabel() {
  const configured = env('LIBREOFFICE_BIN', 'soffice');
  if (configured !== 'soffice' && existsSync(configured)) return configured;
  const vendor = vendorLibreOfficeCandidates().find((candidate) => existsSync(candidate));
  if (vendor) return vendor;
  const fromPath = commandPath(configured || 'soffice');
  if (fromPath) return fromPath;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
        'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
      ]
    : ['/usr/bin/soffice', '/usr/local/bin/soffice'];
  return candidates.find((candidate) => existsSync(candidate)) || `${configured} (not found)`;
}

function vendorLibreOfficeCandidates() {
  if (process.platform !== 'win32') return [];
  const roots = uniquePaths([
    path.join(resourcesRoot, 'vendor', 'libreoffice', 'win'),
    path.join(projectRoot, 'vendor', 'libreoffice', 'win'),
    path.join(path.dirname(process.execPath), 'resources', 'vendor', 'libreoffice', 'win')
  ]);
  return roots.flatMap((root) => [
    path.join(root, 'LibreOfficePortable', 'App', 'libreoffice', 'program', 'soffice.exe'),
    path.join(root, 'LibreOffice', 'program', 'soffice.exe'),
    path.join(root, 'program', 'soffice.exe')
  ]);
}

function uniquePaths(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = path.resolve(value).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function push(line, level = 'info') {
  const text = String(line).trimEnd();
  if (!text) return;
  lines.push({ text, level, time: Date.now() });
  while (lines.length > 500) lines.shift();
  try {
    const logDir = app.getPath('userData');
    mkdirSync(logDir, { recursive: true });
    appendFileSync(path.join(logDir, 'daemon-gui.log'), `${new Date().toISOString()} [${level}] ${text}\n`, 'utf8');
  } catch {
    // Logging must never break the GUI.
  }
  safeSend('daemon:log', lines.at(-1));
}

function safeSend(channel, payload) {
  try {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, payload);
  } catch {
    // The window may already be gone during app shutdown.
  }
}

function metrics() {
  return {
    ready: lines.filter((line) => /\[normaldocs\]\s+ready\b/i.test(line.text)).length,
    failed: lines.filter((line) => /\[normaldocs\]\s+failed\b/i.test(line.text)).length,
    reconnects: lines.filter((line) => /reconnecting|stream_failed/i.test(line.text)).length
  };
}

function diagnostics() {
  const workerOrigin = env('NORMALDOCS_WORKER_ORIGIN', 'https://api.docs.example.com').replace(/\/+$/, '');
  const deviceId = env('NORMALDOCS_DEVICE_ID', env('NORMALDOCS_DAEMON_DEVICE_ID', 'auto-generated'));
  const dataDir = resolvedDataDir();
  const libreOfficeBin = resolveLibreOfficeLabel();
  return {
    projectRoot,
    workspaceRoot,
    resourcesRoot,
    workerOrigin,
    deviceId,
    dataDir,
    libreOfficeBin,
    localPort: Number(env('NORMALDOCS_LOCAL_PORT', '8792')),
    hasDaemonSecret: Boolean(env('NORMALDOCS_DAEMON_SECRET')),
    builtCoreExists: existsSync(path.join(projectRoot, 'dist', 'index.js'))
  };
}

function status() {
  return {
    running: Boolean(child),
    pid: child?.pid || null,
    log: lines,
    metrics: metrics(),
    diagnostics: diagnostics()
  };
}

function startDaemon() {
  if (child) return status();
  const builtEntry = path.join(projectRoot, 'dist', 'index.js');
  const useBuiltCore = isBuilt && existsSync(builtEntry);
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const command = useBuiltCore ? process.execPath : npm;
  const args = useBuiltCore ? ['--enable-source-maps', builtEntry] : ['run', 'dev:core'];
  child = spawn(command, args, {
    cwd: useBuiltCore ? path.dirname(process.execPath) : projectRoot,
    env: buildDaemonEnv(useBuiltCore),
    windowsHide: true
  });
  push(`[gui] starting daemon via ${useBuiltCore ? 'embedded runtime' : 'npm run dev:core'}`);
  if (!env('NORMALDOCS_DAEMON_SECRET')) {
    push('[gui] NORMALDOCS_DAEMON_SECRET is missing; the Worker will reject sync requests.', 'error');
  }
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => chunk.split(/\r?\n/).forEach((line) => push(line, 'info')));
  child.stderr.on('data', (chunk) => chunk.split(/\r?\n/).forEach((line) => push(line, /failed|fatal|error/i.test(line) ? 'error' : 'warn')));
  child.on('error', (error) => {
    push(`[gui] daemon spawn failed: ${error.message}`, 'error');
    child = null;
    safeSend('daemon:status', status());
  });
  child.on('exit', (code, signal) => {
    push(`[gui] daemon exited code=${code ?? 'null'} signal=${signal ?? 'null'}`, code === 0 ? 'info' : 'warn');
    child = null;
    stopTunnel();
    safeSend('daemon:status', status());
  });
  startTunnel();
  safeSend('daemon:status', status());
  return status();
}

function buildDaemonEnv(useBuiltCore = false) {
  const daemonSecret = env('NORMALDOCS_DAEMON_SECRET');
  const next = {
    ...process.env,
    NORMALDOCS_WORKER_ORIGIN: env('NORMALDOCS_WORKER_ORIGIN', 'https://api.docs.example.com').replace(/\/+$/, ''),
    NORMALDOCS_DAEMON_SECRET: daemonSecret,
    DAEMON_SECRET: daemonSecret,
    NORMALDOCS_DATA_DIR: resolvedDataDir(),
    NORMALDOCS_DEVICE_ID: env('NORMALDOCS_DEVICE_ID', env('NORMALDOCS_DAEMON_DEVICE_ID', '')),
    NORMALDOCS_LOCAL_PORT: String(Number(env('NORMALDOCS_LOCAL_PORT', '8792')) || 8792),
    NORMALDOCS_RESOURCES_PATH: resourcesRoot,
    LIBREOFFICE_BIN: normalizeExecutablePath(resolveLibreOfficeLabel(), 'soffice')
  };
  if (useBuiltCore) {
    next.ELECTRON_RUN_AS_NODE = '1';
  }
  return next;
}

function stopDaemon() {
  if (!child) return status();
  push('[gui] stopping daemon process');
  child.kill();
  child = null;
  stopTunnel();
  safeSend('daemon:status', status());
  return status();
}

function cloudflaredPath() {
  const configured = env('NORMALDOCS_CLOUDFLARED_BIN');
  if (configured && existsSync(configured)) return configured;
  const candidates = uniquePaths([
    path.join(resourcesRoot, 'vendor', 'cloudflared', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'),
    path.join(projectRoot, 'vendor', 'cloudflared', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared')
  ]);
  const bundled = candidates.find((candidate) => existsSync(candidate));
  if (bundled) return bundled;
  const fromPath = commandPath('cloudflared');
  return fromPath || null;
}

function normalizeExecutablePath(value, fallback) {
  return value && !String(value).includes('not found') ? value : fallback;
}

function startTunnel() {
  if (tunnel || env('NORMALDOCS_QUICK_TUNNEL', 'true') === 'false') return;
  const bin = cloudflaredPath();
  if (!bin) {
    push('[tunnel] cloudflared not found; local sync still works over outbound HTTPS.', 'warn');
    return;
  }
  const localPort = Number(env('NORMALDOCS_LOCAL_PORT', '8792'));
  tunnel = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${localPort}`], { windowsHide: true });
  push(`[tunnel] starting Quick Tunnel for http://127.0.0.1:${localPort}`);
  tunnel.stdout?.setEncoding('utf8');
  tunnel.stderr?.setEncoding('utf8');
  const parse = (chunk) => String(chunk).split(/\r?\n/).forEach((line) => {
    push(line, 'info');
    const match = line.match(/https:\/\/[-a-z0-9.]+\.trycloudflare\.com/i);
    if (match) void publishTunnelUrl(match[0]);
  });
  tunnel.stdout?.on('data', parse);
  tunnel.stderr?.on('data', parse);
  tunnel.on('exit', (code, signal) => {
    push(`[tunnel] exited code=${code ?? 'null'} signal=${signal ?? 'null'}`, 'warn');
    tunnel = null;
  });
}

function stopTunnel() {
  if (!tunnel) return;
  tunnel.kill();
  tunnel = null;
}

async function publishTunnelUrl(url) {
  const workerOrigin = env('NORMALDOCS_WORKER_ORIGIN', 'https://api.docs.example.com').replace(/\/+$/, '');
  const secret = env('NORMALDOCS_DAEMON_SECRET');
  if (!secret) return;
  try {
    const response = await fetch(`${workerOrigin}/api/sync/tunnel-url`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    push(response.ok ? `[tunnel] published ${url}` : `[tunnel] publish failed: ${response.status}`, response.ok ? 'info' : 'warn');
  } catch (error) {
    push(`[tunnel] publish failed: ${error.message}`, 'warn');
  }
}

async function restartDaemon() {
  stopDaemon();
  await new Promise((resolve) => setTimeout(resolve, 250));
  return startDaemon();
}

async function chooseDataDir() {
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose NormalDocs sync folder',
    defaultPath: resolvedDataDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return status();
  savePortableConfig({ NORMALDOCS_DATA_DIR: result.filePaths[0] });
  push(`[gui] sync folder changed to ${result.filePaths[0]}`);
  return restartDaemon();
}

async function repairMissingPreviews() {
  const workerOrigin = env('NORMALDOCS_WORKER_ORIGIN', 'https://api.docs.example.com').replace(/\/+$/, '');
  const secret = env('NORMALDOCS_DAEMON_SECRET');
  if (!secret) {
    push('[gui] preview repair failed: NORMALDOCS_DAEMON_SECRET missing', 'error');
    return status();
  }
  try {
    const response = await fetch(`${workerOrigin}/api/sync/repair-previews`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: env('NORMALDOCS_DEVICE_ID', env('NORMALDOCS_DAEMON_DEVICE_ID', 'normaldocs-gui')) })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      push(`[gui] preview repair failed: ${response.status}`, 'error');
    } else {
      push(`[gui] queued ${Number(body.repaired || 0)} documents for preview repair`);
      if (!child) startDaemon();
    }
  } catch (error) {
    push(`[gui] preview repair failed: ${error.message}`, 'error');
  }
  return status();
}

function pageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NormalDocs Daemon</title>
  <style>
    :root {
      color-scheme: light;
      --green: #2E6450;
      --ink: #111;
      --muted: #77746e;
      --paper: #f7f6f2;
      --panel: rgba(255, 255, 255, .78);
      --line: rgba(17, 17, 17, .09);
      --good: #1f9d55;
      --warn: #d18a00;
      --bad: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      background:
        radial-gradient(circle at 16% -4%, rgba(46,100,80,.15), transparent 34%),
        linear-gradient(135deg, #fffdf8 0%, var(--paper) 42%, #ece8dc 100%);
      font: 14px/1.5 "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    main { width: min(880px, calc(100vw - 42px)); margin: 0 auto; padding: 34px 0; }
    header { display: flex; align-items: flex-end; justify-content: space-between; gap: 18px; margin-bottom: 18px; }
    h1, h2, p { margin: 0; }
    .eyebrow { margin-bottom: 5px; color: var(--muted); font-size: 12px; font-weight: 800; letter-spacing: .11em; text-transform: uppercase; }
    h1 { font-size: 34px; line-height: 1.05; letter-spacing: -.035em; font-weight: 850; }
    h1 .docs { color: var(--green); }
    h2 { font-size: 15px; font-weight: 760; letter-spacing: -.01em; }
    .status {
      display: inline-flex;
      align-items: center;
      gap: 9px;
      min-height: 38px;
      padding: 9px 14px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,.74);
      box-shadow: 0 10px 28px rgba(0,0,0,.05);
      font-weight: 760;
    }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn); box-shadow: 0 0 0 4px rgba(209,138,0,.12); }
    .dot.on { background: var(--good); box-shadow: 0 0 0 4px rgba(31,157,85,.13); }
    .dot.off { background: var(--bad); box-shadow: 0 0 0 4px rgba(180,35,24,.12); }
    .panel {
      border: 1px solid var(--line);
      border-radius: 24px;
      padding: 20px;
      margin-bottom: 13px;
      background: var(--panel);
      box-shadow: 0 18px 55px rgba(0,0,0,.08);
      backdrop-filter: blur(18px);
    }
    .summary { color: var(--muted); line-height: 1.7; margin-top: 7px; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    button {
      min-height: 39px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 0 16px;
      background: rgba(255,255,255,.92);
      color: var(--ink);
      font: inherit;
      font-weight: 800;
      cursor: pointer;
      transition: transform .18s cubic-bezier(.2,.7,.2,1), background .18s ease, opacity .18s ease;
    }
    button:hover { transform: translateY(-1px); background: #f1f0ec; }
    button:active { transform: translateY(0); }
    button.primary { background: var(--ink); color: white; border-color: var(--ink); }
    button.danger { color: var(--bad); }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 11px; margin-top: 18px; }
    .stat, .check {
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(255,255,255,.55);
      padding: 14px;
      min-height: 76px;
    }
    .stat strong { display: block; font-size: 25px; line-height: 1; letter-spacing: -.04em; }
    .stat span, .check span { display: block; color: var(--muted); font-size: 12px; margin-top: 7px; overflow-wrap: anywhere; }
    .check.good strong { color: var(--good); }
    .check.bad strong { color: var(--bad); }
    .check.warn strong { color: var(--warn); }
    .log {
      height: 310px;
      overflow: auto;
      margin: 16px 0 0;
      padding: 15px;
      border-radius: 18px;
      background: #0e1110;
      color: #d7e7dc;
      font: 12px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace;
      white-space: pre-wrap;
    }
    footer { color: rgba(17,17,17,.46); font-size: 12px; margin-top: 16px; }
    @media (max-width: 720px) {
      header { align-items: flex-start; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      main { width: min(100vw - 28px, 880px); padding: 22px 0; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">local processing</p>
        <h1><span>Normal</span><span class="docs">Docs</span> Daemon</h1>
      </div>
      <div class="status"><span id="statusDot" class="dot"></span><span id="statusText">Starting</span></div>
    </header>

    <section class="panel">
      <h2>Sync Status</h2>
      <p id="summary" class="summary">Starting the local preview daemon. Original documents stay in R2; this app only claims work, generates preview assets, and reports results back to the Worker.</p>
      <div class="actions">
        <button id="restart" class="primary">Restart Sync</button>
        <button id="repair">Repair Missing Previews</button>
        <button id="stop">Stop</button>
        <button id="chooseData">Choose Sync Folder</button>
        <button id="openWeb">Open NormalDocs</button>
        <button id="openData">Open Data Folder</button>
        <button id="openHealth">Open Health</button>
      </div>
      <div class="grid" aria-label="daemon metrics">
        <div class="stat"><strong id="readyCount">0</strong><span>ready this session</span></div>
        <div class="stat"><strong id="failedCount">0</strong><span>failed this session</span></div>
        <div class="stat"><strong id="pidText">-</strong><span>process id</span></div>
      </div>
    </section>

    <section class="panel">
      <h2>Configuration Checks</h2>
      <div id="checks" class="grid"></div>
    </section>

    <section class="panel">
      <h2>Live Log</h2>
      <pre id="log" class="log"></pre>
    </section>

    <footer>Keep this window running to process pending documents. File bytes do not travel through a Tunnel; the daemon pulls work from the Worker/R2 path over outbound HTTPS.</footer>
  </main>
  <script>
    const api = window.normalDocsDaemon;
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const summary = document.getElementById('summary');
    const log = document.getElementById('log');
    const checks = document.getElementById('checks');

    function checkCard(tone, title, detail) {
      return '<div class="check ' + tone + '"><strong>' + title + '</strong><span>' + detail + '</span></div>';
    }

    function renderChecks(diag) {
      const libreOk = !String(diag.libreOfficeBin).includes('not found');
      checks.innerHTML = [
        checkCard(diag.hasDaemonSecret ? 'good' : 'bad', diag.hasDaemonSecret ? 'Daemon secret ready' : 'Daemon secret missing', 'NORMALDOCS_DAEMON_SECRET'),
        checkCard('good', 'Worker', diag.workerOrigin),
        checkCard(diag.builtCoreExists ? 'good' : 'warn', diag.builtCoreExists ? 'Built core ready' : 'Dev core mode', diag.builtCoreExists ? 'dist/index.js' : 'npm run dev:core'),
        checkCard('good', 'PDF/DOCX/XLSX preview', 'Built-in PDF.js, mammoth and workbook parser'),
        checkCard(libreOk ? 'good' : 'warn', 'Office fallback', diag.libreOfficeBin),
        checkCard('good', 'Data folder', diag.dataDir)
      ].join('');
    }

    function renderStatus(status) {
      statusDot.className = 'dot ' + (status.running ? 'on' : 'off');
      statusText.textContent = status.running ? 'Running #' + status.pid : 'Stopped';
      summary.textContent = status.running
        ? 'The daemon is running. New uploads will be claimed, converted to preview assets, and reported automatically.'
        : 'The daemon is stopped. Click Restart Sync to continue processing pending documents.';
      document.getElementById('readyCount').textContent = status.metrics.ready;
      document.getElementById('failedCount').textContent = status.metrics.failed;
      document.getElementById('pidText').textContent = status.pid || '-';
      renderChecks(status.diagnostics);
      log.textContent = status.log.map((line) => {
        const time = new Date(line.time).toLocaleTimeString();
        return time + '  ' + line.text;
      }).join('\\n');
      log.scrollTop = log.scrollHeight;
    }

    api.onLog(() => api.status().then(renderStatus));
    api.onStatus(renderStatus);
    document.getElementById('restart').onclick = () => api.restart().then(renderStatus);
    document.getElementById('repair').onclick = () => api.repairPreviews().then(renderStatus);
    document.getElementById('stop').onclick = () => api.stop().then(renderStatus);
    document.getElementById('chooseData').onclick = () => api.chooseDataDir().then(renderStatus);
    document.getElementById('openWeb').onclick = () => api.openWeb();
    document.getElementById('openData').onclick = () => api.openData();
    document.getElementById('openHealth').onclick = () => api.openHealth();
    api.status().then(renderStatus);
    api.start().then(renderStatus);
  </script>
</body>
</html>`;
}

function createWindow() {
  Menu.setApplicationMenu(null);
  win = new BrowserWindow({
    width: 940,
    height: 760,
    minWidth: 700,
    minHeight: 560,
    title: 'NormalDocs Daemon',
    backgroundColor: '#f7f6f2',
    icon: path.join(projectRoot, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.once('ready-to-show', () => win?.show());
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml())}`);
}

ipcMain.handle('daemon:start', () => startDaemon());
ipcMain.handle('daemon:stop', () => stopDaemon());
ipcMain.handle('daemon:restart', () => restartDaemon());
ipcMain.handle('daemon:repair-previews', () => repairMissingPreviews());
ipcMain.handle('daemon:status', () => status());
ipcMain.handle('daemon:open-health', () => shell.openExternal(`http://127.0.0.1:${diagnostics().localPort}/health`));
ipcMain.handle('daemon:open-web', () => shell.openExternal('https://docs.example.com'));
ipcMain.handle('daemon:open-data', () => {
  mkdirSync(resolvedDataDir(), { recursive: true });
  return shell.openPath(resolvedDataDir());
});
ipcMain.handle('daemon:choose-data-dir', () => chooseDataDir());

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.setName('NormalDocs Daemon');
  if (process.platform === 'win32') {
    app.setAppUserModelId('top.tchirek.normaldocs.daemon');
  }
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(createWindow);
}

app.on('before-quit', () => {
  quitting = true;
  stopDaemon();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
