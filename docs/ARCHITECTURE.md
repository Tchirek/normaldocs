# Architecture & operations

NormalDocs is a document-sharing sibling of NormalPics. It reuses the same
shape: browser-to-R2 uploads, D1 metadata, and a local daemon that does the
heavy document conversion over outbound HTTPS.

## Tiers

```text
Browser  ->  Worker (Hono: D1 + R2 + KV)  ->  R2 (originals)
                      |                          ^
                      v                          |
                     D1 (metadata)          local daemon  -> PDF / preview assets
```

| Package | Responsibility |
|---------|----------------|
| `packages/frontend` | React + Vite + Tailwind document gallery and viewer. |
| `packages/worker` | Hono on Cloudflare Workers with D1, R2, and KV; accounts, metadata, and the SicSic comments callback. |
| `packages/daemon` | Node/Electron preview processor using PDF.js, mammoth, read-excel-file, and Sharp, with an optional bundled LibreOffice fallback for PPT/PPTX and legacy Office files. |

Comments are loaded through the independent SicSic iframe boundary.

## Upload & preview flow

1. The browser uploads the original document to R2 via a signed URL from the
   Worker.
2. The Worker records metadata in D1.
3. The local daemon pulls new documents, renders previews/PDFs (PDF.js, mammoth,
   read-excel-file, Sharp; LibreOffice for PPT/legacy formats), and confirms
   state back to the Worker.

## Configuration & secrets

Non-secret origins live in `.env.example` and `packages/worker/wrangler.toml`
with placeholder domains (`docs.example.com`, `api.docs.example.com`). Secrets are
read from `.dev.vars` locally (see
[../packages/worker/.dev.vars.example](../packages/worker/.dev.vars.example)) and
from `wrangler secret put` in production: `JWT_SECRET`, `DAEMON_SECRET`,
`COMMENTS_CALLBACK_SECRET`, and the delete-PIN hash.

## Deployment

- **Worker:** `npm run build:worker` then `wrangler deploy` from `packages/worker`.
- **Frontend:** `npm run build:frontend` then deploy `packages/frontend/dist`.
- **Daemon:** packaged from `packages/daemon`; the bundled LibreOffice vendor
  directory is excluded from the repo and provisioned per machine.

Secrets stay in `.dev.vars` (local) and `wrangler secret put` (production); never
commit a real `.dev.vars` or `.env`.
