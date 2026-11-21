/**
 * 发布底座的构建、候选校验、追加式发布、回滚与清理实现。
 *
 * 所有写操作都通过同一个本机目录锁串行化；资源先落盘并写入原子索引，
 * 最后才切换 `current`。任何校验失败都不得改变入口指针。
 */

import type { Dirent } from 'node:fs';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import { LIMITS } from '../../src/contracts/limits';
import { buildDrawboardBundle } from '../../src/web/drawboard-bundle';
import { buildMarkdownBundle } from '../../src/web/markdown-bundle';
import {
  activateDeployment,
  buildIdDirectory,
  computeBuildId,
  contentTypeForPath,
  isSafeRelativePath,
  listDeployments,
  readCurrentBuildId,
  readImmutableIndex,
  readLegacyAliases,
  readReleaseManifest,
  sha256Hex,
  staticRelativeFromUrl,
  staticUrlFromRelative,
  verifyFile,
  verifyReleaseAssets,
  WEB_CONTRACT_VERSION,
  WEB_RELEASE_MAX_CONTRACT,
  WEB_RELEASE_MIN_CONTRACT,
  WEB_RELEASE_SCHEMA_VERSION,
  writeJsonAtomic,
  type ImmutableIndex,
  type WebLegacyAliases,
  type WebReleaseAsset,
  type WebReleaseManifest,
} from '../../src/web/web-release';

import { readPins, withReleaseLock, writeReleasePin } from './web-release-state';

export { addPin, readPins, withReleaseLock, type Pins } from './web-release-state';

const REPO_ROOT = resolve(import.meta.dir, '../..');

export interface CliArgs {
  readonly flags: ReadonlySet<string>;
  readonly values: ReadonlyMap<string, string>;
  readonly positionals: readonly string[];
}

/** 支持 `--flag`、`--name value` 与 `--name=value`，不引入参数解析依赖。 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    if (!argument.startsWith('--')) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    if (equals > 0) {
      values.set(argument.slice(2, equals), argument.slice(equals + 1));
      continue;
    }
    const name = argument.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      values.set(name, next);
      index += 1;
    } else {
      flags.add(name);
    }
  }
  return { flags, values, positionals };
}

export function defaultReleasesRoot(): string {
  return resolve(process.env.WEB_RELEASES_ROOT ?? join(REPO_ROOT, 'dist/web-releases'));
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(2)} MiB`;
}

async function pathInfo(path: string) {
  return stat(path).catch(() => null);
}

async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, data);
  await rename(temporary, path);
}

async function copyFileAtomic(source: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await copyFile(source, temporary);
  await rename(temporary, target);
}

export async function walkFiles(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix.length > 0 ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`构建产物不允许符号链接: ${relative}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(root, relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`构建产物包含非普通文件: ${relative}`);
    }
  }
  return files;
}

interface ViteChunk {
  file?: unknown;
  isEntry?: unknown;
  imports?: unknown;
  dynamicImports?: unknown;
  css?: unknown;
  assets?: unknown;
}

export interface ViteEntryGraph {
  readonly entryFile: string;
  readonly cssFiles: readonly string[];
  readonly files: ReadonlySet<string>;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

export async function readViteEntry(webDir: string): Promise<ViteEntryGraph> {
  const manifestPath = join(webDir, '.vite/manifest.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Vite manifest 不可读: ${reason.slice(0, 200)}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Vite manifest 必须是对象');
  }
  const manifest = parsed as Record<string, ViteChunk>;
  const files = new Set<string>();
  const checkFile = async (relative: string): Promise<void> => {
    if (!isSafeRelativePath(relative)) throw new Error(`Vite 产物路径不安全: ${relative}`);
    const info = await pathInfo(join(webDir, relative));
    if (!info?.isFile()) throw new Error(`Vite 产物缺失: ${relative}`);
    files.add(relative);
  };
  for (const chunk of Object.values(manifest)) {
    if (!chunk || typeof chunk !== 'object' || typeof chunk.file !== 'string') {
      throw new Error('Vite manifest 条目缺少 file');
    }
    await checkFile(chunk.file);
    for (const file of [...stringArray(chunk.css), ...stringArray(chunk.assets)]) {
      await checkFile(file);
    }
    for (const dependency of stringArray(chunk.imports)) {
      if (!manifest[dependency]) throw new Error(`Vite manifest 缺少 import: ${dependency}`);
    }
    for (const dependency of stringArray(chunk.dynamicImports)) {
      if (!manifest[dependency]) throw new Error(`Vite manifest 缺少 dynamicImport: ${dependency}`);
    }
  }
  const entryKey = manifest['src/web/app/main.tsx']?.isEntry === true
    ? 'src/web/app/main.tsx'
    : Object.keys(manifest).find((key) => manifest[key]?.isEntry === true);
  const entry = entryKey ? manifest[entryKey] : undefined;
  if (!entry || typeof entry.file !== 'string') throw new Error('Vite manifest 缺少应用入口');
  return { entryFile: entry.file, cssFiles: stringArray(entry.css), files };
}

export interface CollectAssetsOptions {
  /** 布尔值或按相对路径判定；只有内容地址文件才允许一年 immutable。 */
  readonly immutable: boolean | ((relative: string) => boolean);
  /** 新发布构建要求所有扩展名都有明确 MIME；迁移归档允许 octet-stream。 */
  readonly strictMime?: boolean;
}

