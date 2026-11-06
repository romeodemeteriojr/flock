import http from 'node:http';
import { createRouter } from './http.js';
import { registerAll } from './routes/index.js';
import { createGuard } from './guard.js';

// logger, clock and random are optional; the router falls back to silent,
// system and secure versions. They are also put on ctx for handlers to use.
export function createApp({ db, now, config, logger, clock, random }) {
  const router = createRouter({ logger, clock, random });
  const nowFn = now ?? (clock ? () => clock.now() : () => new Date());
  const ctx = { db, now: nowFn, config };
  if (logger) ctx.logger = logger;
  if (clock) ctx.clock = clock;
  if (random) ctx.random = random;
  router.setGuard(createGuard());
  registerAll(router, ctx);
  router.add('GET', '/api/health', () => ({ status: 200, json: { ok: true } }), { auth: 'none' });
  const server = http.createServer((req, res) => {
    router.handle(req, res, ctx).catch((err) => {
      // Last resort: never let one request crash the process.
      if (logger) logger.error('request failed', { err }); else console.error(err);
      if (!res.headersSent) { res.statusCode = 500; res.end(); } else res.destroy();
    });
  });
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
