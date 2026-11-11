/**
 * dsh 监听器的本地状态：WEBBOTS_HOME 路径、status.json、PID、wake.queue 游标。
 *
 * 这些格式与 public/skills/dsh-watch.sh 完全一致；只做纯 I/O，不访问网络、
 * 不接触 token。status 写入使用临时文件 + rename，避免巡检读到半截 JSON。
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { asRecord } from '../output';
import type { JsonObject } from './rpc';

export interface DshPaths {
  home: string;
  queue: string;
  status: string;
  log: string;
  pid: string;
  cursor: string;
}

export type DshState = 'starting' | 'running' | 'stopped' | 'fatal';

export interface DshStatus {
  state: DshState;
  pid: number;
  connected: boolean;
  acked: boolean;
  online: boolean;
  pending_count: number;
  reconnects: number;
  lastEventAt: string | null;
  lastNotificationAt: string | null;
  lastError: string | null;
  startedAt: string | null;
  updatedAt: string;
}

let statusWriteSeq = 0;

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

export function resolveHome(): string {
  const configured = process.env.WEBBOTS_HOME;
  return configured && configured.length > 0 ? configured : join(homedir(), '.webbots');
}

export function dshPaths(): DshPaths {
  const home = resolveHome();
  return {
    home,
    queue: join(home, 'wake.queue'),
    status: join(home, 'status.json'),
    log: join(home, 'watch.log'),
    pid: join(home, 'watch.pid'),
    cursor: join(home, 'wake.cursor'),
  };
}

/** jq `.field // "" | tostring`：null/false 视为空，其它标量转字符串。 */
export function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined || value === false) return '';
  return String(value);
}

/** jq `.attention // "informational"`。 */
export function pickText(value: unknown, fallback: string): string {
  if (value === null || value === undefined || value === false) return fallback;
  return typeof value === 'string' ? value : String(value);
}

/** `.field // ""` 后写入 JSON：空字符串落成 null。 */
export function nullable(value: string): string | null {
  return value.length === 0 ? null : value;
}

/** jq `-r` 后按 shell 数字判断：接受 number 与纯数字字符串。 */
export function numericValue(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+$/u.test(value)) return Number(value);
  return fallback;
}

export function booleanValue(value: unknown): boolean {
  return value === true || value === 'true';
}

export function parseCount(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^\d+$/u.test(raw)) return null;
  return Number(raw);
}

export function pidRunning(pid: number | null): boolean {
  if (pid === null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function readPid(paths: DshPaths): Promise<number | null> {
  let raw: string;
  try {
    raw = (await readFile(paths.pid, 'utf8')).trim();
  } catch {
    return null;
  }
  if (!/^\d+$/u.test(raw)) return null;
  const pid = Number(raw);
  return pidRunning(pid) ? pid : null;
}

export async function ensureHome(paths: DshPaths): Promise<string | null> {
  try {
    await mkdir(paths.home, { recursive: true, mode: 0o700 });
    await chmod(paths.home, 0o700).catch(() => undefined);
  } catch {
    return 'state_dir_failed';
  }
  try {
    await writeFile(paths.queue, '', { flag: 'a', mode: 0o600 });
    await chmod(paths.queue, 0o600).catch(() => undefined);
  } catch {
    return 'wake_queue_failed';
  }
  try {
    await writeFile(paths.log, '', { flag: 'a', mode: 0o600 });
    await chmod(paths.log, 0o600).catch(() => undefined);
  } catch {
    // 日志文件失败不影响事件通道；与旧脚本的 `touch ... || true` 一致。
  }
  return null;
}

export async function writeAtomic(path: string, content: string): Promise<void> {
  statusWriteSeq += 1;
  const temp = `${path}.tmp.${process.pid}.${statusWriteSeq}`;
  await writeFile(temp, content, { mode: 0o600 });
  await chmod(temp, 0o600).catch(() => undefined);
  await rename(temp, path);
}

export async function writeStatusFile(paths: DshPaths, status: DshStatus): Promise<void> {
  status.updatedAt = nowIso();
  try {
    await writeAtomic(paths.status, `${JSON.stringify(status)}\n`);
  } catch {
    // 巡检状态失败不中断监听；事件仍以 wake.queue 为准。
  }
}

export async function readStatusFile(paths: DshPaths): Promise<JsonObject> {
  try {
    const parsed = JSON.parse(await readFile(paths.status, 'utf8')) as unknown;
    return asRecord(parsed);
  } catch {
    return {};
  }
}

export function initialStatus(pid: number): DshStatus {
  return {
    state: 'starting',
    pid,
    connected: false,
    acked: false,
    online: false,
    pending_count: 0,
    reconnects: 0,
    lastEventAt: null,
    lastNotificationAt: null,
    lastError: null,
    startedAt: nowIso(),
    updatedAt: nowIso(),
  };
}

export function countLines(text: string): number {
  let total = 0;
  for (const char of text) if (char === '\n') total += 1;
  return total;
}

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export async function writeCursor(paths: DshPaths, cursor: number): Promise<void> {
  try {
    await writeAtomic(paths.cursor, `${cursor}\n`);
  } catch {
    // 游标只是 wait 的本地优化；写失败时下次重新按 EOF 初始化。
  }
}

export async function readCursor(paths: DshPaths): Promise<number | null> {
  try {
    const raw = (await readFile(paths.cursor, 'utf8')).trim();
    return /^\d+$/u.test(raw) ? Number(raw) : null;
  } catch {
    return null;
  }
}

export async function tailLog(path: string, lines: number): Promise<string[]> {
  if (lines <= 0) return [];
  const text = await readText(path);
  if (text.length === 0) return [];
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n').slice(-lines);
}