/** 收集目录内全部普通文件；只排除 Vite manifest（不可经 /static 下载）。 */
export async function collectAssets(
  webDir: string,
  options: CollectAssetsOptions,
): Promise<WebReleaseAsset[]> {
  const files = (await walkFiles(webDir)).filter(
    (relative) => relative !== '.vite/manifest.json' && !relative.startsWith('.vite/'),
  );
  const assets: WebReleaseAsset[] = [];
  for (const relative of files) {
    const bytes = await readFile(join(webDir, relative));
    const contentType = contentTypeForPath(relative);
    if (options.strictMime && contentType === 'application/octet-stream') {
      throw new Error(`无法确定构建产物 MIME: ${relative}`);
    }
    assets.push({
      url: staticUrlFromRelative(relative),
      sha256: sha256Hex(bytes),
      bytes: bytes.byteLength,
      contentType,
      immutable:
        typeof options.immutable === 'boolean' ? options.immutable : options.immutable(relative),
    });
  }
  return assets;
}

export interface BuildCandidateOptions {
  readonly releasesRoot: string;
  /** 每次真实构建不同；同时注入客户端用于支持诊断。 */
  readonly nonce?: string;
  readonly log?: (message: string) => void;
}

export interface WebReleaseCandidate {
  readonly candidateDir: string;
  readonly webDir: string;
  readonly manifest: WebReleaseManifest;
  readonly modules: {
    readonly markdown: { readonly url: string; readonly bytes: Uint8Array };
    readonly drawboard: { readonly url: string; readonly bytes: Uint8Array };
  };
}

/**
 * 真实构建一个候选：先 Bun 模块（内存）→ 计算哈希 URL → Vite 独立目录
 * → 落盘模块 → 遍历全部产物生成描述。任何一步失败都不会触碰到当前发布。
 */
