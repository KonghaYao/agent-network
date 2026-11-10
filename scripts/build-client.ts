#!/usr/bin/env bun
/**
 * 把 client/cli.ts 打包成单文件可执行 JS：public/skills/agentnet.js。
 *
 * - 不注入 PUBLIC_ORIGIN、token 或任何部署信息；URL/凭据只从运行时参数
 *   或 AGENTNET_URL / AGENTNET_TOKEN 读取。
 * - 输出不含 sourcemap 与时间戳，重复构建应得到同一份字节。
 */

import { chmod, mkdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const outdir = resolve(root, 'public/skills');
const outfile = resolve(outdir, 'agentnet.js');

await mkdir(outdir, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(root, 'client/cli.ts')],
  target: 'bun',
  format: 'esm',
  outdir,
  naming: 'agentnet.js',
  minify: false,
  sourcemap: 'none',
  banner: '#!/usr/bin/env bun',
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

await chmod(outfile, 0o755);
const info = await stat(outfile);
console.log(`build:client -> ${relative(root, outfile)} (${info.size} bytes)`);
