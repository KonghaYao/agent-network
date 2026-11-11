/**
 * 文件端到端：上传、发送、下载与房间文件管理。
 *
 * 上传分两步：`network_file_upload_prepare` 只签发绑定文件名/MIME/大小/
 * SHA-256 的短时票据，随后由 CLI 按返回的 URL 与请求头直接 POST 原始字节。
 * 上传请求不携带 Bearer token；票据过期、体积超限、摘要不一致都转换成
 * 可操作的中文提示，错误信息里不放签名 URL。
 */

import { stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { commaList, newId, optionalInteger, required } from '../options';
import type { McpClient, ResolvedConfig } from '../mcp';
import { CliError } from '../mcp';
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  emit,
  field,
  line,
} from '../output';

/** 与服务端 `FILE_ID_PATTERN` 一致；客户端不解码文件内容，只做输入分流。 */
const FILE_ID = /^f_[A-Za-z0-9_-]{22}$/u;
const UPLOAD_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

interface FileOutcome {
  file_id: string;
  room_file_id: string | null;
  room_id: string | null;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  expires_at: string | null;
  bound: boolean;
  public_url: string | null;
  preview_url: string | null;
  download_url: string | null;
  state: string | null;
  visibility: string | null;
  retained: boolean | null;
}

interface UploadFileOptions {
  path: string;
  name?: string | undefined;
  mime?: string | undefined;
  room?: string | undefined;
  requestId?: string | undefined;
}

function roomFrom(room: string | undefined, command: string): string {
  if (!room) {
    throw new CliError(
      `缺少房间 id：使用 ${command} --room <id>（可用 rooms 查看；运行 agentnet ${command} --help 查看示例）`,
    );
  }
  return room;
}

function fileIdFrom(
  options: { file?: string; fileId?: string },
  command: string,
): string {
  const value = options.file ?? options.fileId;
  if (!value) {
    throw new CliError(
      `缺少文件 id：使用 ${command} --file <file_id>（可用 files --room <id> 查看；运行 agentnet ${command} --help 查看示例）`,
    );
  }
  return value;
}

/** Bun 的 `file.type` 可能带 charset；MCPP 只接受纯 MIME。 */
function mimeForPath(path: string): string {
  const raw = Bun.file(path).type ?? '';
  const candidate = raw.split(';')[0]?.trim().toLowerCase() ?? '';
  return /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/u.test(candidate) &&
    candidate !== 'multipart/form-data'
    ? candidate
    : 'application/octet-stream';
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(path).stream()) hasher.update(chunk);
  return hasher.digest('hex');
}

function safeName(raw: string): string {
  const name = basename(raw).trim();
  return name.length > 0 && name !== '.' && name !== '..' ? name : 'download';
}

function httpUrl(raw: string, label: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CliError(`${label}不是合法 URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliError(`${label}必须是 http:// 或 https://`);
  }
  return parsed.toString();
}

function preparedHeaders(value: unknown): Record<string, string> {
  const source = asRecord(value);
  const headers: Record<string, string> = {};
  for (const [key, item] of Object.entries(source)) {
    if (typeof item === 'string') headers[key] = item;
  }
  if (Object.keys(headers).length === 0) {
    throw new CliError('上传准备结果缺少请求头；请重新执行 upload');
  }
  return headers;
}