export async function buildCandidate(options: BuildCandidateOptions): Promise<WebReleaseCandidate> {
  const log = options.log ?? (() => undefined);
  const nonce = options.nonce ?? crypto.randomUUID();
  const candidatesRoot = join(options.releasesRoot, 'candidates');
  await mkdir(candidatesRoot, { recursive: true });
  const candidateDir = await mkdtemp(join(candidatesRoot, 'build-'));
  const webDir = join(candidateDir, 'web');
  await mkdir(webDir, { recursive: true });

  const [markdownBundle, drawboardBundle] = await Promise.all([
    buildMarkdownBundle(),
    buildDrawboardBundle(),
  ]);
  if (!markdownBundle || !drawboardBundle) {
    const failed = [
      ...(markdownBundle ? [] : ['markdown']),
      ...(drawboardBundle ? [] : ['drawboard']),
    ].join(', ');
    throw new Error(`Bun 模块构建失败: ${failed}`);
  }
  const markdownBytes = new TextEncoder().encode(markdownBundle.code);
  const drawboardBytes = new TextEncoder().encode(drawboardBundle.code);
  const markdownUrl = staticUrlFromRelative(
    `assets/chat-markdown-${sha256Hex(markdownBytes).slice(0, 12)}.js`,
  );
  const drawboardUrl = staticUrlFromRelative(
    `assets/chat-drawboard-${sha256Hex(drawboardBytes).slice(0, 12)}.js`,
  );
  const modulesFile = join(candidateDir, 'modules.json');
  await writeJsonAtomic(modulesFile, { markdown: markdownUrl, drawboard: drawboardUrl });

  // 复用 `bun run build:web` 同一条 Vite CLI 路径；programmatic build 会
  // 跳过 StyleX/lightningcss 的 CLI 侧初始化，导致 @lenso/tokens 编译失败。
  log('vite build 开始');
  const viteBin = resolve(REPO_ROOT, 'node_modules/.bin/vite');
  const child = Bun.spawn([viteBin, 'build', '--outDir', webDir, '--emptyOutDir'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      WEB_BUILD_OUT_DIR: webDir,
      WEB_RELEASE_MODULES_FILE: modulesFile,
      WEB_BUILD_NONCE: nonce,
    } as Record<string, string>,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`vite build 失败（退出码 ${exitCode}）`);

  await writeFileAtomic(join(webDir, staticRelativeFromUrl(markdownUrl)), markdownBytes);
  await writeFileAtomic(join(webDir, staticRelativeFromUrl(drawboardUrl)), drawboardBytes);

  const graph = await readViteEntry(webDir);
  // 只有 Vite 内容地址目录 `assets/` 允许一年 immutable；将来的 sw.js、
  // manifest.webmanifest 等公开文件必须重新验证，使用 no-cache。
  const assets = await collectAssets(webDir, {
    immutable: (relative) => relative.startsWith('assets/'),
    strictMime: true,
  });
  const byUrl = new Map(assets.map((asset) => [asset.url, asset]));
  const entry = byUrl.get(staticUrlFromRelative(graph.entryFile));
  if (!entry) throw new Error('入口不在构建产物中');
  if (entry.bytes > LIMITS.webEntryHardLimitBytes) {
    throw new Error(
      `入口 ${entry.bytes} B 超过上限 ${LIMITS.webEntryHardLimitBytes} B`,
    );
  }
  for (const file of graph.files) {
    if (!byUrl.has(staticUrlFromRelative(file))) {
      throw new Error(`Vite 依赖产物未纳入清单: ${file}`);
    }
  }
  const css = graph.cssFiles.map((file) => staticUrlFromRelative(file));
  for (const href of css) {
    if (!byUrl.has(href)) throw new Error(`入口 CSS 未纳入清单: ${href}`);
  }
  const markdownAsset = byUrl.get(markdownUrl);
  const drawboardAsset = byUrl.get(drawboardUrl);
  if (!markdownAsset || !drawboardAsset) throw new Error('Bun 模块未纳入构建产物');

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
  await writeJsonAtomic(join(candidateDir, 'release.json'), manifest);
  const candidate: WebReleaseCandidate = {
    candidateDir,
    webDir,
    manifest,
    modules: {
      markdown: { url: markdownUrl, bytes: markdownBytes },
      drawboard: { url: drawboardUrl, bytes: drawboardBytes },
    },
  };
  await validateCandidate(candidate);
  log(
    `候选构建完成: ${manifest.buildId} (${manifest.assets.length} assets, entry ${formatBytes(entry.bytes)})`,
  );
  return candidate;
}

/** 发布前重读候选目录中的每个字节，防止构建后/复制前被篡改。 */
export async function validateCandidate(candidate: WebReleaseCandidate): Promise<void> {
  const errors: string[] = [];
  const index: ImmutableIndex = {
    schemaVersion: WEB_RELEASE_SCHEMA_VERSION,
    assets: Object.fromEntries(
      candidate.manifest.assets.map((asset) => [staticRelativeFromUrl(asset.url), asset]),
    ),
  };
  errors.push(
    ...(await verifyReleaseAssets({
      manifest: candidate.manifest,
      publicDir: candidate.webDir,
      index,
    })),
  );
  const entry = candidate.manifest.assets.find((asset) => asset.url === candidate.manifest.entry);
  if (!entry) errors.push('入口不在资源清单中');
  else if (entry.bytes > LIMITS.webEntryHardLimitBytes) {
    errors.push(`入口 ${entry.bytes} B 超过上限 ${LIMITS.webEntryHardLimitBytes} B`);
  }
  if (errors.length > 0) {
    throw new Error(`候选校验失败: ${errors.slice(0, 8).join('; ')}`);
  }
}

