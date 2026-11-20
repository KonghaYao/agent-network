/**
 * Web 发布快照的共享定义与只读加载器。
 *
 * 发布描述（release.json）是服务端在启动时固定下来的唯一权威：
 * - 静态资源只能通过 append-only 索引里的 URL 访问；
 * - buildId 是规范化描述的内容摘要，不含部署流水号与时间戳；
 * - 当前指针（current）在进程启动时解析一次，运行中的进程不追随新发布。
 *
 * 本模块同时被 `src/bun/main.ts`、`src/app.ts` 与发布脚本使用，
 * 因此不导入 Hono、数据库或任何业务模块。
 */

import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

export const WEB_RELEASE_SCHEMA_VERSION = 1;
export const WEB_CONTRACT_VERSION = 1;
export const WEB_RELEASE_MIN_CONTRACT = 1;
export const WEB_RELEASE_MAX_CONTRACT = 1;
export const WEB_RELEASE_BUILD_ID = /^sha256:[0-9a-f]{64}$/u;
export const WEB_RELEASE_DIR_NAME = /^[0-9a-f]{64}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

export interface WebReleaseAsset {
  /** 同源公开 URL，例如 `/static/assets/main-abc.js`。 */
  readonly url: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly contentType: string;
  /** 只有内容地址（文件名带内容哈希）才允许一年 immutable。 */
  readonly immutable: boolean;
}

export interface WebReleaseModule extends WebReleaseAsset {}

export interface WebReleaseManifest {
  readonly schemaVersion: number;
  readonly buildId: string;
  readonly webContract: number;
  readonly minWebContract: number;
  readonly maxWebContract: number;
  /** 入口脚本 URL。 */
  readonly entry: string;
  /** 入口 CSS URL；可能为空。 */
  readonly css: readonly string[];
  readonly modules: {
    readonly markdown: WebReleaseModule;
    readonly drawboard: WebReleaseModule;
  };
  readonly assets: readonly WebReleaseAsset[];
  /** 只用于审计与运维，不参与 buildId。 */
  readonly createdAt: string;
}

export type WebReleaseDigestInput = Omit<WebReleaseManifest, 'buildId' | 'createdAt'>;

export type WebDeploymentAction = 'baseline' | 'deploy' | 'rollback';

export interface WebDeploymentRecord {
  readonly deploymentId: string;
  readonly buildId: string;
  readonly action: WebDeploymentAction;
  readonly activatedAt: string;
  readonly minWebContract: number;
  readonly maxWebContract: number;
}

export interface WebLegacyAlias {
  /** 相对 releasesRoot 的路径，固定在 `legacy/` 下。 */
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly contentType: string;
}

export interface WebLegacyAliases {
  readonly schemaVersion: number;
  readonly frozenAt: string;
  readonly baselineBuildId: string;
  readonly aliases: {
    readonly 'chat-markdown.js': WebLegacyAlias;
    readonly 'chat-drawboard.js': WebLegacyAlias;
  };
}

export interface ImmutableIndex {
  readonly schemaVersion: number;
  /** key 是 `/static/` 之后的相对路径，例如 `assets/main-abc.js`。 */
  readonly assets: Readonly<Record<string, WebReleaseAsset>>;
}

export interface LoadedWebRelease {
  /** releasesRoot 的绝对路径。 */
  readonly root: string;
  readonly releaseDir: string;
  readonly deploymentId: string;
  readonly manifest: WebReleaseManifest;
  /** 追加式静态资产根。 */
  readonly publicDir: string;
  readonly index: ImmutableIndex;
  /** 首次迁移冻结的固定别名；全新部署还没有旧页时为 null。 */
  readonly legacy: WebLegacyAliases | null;
}