function uploadError(
  status: number,
  payload: Record<string, unknown> | null,
  maxBytes: number | undefined,
): CliError {
  const error = asRecord(payload?.error);
  const serverCode = asString(error.code);
  const serverMessage = asString(error.message);
  const limit = maxBytes === undefined ? '' : `（服务端上限 ${maxBytes} 字节）`;
  if (status === 401 || status === 403) {
    return new CliError(
      '上传票据已过期、凭据已撤销或上传元数据不匹配；票据只有 5 分钟有效期，请重新执行 upload',
      { code: 'UPLOAD_TICKET_EXPIRED' },
    );
  }
  if (status === 413) {
    return new CliError(`文件超过服务端上限${limit}；压缩或拆分后重试`, {
      code: 'FILE_TOO_LARGE',
    });
  }
  if (status === 507) {
    return new CliError(
      '草稿配额不足：先删除未绑定文件（files/file-delete）或联系管理员扩容，然后重新 upload',
      { code: 'QUOTA_EXCEEDED' },
    );
  }
  if (status === 429) {
    return new CliError('上传并发或频率超限，稍后重试', {
      code: serverCode || 'UPLOAD_LIMIT_REACHED',
    });
  }
  if (status === 503) {
    return new CliError('文件存储暂不可用，稍后重试', {
      code: serverCode || 'FILE_STORAGE_UNAVAILABLE',
    });
  }
  if (/CHECKSUM_MISMATCH|SHA256_MISMATCH/u.test(serverCode)) {
    return new CliError(
      '上传内容与票据的 SHA-256 不一致：本地文件可能在上传期间被修改；请保持文件不变后重试',
      { code: serverCode },
    );
  }
  if (serverCode === 'UPLOAD_RESULT_UNKNOWN') {
    return new CliError(
      '上传结果未知：服务端可能已经保存文件；不要盲目重传，先用 files/file-info 检查草稿',
      { code: 'UPLOAD_RESULT_UNKNOWN' },
    );
  }
  const detail = serverMessage || serverCode || '未知错误';
  return new CliError(`上传失败（HTTP ${status}）：${detail}`, {
    code: serverCode || `HTTP_${status}`,
  });
}

function prepareFailure(error: unknown): never {
  if (!(error instanceof CliError)) throw error;
  if (/size|too (?:big|large)|maximum|max\b/iu.test(error.message)) {
    throw new CliError(`文件超过服务端上限：${error.message}；压缩或拆分后重试`, {
      code: 'FILE_TOO_LARGE',
    });
  }
  throw error;
}

/**
 * 上传一个本地文件；`room` 存在时立即绑定并返回带票据地址。
 *
 * 失败时只把 `file_id`（若已产生）放进 details，绝不把上传票据或签名
 * URL 带进错误输出，便于脚本安全重试。
 */
