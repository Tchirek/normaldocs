import { Hono } from 'hono';
import type { Env, Variables } from './types';
import { corsHeaders } from './lib/cors';
import { authRoute } from './routes/auth';
import { commentsRoute } from './routes/comments';
import { commentsCallbackRoute } from './routes/comments-callback';
import { documentsRoute } from './routes/documents';
import { downloadRoute, previewRoute } from './routes/download';
import { likesRoute } from './routes/likes';
import { printRoute } from './routes/print';
import { syncRoute } from './routes/sync';
import { uploadRoute } from './routes/upload';
import { ValidationError } from './lib/validation';

const app = new Hono<{ Bindings: Env; Variables: Variables }>();

app.use('*', async (c, next) => {
  c.set('requestId', crypto.randomUUID());
  if (c.req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(c.env, c.req.raw) });
  }
  await next();
  c.res = new Response(c.res.body, c.res);
  const headers = corsHeaders(c.env, c.req.raw);
  for (const [key, value] of Object.entries(headers)) c.res.headers.set(key, value);
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
});

app.get('/api/health', (c) => c.json({ ok: true, service: 'normaldocs-worker', now: Date.now() }));
app.route('/api/auth', authRoute);
app.route('/api/upload', uploadRoute);
app.route('/api/documents', documentsRoute);
app.route('/api/download', downloadRoute);
app.route('/api/preview', previewRoute);
app.route('/api/likes', likesRoute);
app.route('/api/sync', syncRoute);
app.route('/api/comments-callback', commentsCallbackRoute);
app.route('/api/comment', commentsRoute);
app.route('/api/print', printRoute);
app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
app.get('*', (c) => {
  if (c.env.ASSETS) return c.env.ASSETS.fetch(c.req.raw);
  return c.json({ error: 'asset_binding_missing' }, 500);
});
app.onError((error, c) => {
  if (error instanceof ValidationError) return c.json({ error: error.message }, 400);
  console.error('normaldocs worker error', c.get('requestId'), error);
  return c.json({ error: 'internal_error' }, 500);
});
app.notFound((c) => c.json({ error: 'not_found' }, 404));

export default app;
