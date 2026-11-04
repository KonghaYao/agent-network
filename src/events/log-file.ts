/**
 * MCP Events 文件日志 sink（轻量插件，不引入日志框架）。
 *
 * - 默认 `${DATA_DIR}/logs/events.log`，可用 `EVENTS_LOG_FILE` 覆盖；
 * - JSON 行 append，单文件约 10 MiB，保留 5 个 `.1`..`.5`；
 * - 写入/轮转失败 fail-open，不影响请求，stdout/journald 日志照常输出；
 * - 只接收调用方已脱敏的整行文本，不解析业务字段，不接触 URL/secret。
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const EVENTS_LOG_MAX_BYTES = 10 * 1024 * 1024;
export const EVENTS_LOG_BACKUPS = 5;

export interface EventsFileLogOptions {
  /** 默认取 `DATA_DIR`，再回退到 `.data`。 */
  dataDir?: string;
  /** 最高优先级覆盖；未提供时读 `EVENTS_LOG_FILE`。 */
  filePath?: string;
  maxBytes?: number;
  backups?: number;
}

interface FileLogSink {
  filePath: string;
  maxBytes: number;
  backups: number;
  size: number;
}

let sink: FileLogSink | null = null;

function rotate(current: FileLogSink): void {
  if (current.backups <= 0 || current.maxBytes <= 0) return;
  const oldest = `${current.filePath}.${current.backups}`;
  try {
    if (existsSync(oldest)) unlinkSync(oldest);
  } catch {
    // fail-open：清理最旧文件失败时继续尝试其余步骤。
  }
  for (let index = current.backups - 1; index >= 1; index -= 1) {
    const from = `${current.filePath}.${index}`;
    if (!existsSync(from)) continue;
    try {
      renameSync(from, `${current.filePath}.${index + 1}`);
    } catch {
      return;
    }
  }
  try {
    renameSync(current.filePath, `${current.filePath}.1`);
    current.size = 0;
  } catch {
    // fail-open：当前文件无法轮转时保持追加。
  }
}

/**
 * 启动时调用；目录创建失败返回 false 并禁用文件日志。
 * 已存在的文件按当前大小继续计量，进程重启后仍能正确轮转。
 */
export function initEventsFileLog(options: EventsFileLogOptions = {}): boolean {
  try {
    const dataDir = resolve(options.dataDir ?? process.env.DATA_DIR ?? '.data');
    const filePath = resolve(
      options.filePath ?? process.env.EVENTS_LOG_FILE ?? join(dataDir, 'logs', 'events.log'),
    );
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o750 });
    const size = existsSync(filePath) ? statSync(filePath).size : 0;
    sink = {
      filePath,
      maxBytes: options.maxBytes ?? EVENTS_LOG_MAX_BYTES,
      backups: options.backups ?? EVENTS_LOG_BACKUPS,
      size,
    };
    return true;
  } catch (error) {
    sink = null;
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`agent-network events file log disabled: ${message}`);
    return false;
  }
}

/** 追加一行；未初始化或写入失败时静默返回，stdout 日志不受影响。 */
export function writeEventsLogLine(line: string): void {
  if (sink === null) return;
  const bytes = Buffer.byteLength(line, 'utf8') + 1;
  try {
    if (
      sink.maxBytes > 0 &&
      sink.backups > 0 &&
      sink.size > 0 &&
      sink.size + bytes > sink.maxBytes
    ) {
      rotate(sink);
    }
    appendFileSync(sink.filePath, `${line}\n`, { encoding: 'utf8', mode: 0o640 });
    sink.size += bytes;
  } catch {
    // fail-open：磁盘满、权限变化或目录被删除都不影响请求。
  }
}

export function eventsLogFilePath(): string | null {
  return sink?.filePath ?? null;
}

/** 仅测试使用：断开文件 sink，避免跨用例串写。 */
export function resetEventsFileLog(): void {
  sink = null;
}