export interface ReleaseValidationResult {
  readonly manifest: WebReleaseManifest | null;
  readonly errors: readonly string[];
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function buildIdDirectory(buildId: string): string {
  if (!WEB_RELEASE_BUILD_ID.test(buildId)) {
    throw new Error('buildId 必须形如 sha256:<64 位小写十六进制>');
  }
  return buildId.slice('sha256:'.length);
}

/** 只接受 `assets/...` 这类没有空段、`.`、`..` 的相对路径。 */
export function isSafeRelativePath(value: string): boolean {
  if (value.length === 0 || value.includes('\0') || value.startsWith('/') || value.includes('\\')) {
    return false;
  }
  return value
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

export function staticRelativeFromUrl(url: string): string {
  if (!url.startsWith('/static/')) throw new Error(`不是 /static/ URL: ${url}`);
  const relative = url.slice('/static/'.length);
  if (!isSafeRelativePath(relative)) throw new Error(`静态 URL 路径不安全: ${url}`);
  return relative;
}

export function staticUrlFromRelative(relative: string): string {
  if (!isSafeRelativePath(relative)) throw new Error(`静态相对路径不安全: ${relative}`);
  return `/static/${relative}`;
}

export function contentTypeForPath(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith('.js') || lower.endsWith('.mjs')) return 'text/javascript; charset=utf-8';
  if (lower.endsWith('.css')) return 'text/css; charset=utf-8';
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.woff2')) return 'font/woff2';
  if (lower.endsWith('.woff')) return 'font/woff';
  if (lower.endsWith('.ttf')) return 'font/ttf';
  if (lower.endsWith('.otf')) return 'font/otf';
  if (lower.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.avif')) return 'image/avif';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.ico')) return 'image/x-icon';
  if (lower.endsWith('.wasm')) return 'application/wasm';
  if (lower.endsWith('.md')) return 'text/markdown; charset=utf-8';
  if (lower.endsWith('.txt')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function normalizeAsset(asset: WebReleaseAsset): WebReleaseAsset {
  return {
    url: asset.url,
    sha256: asset.sha256,
    bytes: asset.bytes,
    contentType: asset.contentType,
    immutable: asset.immutable,
  };
}

/** buildId 只依赖稳定字段；URL 与资源顺序固定，保证跨机器可复算。 */
export function computeBuildId(input: WebReleaseDigestInput): string {
  const normalized = {
    schemaVersion: input.schemaVersion,
    webContract: input.webContract,
    minWebContract: input.minWebContract,
    maxWebContract: input.maxWebContract,
    entry: input.entry,
    css: [...input.css].sort(),
    modules: {
      markdown: normalizeAsset(input.modules.markdown),
      drawboard: normalizeAsset(input.modules.drawboard),
    },
    assets: [...input.assets]
      .map(normalizeAsset)
      .sort((left, right) => left.url.localeCompare(right.url)),
  };
  return `sha256:${sha256Hex(JSON.stringify(normalized))}`;
}

function parseAsset(value: unknown, label: string, errors: string[]): WebReleaseAsset | null {
  if (!isRecord(value)) {
    errors.push(`${label} 必须是对象`);
    return null;
  }
  const local: string[] = [];
  const { url, sha256, bytes, contentType, immutable } = value;
  if (!isNonEmptyString(url) || !url.startsWith('/static/')) {
    local.push(`${label}.url 必须是 /static/ URL`);
  } else {
    try {
      staticRelativeFromUrl(url);
    } catch {
      local.push(`${label}.url 路径不安全`);
    }
  }
  if (!isSha256(sha256)) local.push(`${label}.sha256 必须是 64 位十六进制`);
  if (!isPositiveInt(bytes)) local.push(`${label}.bytes 必须是正整数`);
  if (!isNonEmptyString(contentType)) local.push(`${label}.contentType 不能为空`);
  if (typeof immutable !== 'boolean') local.push(`${label}.immutable 必须是布尔值`);
  if (local.length > 0) {
    errors.push(...local);
    return null;
  }
  return {
    url: url as string,
    sha256: sha256 as string,
    bytes: bytes as number,
    contentType: contentType as string,
    immutable: immutable as boolean,
  };
}

/**
 * 解析并完整校验发布描述：
 * - 所有 URL 都在 `/static/` 下且路径安全；
 * - entry/css/modules 必须出现在 assets 中；
 * - buildId 必须与规范化内容一致，防止手工篡改清单。
 */
export function parseReleaseManifest(value: unknown): ReleaseValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { manifest: null, errors: ['release.json 必须是对象'] };

  if (value.schemaVersion !== WEB_RELEASE_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须是 ${WEB_RELEASE_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.buildId) || !WEB_RELEASE_BUILD_ID.test(value.buildId)) {
    errors.push('buildId 必须形如 sha256:<64 位小写十六进制>');
  }
  if (value.webContract !== WEB_CONTRACT_VERSION) {
    errors.push(`webContract 必须是 ${WEB_CONTRACT_VERSION}`);
  }
  if (!isPositiveInt(value.minWebContract) || !isPositiveInt(value.maxWebContract)) {
    errors.push('minWebContract/maxWebContract 必须是正整数');
  } else if (
    typeof value.webContract === 'number' &&
    (value.minWebContract > value.webContract || value.webContract > value.maxWebContract)
  ) {
    errors.push('webContract 必须落在 minWebContract..maxWebContract 之间');
  }
  if (!isNonEmptyString(value.entry) || !value.entry.startsWith('/static/')) {
    errors.push('entry 必须是 /static/ URL');
  }
  const css: string[] = [];
  if (!Array.isArray(value.css)) {
    errors.push('css 必须是数组');
  } else {
    for (const [index, href] of value.css.entries()) {
      if (!isNonEmptyString(href) || !href.startsWith('/static/')) {
        errors.push(`css[${index}] 必须是 /static/ URL`);
      } else {
        css.push(href);
      }
    }
  }
  if (!isNonEmptyString(value.createdAt)) errors.push('createdAt 不能为空');

  let modules: WebReleaseManifest['modules'] | null = null;
  if (!isRecord(value.modules)) {
    errors.push('modules 必须是对象');
  } else {
    const markdown = parseAsset(value.modules.markdown, 'modules.markdown', errors);
    const drawboard = parseAsset(value.modules.drawboard, 'modules.drawboard', errors);
    if (markdown && drawboard) modules = { markdown, drawboard };
  }

  const assets: WebReleaseAsset[] = [];
  if (!Array.isArray(value.assets) || value.assets.length === 0) {
    errors.push('assets 必须是非空数组');
  } else {
    for (const [index, asset] of value.assets.entries()) {
      const parsed = parseAsset(asset, `assets[${index}]`, errors);
      if (parsed) assets.push(parsed);
    }
  }

  const assetUrls = new Set(assets.map((asset) => asset.url));
  if (assetUrls.size !== assets.length) errors.push('assets 中存在重复 URL');
  if (isNonEmptyString(value.entry) && !assetUrls.has(value.entry)) {
    errors.push('entry 不在 assets 中');
  }
  for (const href of css) {
    if (!assetUrls.has(href)) errors.push(`css ${href} 不在 assets 中`);
  }
  if (modules) {
    for (const [name, module] of Object.entries(modules)) {
      if (!assetUrls.has(module.url)) errors.push(`modules.${name} 不在 assets 中`);
    }
  }

  if (errors.length > 0) return { manifest: null, errors };

  const manifest: WebReleaseManifest = {
    schemaVersion: WEB_RELEASE_SCHEMA_VERSION,
    buildId: value.buildId as string,
    webContract: WEB_CONTRACT_VERSION,
    minWebContract: value.minWebContract as number,
    maxWebContract: value.maxWebContract as number,
    entry: value.entry as string,
    css,
    modules: modules as WebReleaseManifest['modules'],
    assets,
    createdAt: value.createdAt as string,
  };
  const expected = computeBuildId(manifest);
  if (expected !== manifest.buildId) {
    return { manifest: null, errors: [`buildId 与发布描述内容不一致（期望 ${expected}）`] };
  }
  return { manifest, errors: [] };
}

export async function readReleaseManifest(path: string): Promise<ReleaseValidationResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { manifest: null, errors: [`无法读取 release.json: ${reason.slice(0, 200)}`] };
  }
  return parseReleaseManifest(parsed);
}

