/**
 * Build assertion for the Fenix memory vendor phase.
 *
 * 1. Builds a test-only lazy host that dynamically imports `fenix/index.ts`,
 *    plus a render fixture used by the Playwright vendor spec.
 * 2. Asserts the vendor code is emitted as a separate chunk (not in the host entry).
 * 3. Asserts the scoped Tailwind CSS is emitted without preflight; the only global
 *    layers allowed are Tailwind's `theme` custom properties and `properties`
 *    defaults (documented risk in the PR description).
 * 4. Asserts the ported JS contains no innerHTML-style sinks.
 * 5. Asserts the vendor chunks stay under the phase size budget.
 * 6. Requires the production SPA manifest and asserts the Fenix memory code is
 *    reachable only through the dynamic AgentMemoryDialog/DataView chunks
 *    (stage 4 wires the vendor UI into the panel), and stays within budgets.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { build, type Manifest } from 'vite';

const root = resolve(import.meta.dir, '..');
const outDir = join(root, 'dist/fenix-vendor-check');
const hostEntry = join(root, 'tests/fixtures/fenix-lazy-host.tsx');
const renderEntry = join(root, 'tests/fixtures/fenix-render-host.html');

/** Phase budget: these chunks are lazy vendor code, never first paint. */
const HOST_MAX_BYTES = 64 * 1024;
const FENIX_ENTRY_MAX_BYTES = 320 * 1024;
const CSS_MAX_BYTES = 96 * 1024;

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
    rollupOptions: {
      input: {
        'fenix-lazy-host': hostEntry,
        'fenix-render-host': renderEntry,
      },
    },
  },
});

const manifest = JSON.parse(read(join(outDir, '.vite/manifest.json'))) as Manifest;
const hostKey = Object.keys(manifest).find((key) => key.includes('fenix-lazy-host'));
check(Boolean(hostKey), 'lazy host entry exists in the build manifest');

const hostChunk = hostKey ? manifest[hostKey] : undefined;
check(Boolean(hostChunk), 'lazy host chunk resolved');

const fenixKey = Object.keys(manifest).find((key) => key.includes('features/memory/fenix/index'));
check(Boolean(fenixKey), 'fenix/index.ts is emitted as its own module chunk');

const renderKey = Object.keys(manifest).find((key) => key.includes('fenix-render-host.html'));
check(Boolean(renderKey), 'render fixture HTML is emitted for the Playwright vendor spec');
check(
  existsSync(join(outDir, 'tests/fixtures/fenix-render-host.html')),
  'render fixture page is written at the path served by the e2e spec',
);

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
check(
  /@layer\s+base\s*\{\s*\.fenix-memory-root\b/u.test(css),
  'custom reset layer starts at .fenix-memory-root',
);
check(
  !/@layer\s+base\s*\{\s*(?:html|:root|:host|\*)/u.test(css),
  'custom reset layer does not target html, :root, :host or *',
);
// Tailwind always emits these two global layers; they declare custom properties only
// (`theme` on :root/:host, `properties` defaults on *). They are a known global
// side effect of the vendor stylesheet, not a reset. Pin them so a future Tailwind
// upgrade that widens the global surface (e.g. preflight in `base`) fails here.
check(
  css.includes('@layer theme{:root,:host{'),
  'Tailwind theme variables stay in the known global :root,:host layer',
);
check(
  css.includes('@layer properties{'),
  'Tailwind property defaults stay in the known global properties layer',
);

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

check(hostSize > 0 && hostSize <= HOST_MAX_BYTES, `host chunk size ${hostSize} B <= ${HOST_MAX_BYTES} B`);
check(
  fenixSize > 0 && fenixSize <= FENIX_ENTRY_MAX_BYTES,
  `fenix entry size ${fenixSize} B <= ${FENIX_ENTRY_MAX_BYTES} B`,
);
check(cssSize > 0 && cssSize <= CSS_MAX_BYTES, `fenix CSS size ${cssSize} B <= ${CSS_MAX_BYTES} B`);

const productionManifestPath = join(root, 'dist/web/.vite/manifest.json');
const hasProductionManifest = existsSync(productionManifestPath);
check(
  hasProductionManifest,
  'production SPA manifest exists (run `bun run build:web` first)',
);
if (hasProductionManifest) {
  const productionManifest = JSON.parse(read(productionManifestPath)) as Manifest;
  const productionKeys = Object.keys(productionManifest);
  const entryKey = productionKeys.find((key) => key.endsWith('src/web/app/main.tsx'));
  const dialogKey = productionKeys.find(
    (key) => key.includes('AgentMemoryDialog') && key.endsWith('.js'),
  );
  const dataViewKey = productionKeys.find(
    (key) => key.includes('features/memory/fenix/components/DataView') && key.endsWith('.tsx'),
  );
  const entry = entryKey ? productionManifest[entryKey] : undefined;
  const dialog = dialogKey ? productionManifest[dialogKey] : undefined;
  const dataView = dataViewKey ? productionManifest[dataViewKey] : undefined;

  check(Boolean(entry), 'production entry resolves in the manifest');
  check(
    Boolean(dialog && entry?.dynamicImports?.includes(dialogKey as string)),
    'AgentMemoryDialog stays behind a dynamic import from the SPA entry',
  );
  check(
    Boolean(dataView && dialog?.dynamicImports?.some((key) => key.includes('features/memory/fenix/components/DataView'))),
    'Fenix DataView stays behind a dynamic import from AgentMemoryDialog',
  );

  const entryCode = entry ? read(join(root, 'dist/web', entry.file)) : '';
  check(
    !entryCode.includes('fenix-memory-root') && !entryCode.includes('fenix-constellation'),
    'production entry does not inline Fenix memory markup',
  );
  const entrySize = entry ? sizeOf(join(root, 'dist/web', entry.file)) : 0;
  check(entrySize > 0 && entrySize <= 950 * 1024, `production entry size ${entrySize} B <= 950 KiB`);

  const memoryJs = productionKeys
    .map((key) => productionManifest[key])
    .filter((chunk): chunk is NonNullable<typeof chunk> => Boolean(chunk?.file))
    .filter((chunk) =>
      /(?:AgentMemoryDialog|DataView|MemoryDetailModal|MemoryEntities)-/.test(chunk.file),
    )
    .reduce((total, chunk) => total + sizeOf(join(root, 'dist/web', chunk.file)), 0);
  check(memoryJs > 0 && memoryJs <= 300 * 1024, `memory lazy JS total ${memoryJs} B <= 300 KiB`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall fenix vendor checks passed');
