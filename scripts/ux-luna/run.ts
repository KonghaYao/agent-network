import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Each suite owns a fresh server, temporary SQLite store and synthetic actors.
// Run sequentially: the fixtures also own their browser and listen port.
const output = process.env.UX_OUTPUT || await mkdtemp(join(tmpdir(), 'webots-ux-results-'));
const suites = [
  'client-syntax', 'recall-fixes', 'chat-fixes', 'group-fixes',
  'search-fixes', 'actions-fixes', 'recall-offline', 'mobile-fixes',
];
for (const suite of suites) {
  console.log(`\nRunning UX suite: ${suite}`);
  const process = Bun.spawn([Bun.which('bun') || 'bun', resolve(import.meta.dir, `${suite}.ts`)], {
    env: { ...Bun.env, UX_OUTPUT: output }, stdout: 'inherit', stderr: 'inherit',
  });
  const code = await process.exited;
  if (code !== 0) throw new Error(`UX suite ${suite} failed (${code}); reports: ${output}`);
}
console.log(`UX suites passed: ${suites.length}; reports: ${output}`);