export interface PublishOptions {
  readonly releasesRoot: string;
  readonly activate?: boolean;
  /** 只在首次迁移时使用；已存在 legacy.json 时拒绝覆盖。 */
  readonly freezeLegacy?: boolean;
  readonly pin?: 'build' | 'migration-baseline';
  readonly keepCandidate?: boolean;
  readonly log?: (message: string) => void;
}

export interface PublishResult {
  readonly buildId: string;
  readonly deploymentId: string | null;
  readonly releaseDir: string;
  readonly assets: number;
  readonly legacyFrozen: boolean;
}

async function freezeLegacyAliases(
  releasesRoot: string,
  candidate: WebReleaseCandidate,
  resumeMigration: boolean,
): Promise<WebLegacyAliases> {
  const legacyPath = join(releasesRoot, 'legacy.json');
  const existing = await readLegacyAliases(releasesRoot);
  if (existing) {
    if (!resumeMigration || existing.baselineBuildId !== candidate.manifest.buildId) {
      throw new Error('legacy.json 已存在；固定别名只能冻结一次');
    }
    // A previous migration can stop after freezing aliases and before activating current.
    for (const [name, module] of [
      ['chat-markdown.js', candidate.manifest.modules.markdown],
      ['chat-drawboard.js', candidate.manifest.modules.drawboard],
    ] as const) {
      const alias = existing.aliases[name];
      if (alias.sha256 !== module.sha256 || alias.bytes !== module.bytes) {
        throw new Error(`固定别名与迁移基线不一致: ${name}`);
      }
      const failure = await verifyFile(join(releasesRoot, alias.file), alias);
      if (failure) throw new Error(failure);
    }
    return existing;
  }
  const legacyDir = join(releasesRoot, 'legacy');
  await mkdir(legacyDir, { recursive: true });
  const files = [
    { name: 'chat-markdown.js' as const, bytes: candidate.modules.markdown.bytes },
    { name: 'chat-drawboard.js' as const, bytes: candidate.modules.drawboard.bytes },
  ];
  const aliases: Record<string, { file: string; sha256: string; bytes: number; contentType: string }> = {};
  for (const file of files) {
    const relative = `legacy/${file.name}`;
    await writeFileAtomic(join(releasesRoot, relative), file.bytes);
    aliases[file.name] = {
      file: relative,
      sha256: sha256Hex(file.bytes),
      bytes: file.bytes.byteLength,
      contentType: 'text/javascript; charset=utf-8',
    };
  }
  const legacy: WebLegacyAliases = {
    schemaVersion: WEB_RELEASE_SCHEMA_VERSION,
    frozenAt: new Date().toISOString(),
    baselineBuildId: candidate.manifest.buildId,
    aliases: {
      'chat-markdown.js': aliases['chat-markdown.js']!,
      'chat-drawboard.js': aliases['chat-drawboard.js']!,
    },
  };
  await writeJsonAtomic(legacyPath, legacy);
  return legacy;
}

/**
 * 追加资源到共享根并原子扩充索引；全部资源复核通过后才写 release.json
 * 与 current 指针。资源先落盘、索引后提交，任何中途失败都不会公告新入口。
 */
