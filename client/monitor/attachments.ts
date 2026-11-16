/**
 * 监听器的同源附件下载：只处理 `PUBLIC_ORIGIN` / `AGENTNET_URL` 主机下
 * 形如 `/f/<fileId>` 的公共链接，把图片与 PDF 落到本地 state 目录。
 *
 * 安全边界：
 * - 只接受与允许 origin 完全相同的 http(s) URL，且路径精确为 `/f/<fileId>`；
 *   带 userinfo、query、hash 或其它路径的链接一律拒绝，不会去掉 query/hash
 *   后另行下载；
 * - 根相对 `/f/<fileId>` 以 `PUBLIC_ORIGIN` 为基准解析；未配置时依次回退
 *   到 `AGENTNET_URL`、监听 endpoint。绝对 URL 的 host 必须命中允许 origin；
 * - 不携带任何凭据（`credentials: 'omit'`），不做 cookie 转发；
 * - 重定向手动跟随，每一跳都重新校验 origin 与 `/f/` 路径，最多 3 跳；
 * - 文件名只由内容 SHA-256 与固定扩展名组成，不会从 URL 派生路径；
 * - 目标文件已存在时先校验大小与 SHA-256：一致则复用，不一致则跳过，
 *   不会用 `rename` 覆盖已有文件；
 * - 同时最多下载 `LIMITS.monitorAttachmentMax` 个，单个超过
 *   `LIMITS.monitorAttachmentBytes` 或 `LIMITS.monitorAttachmentTimeoutMs`
 *   即跳过；任何失败只减少附件数量，不阻塞投递。
 */

import { createHash } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import {
  MESSAGE_FILE_ID_SOURCE,
  normalizeEscapedNewlines,
} from '../../src/contracts/file-links';
import { LIMITS } from '../../src/contracts/limits';

/** 与 `src/contracts/file-links.ts` 共用同一 fileId 片段，避免规则漂移。 */
const FILE_ID = new RegExp(`^${MESSAGE_FILE_ID_SOURCE}$`, 'u');
const FILE_PATH = /^\/f\/([^/]+)$/u;
/** 正文扫描规则与服务端一致；命中后仍用 `FILE_ID` 做精确校验。 */
const FILE_REF = /\/f\/([A-Za-z0-9_-]+)/gu;
const MAX_REDIRECTS = 3;

/** 向后扫描 URL 前缀时视为分隔符的字符（与服务端链接提取保持一致）。 */
const PREFIX_DELIMITERS = new Set([
  '"',
  "'",
  '`',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '<',
  '>',
  ',',
  ';',
  '*',
  '|',
  '。',
  '，',
  '；',
  '：',
  '！',
  '？',
  '、',
  '）',
  '】',
  '》',
  '」',
  '』',
]);

const ABSOLUTE_PREFIX = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]+)$/u;
const TOKEN_AFTER = /^[A-Za-z0-9_-]$/u;

export interface MonitorAttachment {
  /** 规范化后的同源下载地址；不含 query/hash 与凭据。 */
  url: string;
  /** 本地绝对路径；Agent 可直接 Read。 */
  path: string;
  mime: string;
  bytes: number;
  sha256: string;
}

export interface AttachmentDownloadOutcome {
  attachments: MonitorAttachment[];
  /** 候选链接中未落入 attachments 的数量（超限、类型不支持、超时等）。 */
  skipped: number;
}

export interface AttachmentDownloadOptions {
  body: string;
  /** 允许下载的 origin 列表；由 `attachmentOrigins` 生成。 */
  origins: readonly string[];
  /** `<state>/attachments` 目录。 */
  directory: string;
  signal?: AbortSignal;
}

/**
 * 从 `PUBLIC_ORIGIN`、`AGENTNET_URL` 与监听 endpoint 收集允许下载的 origin，
 * 去重并只保留 http(s)。顺序固定为 PUBLIC_ORIGIN、AGENTNET_URL、endpoint，
 * 其中第一个也是根相对 `/f/<fileId>` 的解析基准。
 */
export function attachmentOrigins(
  endpoint: string,
  publicOrigin: string | undefined = process.env.PUBLIC_ORIGIN,
  agentnetUrl: string | undefined = process.env.AGENTNET_URL,
): string[] {
  const origins: string[] = [];
  for (const raw of [publicOrigin, agentnetUrl, endpoint]) {
    if (raw === undefined || raw.length === 0) continue;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
      origins.push(url.origin);
    } catch {
      // 非法配置由入口统一报错；这里只跳过。
    }
  }
  return [...new Set(origins)];
}

function isDelimiter(char: string | undefined): boolean {
  return char === undefined || /\s/u.test(char) || PREFIX_DELIMITERS.has(char);
}

