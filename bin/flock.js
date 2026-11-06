#!/usr/bin/env node
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { loadConfig, VERSION } from '../src/config.js';
import { createApp } from '../src/server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const commands = {
  async version() {
    console.log(`flock ${VERSION}`);
    return 0;
  },
  async serve() {
    const config = loadConfig();
    const dbFile = path.join(root, 'src', 'db.js');
    if (!existsSync(dbFile)) {
      console.error('The database part of flock is not merged yet (src/db.js is missing), so the server cannot start.');
      return 1;
    }
    const { openDb } = await import(pathToFileURL(dbFile).href);
    if (config.dbPath !== ':memory:') mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
    const db = await openDb(config.dbPath);
    const app = createApp({ db, config });
    const port = await app.listen(config.port);
    console.log(`flock is running at http://localhost:${port}`);
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
