import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

interface Chunk {
  file: string;
  imports?: string[];
  dynamicImports?: string[];
  css?: string[];
}

const root = resolve(import.meta.dirname, '../dist/web');
const manifest = await Bun.file(resolve(root, '.vite/manifest.json')).json() as Record<string, Chunk>;
const entry = 'src/web/app/main.tsx';
const visited = new Set<string>();
const js = new Set<string>();
const css = new Set<string>();
function visit(key: string) {
  if (visited.has(key)) return;
  visited.add(key);
  const chunk = manifest[key];
  if (!chunk) throw new Error(`manifest 缺少 ${key}`);
  js.add(chunk.file);
  for (const file of chunk.css ?? []) css.add(file);
  for (const dependency of chunk.imports ?? []) visit(dependency);
}
visit(entry);
async function bytes(files: Set<string>) {
  return (await Promise.all([...files].map(async (file) => (await stat(resolve(root, file))).size)))
    .reduce((sum, size) => sum + size, 0);
}
const main = manifest[entry];
if (!main) throw new Error('manifest 缺少应用入口');
console.log(JSON.stringify({
  entry: main.file,
  entryBytes: (await stat(resolve(root, main.file))).size,
  staticJsBytes: await bytes(js),
  staticCssBytes: await bytes(css),
  staticFiles: [...js, ...css],
  dynamicImports: main.dynamicImports ?? [],
}, null, 2));