/** 判断 `/f/` 之前的前缀是相对路径还是允许 origin 的绝对 URL。 */
function prefixOf(
  body: string,
  index: number,
): { kind: 'relative' } | { kind: 'absolute'; origin: string; userinfo: boolean } | null {
  let start = index;
  while (start > 0 && !isDelimiter(body[start - 1])) start -= 1;
  const prefix = body.slice(start, index);
  if (prefix === '') return { kind: 'relative' };
  if (!ABSOLUTE_PREFIX.test(prefix)) return null;
  try {
    const url = new URL(`${prefix}/`);
    return {
      kind: 'absolute',
      origin: url.origin,
      userinfo: url.username !== '' || url.password !== '',
    };
  } catch {
    return null;
  }
}

/**
 * fileId 后紧跟 `/`、query 或 hash 都不是可下载候选；`/f/<id>.tar`
 * 也不当成 `<id>` 的附件（与服务端链接规则一致）。
 */
function validSuffix(body: string, end: number): boolean {
  const next = body[end];
  if (next === '/' || next === '?' || next === '#') return false;
  if (next === '.') return !TOKEN_AFTER.test(body[end + 1] ?? '');
  return true;
}

/**
 * 从正文按出现顺序提取候选 URL，同时接受 `PUBLIC_ORIGIN` 与
 * `AGENTNET_URL`（二者可不同）。绝对链接必须命中允许 origin；根相对链接
 * 解析到 `origins[0]`。按完整 URL 去重后再取前
 * `LIMITS.monitorAttachmentMax` 个，不按 origin 分组，避免正文顺序错乱。
 */
export function extractAttachmentCandidates(
  body: string,
  origins: readonly string[],
): string[] {
  if (origins.length === 0) return [];
  const allowed = new Set(origins);
  const relativeOrigin = origins[0] as string;
  const candidates: string[] = [];
  const seen = new Set<string>();
  const text = normalizeEscapedNewlines(body);

  for (const match of text.matchAll(FILE_REF)) {
    if (candidates.length >= LIMITS.monitorAttachmentMax) break;
    const fileId = match[1];
    if (fileId === undefined || !FILE_ID.test(fileId)) continue;
    const end = (match.index ?? 0) + match[0].length;
    if (!validSuffix(text, end)) continue;

    const prefix = prefixOf(text, match.index ?? 0);
    if (prefix === null) continue;
    let origin: string;
    if (prefix.kind === 'relative') {
      origin = relativeOrigin;
    } else {
      if (prefix.userinfo || !allowed.has(prefix.origin)) continue;
      origin = prefix.origin;
    }

    const url = `${origin}/f/${fileId}`;
    if (seen.has(url)) continue;
    seen.add(url);
    candidates.push(url);
  }
  return candidates;
}

/** 精确 `/f/<fileId>` 同源校验；重定向后的每一跳都调用。 */
function allowedUrl(raw: string, origins: ReadonlySet<string>): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username.length > 0 || url.password.length > 0) return null;
  if (url.search.length > 0 || url.hash.length > 0) return null;
  if (!origins.has(url.origin)) return null;
  const match = FILE_PATH.exec(url.pathname);
  if (match === null || !FILE_ID.test(match[1] ?? '')) return null;
  return url;
}

function extensionFor(mime: string): string | null {
  if (mime === 'application/pdf') return '.pdf';
  switch (mime) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    case 'image/avif':
      return '.avif';
    case 'image/bmp':
      return '.bmp';
    case 'image/svg+xml':
      return '.svg';
    default:
      return mime.startsWith('image/') ? '.img' : null;
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 连接可能已关闭；没有需要清理的状态。
  }
}

/** 目录固定 0700；已存在时也重新收紧权限。 */
export async function ensureAttachmentDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

/**
 * 启动/退出清理：只删除 attachments 目录下超过保留期的普通文件。
 * 符号链接与子目录不动，避免越界删除。
 */
export async function cleanupOldAttachments(
  directory: string,
  now: number = Date.now(),
): Promise<number> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const path = join(directory, entry.name);
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      if (now - info.mtimeMs <= LIMITS.monitorAttachmentRetentionMs) continue;
      await unlink(path);
      removed += 1;
    } catch {
      // 单个文件失败不影响其它附件。
    }
  }
  return removed;
}

/**
 * 长进程的周期性清理：按固定间隔重新扫描 attachments 目录。
 * 定时器 unref，不阻止进程退出；调用方必须在退出时调用返回的 stop。
 */
