/**
 * 首次迁移：归档线上正在服务的 `dist/web` 与两个模块的实际响应字节，
 * 建立可回滚的 baseline release，并冻结固定兼容别名。
 *
 * 必须在第一次用新发布模型重启前执行。固定别名只能冻结一次；
 * 无法取得线上模块准确字节时停止迁移，绝不用重新构建的 bundle 顶替。
 */

import { cp, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import {
  buildIdDirectory,
  computeBuildId,
  readCurrentBuildId,
  sha256Hex,
  staticRelativeFromUrl,
  staticUrlFromRelative,
  WEB_CONTRACT_VERSION,
  WEB_RELEASE_MAX_CONTRACT,
  WEB_RELEASE_MIN_CONTRACT,
  WEB_RELEASE_SCHEMA_VERSION,
  writeJsonAtomic,
  type WebReleaseManifest,
} from '../src/web/web-release';
import { LIMITS } from '../src/contracts/limits';
import {
  collectAssets,
  defaultReleasesRoot,
  parseArgs,
  publishCandidate,
  readViteEntry,
  type WebReleaseCandidate,
} from './lib/web-release';

const args = parseArgs(process.argv.slice(2));
const root = args.values.get('root') ?? defaultReleasesRoot();
const dist = resolve(args.values.get('dist') ?? 'dist/web');
const baseUrl = (args.values.get('base-url') ?? 'http://127.0.0.1:8792').replace(/\/+$/u, '');

async function fetchModule(name: 'chat-markdown.js' | 'chat-drawboard.js'): Promise<Uint8Array> {
  const url = `${baseUrl}/assets/${name}`;
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取线上模块 ${url}: ${reason.slice(0, 200)}`);
  }
  if (response.status !== 200) {
    throw new Error(`无法读取线上模块 ${url}: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error(`线上模块为空: ${url}`);
  return bytes;
}

try {
  const existing = await readCurrentBuildId(root);
  if (existing) {
    throw new Error(`发布根已有 current 指针，拒绝重复迁移: ${root}`);
  }
  const manifestInfo = await stat(join(dist, '.vite/manifest.json')).catch(() => null);
  if (!manifestInfo?.isFile()) {
    throw new Error(`dist manifest 不存在，不能归档: ${dist}/.vite/manifest.json`);
  }

  const [markdownBytes, drawboardBytes] = await Promise.all([
    fetchModule('chat-markdown.js'),
    fetchModule('chat-drawboard.js'),
  ]);
  const candidatesRoot = join(root, 'candidates');
  await mkdir(candidatesRoot, { recursive: true });
  const candidateDir = await mkdtemp(join(candidatesRoot, 'migration-'));
  const webDir = join(candidateDir, 'web');
  await cp(dist, webDir, { recursive: true });

  const markdownUrl = staticUrlFromRelative(
    `assets/chat-markdown-${sha256Hex(markdownBytes).slice(0, 12)}.js`,
  );
  const drawboardUrl = staticUrlFromRelative(
    `assets/chat-drawboard-${sha256Hex(drawboardBytes).slice(0, 12)}.js`,
  );
  await writeFile(join(webDir, staticRelativeFromUrl(markdownUrl)), markdownBytes);
  await writeFile(join(webDir, staticRelativeFromUrl(drawboardUrl)), drawboardBytes);

  const graph = await readViteEntry(webDir);
  // 只有 assets/ 下的 Vite 内容地址文件允许 immutable；迁移归档的其它
  // 公开文件（例如 public 副本）保持 no-cache + 内容 ETag。
  const assets = await collectAssets(webDir, {
    immutable: (relative) => relative.startsWith('assets/'),
    strictMime: false,
  });
  const byUrl = new Map(assets.map((asset) => [asset.url, asset]));
  const entry = byUrl.get(staticUrlFromRelative(graph.entryFile));
  if (!entry) throw new Error('归档入口不在构建产物中');
  if (entry.bytes > LIMITS.webEntryHardLimitBytes) {
    throw new Error(`归档入口 ${entry.bytes} B 超过上限 ${LIMITS.webEntryHardLimitBytes} B`);
  }
  const css = graph.cssFiles.map((file) => staticUrlFromRelative(file));
  const markdownAsset = byUrl.get(markdownUrl);
  const drawboardAsset = byUrl.get(drawboardUrl);
  if (!markdownAsset || !drawboardAsset) throw new Error('归档模块未纳入清单');

  const digestInput = {
    schemaVersion: WEB_RELEASE_SCHEMA_VERSION,
    webContract: WEB_CONTRACT_VERSION,
    minWebContract: WEB_RELEASE_MIN_CONTRACT,
    maxWebContract: WEB_RELEASE_MAX_CONTRACT,
    entry: staticUrlFromRelative(graph.entryFile),
    css,
    modules: { markdown: markdownAsset, drawboard: drawboardAsset },
    assets,
  } as const;
  const manifest: WebReleaseManifest = {
    ...digestInput,
    buildId: computeBuildId(digestInput),
    createdAt: new Date().toISOString(),
  };
  const candidate: WebReleaseCandidate = {
    candidateDir,
    webDir,
    manifest,
    modules: {
      markdown: { url: markdownUrl, bytes: markdownBytes },
      drawboard: { url: drawboardUrl, bytes: drawboardBytes },
    },
  };
  await writeJsonAtomic(join(candidateDir, 'release.json'), manifest);
  const result = await publishCandidate(candidate, {
    releasesRoot: root,
    activate: true,
    pin: 'migration-baseline',
    freezeLegacy: true,
    keepCandidate: false,
    log: (message) => console.log(message),
  });
  console.log(
    JSON.stringify(
      {
        baselineBuildId: result.buildId,
        deploymentId: result.deploymentId,
        releaseDir: join(root, 'releases', buildIdDirectory(manifest.buildId)),
        entry: manifest.entry,
        entryBytes: entry.bytes,
        assets: manifest.assets.length,
        legacy: {
          markdown: { bytes: markdownBytes.byteLength, sha256: markdownAsset.sha256 },
          drawboard: { bytes: drawboardBytes.byteLength, sha256: drawboardAsset.sha256 },
        },
      },
      null,
      2,
    ),
  );
  console.log('基线发布已建立，固定别名已冻结；现在可以构建并切换第一个新发布。');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