export function parseImmutableIndex(value: unknown): {
  index: ImmutableIndex | null;
  errors: readonly string[];
} {
  const errors: string[] = [];
  if (!isRecord(value)) return { index: null, errors: ['immutable-index.json 必须是对象'] };
  if (value.schemaVersion !== WEB_RELEASE_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须是 ${WEB_RELEASE_SCHEMA_VERSION}`);
  }
  const assets: Record<string, WebReleaseAsset> = {};
  if (!isRecord(value.assets)) {
    errors.push('assets 必须是对象');
  } else {
    for (const [relative, asset] of Object.entries(value.assets)) {
      if (!isSafeRelativePath(relative)) {
        errors.push(`索引路径不安全: ${relative}`);
        continue;
      }
      const parsed = parseAsset(asset, `assets.${relative}`, errors);
      if (!parsed) continue;
      if (parsed.url !== staticUrlFromRelative(relative)) {
        errors.push(`索引 ${relative} 的 URL 与路径不一致`);
        continue;
      }
      assets[relative] = parsed;
    }
  }
  if (errors.length > 0) return { index: null, errors };
  return { index: { schemaVersion: WEB_RELEASE_SCHEMA_VERSION, assets }, errors: [] };
}

export async function readImmutableIndex(path: string): Promise<{
  index: ImmutableIndex | null;
  errors: readonly string[];
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { index: null, errors: [`无法读取 immutable-index.json: ${reason.slice(0, 200)}`] };
  }
  return parseImmutableIndex(parsed);
}

function parseLegacyAlias(value: unknown, label: string, errors: string[]): WebLegacyAlias | null {
  if (!isRecord(value)) {
    errors.push(`${label} 必须是对象`);
    return null;
  }
  const local: string[] = [];
  const { file, sha256, bytes, contentType } = value;
  if (!isNonEmptyString(file) || !file.startsWith('legacy/') || !isSafeRelativePath(file)) {
    local.push(`${label}.file 必须是 legacy/ 下的安全相对路径`);
  }
  if (!isSha256(sha256)) local.push(`${label}.sha256 必须是 64 位十六进制`);
  if (!isPositiveInt(bytes)) local.push(`${label}.bytes 必须是正整数`);
  if (!isNonEmptyString(contentType)) local.push(`${label}.contentType 不能为空`);
  if (local.length > 0) {
    errors.push(...local);
    return null;
  }
  return {
    file: file as string,
    sha256: sha256 as string,
    bytes: bytes as number,
    contentType: contentType as string,
  };
}

export function parseLegacyAliases(value: unknown): {
  legacy: WebLegacyAliases | null;
  errors: readonly string[];
} {
  const errors: string[] = [];
  if (!isRecord(value)) return { legacy: null, errors: ['legacy.json 必须是对象'] };
  if (value.schemaVersion !== WEB_RELEASE_SCHEMA_VERSION) {
    errors.push(`schemaVersion 必须是 ${WEB_RELEASE_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.frozenAt)) errors.push('frozenAt 不能为空');
  if (!isNonEmptyString(value.baselineBuildId) || !WEB_RELEASE_BUILD_ID.test(value.baselineBuildId)) {
    errors.push('baselineBuildId 必须是 buildId');
  }
  if (!isRecord(value.aliases)) {
    errors.push('aliases 必须是对象');
    return { legacy: null, errors };
  }
  const markdown = parseLegacyAlias(value.aliases['chat-markdown.js'], 'aliases.chat-markdown.js', errors);
  const drawboard = parseLegacyAlias(
    value.aliases['chat-drawboard.js'],
    'aliases.chat-drawboard.js',
    errors,
  );
  if (errors.length > 0 || !markdown || !drawboard) return { legacy: null, errors };
  return {
    legacy: {
      schemaVersion: WEB_RELEASE_SCHEMA_VERSION,
      frozenAt: value.frozenAt as string,
      baselineBuildId: value.baselineBuildId as string,
      aliases: { 'chat-markdown.js': markdown, 'chat-drawboard.js': drawboard },
    },
    errors: [],
  };
}

