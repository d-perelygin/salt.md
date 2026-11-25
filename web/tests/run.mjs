// Runs the browser regressions in parallel.
//
//   node run.mjs                 # everything in package.json's test script
//   node run.mjs --jobs 4        # cap the workers (default: cores - 2, max 4)
//   node run.mjs --serial        # one at a time, the old behaviour
//   node run.mjs mobile-shell    # only tests whose name contains/equals it
//
// Every test already brings its own server, data directory and browser, so
// they can run side by side; the only shared thing is the built binary in
// web/dist, which is read-only while the tests run. Each worker's output is
// captured and printed only when it fails, so a run reads as a list of names
// instead of forty interleaved logs.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const all = Array.isArray(pkg.testFiles)
  ? pkg.testFiles
  : pkg.scripts.test
    .split('&&')
    .map((part) => part.trim().replace(/^node\s+/, ''))
    .filter(Boolean);

const argv = process.argv.slice(2);
let jobs = Math.max(1, Math.min(4, (cpus().length || 4) - 2));
const filters = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--serial') jobs = 1;
  else if (arg === '--jobs' || arg === '-j') jobs = Math.max(1, Number.parseInt(argv[++i], 10) || 1);
  else if (arg.startsWith('--jobs=')) jobs = Math.max(1, Number.parseInt(arg.slice(7), 10) || 1);
  else filters.push(arg);
}

let files = all;
if (filters.length) {
  files = all.filter((file) => {
    const name = file.replace(/\.mjs$/, '');
    return filters.some((f) => f === file || f === name || name.startsWith(f));
  });
}
if (files.length === 0) {
  console.error(`No test matches ${filters.join(' ')}. Known: ${all.map((f) => f.replace(/\.mjs$/, '')).join(', ')}`);
  process.exit(2);
}

const queue = files.slice();
const failures = [];
let running = 0;
const started = Date.now();

const seconds = (ms) => (ms / 1000).toFixed(1);

const finish = new Promise((resolve) => {
  const next = () => {
    if (queue.length === 0 && running === 0) return resolve();
    while (running < jobs && queue.length > 0) {
      const file = queue.shift();
      running++;
      const at = Date.now();
      const child = spawn(process.execPath, [join(here, file)], {
        cwd: here,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => {
        running--;
        const took = Date.now() - at;
        process.stdout.write(`${code === 0 ? '✓' : '✗'} ${file} (${seconds(took)}s)\n`);
        if (code !== 0) failures.push({ file, out, code, took });
        next();
      });
    }
  };
  next();
});

await finish;

const total = ((Date.now() - started) / 1000).toFixed(1);
if (failures.length === 0) {
  console.log(`\n${files.length} of ${files.length} passed in ${total}s with ${jobs} worker${jobs === 1 ? '' : 's'}.`);
  process.exit(0);
}
for (const { file, out } of failures) {
  console.log(`\n${'='.repeat(60)}\n${file}\n${'='.repeat(60)}\n${out.trimEnd()}`);
}
console.log(`\n${failures.length} of ${files.length} failed in ${total}s: ${failures.map((f) => f.file).join(', ')}`);
process.exit(1);
