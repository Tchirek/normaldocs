import http from 'node:http';
import type { DaemonConfig } from '../config/index.js';

export function startLocalServer(config: DaemonConfig): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, service: 'normaldocs-daemon', deviceId: config.deviceId }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(config.localPort, '127.0.0.1');
  return server;
}
