#!/usr/bin/env node
// Builds whichever snapshots are missing. They aren't in git, so a fresh clone
// fetches them before its first dev, build, test or bench run; once they exist
// this does nothing (`pnpm data` refreshes them).

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = (file) => join(root, 'web', 'public', 'data', file);

const BUILDERS = [
  { script: 'fetch-tles.mjs', files: ['catalog.bin', 'catalog.json'] },
  { script: 'fetch-ephemeris.mjs', files: ['ephemeris-moon.bin', 'ephemeris-mars.bin'] },
];

for (const { script, files } of BUILDERS) {
  if (files.every((f) => existsSync(out(f)))) continue;
  console.log(`No ${files.join(' / ')} yet: running data/${script}`);
  const { status } = spawnSync(process.execPath, [join(root, 'data', script)], { stdio: 'inherit' });
  if (status !== 0) process.exit(status ?? 1);
}
