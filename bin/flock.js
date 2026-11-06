#!/usr/bin/env node
// Thin entry point: all the work is in src/cli/.
import { run } from '../src/cli/commands.js';

const code = await run(process.argv.slice(2), process.env);
if (code !== null && code !== undefined) process.exit(code);