export function startAttachmentCleanup(
  directory: string,
  intervalMs: number = LIMITS.monitorAttachmentCleanupIntervalMs,
): () => void {
  const timer = setInterval(() => {
    void cleanupOldAttachments(directory).catch(() => undefined);
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

export async function prepareAttachmentDirectory(directory: string): Promise<void> {
  await ensureAttachmentDirectory(directory);
  await cleanupOldAttachments(directory);
}

/** 有界并发执行；结果保持输入顺序。 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readResponse(
  response: Response,
  url: string,
  directory: string,
): Promise<MonitorAttachment | null> {
  const mime = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = extensionFor(mime);
  if (extension === null) {
    await discard(response);
    return null;
  }

  const declared = Number(response.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > LIMITS.monitorAttachmentBytes) {
    await discard(response);
    return null;
  }

  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const value = chunk.value;
      if (value === undefined) continue;
      bytes += value.byteLength;
      if (bytes > LIMITS.monitorAttachmentBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  if (bytes === 0) return null;

  const payload = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  const sha256 = createHash('sha256').update(payload).digest('hex');
  await ensureAttachmentDirectory(directory);
  const base = resolve(directory);
  const filename = `${sha256}${extension}`;
  const target = resolve(base, filename);
  // 文件名只来自 SHA-256 与白名单扩展名；仍做一次目录边界检查。
  if (dirname(target) !== base || basename(target) !== filename) return null;
  const within = relative(base, target);
  if (within.startsWith('..') || isAbsolute(within)) return null;

  const attachment: MonitorAttachment = { url, path: target, mime, bytes, sha256 };
  const existing = await existingAttachmentState(target, bytes, sha256);
  // 已存在且内容一致时直接复用；不一致时跳过，绝不覆盖。
  if (existing === 'valid') {
    // 保留期从最近一次使用开始，避免长期运行清理误删仍在引用的附件。
    const now = new Date();
    await utimes(target, now, now).catch(() => undefined);
    return attachment;
  }
  if (existing === 'invalid') return null;

  // 先写同目录临时文件；用硬链接发布到内容 hash 目标。link 在目标已存在时
  // 返回 EEXIST，因此不会覆盖并发写入的同名文件。
  const temp = resolve(base, `.${filename}.${process.pid}.${Date.now().toString(36)}.tmp`);
  if (dirname(temp) !== base) return null;
  try {
    await writeFile(temp, payload, { mode: 0o600 });
    await chmod(temp, 0o600);
    await link(temp, target);
  } catch {
    // 并发创建同名目标时重新校验，一致则复用；其它失败只跳过。
    await unlink(temp).catch(() => undefined);
    return (await existingAttachmentState(target, bytes, sha256)) === 'valid' ? attachment : null;
  }
  await unlink(temp).catch(() => undefined);
  return attachment;
}

/** 目标已存在时按大小与内容 SHA-256 判定；不跟随符号链接。 */
async function existingAttachmentState(
  target: string,
  bytes: number,
  sha256: string,
): Promise<'missing' | 'valid' | 'invalid'> {
  try {
    const info = await lstat(target);
    if (!info.isFile() || info.size !== bytes) return 'invalid';
    const content = await readFile(target);
    return createHash('sha256').update(content).digest('hex') === sha256 ? 'valid' : 'invalid';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  }
}

async function downloadOne(
  rawUrl: string,
  origins: ReadonlySet<string>,
  directory: string,
  monitorSignal: AbortSignal | undefined,
): Promise<MonitorAttachment | null> {
  let current = allowedUrl(rawUrl, origins);
  if (current === null) return null;

  // 每个附件独立 5 秒预算，互不占用；monitor 退出时一并中止。
  const timeout = AbortSignal.timeout(LIMITS.monitorAttachmentTimeoutMs);
  const signal = monitorSignal === undefined ? timeout : AbortSignal.any([timeout, monitorSignal]);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        signal,
        headers: { accept: 'image/*,application/pdf' },
      });
    } catch {
      return null;
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await discard(response);
      if (location === null || hop === MAX_REDIRECTS) return null;
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return null;
      }
      const checked = allowedUrl(next.toString(), origins);
      if (checked === null) return null;
      current = checked;
      continue;
    }

    if (response.status !== 200) {
      await discard(response);
      return null;
    }
    return await readResponse(response, current.toString(), directory);
  }
  return null;
}

/**
 * 下载正文中的同源附件。任何单个失败都只计入 skipped；调用方不得因
 * 附件失败而丢弃投递。
 */
export async function downloadAttachments(
  options: AttachmentDownloadOptions,
): Promise<AttachmentDownloadOutcome> {
  const candidates = extractAttachmentCandidates(options.body, options.origins);
  if (candidates.length === 0) return { attachments: [], skipped: 0 };

  const origins = new Set(options.origins);
  const results = await mapWithConcurrency(
    candidates,
    LIMITS.monitorAttachmentConcurrency,
    async (candidate) => {
      try {
        return await downloadOne(candidate, origins, options.directory, options.signal);
      } catch {
        return null;
      }
    },
  );
  const attachments = results.filter((item): item is MonitorAttachment => item !== null);
  return { attachments, skipped: results.length - attachments.length };
}

/** 事件里的紧凑结构；`path` 是本地绝对路径。 */
export function attachmentFields(attachments: readonly MonitorAttachment[]): Array<{
  url: string;
  path: string;
  mime: string;
  bytes: number;
  sha256: string;
}> {
  return attachments.map((attachment) => ({
    url: attachment.url,
    path: attachment.path,
    mime: attachment.mime,
    bytes: attachment.bytes,
    sha256: attachment.sha256,
  }));
}

/** codex prompt 的一行附件路径列表；无附件时返回空串。 */
export function attachmentPromptLine(attachments: readonly MonitorAttachment[]): string {
  if (attachments.length === 0) return '';
  return `\n\n附件本地路径：${attachments.map((attachment) => attachment.path).join('、')}`;
}