export async function publishCandidate(
  candidate: WebReleaseCandidate,
  options: PublishOptions,
): Promise<PublishResult> {
  const log = options.log ?? (() => undefined);
  await validateCandidate(candidate);
  const publicDir = join(options.releasesRoot, 'public');
  const releaseDir = join(options.releasesRoot, 'releases', buildIdDirectory(candidate.manifest.buildId));
  const baseline = options.pin === 'migration-baseline';
  const deployment = await withReleaseLock(options.releasesRoot, async () => {
    if (baseline && (await readCurrentBuildId(options.releasesRoot))) {
      throw new Error(`发布根已有 current 指针，拒绝重复迁移: ${options.releasesRoot}`);
    }
    await mkdir(publicDir, { recursive: true });
    const indexPath = join(options.releasesRoot, 'immutable-index.json');
    const indexInfo = await pathInfo(indexPath);
    const existing = await readImmutableIndex(indexPath);
    if (!existing.index && indexInfo) {
      throw new Error(`发布索引存在但不可读，拒绝发布: ${existing.errors.join('; ')}`);
    }
    const previous: ImmutableIndex =
      existing.index ?? { schemaVersion: WEB_RELEASE_SCHEMA_VERSION, assets: {} };
    const assets: Record<string, WebReleaseAsset> = { ...previous.assets };
    for (const asset of candidate.manifest.assets) {
      const relative = staticRelativeFromUrl(asset.url);
      const source = join(candidate.webDir, relative);
      const target = join(publicDir, relative);
      const indexed = assets[relative];
      if (indexed) {
        if (
          indexed.sha256 !== asset.sha256 ||
          indexed.bytes !== asset.bytes ||
          indexed.contentType !== asset.contentType ||
          indexed.immutable !== asset.immutable
        ) {
          throw new Error(`同一 URL 已存在不同内容: ${asset.url}`);
        }
        const failure = await verifyFile(target, asset);
        if (failure) throw new Error(`已发布资源损坏: ${failure}`);
      } else {
        const info = await pathInfo(target);
        if (info) {
          const digest = sha256Hex(await readFile(target));
          if (digest !== asset.sha256) throw new Error(`目标已存在且内容不同: ${asset.url}`);
        } else {
          await copyFileAtomic(source, target);
        }
        assets[relative] = asset;
      }
    }
    const nextIndex: ImmutableIndex = { schemaVersion: WEB_RELEASE_SCHEMA_VERSION, assets };
    const failures = await verifyReleaseAssets({ manifest: candidate.manifest, publicDir, index: nextIndex });
    if (failures.length) throw new Error(`发布后资源复核失败: ${failures.slice(0, 8).join('; ')}`);
    await writeJsonAtomic(indexPath, nextIndex);
    await mkdir(releaseDir, { recursive: true });
    await writeJsonAtomic(join(releaseDir, 'release.json'), candidate.manifest);
    if (options.freezeLegacy) {
      await freezeLegacyAliases(options.releasesRoot, candidate, baseline);
    }
    if (options.pin) {
      await writeReleasePin(options.releasesRoot, candidate.manifest.buildId, baseline);
    }
    if (options.activate === false) return null;
    return activateDeployment(options.releasesRoot, candidate.manifest, 'deploy');
  });
  if (options.keepCandidate !== true) {
    await rm(candidate.candidateDir, { recursive: true, force: true });
  }
  log(
    `发布完成: ${candidate.manifest.buildId}${deployment ? ` → ${deployment.deploymentId}` : '（未切换指针）'}`,
  );
  return {
    buildId: candidate.manifest.buildId,
    deploymentId: deployment?.deploymentId ?? null,
    releaseDir,
    assets: candidate.manifest.assets.length,
    legacyFrozen: options.freezeLegacy === true,
  };
}

export interface RollbackResult {
  readonly buildId: string;
  readonly deploymentId: string;
  readonly action: 'rollback';
}

/** 回滚只切指针，不重新构建、不覆盖任何字节；目标 build 的全部资源必须仍可用。 */
export async function rollbackTo(root: string, target: string): Promise<RollbackResult> {
  return withReleaseLock(root, async () => {
    const currentBuild = await readCurrentBuildId(root);
    if (!currentBuild) throw new Error('没有当前发布，无法回滚');
    let buildId = target;
    if (target === 'previous') {
      const deployments = await listDeployments(root);
      const previous = deployments.find((record) => record.buildId !== currentBuild);
      if (!previous) throw new Error('没有可回滚的上一个不同 build');
      buildId = previous.buildId;
    }
    const releaseDir = join(root, 'releases', buildIdDirectory(buildId));
    const parsed = await readReleaseManifest(join(releaseDir, 'release.json'));
    if (!parsed.manifest) throw new Error(`目标发布无效: ${parsed.errors.join('; ')}`);
    const indexResult = await readImmutableIndex(join(root, 'immutable-index.json'));
    if (!indexResult.index) throw new Error(`索引无效: ${indexResult.errors.join('; ')}`);
    const errors = await verifyReleaseAssets({
      manifest: parsed.manifest,
      publicDir: join(root, 'public'),
      index: indexResult.index,
    });
    if (errors.length > 0) throw new Error(`目标资源不可用: ${errors.slice(0, 8).join('; ')}`);
    const record = await activateDeployment(root, parsed.manifest, 'rollback');
    return { buildId: parsed.manifest.buildId, deploymentId: record.deploymentId, action: 'rollback' };
  });
}

