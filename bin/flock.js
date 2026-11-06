#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadConfig, VERSION } from '../src/config.js';
import { createApp } from '../src/server.js';
import { createLogger, LEVELS } from '../src/infra/logger.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commands = {
  async version() {
    console.log(`flock ${VERSION}`);
    return 0;
  },
  async serve() {
    let config;
    try {
      config = loadConfig();
    } catch (err) {
      console.error(err.message);
      return 1;
    }
    const level = Object.hasOwn(LEVELS, process.env.FLOCK_LOG_LEVEL ?? '') ? process.env.FLOCK_LOG_LEVEL : 'info';
    const logger = createLogger({ level });
    const dbFile = path.join(root, 'src', 'db.js');
    if (!existsSync(dbFile)) {
      console.error('The database part of flock is not merged yet (src/db.js is missing), so the server cannot start.');
      return 1;
    }
    const { openDb } = await import(pathToFileURL(dbFile).href);
    if (config.dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
    const db = await openDb(config.dbPath);
    const app = createApp({ db, config, logger });
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
        try { db.close(); } catch (err) { logger.error('could not close the database', { err }); }
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