async function uploadFile(
  client: McpClient,
  options: UploadFileOptions,
): Promise<FileOutcome> {
  const path = resolve(options.path);
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new CliError(`文件不存在或不是普通文件：${path}`);
  const file = Bun.file(path);
  const size = file.size;
  const name = options.name ?? basename(path);
  const mime = (options.mime ?? mimeForPath(path)).toLowerCase();
  const sha256 = await sha256File(path);

  let prepared: Record<string, unknown>;
  try {
    prepared = await client.callTool('network_file_upload_prepare', {
      name,
      mime_type: mime,
      size,
      sha256,
    });
  } catch (error) {
    prepareFailure(error);
  }

  const maxFileBytes =
    typeof prepared.max_file_bytes === 'number' ? prepared.max_file_bytes : undefined;
  if (maxFileBytes !== undefined && size > maxFileBytes) {
    throw new CliError(`文件超过服务端上限（${maxFileBytes} 字节）；压缩或拆分后重试`, {
      code: 'FILE_TOO_LARGE',
    });
  }
  const uploadUrl = httpUrl(asString(prepared.upload_url), '上传地址');
  if (asString(prepared.method, 'POST') !== 'POST') {
    throw new CliError('上传准备结果要求非 POST 方法，当前客户端不支持');
  }
  const headers = preparedHeaders(prepared.headers);
  const expiresAt = asString(prepared.expires_at);
  if (expiresAt && Date.parse(expiresAt) <= Date.now()) {
    throw new CliError('上传票据已过期；请重新执行 upload（票据 5 分钟内有效）', {
      code: 'UPLOAD_TICKET_EXPIRED',
    });
  }

  let response: Response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers,
      body: file,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `上传请求失败：${reason}；网络恢复后重试，票据过期则重新执行 upload`,
      { code: 'UPLOAD_NETWORK_ERROR' },
    );
  }

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) throw uploadError(response.status, payload, maxFileBytes);
  if (payload === null) {
    throw new CliError(`上传响应不是合法 JSON（HTTP ${response.status}）`, {
      code: 'UPLOAD_BAD_RESPONSE',
    });
  }

  const fileId = asString(payload.fileId);
  if (!FILE_ID.test(fileId)) {
    throw new CliError('上传响应缺少合法 fileId；请重试或联系管理员检查上传服务', {
      code: 'UPLOAD_BAD_RESPONSE',
    });
  }
  const actualSize = asNumber(payload.size, -1);
  const actualSha = asString(payload.sha256).toLowerCase();
  if (actualSize !== size || actualSha !== sha256) {
    throw new CliError(
      '上传结果校验失败（size/sha256 与本地文件不一致）；文件未绑定，请重新上传',
      {
        code: 'UPLOAD_VERIFY_FAILED',
        details: {
          file_id: fileId,
          expected_size: size,
          actual_size: actualSize,
          expected_sha256: sha256,
          actual_sha256: actualSha,
        },
      },
    );
  }

  const outcome: FileOutcome = {
    file_id: fileId,
    room_file_id: null,
    room_id: null,
    name: asString(payload.name, name),
    mime_type: asString(payload.mimeType, mime),
    size: actualSize,
    sha256: actualSha,
    expires_at: asString(payload.expiresAt) || null,
    bound: false,
    public_url: asString(payload.publicUrl) || null,
    preview_url: asString(payload.previewUrl) || null,
    download_url: asString(payload.downloadUrl) || null,
    state: asString(payload.state) || null,
    visibility: asString(payload.visibility) || null,
    retained: typeof payload.retained === 'boolean' ? payload.retained : null,
  };

  if (options.room === undefined) return outcome;

  let bind: Record<string, unknown>;
  try {
    bind = await client.callTool('network_room_file_bind', {
      request_id: options.requestId ?? newId('req'),
      room_id: options.room,
      file_id: fileId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `上传成功但绑定失败（file_id=${fileId}）：${reason}；可用 file-bind --room ${options.room} --file ${fileId} 重试`,
      {
        code: error instanceof CliError ? error.code : 'FILE_BIND_FAILED',
        details: { file_id: fileId, room_id: options.room, name, size, sha256 },
      },
    );
  }

  const bound = asRecord(bind.file);
  outcome.bound = true;
  outcome.room_id = asString(bound.room_id, options.room);
  outcome.room_file_id = asString(bound.room_file_id) || null;
  outcome.name = asString(bound.name, outcome.name);
  outcome.mime_type = asString(bound.mime_type, outcome.mime_type);
  outcome.size = asNumber(bound.size, outcome.size);
  outcome.sha256 = asString(bound.sha256, outcome.sha256);
  outcome.expires_at = asString(bound.expires_at) || outcome.expires_at;
  outcome.public_url = asString(bound.public_url) || outcome.public_url;
  outcome.preview_url = asString(bound.preview_url) || outcome.preview_url;
  outcome.download_url = asString(bound.download_url) || outcome.download_url;
  outcome.state = asString(bound.state) || outcome.state;
  outcome.visibility = asString(bound.visibility) || outcome.visibility;
  outcome.retained =
    typeof bound.retained === 'boolean' ? bound.retained : outcome.retained;
  return outcome;
}

function printUpload(value: FileOutcome): void {
  line(
    `uploaded ${field('file_id', value.file_id)} ${field('size', value.size)} ${field(
      'sha256',
      value.sha256,
    )} ${field('mime', value.mime_type)} ${field('name', value.name)}`,
  );
  if (value.bound) {
    line(
      `bind=bound ${field('room_id', value.room_id)} ${field(
        'room_file_id',
        value.room_file_id,
      )}`,
    );
    if (value.preview_url) line(`preview_url=${value.preview_url}`);
    if (value.download_url) line(`download_url=${value.download_url}`);
  } else {
    line('bind=skipped（未传 --room；可先用 file-bind 绑定再发送）');
  }
  line(`expires_at=${value.expires_at ?? '-'}`);
}

export interface UploadOptions {
  file?: string;
  name?: string;
  mime?: string;
  room?: string;
  requestId?: string;
}

export async function upload(
  client: McpClient,
  config: ResolvedConfig,
  options: UploadOptions,
): Promise<void> {
  const filePath = required(options.file, 'file', {
    suggestion: '本地文件路径',
    command: 'upload',
  });
  const outcome = await uploadFile(client, {
    path: filePath,
    name: options.name,
    mime: options.mime,
    room: options.room,
    requestId: options.requestId,
  });
  emit(config, outcome, printUpload);
}