export interface PruneOptions {
  readonly root: string;
  readonly apply: boolean;
  readonly graceMs: number;
  readonly now?: number;
  readonly log?: (message: string) => void;
}

export interface PruneResult {
  readonly retainedBuilds: readonly string[];
  readonly originals: readonly string[];
  readonly candidates: readonly { relative: string; bytes: number; url: string }[];
  readonly bytes: number;
  readonly removed: number;
  /** 超过隔离期、可安全丢弃的候选构建目录（成功保留或失败遗留）。 */
  readonly candidateDirs: readonly { name: string; bytes: number }[];
  readonly candidateBytes: number;
  readonly removedCandidateDirs: number;
}

/**
 * 保留集合 = 当前发布 ∪ 最近 7 天部署 ∪ 最近两个不同 build ∪ 显式 pin
 * ∪ 迁移基线。只删除共享资产根中未被任何保留发布引用、且超过隔离期的文件。
 */
export async function pruneReleases(options: PruneOptions): Promise<PruneResult> {
  const log = options.log ?? (() => undefined);
  const result = await withReleaseLock(options.root, async () => {
    const currentBuild = await readCurrentBuildId(options.root);
    if (!currentBuild) throw new Error('没有当前发布，拒绝清理');
    const deployments = await listDeployments(options.root);
    const pins = await readPins(options.root);
    const now = options.now ?? Date.now();
    const retained = new Set<string>([currentBuild]);
    for (const record of deployments) {
      const activatedAt = Date.parse(record.activatedAt);
      if (Number.isFinite(activatedAt) && activatedAt >= now - LIMITS.webReleaseRetentionMs) {
        retained.add(record.buildId);
      }
    }
    const recent: string[] = [];
    for (const record of deployments) {
      if (!recent.includes(record.buildId)) recent.push(record.buildId);
      if (recent.length >= LIMITS.webReleaseRetainedBuilds) break;
    }
    for (const buildId of recent) retained.add(buildId);
    for (const buildId of pins.builds) retained.add(buildId);
    if (pins.legacyBaseline) retained.add(pins.legacyBaseline);

    const referenced = new Set<string>();
    for (const buildId of retained) {
      const parsed = await readReleaseManifest(
        join(options.root, 'releases', buildIdDirectory(buildId), 'release.json'),
      );
      if (!parsed.manifest) {
        throw new Error(`保留发布的描述不可读，停止清理: ${buildId} (${parsed.errors.join('; ')})`);
      }
      for (const asset of parsed.manifest.assets) {
        referenced.add(staticRelativeFromUrl(asset.url));
      }
    }

    const indexResult = await readImmutableIndex(join(options.root, 'immutable-index.json'));
    if (!indexResult.index) {
      throw new Error(`索引不可读，停止清理: ${indexResult.errors.join('; ')}`);
    }
    const index = indexResult.index;
    const publicDir = join(options.root, 'public');
    const candidates: { relative: string; bytes: number; url: string; file: string }[] = [];
    const files = await walkFiles(publicDir).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [] as string[];
      throw error;
    });
    const keepIndexed = new Set(referenced);
    for (const relative of files) {
      if (referenced.has(relative)) continue;
      const file = join(publicDir, relative);
      const info = await stat(file);
      if (now - info.mtimeMs < options.graceMs) {
        keepIndexed.add(relative);
        continue;
      }
      candidates.push({
        relative,
        bytes: info.size,
        url: staticUrlFromRelative(relative),
        file,
      });
    }
    const bytes = candidates.reduce((sum, item) => sum + item.bytes, 0);
    const staleCandidates = await collectStaleCandidateDirs(
      options.root,
      now,
      options.graceMs,
      log,
    );
    const candidateBytes = staleCandidates.reduce((sum, item) => sum + item.bytes, 0);
    log(
      `保留 ${retained.size} 个 build、${referenced.size} 个 URL；可清理 ${candidates.length} 个文件（${formatBytes(bytes)}）与 ${staleCandidates.length} 个过期候选目录（${formatBytes(candidateBytes)}）`,
    );
    for (const candidate of candidates) {
      log(`  ${candidate.url} (${formatBytes(candidate.bytes)})`);
    }
    for (const candidate of staleCandidates) {
      log(`  candidates/${candidate.name}/ (${formatBytes(candidate.bytes)})`);
    }
    const publicSummary = candidates.map(({ relative, bytes: size, url }) => ({
      relative,
      bytes: size,
      url,
    }));
    const candidateSummary = staleCandidates.map(({ name, bytes: size }) => ({
      name,
      bytes: size,
    }));
    if (!options.apply) {
      return {
        retainedBuilds: [...retained],
        originals: [...referenced],
        candidates: publicSummary,
        bytes,
        removed: 0,
        candidateDirs: candidateSummary,
        candidateBytes,
        removedCandidateDirs: 0,
      };
    }
    // 先提交新索引再删文件：中断时最多留下索引外的孤儿文件，
    // 不会出现索引仍指向已删除文件。
    const nextAssets = Object.fromEntries(
      Object.entries(index.assets).filter(([relative]) => keepIndexed.has(relative)),
    );
    await writeJsonAtomic(join(options.root, 'immutable-index.json'), {
      schemaVersion: WEB_RELEASE_SCHEMA_VERSION,
      assets: nextAssets,
    });
    for (const candidate of candidates) {
      await unlink(candidate.file).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
    for (const candidate of staleCandidates) {
      await rm(candidate.path, { recursive: true, force: true });
    }
    // 只移除已经空掉的目录，不触碰根目录与 legacy/。
    const directories = new Set<string>();
    for (const candidate of candidates) {
      let directory = dirname(candidate.file);
      while (directory.startsWith(`${publicDir}${sep}`)) {
        directories.add(directory);
        directory = dirname(directory);
      }
    }
    for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
      await rmdir(directory).catch(() => undefined);
    }
    return {
      retainedBuilds: [...retained],
      originals: [...referenced],
      candidates: publicSummary,
      bytes,
      removed: candidates.length,
      candidateDirs: candidateSummary,
      candidateBytes,
      removedCandidateDirs: staleCandidates.length,
    };
  });
  return result;
}

