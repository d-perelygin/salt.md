// Runs the browser regressions in parallel.
//
//   node run.mjs                 # everything in package.json's test script
//   node run.mjs --jobs 4        # cap the workers (default: 2; see below)
//   node run.mjs --serial        # one at a time, the old behaviour
//   node run.mjs mobile-shell    # only tests whose name contains/equals it
//
// Every test already brings its own server, data directory and browser, so
// they can run side by side. The binary is built once here and handed to every
// test through SALT_TEST_BINARY, which fixture.mjs reads; web/dist is read-only while
// the tests run. Each worker's output is
// captured and printed only when it fails, so a run reads as a list of names
// instead of forty interleaved logs.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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
// Two, and starts are spaced out. Four browsers and four servers on one laptop
// made a different test fail on every run (each green on its own), and macOS
// sometimes refuses a Chrome whose code-sign clone lands while another launch
// is in flight. --jobs 4 is still there for a hurry.
let jobs = Math.max(1, Math.min(2, (cpus().length || 4) - 2));
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

// One build for the whole run. A fixture used to build the binary itself;
// cached, that was quick, but four at a time still fought over the cache.
const buildDir = mkdtempSync(join(tmpdir(), 'salt-tests-'));
const binary = join(buildDir, 'salt');
const cleanup = () => rmSync(buildDir, { recursive: true, force: true });
process.once('exit', cleanup);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    cleanup();
    process.exit(1);
  });
}
const built = spawnSync(process.env.GO_BINARY || 'go', ['build', '-o', binary, '.'], {
  cwd: resolve(here, '../..'),
  encoding: 'utf8',
});
if (built.status !== 0) {
  console.error(`Build failed:\n${built.stderr || built.stdout}`);
  process.exit(1);
}
const childEnv = { ...process.env, SALT_TEST_BINARY: binary };

// A backstop, not a target: a test takes seconds here. Without it one stuck
// browser launch blocks the whole run for as long as the terminal stays open.
const TEST_TIMEOUT_MS = Number(process.env.TEST_TIMEOUT_MS) || 120_000;

const queue = files.slice();
const failures = [];
// One retry per file. On this laptop a Chrome launch or a busy moment fails
// one test every few runs, always a different one, and each passes alone; a
// real regression fails both times. The retry is printed, never silent.
const retried = new Set();
let running = 0;
// A short gap between launches: the burst was what the browser launches and
// the servers fought over.
const SPAWN_GAP_MS = 700;
let lastSpawnAt = 0;
const started = Date.now();

const seconds = (ms) => (ms / 1000).toFixed(1);

const finish = new Promise((resolve) => {
  const next = () => {
    if (queue.length === 0 && running === 0) return resolve();
    while (running < jobs && queue.length > 0) {
      const wait = SPAWN_GAP_MS - (Date.now() - lastSpawnAt);
      if (wait > 0) {
        setTimeout(next, wait);
        return;
      }
      const file = queue.shift();
      running++;
      lastSpawnAt = Date.now();
      const at = Date.now();
      const child = spawn(process.execPath, [join(here, file)], {
        cwd: here,
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      const timer = setTimeout(() => {
        out += `\nTimed out after ${TEST_TIMEOUT_MS / 1000}s; killed.\n`;
        child.kill('SIGKILL');
      }, TEST_TIMEOUT_MS);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('close', (code) => {
        clearTimeout(timer);
        running--;
        const took = Date.now() - at;
        process.stdout.write(`${code === 0 ? '✓' : '✗'} ${file} (${seconds(took)}s)\n`);
        if (code !== 0) {
          if (!retried.has(file)) {
            retried.add(file);
            process.stdout.write(`↻ ${file} failed; retrying once\n`);
            queue.push(file);
          } else {
            failures.push({ file, out, code, took });
          }
        }
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
