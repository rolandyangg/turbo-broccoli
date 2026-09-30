#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so no build step is required.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const r = spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(r.status ?? 1);
