import http from 'node:http';
import { createRouter } from './http.js';
import { registerAll } from './routes/index.js';
import { createGuard } from './guard.js';

export function createApp({ db, now = () => new Date(), config }) {
  const router = createRouter();
  const ctx = { db, now, config };
  router.setGuard(createGuard());
  registerAll(router, ctx);
  router.add('GET', '/api/health', () => ({ status: 200, json: { ok: true } }), { auth: 'none' });
  const server = http.createServer((req, res) => { router.handle(req, res, ctx); });
  return {
    server,
    router,
    ctx,
    listen(port = config?.port ?? 8080) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    },
  };
}
