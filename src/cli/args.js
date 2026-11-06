// Tiny argument parser for the CLI: positionals plus `--name value` options.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * @param {string[]} argv
 * @param {string[]} valueOptions  Option names (without --) that take a value.
 * @returns {{positionals: string[], options: Record<string, string>}}
 */
export function parseArgs(argv, valueOptions) {
  const positionals = [];
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const [rawName, inline] = a.slice(2).split(/=(.*)/s, 2);
      if (!valueOptions.includes(rawName)) throw new UsageError(`Unknown option: --${rawName}`);
      let value = inline;
      if (value === undefined) {
        value = argv[++i];
        if (value === undefined) throw new UsageError(`Option --${rawName} needs a value`);
      }
      options[rawName] = value;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, options };
}
