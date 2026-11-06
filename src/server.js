import http from 'node:http';
import { createRouter } from './http.js';
import { register as registerRoutes } from './routes/index.js';
import { createGuard } from './guard.js';
import { createContainer } from './container.js';
import { silentLogger } from './infra/logger.js';

// Old form: createApp({ db, now, config, logger?, clock?, random? }). Builds a
// container from those parts. Without a logger it stays silent (as before).
function containerFromParts({ db, now, config, logger, clock, random, hasher }) {
  const o = { db, logger: logger ?? silentLogger() };
  if (config !== undefined) o.config = config;
  if (clock) o.clock = clock;
  else if (now) o.clock = { now: () => { const n = now(); return n instanceof Date ? n : new Date(n); } };
  if (random) o.random = random;
  if (hasher) o.hasher = hasher;
  return createContainer(o);
}

/**
 * createApp({ container }) — the normal form (see src/container.js).
 * createApp({ db, now, config, logger, clock, random }) — older form, still supported.
 */
export function createApp(opts = {}) {
  const container = opts.container ?? containerFromParts(opts);
  const { config, clock, logger, random } = container;
  // The router only gets a logger when one was really given, so the old
  // silent form behaves exactly as before.
  const explicitLogger = opts.container ? logger : opts.logger;
  const router = createRouter({ logger: explicitLogger, clock, random });
  const now = !opts.container && opts.now ? opts.now : () => clock.now();
  const ctx = {
    services: container.services,
    config,
    clock,
    logger,
    random,
    hasher: container.hasher,
    data: container.data,
    // DEPRECATED: the raw database connection and now(), only for the route
    // modules that still use them until their refactor cards land. New code
    // uses services (and clock) instead.
    db: container.db,
    now,
  };
  router.setGuard(createGuard());
  registerRoutes(router, ctx);
  router.add('GET', '/api/health', () => ({ status: 200, json: { ok: true } }), { auth: 'none' });
  const server = http.createServer((req, res) => {
    router.handle(req, res, ctx).catch((err) => {
      // Last resort: never let one request crash the process.
      if (explicitLogger) explicitLogger.error('request failed', { err }); else console.error(err);
      if (!res.headersSent) { res.statusCode = 500; res.end(); } else res.destroy();
    });
  });
  return {
    server,
    router,
    ctx,
    container,
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
