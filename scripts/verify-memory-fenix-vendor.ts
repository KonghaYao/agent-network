/**
 * Build assertion for the Fenix memory vendor phase.
 *
 * 1. Builds a test-only lazy host that dynamically imports `fenix/index.ts`.
 * 2. Asserts the vendor code is emitted as a separate chunk (not in the host entry).
 * 3. Asserts the scoped Tailwind CSS is emitted without preflight.
 * 4. Asserts the ported JS contains no innerHTML-style sinks.
 * 5. Asserts the production SPA manifest does not reference `fenix/`.
 */

import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build, type Manifest } from 'vite';

const root = resolve(import.meta.dir, '..');
const outDir = join(root, 'dist/fenix-vendor-check');
const hostEntry = join(root, 'tests/fixtures/fenix-lazy-host.tsx');

let failures = 0;

function check(condition: boolean, message: string): void {
  if (condition) {
    console.log(`ok - ${message}`);
    return;
  }
  failures += 1;
  console.error(`not ok - ${message}`);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sizeOf(path: string): number {
  return statSync(path).size;
}

rmSync(outDir, { recursive: true, force: true });

await build({
  root,
  configFile: false,
  base: '/static/',
  plugins: [react(), tailwindcss()],
  logLevel: 'warn',
  build: {
    outDir,
    emptyOutDir: true,
    manifest: true,
    sourcemap: false,
    target: 'es2022',
    rollupOptions: { input: hostEntry },
  },
});

const manifest = JSON.parse(read(join(outDir, '.vite/manifest.json'))) as Manifest;
const hostKey = Object.keys(manifest).find((key) => key.includes('fenix-lazy-host'));
check(Boolean(hostKey), 'lazy host entry exists in the build manifest');

const hostChunk = hostKey ? manifest[hostKey] : undefined;
check(Boolean(hostChunk), 'lazy host chunk resolved');

const fenixKey = Object.keys(manifest).find((key) => key.includes('features/memory/fenix/index'));
check(Boolean(fenixKey), 'fenix/index.ts is emitted as its own module chunk');

check(
  Boolean(hostChunk && hostChunk.dynamicImports?.some((key) => key.includes('features/memory/fenix/index'))),
  'lazy host references fenix/index.ts through a dynamic import',
);

const hostCode = hostChunk ? read(join(outDir, hostChunk.file)) : '';
check(
  !hostCode.includes('FENIX_MEMORY_VENDOR_MARKER') && !hostCode.includes('fenix-memory-vendor-chunk'),
  'host entry does not inline the fenix vendor chunk marker',
);

const fenixChunk = fenixKey ? manifest[fenixKey] : undefined;
const fenixCode = fenixChunk ? read(join(outDir, fenixChunk.file)) : '';
check(
  fenixCode.includes('fenix-memory-vendor-chunk') || hostCode.includes('FENIX_MEMORY_VENDOR_MARKER'),
  'vendor marker is present outside the host entry (chunk separation proven)',
);

const cssFiles = readdirSync(join(outDir, 'assets')).filter((file) => file.endsWith('.css'));
check(cssFiles.length > 0, 'fenix Tailwind CSS asset is emitted');

const css = cssFiles.map((file) => read(join(outDir, 'assets', file))).join('\n');
check(css.includes('.fenix-memory-root'), 'CSS contains the scoped root selector');
check(!css.includes('-webkit-text-size-adjust'), 'CSS does not contain Tailwind preflight (html adjust)');
check(!css.includes('html,:host'), 'CSS does not contain Tailwind preflight (html selector)');
check(!css.includes('@layer base{html'), 'CSS does not contain a global html reset');

function walkSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkSources(path, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(path);
  }
  return out;
}

const sources = walkSources(join(root, 'src/web/features/memory/fenix')).map(read).join('\n');
check(!/innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML/.test(sources), 'ported source has no HTML injection sinks');

const hostSize = hostChunk ? sizeOf(join(outDir, hostChunk.file)) : 0;
const fenixSize = fenixChunk ? sizeOf(join(outDir, fenixChunk.file)) : 0;
const cssSize = cssFiles.reduce((total, file) => total + sizeOf(join(outDir, 'assets', file)), 0);
console.log(`sizes: host=${hostSize} B, fenix-entry=${fenixSize} B, css=${cssSize} B`);

const productionManifestPath = join(root, 'dist/web/.vite/manifest.json');
try {
  const productionManifest = read(productionManifestPath);
  check(!productionManifest.includes('features/memory/fenix'), 'production SPA manifest does not reference fenix/');
} catch {
  console.log('skip - production manifest not found (run `bun run build:web` first)');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall fenix vendor checks passed');