/** file 参数既可以是本地路径，也可以是已上传的 file_id。 */
async function resolveInput(
  raw: string,
): Promise<{ kind: 'path'; path: string } | { kind: 'file_id'; fileId: string }> {
  if (FILE_ID.test(raw) && !(await Bun.file(raw).exists())) {
    return { kind: 'file_id', fileId: raw };
  }
  return { kind: 'path', path: raw };
}

async function roomFileMetadata(
  client: McpClient,
  roomId: string,
  fileId: string,
): Promise<FileOutcome> {
  let result: Record<string, unknown>;
  try {
    result = await client.callTool('network_room_file_get', {
      room_id: roomId,
      file_id: fileId,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `${reason}；确认文件已绑定到该房间（upload --room 或 file-bind）`,
      {
        code: error instanceof CliError ? error.code : 'FILE_UNAVAILABLE',
        details: { file_id: fileId, room_id: roomId },
      },
    );
  }
  const file = asRecord(result.file);
  return {
    file_id: asString(file.file_id, fileId),
    room_file_id: asString(file.room_file_id) || null,
    room_id: asString(file.room_id, roomId),
    name: asString(file.name, fileId),
    mime_type: asString(file.mime_type, 'application/octet-stream'),
    size: asNumber(file.size),
    sha256: asString(file.sha256),
    expires_at: asString(file.expires_at) || null,
    bound: true,
    public_url: asString(file.public_url) || null,
    preview_url: asString(file.preview_url) || null,
    download_url: asString(file.download_url) || null,
    state: null,
    visibility: null,
    retained: typeof file.retained === 'boolean' ? file.retained : null,
  };
}

export interface SendFileOptions {
  room?: string;
  file?: string;
  body?: string;
  name?: string;
  mime?: string;
  invoke?: string;
  noInvoke?: boolean;
  mention?: string;
  mentions?: string;
  requestId?: string;
  clientMessageId?: string;
}

export async function sendFile(
  client: McpClient,
  config: ResolvedConfig,
  options: SendFileOptions,
): Promise<void> {
  const roomId = roomFrom(options.room, 'send-file');
  const input = required(options.file, 'file', {
    suggestion: '本地文件路径或已上传的 file_id',
    command: 'send-file',
  });
  const nameFlag = options.name;
  const mimeFlag = options.mime;
  const resolved = await resolveInput(input);

  let outcome: FileOutcome;
  if (resolved.kind === 'path') {
    try {
      outcome = await uploadFile(client, {
        path: resolved.path,
        name: nameFlag,
        mime: mimeFlag,
        room: roomId,
      });
    } catch (error) {
      if (
        error instanceof CliError &&
        error.details !== undefined &&
        error.message.includes('绑定失败')
      ) {
        const fileId = asString(asRecord(error.details).file_id);
        if (fileId) {
          throw new CliError(
            `${error.message}；文件已上传，可用 send-file --room ${roomId} --file ${fileId} 重试发送`,
            { code: error.code, details: error.details },
          );
        }
      }
      throw error;
    }
  } else {
    if (nameFlag !== undefined || mimeFlag !== undefined) {
      throw new CliError('--name/--mime 只用于本地上传；file_id 输入沿用已上传的元数据');
    }
    outcome = await roomFileMetadata(client, roomId, resolved.fileId);
  }

  const linkUrl = outcome.download_url ?? outcome.preview_url ?? outcome.public_url;
  if (!linkUrl) {
    throw new CliError(
      `文件 ${outcome.file_id} 缺少可发送的下载地址；先用 file --room ${roomId} --file ${outcome.file_id} 刷新后重试`,
      { code: 'FILE_URL_MISSING', details: { file_id: outcome.file_id, room_id: roomId } },
    );
  }

  let text = options.body;
  if (text === '-') text = await Bun.stdin.text();
  text = (text ?? '').trimEnd();
  const link = `[${outcome.name}](${linkUrl})`;
  const body = text.length > 0 ? `${text}\n\n${link}` : link;

  const explicitInvoke = commaList(options.invoke);
  const noInvoke = options.noInvoke === true;
  if (noInvoke && explicitInvoke !== undefined) {
    throw new CliError('--invoke 与 --no-invoke 不能同时使用（运行 agentnet send-file --help 查看示例）');
  }
  const invoke = noInvoke ? [] : explicitInvoke;
  const mentions = commaList(options.mention ?? options.mentions);
  const requestId = options.requestId ?? newId('req');
  const clientMessageId = options.clientMessageId ?? newId('msg');

  let sent: Record<string, unknown>;
  try {
    sent = await client.callTool('network_message_send', {
      request_id: requestId,
      client_message_id: clientMessageId,
      room_id: roomId,
      body,
      ...(invoke === undefined ? {} : { invoke }),
      ...(mentions === undefined ? {} : { mentions }),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `文件已就绪（file_id=${outcome.file_id}），但消息发送失败：${reason}；先确认消息未发出（send-status），再用 send-file --room ${roomId} --file ${outcome.file_id} 重试`,
      {
        code: error instanceof CliError ? error.code : 'MESSAGE_SEND_FAILED',
        details: {
          file_id: outcome.file_id,
          room_file_id: outcome.room_file_id,
          room_id: roomId,
          request_id: requestId,
          client_message_id: clientMessageId,
        },
      },
    );
  }

  const sentMessage = asRecord(sent.message);
  const output: Record<string, unknown> = {
    file_id: outcome.file_id,
    room_file_id: outcome.room_file_id,
    room_id: roomId,
    name: outcome.name,
    mime_type: outcome.mime_type,
    size: outcome.size,
    sha256: outcome.sha256,
    bound: outcome.bound,
    // 消息 preview 会原样带上带票据的文件链接；CLI 输出只保留定位字段，
    // 避免把签名 URL 写进日志或脚本结果。
    message: {
      message_id: asString(sentMessage.message_id),
      created_seq: asString(sentMessage.created_seq),
      sender_id: asString(sentMessage.sender_id),
    },
    delivery_ids: asArray(sent.delivery_ids).map(String),
    request_id: requestId,
    client_message_id: clientMessageId,
  };
  emit(config, output, (value) => {
    const message = asRecord(value.message);
    const deliveries = asArray(value.delivery_ids).map(String);
    line(
      `已发送 ${field('message_id', asString(message.message_id, '-'))} ${field(
        'seq',
        asString(message.created_seq, '-'),
      )} ${field('room_id', roomId)}`,
    );
    line(
      `file_id=${outcome.file_id} ${field('room_file_id', outcome.room_file_id)} ${field(
        'size',
        outcome.size,
      )} ${field('sha256', outcome.sha256)} ${field('mime', outcome.mime_type)}`,
    );
    line(
      `deliveries=${deliveries.length > 0 ? deliveries.join(',') : 'none'} ${field(
        'request_id',
        requestId,
      )} ${field('client_message_id', clientMessageId)}`,
    );
  });
}

function downloadStatusError(status: number, statusText: string): CliError {
  if (status === 401 || status === 403) {
    return new CliError(
      `下载被拒绝（HTTP ${status} ${statusText}）：下载票据可能已过期或当前身份无权访问；重新执行 download 获取新票据`,
      { code: 'DOWNLOAD_FORBIDDEN' },
    );
  }
  if (status === 404) {
    return new CliError(
      `文件不存在、已删除或已过期（HTTP 404 ${statusText}）；用 file --room <id> --file <file_id> 确认状态`,
      { code: 'FILE_UNAVAILABLE' },
    );
  }
  if (status === 503) {
    return new CliError(`文件存储暂不可用（HTTP 503 ${statusText}），稍后重试`, {
      code: 'FILE_STORAGE_UNAVAILABLE',
    });
  }
  return new CliError(`下载失败（HTTP ${status} ${statusText}）`, {
    code: `HTTP_${status}`,
  });
}

async function outputPath(out: string | undefined, name: string): Promise<string> {
  if (!out) return resolve(safeName(name));
  const info = await stat(out).catch(() => null);
  if (info?.isDirectory() === true) return resolve(join(out, safeName(name)));
  return resolve(out);
}

export interface DownloadOptions {
  room?: string;
  file?: string;
  fileId?: string;
  out?: string;
}

export async function download(
  client: McpClient,
  config: ResolvedConfig,
  options: DownloadOptions,
): Promise<void> {
  const roomId = roomFrom(options.room, 'download');
  const fileId = fileIdFrom(options, 'download');
  const file = await roomFileMetadata(client, roomId, fileId);
  const url = file.download_url ?? file.preview_url;
  if (!url) {
    throw new CliError(
      `文件 ${fileId} 缺少下载地址；先用 file --room ${roomId} --file ${fileId} 刷新后重试`,
      { code: 'FILE_URL_MISSING', details: { file_id: fileId, room_id: roomId } },
    );
  }
  const target = await outputPath(options.out, file.name);

  let response: Response;
  try {
    response = await fetch(httpUrl(url, '下载地址'), {
      headers: { accept: '*/*' },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`下载请求失败：${reason}；网络恢复后重试`, {
      code: 'DOWNLOAD_NETWORK_ERROR',
    });
  }
  if (!response.ok) throw downloadStatusError(response.status, response.statusText);

  try {
    await Bun.write(target, response);
  } catch (error) {
    await Bun.file(target)
      .unlink()
      .catch(() => {});
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`无法写入 ${target}：${reason}`, { code: 'DOWNLOAD_WRITE_FAILED' });
  }

  const actualSize = (await stat(target)).size;
  const actualSha = await sha256File(target);
  if (
    (file.size > 0 && actualSize !== file.size) ||
    (file.sha256.length > 0 && actualSha !== file.sha256)
  ) {
    await Bun.file(target)
      .unlink()
      .catch(() => {});
    throw new CliError(
      `下载内容校验失败（size/sha256 与房间文件元数据不一致）；已删除临时文件 ${target}，请重试`,
      {
        code: 'DOWNLOAD_VERIFY_FAILED',
        details: {
          file_id: fileId,
          expected_size: file.size,
          actual_size: actualSize,
          expected_sha256: file.sha256,
          actual_sha256: actualSha,
        },
      },
    );
  }

  const output = {
    room_id: roomId,
    file_id: fileId,
    room_file_id: file.room_file_id,
    name: file.name,
    size: actualSize,
    sha256: actualSha,
    saved_to: target,
  };
  emit(config, output, (value) => {
    line(`saved ${asString(value.saved_to)}`);
    line(
      `file_id=${fileId} ${field('name', file.name)} ${field('size', actualSize)} ${field(
        'sha256',
        actualSha,
      )}`,
    );
  });
}

export interface FilesOptions {
  room?: string;
  limit?: string;
  cursor?: string;
}

export async function files(
  client: McpClient,
  config: ResolvedConfig,
  options: FilesOptions,
): Promise<void> {
  const roomId = roomFrom(options.room, 'files');
  const limit = optionalInteger(options.limit, 'limit', { min: 1, command: 'files' });
  const cursor = options.cursor;
  const result = await client.callTool('network_room_file_list', {
    room_id: roomId,
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  emit(config, result, (value) => {
    const items = asArray(value.items).map(asRecord);
    const quota = asRecord(value.quota);
    line(
      `FILES (${items.length}${value.has_more ? ', more' : ''}) next_cursor=${asString(
        value.next_cursor,
        '-',
      )} has_more=${String(value.has_more === true)} quota=${asNumber(
        quota.used_bytes,
      )}/${asNumber(quota.limit_bytes)}B ${asNumber(quota.used_files)}/${asNumber(
        quota.limit_files,
      )}`,
    );
    for (const item of items) {
      line(
        `${asString(item.room_file_id, '-')}  ${asString(item.file_id, '-')}  ${asString(
          item.name,
          '-',
        )}  ${asNumber(item.size)}B  ${asString(item.mime_type, '-')}  uploader=${asString(
          item.uploader_name,
          asString(item.uploader_id, '-'),
        )}${item.retained === true ? '  RETAINED' : ''}`,
      );
    }
  });
}

function printRoomFile(file: Record<string, unknown>): void {
  line(
    `room_file_id=${asString(file.room_file_id, '-')} file_id=${asString(
      file.file_id,
      '-',
    )} room_id=${asString(file.room_id, '-')}`,
  );
  line(
    `name=${asString(file.name, '-')} size=${asNumber(file.size)} mime=${asString(
      file.mime_type,
      '-',
    )} sha256=${asString(file.sha256, '-')}`,
  );
  line(
    `preview_kind=${asString(file.preview_kind, '-')} uploader=${asString(
      file.uploader_name,
      asString(file.uploader_id, '-'),
    )} can_delete=${String(file.can_delete === true)} retained=${String(
      file.retained === true,
    )}`,
  );
  line(
    `created_at=${asString(file.created_at, '-')} expires_at=${asString(
      file.expires_at,
      '-',
    )}`,
  );
}

export interface RoomFileOptions {
  room?: string;
  file?: string;
  fileId?: string;
}

export async function file(
  client: McpClient,
  config: ResolvedConfig,
  options: RoomFileOptions,
): Promise<void> {
  const roomId = roomFrom(options.room, 'file');
  const fileId = fileIdFrom(options, 'file');
  const result = await client.callTool('network_room_file_get', {
    room_id: roomId,
    file_id: fileId,
  });
  emit(config, result, (value) => printRoomFile(asRecord(value.file)));
}

export async function fileInfo(
  client: McpClient,
  config: ResolvedConfig,
  options: Pick<RoomFileOptions, 'file' | 'fileId'>,
): Promise<void> {
  const fileId = fileIdFrom(options, 'file-info');
  const result = await client.callTool('drive_file_info', { fileId });
  emit(config, result, (value) => {
    line(
      `file_id=${asString(value.fileId, '-')} name=${asString(
        value.name,
        '-',
      )} size=${asNumber(value.size)} mime=${asString(value.mimeType, '-')}`,
    );
    line(
      `sha256=${asString(value.sha256, '-')} state=${asString(
        value.state,
        '-',
      )} visibility=${asString(value.visibility, '-')} retained=${String(
        value.retained === true,
      )}`,
    );
    const quota = asRecord(value.quota);
    line(
      `created_at=${asString(value.createdAt, '-')} expires_at=${asString(
        value.expiresAt,
        '-',
      )} quota=${asNumber(quota.used_bytes)}/${asNumber(quota.limit_bytes)}B ` +
        `${asNumber(quota.used_files)}/${asNumber(quota.limit_files)}`,
    );
  });
}

export interface FileBindOptions extends RoomFileOptions {
  requestId?: string;
}

export async function fileBind(
  client: McpClient,
  config: ResolvedConfig,
  options: FileBindOptions,
): Promise<void> {
  const roomId = roomFrom(options.room, 'file-bind');
  const fileId = fileIdFrom(options, 'file-bind');
  const requestId = options.requestId ?? newId('req');
  const result = await client.callTool('network_room_file_bind', {
    request_id: requestId,
    room_id: roomId,
    file_id: fileId,
  });
  const output: Record<string, unknown> = { ...result, request_id: requestId };
  emit(config, output, (value) => {
    const bound = asRecord(value.file);
    printRoomFile(bound);
    line(
      `bind=bound ${field('request_id', requestId)} preview_url=${asString(
        bound.preview_url,
        '-',
      )}`,
    );
    line(`download_url=${asString(bound.download_url, '-')}`);
  });
}

export async function fileDelete(
  client: McpClient,
  config: ResolvedConfig,
  options: FileBindOptions,
): Promise<void> {
  const roomId = roomFrom(options.room, 'file-delete');
  const fileId = fileIdFrom(options, 'file-delete');
  const requestId = options.requestId ?? newId('req');
  const result = await client.callTool('network_room_file_delete', {
    request_id: requestId,
    room_id: roomId,
    file_id: fileId,
  });
  const output: Record<string, unknown> = { ...result, request_id: requestId };
  emit(config, output, (value) => {
    line(`deleted file_id=${asString(value.file_id, fileId)} ${field('request_id', requestId)}`);
  });
}
