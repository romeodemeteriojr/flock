#!/usr/bin/env node
import { VERSION } from '../src/config.js';
import { createContainer } from '../src/container.js';
import { createApp } from '../src/server.js';
import { createLogger, LEVELS } from '../src/infra/logger.js';

const commands = {
  async version() {
    console.log(`flock ${VERSION}`);
    return 0;
  },
  async serve() {
    const level = Object.hasOwn(LEVELS, process.env.FLOCK_LOG_LEVEL ?? '') ? process.env.FLOCK_LOG_LEVEL : 'info';
    // The server's own log goes to stdout (one JSON line per event).
    const logger = createLogger({ level });
    let container;
    try {
      container = createContainer({ logger });
    } catch (err) {
      console.error(err.message);
      return 1;
    }
    const { config } = container;
    const app = createApp({ container });
    const port = await app.listen(config.port);
    logger.info('flock started', { version: VERSION, port, pid: process.pid });
    console.log(`flock is running at http://localhost:${port}`);

    let stopping = false;
    const shutdown = (signal) => {
      if (stopping) {
        logger.warn('second signal, stopping now', { signal });
        process.exit(1);
      }
      stopping = true;
      logger.info('flock stopping', { signal });
      // Stop accepting new connections, let in-flight requests finish, then
      // force-close anything still open after a few seconds.
      const force = setTimeout(() => app.server.closeAllConnections?.(), 5000);
      force.unref();
      app.server.close(() => {
        clearTimeout(force);
        try { container.close(); } catch (err) { logger.error('could not close the database', { err }); }
        logger.info('flock stopped');
        process.exit(0);
      });
      app.server.closeIdleConnections?.();
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    return null; // keep running
  },
};

let name = process.argv[2];
if (name === '--version') name = 'version';
if (!name || !commands[name]) {
  console.error(`Usage: node bin/flock.js <command>\n\nCommands:\n  ${Object.keys(commands).join('\n  ')}`);
  process.exit(1);
}
const code = await commands[name](process.argv.slice(3));
if (code !== null && code !== undefined) process.exit(code);
