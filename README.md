# NormalDocs

NormalDocs is a document-sharing sibling project to NormalPics. It keeps the same reliable architecture: browser-to-R2 uploads, D1 metadata, and a local daemon that performs heavy document conversion through outbound HTTPS.

## Architecture

- Frontend: React, Vite, TailwindCSS.
- Worker: Hono on Cloudflare Workers with D1, R2, and KV.
- Daemon: Node/Electron document preview processor using PDF.js, mammoth, read-excel-file, Sharp, and an optional bundled LibreOffice fallback for PPT/PPTX or legacy Office files.
- Comments: loaded through the independent SicSic iframe boundary.

## Local Development

```bash
npm install
npm run build:all
```

Frontend:

```bash
npm run dev:frontend
```

Worker:

```bash
npm run dev:worker
```

Daemon:

```bash
npm run dev:daemon
```

The daemon GUI starts the sync worker automatically and shows live logs, config health, the local data folder, and per-session processing counts:

```bash
npm --workspace packages/daemon run gui
```

The local daemon only needs `NORMALDOCS_WORKER_ORIGIN`, `NORMALDOCS_DAEMON_SECRET`, and a stable device id. It does not need R2 access keys. PDF, DOCX, DOC, and XLSX previews are generated with bundled JavaScript/native packages; LibreOffice is only an optional fallback for PPT/PPTX and legacy Office formats. Processed thumbnails, manifests, HTML/table previews, and optional PDFs are uploaded back through the Worker sync API under the active claim lease.

## Deployment Defaults

- Frontend domain: `https://docs.example.com`
- Worker domain: `https://api.docs.example.com`
- Pages project: `normaldocs-frontend`
- Worker name: `normaldocs-worker`
- D1 database: `normaldocs`
- R2 bucket: `normaldocs`
- KV binding: `NORMALDOCS_KV`

Secrets must be configured through Cloudflare secrets or ignored local `.env` files. Do not commit live tokens, daemon secrets, local document caches, generated previews, or release binaries.