/**
 * 候选目录在发布成功且 keepCandidate 时保留，构建失败时也可能遗留。
 * 只清理 mtime 超过隔离期的目录；返回 dry-run 与 apply 共用的清单。
 */
async function collectStaleCandidateDirs(
  root: string,
  now: number,
  graceMs: number,
  log: (message: string) => void,
): Promise<{ name: string; bytes: number; path: string }[]> {
  const candidatesRoot = join(root, 'candidates');
  let entries: Dirent[];
  try {
    entries = await readdir(candidatesRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const stale: { name: string; bytes: number; path: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(candidatesRoot, entry.name);
    const info = await stat(path).catch(() => null);
    if (!info || now - info.mtimeMs < graceMs) continue;
    let bytes = 0;
    try {
      for (const relative of await walkFiles(path)) {
        bytes += (await stat(join(path, relative))).size;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`  跳过不可读候选目录 candidates/${entry.name}/: ${reason}`);
      continue;
    }
    stale.push({ name: entry.name, bytes, path });
  }
  return stale;
}

export interface LiveProbeResult {
  readonly buildId: string;
  readonly deploymentId: string;
  readonly assets: number;
  readonly bytes: number;
}

async function fetchChecked(url: string, expected: {
  status?: number;
  contentType?: string;
  cacheControl?: string;
  sha256?: string;
}): Promise<{ response: Response; bytes: Uint8Array }> {
  const response = await fetch(url, { headers: { 'cache-control': 'no-cache' } });
  const actual = new Uint8Array(await response.arrayBuffer());
  if (expected.status !== undefined && response.status !== expected.status) {
    throw new Error(`${url} 状态 ${response.status}，期望 ${expected.status}`);
  }
  if (expected.contentType) {
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType !== expected.contentType) {
      throw new Error(`${url} content-type=${contentType}，期望 ${expected.contentType}`);
    }
  }
  if (expected.cacheControl) {
    const cacheControl = response.headers.get('cache-control') ?? '';
    if (cacheControl !== expected.cacheControl) {
      throw new Error(`${url} cache-control=${cacheControl}，期望 ${expected.cacheControl}`);
    }
  }
  if (expected.sha256 && sha256Hex(actual) !== expected.sha256) {
    throw new Error(`${url} 字节摘要不符`);
  }
  return { response, bytes: actual };
}

/**
 * 对运行中的实例做端到端探针：版本接口、HTML 元数据、全部资产字节/MIME/
 * 缓存头、固定别名与 `/mcp` 非 GET。供发布脚本与 A/B/A 验收共用。
 */
export interface LiveProbeOptions {
  /** 发布根必须已有冻结别名；用于一键部署拒绝未迁移的旧 dist 切换。 */
  readonly requireLegacyAliases?: boolean;
}

export async function probeLiveRelease(
  base: string,
  root: string,
  expectedBuildId: string,
  options: LiveProbeOptions = {},
): Promise<LiveProbeResult> {
  const origin = base.replace(/\/+$/u, '');
  const health = await fetch(`${origin}/health`);
  if (health.status !== 200) throw new Error(`/health 状态 ${health.status}`);

  const version = await fetch(`${origin}/web-version.json`);
  if (version.status !== 200) throw new Error(`/web-version.json 状态 ${version.status}`);
  if (version.headers.get('cache-control') !== 'no-store') {
    throw new Error('/web-version.json 必须 no-store');
  }
  const versionBody = (await version.json()) as Record<string, unknown>;
  if (versionBody.buildId !== expectedBuildId) {
    throw new Error(`/web-version.json buildId ${String(versionBody.buildId)}，期望 ${expectedBuildId}`);
  }
  const deploymentId = typeof versionBody.deploymentId === 'string' ? versionBody.deploymentId : '';
  if (!deploymentId.startsWith('r')) throw new Error('/web-version.json 缺少 deploymentId');

  const home = await fetch(`${origin}/`);
  if (home.status !== 200) throw new Error(`/ 状态 ${home.status}`);
  if (home.headers.get('cache-control') !== 'no-store') throw new Error('/ 必须 no-store');
  const html = await home.text();
  const releaseMatch = /<script type="application\/json" id="web-release">([\s\S]*?)<\/script>/u.exec(html);
  if (!releaseMatch?.[1]) throw new Error('HTML 缺少 #web-release');
  const release = JSON.parse(releaseMatch[1]) as Record<string, unknown>;
  if (release.buildId !== expectedBuildId) {
    throw new Error(`HTML buildId ${String(release.buildId)}，期望 ${expectedBuildId}`);
  }
  if (release.webContract !== versionBody.maxWebContract) {
    throw new Error('HTML webContract 与版本接口不一致');
  }

  const parsed = await readReleaseManifest(
    join(root, 'releases', buildIdDirectory(expectedBuildId), 'release.json'),
  );
  if (!parsed.manifest) throw new Error(`发布描述不可读: ${parsed.errors.join('; ')}`);
  const manifest = parsed.manifest;
  let bytes = 0;
  for (const asset of manifest.assets) {
    const result = await fetchChecked(`${origin}${asset.url}`, {
      status: 200,
      contentType: asset.contentType,
      cacheControl: asset.immutable
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
      sha256: asset.sha256,
    });
    bytes += result.bytes.byteLength;
  }

  const legacy = await readLegacyAliases(root);
  if (!legacy && options.requireLegacyAliases) {
    throw new Error(`固定别名未冻结（缺少 ${root}/legacy.json）：拒绝把未迁移发布判定为成功`);
  }
  if (legacy) {
    for (const [name, alias] of Object.entries(legacy.aliases)) {
      await fetchChecked(`${origin}/assets/${name}`, {
        status: 200,
        contentType: alias.contentType,
        cacheControl: `public, max-age=${LIMITS.webAliasCacheMaxAgeSeconds}`,
        sha256: alias.sha256,
      });
    }
  }

  const mcpGet = await fetch(`${origin}/mcp`);
  if (mcpGet.status !== 405 || mcpGet.headers.get('allow') !== 'POST') {
    throw new Error(`GET /mcp 期望 405 + Allow: POST，实际 ${mcpGet.status}`);
  }
  return {
    buildId: expectedBuildId,
    deploymentId,
    assets: manifest.assets.length,
    bytes,
  };
}
