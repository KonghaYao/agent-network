/**
 * `agentnet monitor --harness other`：旧哨兵的 TypeScript 等价实现。
 *
 * 无 monitor 的宿主用后台任务承载哨兵：它增量读取 watch.log 并保存本地游标，发现新的 `^ALERT`
 * 行就让进程结束，借宿主的「任务完成」通知唤醒会话。它不访问服务端、
 * 不接触 token，也就不是轮询服务端的替代品。
 */

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { readAlertCursor, scanAlertLog } from './alert-log';
import { writeAtomicFile } from './atomic';
import { abortableSleep } from './engine';
import { acquireLock } from './locks';

export interface OtherHarnessOptions {
  log?: string;
  stateDir?: string;
  maxWait?: string;
  poll?: string;
}

export interface OtherSentinelOptions {
  logPath: string;
  stateDir?: string;
  maxWaitSeconds: number;
  pollSeconds: number;
  signal?: AbortSignal;
  stdout?: (line: string) => void | Promise<void>;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * 返回码与脚本一致：日志缺失 2；出现新 ALERT 或等待超时均为 0。
 */
export async function runOtherSentinel(options: OtherSentinelOptions): Promise<number> {
  const stdout = options.stdout ?? writeStdout;
  if (!isFile(options.logPath)) {
    await stdout(`ERROR log_not_found path=${options.logPath}`);
    return 2;
  }

  const stateDir = options.stateDir ?? join(homedir(), '.agentnet', 'monitor', 'other');
  const key = createHash('sha256').update(resolve(options.logPath)).digest('hex');
  const path = join(stateDir, `${key}.json`);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  let release: () => Promise<void>;
  try {
    release = await acquireLock(path, { stale: 10_000, update: 5_000 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ELOCKED') throw error;
    await stdout('ERROR type=environment message=sentinel_already_running');
    return 1;
  }
  try {
    let cursor = await readAlertCursor(path);
    const deadline = Date.now() + options.maxWaitSeconds * 1000;
    do {
      if (options.signal?.aborted) return 0;
      const { cursor: next, lines } = await scanAlertLog(options.logPath, cursor);
      if (lines.length) {
        await stdout(`WAKE reason=alert new=${lines.length} total=${next.total}`);
        for (const line of lines) await stdout(line);
      }
      if (!cursor || cursor.offset !== next.offset || cursor.identity !== next.identity ||
          cursor.anchor !== next.anchor || cursor.total !== next.total) {
        await writeAtomicFile(path, JSON.stringify(next));
      }
      cursor = next;
      if (lines.length) return 0;
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await abortableSleep(Math.min(options.pollSeconds * 1000, remaining), options.signal);
    } while (!options.signal?.aborted);
    if (!options.signal?.aborted) await stdout(`WAKE reason=idle total_alerts=${cursor.total}`);
    return 0;
  } finally {
    await release();
  }
}

export function numeric(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function writeStdout(line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${line}\n`, (error) => error ? reject(error) : resolve());
  });
}

function fail(line: string): number {
  process.stdout.write(`${line}\n`);
  return 1;
}

export async function runOtherHarness(options: OtherHarnessOptions = {}): Promise<number> {
  const logPath =
    options.log ??
    process.env.LOG ??
    join(homedir(), '.agentnet', 'watch.log');
  const maxWait = numeric(options.maxWait ?? process.env.MAX_WAIT, 360);
  if (maxWait === null) return fail('ERROR type=configuration message=invalid_max_wait');
  const poll = numeric(options.poll ?? process.env.POLL, 3);
  if (poll === null) return fail('ERROR type=configuration message=invalid_poll');

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  try {
    return await runOtherSentinel({
      logPath,
      stateDir: options.stateDir,
      maxWaitSeconds: maxWait,
      pollSeconds: poll,
      signal: controller.signal,
      stdout: writeStdout,
    });
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
  }
}