export async function readLegacyAliases(root: string): Promise<WebLegacyAliases | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(root, 'legacy.json'), 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取 legacy.json: ${reason.slice(0, 200)}`);
  }
  const { legacy, errors } = parseLegacyAliases(parsed);
  if (!legacy) throw new Error(`legacy.json 无效: ${errors.join('; ')}`);
  return legacy;
}

export async function verifyFile(path: string, asset: Pick<WebReleaseAsset, 'sha256' | 'bytes'>): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return `${path} 不是普通文件`;
    if (info.size !== asset.bytes) return `${path} 大小不符（期望 ${asset.bytes}，实际 ${info.size}）`;
    const digest = sha256Hex(await readFile(path));
    if (digest !== asset.sha256) return `${path} 摘要不符`;
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return `${path} 不可读: ${reason.slice(0, 200)}`;
  }
}

/** 校验清单内每个文件在共享资产根中存在、可读且摘要匹配。 */
export async function verifyReleaseAssets(input: {
  manifest: WebReleaseManifest;
  publicDir: string;
  index: ImmutableIndex;
}): Promise<readonly string[]> {
  const errors: string[] = [];
  const publicRoot = resolve(input.publicDir);
  for (const asset of input.manifest.assets) {
    let relative: string;
    try {
      relative = staticRelativeFromUrl(asset.url);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const indexed = input.index.assets[relative];
    if (!indexed) {
      errors.push(`${asset.url} 不在 immutable-index.json 中`);
      continue;
    }
    if (
      indexed.sha256 !== asset.sha256 ||
      indexed.bytes !== asset.bytes ||
      indexed.contentType !== asset.contentType ||
      indexed.immutable !== asset.immutable
    ) {
      errors.push(`${asset.url} 的索引元数据与发布描述不一致`);
      continue;
    }
    const path = resolve(publicRoot, relative);
    if (!path.startsWith(`${publicRoot}${sep}`)) {
      errors.push(`${asset.url} 解析到资产根之外`);
      continue;
    }
    const failure = await verifyFile(path, asset);
    if (failure) errors.push(failure);
  }
  if (input.manifest.assets.length === 0) errors.push('发布描述没有资源');
  return errors;
}

export async function verifyLegacyAliases(
  root: string,
  legacy: WebLegacyAliases,
): Promise<readonly string[]> {
  const errors: string[] = [];
  const rootPath = resolve(root);
  for (const [name, alias] of Object.entries(legacy.aliases)) {
    const path = resolve(rootPath, alias.file);
    if (!path.startsWith(`${rootPath}${sep}`)) {
      errors.push(`${name} 的冻结路径越界`);
      continue;
    }
    const failure = await verifyFile(path, alias);
    if (failure) errors.push(failure);
  }
  return errors;
}

/**
 * 读取 `current` 指针。优先读取相对 symlink；为不支持 symlink 的部署
 * 保留纯文本指针文件作为回退。两者都只接受 64 位十六进制目录名。
 */
export async function readCurrentBuildId(root: string): Promise<string | null> {
  const current = join(root, 'current');
  let target: string;
  try {
    const info = await lstat(current);
    target = info.isSymbolicLink()
      ? await readlink(current)
      : (await readFile(current, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const normalized = target.replaceAll('\\', '/').replace(/\/+$/u, '');
  const directory = normalized.startsWith('releases/')
    ? normalized.slice('releases/'.length)
    : basename(normalized);
  if (!WEB_RELEASE_DIR_NAME.test(directory)) {
    throw new Error(`current 指针无效: ${target}`);
  }
  return `sha256:${directory}`;
}

export function parseDeploymentRecord(value: unknown): WebDeploymentRecord | null {
  if (!isRecord(value)) return null;
  const { deploymentId, buildId, action, activatedAt, minWebContract, maxWebContract } = value;
  if (!isNonEmptyString(deploymentId) || !deploymentId.startsWith('r')) return null;
  if (!isNonEmptyString(buildId) || !WEB_RELEASE_BUILD_ID.test(buildId)) return null;
  if (action !== 'baseline' && action !== 'deploy' && action !== 'rollback') return null;
  if (!isNonEmptyString(activatedAt) || Number.isNaN(Date.parse(activatedAt))) return null;
  if (!isPositiveInt(minWebContract) || !isPositiveInt(maxWebContract)) return null;
  return {
    deploymentId,
    buildId,
    action,
    activatedAt,
    minWebContract,
    maxWebContract,
  };
}

/** 部署记录按文件名倒序；deploymentId 以毫秒时间戳开头，可稳定排序。 */
export async function listDeployments(root: string): Promise<readonly WebDeploymentRecord[]> {
  let names: string[];
  try {
    names = await readdir(join(root, 'deployments'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const records: WebDeploymentRecord[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort().reverse()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(root, 'deployments', name), 'utf8'));
    } catch {
      throw new Error(`部署记录不可读: ${name}`);
    }
    const record = parseDeploymentRecord(parsed);
    if (!record) throw new Error(`部署记录无效: ${name}`);
    records.push(record);
  }
  return records;
}

export async function latestDeploymentForBuild(
  root: string,
  buildId: string,
): Promise<WebDeploymentRecord | null> {
  return (await listDeployments(root)).find((record) => record.buildId === buildId) ?? null;
}

export function nextDeploymentId(now = Date.now()): string {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  return `r${String(now).padStart(13, '0')}-${suffix}`;
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

/**
 * 原子切换 current 指针。symlink 在 POSIX 上以 rename 覆盖；
 * 失败时退回纯文本指针文件，服务端两种都支持。
 */
export async function switchCurrent(root: string, buildId: string): Promise<void> {
  const directory = buildIdDirectory(buildId);
  const releaseDir = join(root, 'releases', directory);
  const manifest = await readReleaseManifest(join(releaseDir, 'release.json'));
  if (!manifest.manifest) {
    throw new Error(`拒绝切换到无效发布: ${manifest.errors.join('; ')}`);
  }
  const current = join(root, 'current');
  const target = `releases/${directory}`;
  const temporary = join(root, `.current-${process.pid}-${crypto.randomUUID()}`);
  try {
    await symlink(target, temporary);
    await rename(temporary, current);
    return;
  } catch {
    const temporaryFile = `${temporary}.json`;
    await writeFile(temporaryFile, `${directory}\n`);
    await rename(temporaryFile, current);
  }
}

export async function activateDeployment(
  root: string,
  manifest: WebReleaseManifest,
  action: WebDeploymentAction,
): Promise<WebDeploymentRecord> {
  const record: WebDeploymentRecord = {
    deploymentId: nextDeploymentId(),
    buildId: manifest.buildId,
    action,
    activatedAt: new Date().toISOString(),
    minWebContract: manifest.minWebContract,
    maxWebContract: manifest.maxWebContract,
  };
  await writeJsonAtomic(join(root, 'deployments', `${record.deploymentId}.json`), record);
  await switchCurrent(root, manifest.buildId);
  return record;
}

/**
 * 启动时读取并固定当前发布。目录不存在返回 null（调用方决定是否退回
 * `dist/web` 开发模式）；指针存在但任何一项校验失败都抛错，禁止半发布上线。
 */
export async function loadCurrentWebRelease(root: string): Promise<LoadedWebRelease | null> {
  const buildId = await readCurrentBuildId(root);
  if (!buildId) return null;
  const releaseDir = join(root, 'releases', buildIdDirectory(buildId));
  const parsed = await readReleaseManifest(join(releaseDir, 'release.json'));
  if (!parsed.manifest) {
    throw new Error(`发布描述无效: ${parsed.errors.join('; ')}`);
  }
  const manifest = parsed.manifest;
  if (manifest.buildId !== buildId) {
    throw new Error(`current 指向 ${buildId}，但 release.json 是 ${manifest.buildId}`);
  }
  const publicDir = join(root, 'public');
  const indexResult = await readImmutableIndex(join(root, 'immutable-index.json'));
  if (!indexResult.index) {
    throw new Error(`发布索引无效: ${indexResult.errors.join('; ')}`);
  }
  const index = indexResult.index;
  const assetErrors = await verifyReleaseAssets({ manifest, publicDir, index });
  if (assetErrors.length > 0) {
    throw new Error(`发布资源校验失败: ${assetErrors.slice(0, 8).join('; ')}`);
  }
  const legacy = await readLegacyAliases(root);
  if (legacy) {
    const aliasErrors = await verifyLegacyAliases(root, legacy);
    if (aliasErrors.length > 0) {
      throw new Error(`固定别名校验失败: ${aliasErrors.slice(0, 4).join('; ')}`);
    }
  }
  const deployment = await latestDeploymentForBuild(root, manifest.buildId);
  if (!deployment) {
    throw new Error(`当前发布缺少部署记录: ${manifest.buildId}`);
  }
  if (
    deployment.minWebContract !== manifest.minWebContract ||
    deployment.maxWebContract !== manifest.maxWebContract
  ) {
    throw new Error('部署记录的契约范围与发布描述不一致');
  }
  return {
    root,
    releaseDir,
    deploymentId: deployment.deploymentId,
    manifest,
    publicDir,
    index,
    legacy,
  };
}
