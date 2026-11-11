/**
 * `agentnet monitor --harness other`：other-sentinel.sh 的 TypeScript 等价实现。
 *
 * 无 monitor 的宿主用后台任务承载哨兵：它只读 watch.log，发现新的 `^ALERT`
 * 行就让进程结束，借宿主的「任务完成」通知唤醒会话。它不访问服务端、
 * 不接触 token，也就不是轮询服务端的替代品。
 */

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { flagValue, type CliArgs } from '../args';

export interface OtherSentinelOptions {
  logPath: string;
  maxWaitSeconds: number;
  pollSeconds: number;
  signal?: AbortSignal;
  stdout?: (line: string) => void;
}

export function countAlerts(text: string): number {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('ALERT'))
    .length;
}

export function alertLines(text: string): string[] {
  return text.split(/\r?\n/u).filter((line) => line.startsWith('ALERT'));
}

function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolveSleep();
    }
    if (signal?.aborted) finish();
    else signal?.addEventListener('abort', finish, { once: true });
  });
}

async function readLog(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
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
  const stdout = options.stdout ?? ((line) => process.stdout.write(`${line}\n`));
  if (!isFile(options.logPath)) {
    stdout(`ERROR log_not_found path=${options.logPath}`);
    return 2;
  }

  const initial = await readLog(options.logPath);
  const start = initial === null ? 0 : countAlerts(initial);
  const deadline = Date.now() + options.maxWaitSeconds * 1000;

  while (Date.now() < deadline) {
    if (options.signal?.aborted) return 0;
    const text = await readLog(options.logPath);
    const total = text === null ? 0 : countAlerts(text);
    if (total > start) {
      const fresh = text === null ? [] : alertLines(text).slice(-(total - start));
      stdout(`WAKE reason=alert new=${total - start} total=${total}`);
      for (const line of fresh) stdout(line);
      return 0;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await abortableSleep(Math.min(options.pollSeconds * 1000, remaining), options.signal);
  }

  stdout(`WAKE reason=idle total_alerts=${start}`);
  return 0;
}

function numeric(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fail(line: string): number {
  writeStdout(line);
  return 1;
}

export async function runOtherHarness(args: CliArgs): Promise<number> {
  const logPath =
    flagValue(args, 'log') ??
    process.env.LOG ??
    join(homedir(), '.agentnet', 'watch.log');
  const maxWait = numeric(flagValue(args, 'max-wait') ?? process.env.MAX_WAIT, 360);
  if (maxWait === null) return fail('ERROR type=configuration message=invalid_max_wait');
  const poll = numeric(flagValue(args, 'poll') ?? process.env.POLL, 3);
  if (poll === null) return fail('ERROR type=configuration message=invalid_poll');

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);
  try {
    return await runOtherSentinel({
      logPath,
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
