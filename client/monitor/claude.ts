/**
 * `agentnet monitor --harness claude`：Claude Code Monitor 的 TS 监听入口。
 *
 * 对外契约与旧 shell 监听一致：
 * - stdout 每行一个事件 JSON；
 * - stderr 输出 READY、RECONNECTING、DEGRADED 与 ERROR；
 * - 自动 claim 成功后携带正文预览与 event_file；
 * - SIGINT/SIGTERM/SIGHUP 清理状态目录后以 0 退出。
 */

import { CliError, resolveConfig } from '../mcp';
import { MonitorEngine } from './engine';
import { BODY_PREVIEW_CHARS } from './events';
import { MonitorRpc } from './rpc';
import { MonitorState } from './state';

export interface MonitorContext {
  baseUrl: string | null;
  token: string | null;
}

function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

function fail(line: string): number {
  writeStderr(line);
  return 1;
}

export async function runClaudeMonitor(
  context: MonitorContext,
  options: { stateDir?: string } = {},
): Promise<number> {
  const token = context.token;
  if (!token) return fail('ERROR type=credential message=missing_token');
  if (/[\r\n]/u.test(token)) return fail('ERROR type=credential message=invalid_token_format');
  if (context.baseUrl === null) {
    return fail('ERROR type=configuration message=missing_agentnet_url');
  }

  let endpoint: string;
  try {
    endpoint = resolveConfig({ url: context.baseUrl, token, json: false }).endpoint;
  } catch (error) {
    if (error instanceof CliError) {
      return fail('ERROR type=configuration message=invalid_agentnet_url');
    }
    throw error;
  }

  const stateDirectory = options.stateDir ?? process.env.AGENTNET_MONITOR_STATE_DIR;
  const keep = process.env.AGENTNET_MONITOR_KEEP === '1';
  let state: MonitorState;
  try {
    state = await MonitorState.create({ directory: stateDirectory, keep });
  } catch {
    return fail('ERROR type=environment message=workdir_failed');
  }

  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop);

  try {
    const rpc = new MonitorRpc({ endpoint, token, signal: controller.signal });
    const engine = new MonitorEngine({
      rpc,
      state,
      signal: controller.signal,
      bodyPreviewChars: BODY_PREVIEW_CHARS,
    });
    return await engine.run();
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
    await state.cleanup();
  }
}
