// The CLI commands. Each one builds the app with createContainer and talks to
// services and repositories through it: no SQL here.
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { VERSION, loadConfig } from '../config.js';
import { createContainer } from '../container.js';
import { createLogger, LEVELS } from '../infra/logger.js';
import { createApp } from '../server.js';
import { isValidDate } from '../dates.js';
import { AppError } from '../errors.js';
import { parseArgs, UsageError } from './args.js';
import { csvLine } from './csv.js';
import { seedDemo } from './demo.js';

export const HELP = `Usage: flock <command> [options]

Commands:
  serve                      Start the web app
  create-admin <username> 'Full Name'
                             Create the first scheduler (prints a temporary password once)
  demo                       Fill an empty database with fake demo data
  backup <file>              Copy the database to a new file (never overwrites)
  export <file.csv> [--from YYYY-MM-DD --to YYYY-MM-DD]
                             Write the schedule as a CSV file (never overwrites)
  help                       Show this help
  version                    Show the version

Options:
  --db <path>                Database file (default: FLOCK_DB, or ./data/flock.db)
`;

class Refusal extends Error {}

function open(options, extra = {}, env = {}) {
  env = { ...env };
  if (options.db) env.FLOCK_DB = options.db;
  return createContainer({ config: loadConfig(env), ...extra });
}

// Runs fn with a container and always closes it.
async function withContainer(options, env, fn) {
  const container = open(options, {}, env);
  try {
    return await fn(container);
  } finally {
    container.close();
  }
}

function args(argv, extraOptions = []) {
  return parseArgs(argv, ['db', ...extraOptions]);
}

function exactly(positionals, n, usage) {
  if (positionals.length !== n) throw new UsageError(`Usage: flock ${usage}`);
}

const refuseOverwrite = (file) => {
  if (existsSync(file)) throw new Refusal(`${file} already exists. Choose a new file name; flock never overwrites.`);
};

export const commands = {
  async help() {
    console.log(HELP);
    return 0;
  },

  async version() {
    console.log(`flock ${VERSION}`);
    return 0;
  },

  async serve(argv, env) {
    const { options } = args(argv);
    const level = Object.hasOwn(LEVELS, env.FLOCK_LOG_LEVEL ?? '') ? env.FLOCK_LOG_LEVEL : 'info';
    const logger = createLogger({ level }); // the server's own log goes to stdout
    let container;
    try {
      container = open(options, { logger }, env);
    } catch (err) {
      console.error(err.message);
      return 1;
    }
    const app = createApp({ container });
    const port = await app.listen(container.config.port);
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

  async 'create-admin'(argv, env) {
    const { positionals, options } = args(argv);
    exactly(positionals, 2, "create-admin <username> 'Full Name'");
    const [username, name] = positionals;
    return withContainer(options, env, async ({ services, data }) => {
      if (await data.people.findAuthByUsername(username)) throw new Refusal(`The username "${username}" already exists.`);
      const { person, tempPassword } = await services.people.create(null, { name, username, role: 'admin' });
      console.log(`Created the scheduler "${person.username}" (${person.name}).`);
      console.log(`Temporary password: ${tempPassword}`);
      console.log('Log in with this, then choose your own password. It is shown only once.');
      return 0;
    });
  },

  async demo(argv, env) {
    const { positionals, options } = args(argv);
    exactly(positionals, 0, 'demo');
    return withContainer(options, env, async (container) => {
      if ((await container.data.maintenance.personCount()) > 0) {
        throw new Refusal('This database already has people, so flock will not add demo data. Use a new, empty database.');
      }
      const { tempPassword, counts } = await seedDemo(container);
      console.log(`Demo data added: ${counts.people} people, ${counts.teams} teams, ${counts.services} services, ${counts.blockouts} blockouts.`);
      console.log('Everything here is fake.');
      console.log('Admin username: demo-admin');
      console.log(`Temporary password: ${tempPassword}`);
      console.log('Log in with this, then choose your own password. It is shown only once.');
      return 0;
    });
  },

  async backup(argv, env) {
    const { positionals, options } = args(argv);
    exactly(positionals, 1, 'backup <file>');
    const file = path.resolve(positionals[0]);
    return withContainer(options, env, async ({ data }) => {
      refuseOverwrite(file);
      await data.maintenance.backupTo(file);
      console.log(`Backup written to ${file}`);
      return 0;
    });
  },

  async export(argv, env) {
    const { positionals, options } = args(argv, ['from', 'to']);
    exactly(positionals, 1, 'export <file.csv> [--from YYYY-MM-DD --to YYYY-MM-DD]');
    const { from, to } = options;
    for (const [k, v] of [['from', from], ['to', to]]) {
      if (v !== undefined && !isValidDate(v)) throw new UsageError(`--${k} must be a real date like 2026-03-01`);
    }
    if (from && to && to < from) throw new UsageError('--to must not be before --from');
    const file = path.resolve(positionals[0]);
    return withContainer(options, env, async ({ data }) => {
      refuseOverwrite(file);
      const slots = await data.slots.listForServices(from ?? '0001-01-01', to ?? '9999-12-31');
      const lines = [csvLine(['date', 'time', 'service', 'team', 'position', 'person', 'status'])];
      for (const s of slots) {
        lines.push(csvLine([s.serviceDate, s.serviceTime, s.serviceTitle, s.teamName, s.positionName, s.personName ?? '', s.status]));
      }
      writeFileSync(file, `${lines.join('\n')}\n`, { flag: 'wx' });
      console.log(`Exported ${slots.length} rows to ${file}`);
      return 0;
    });
  },
};

/** Run the CLI. Returns an exit code, or null when a server keeps running. */
export async function run(argv, env = {}) {
  let name = argv[0];
  if (name === '--version') name = 'version';
  if (name === '--help' || name === '-h') name = 'help';
  if (!name || !Object.hasOwn(commands, name)) {
    console.error(`${name ? `Unknown command: ${name}\n\n` : ''}${HELP}`);
    return 1;
  }
  try {
    return await commands[name](argv.slice(1), env);
  } catch (err) {
    if (err instanceof UsageError || err instanceof Refusal || err instanceof AppError || err?.name === 'ConfigError') {
      console.error(err.message);
      return 1;
    }
    console.error(`flock ${name} failed: ${err?.message ?? err}`);
    return 1;
  }
}
