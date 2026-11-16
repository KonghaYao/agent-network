/**
 * `agentnet monitor --harness claude`：Claude Code Monitor 的 TS 监听入口。
 *
 * 对外契约与旧 shell 监听一致：
 * - stdout 每行一个事件 JSON；
 * - stderr 输出 READY、RECONNECTING、DEGRADED 与 ERROR；
 * - 自动 claim 成功后携带正文预览与 event_file；
 * - 默认（`all`）监听全部房间活动并输出所有 informational stream item；
 *   `--no-room-events` 可关闭；
 * - SIGINT/SIGTERM/SIGHUP 保留 seen/游标，清理事件文件后以 0 退出。
 */

import { CliError, resolveConfig } from '../mcp';
import { MonitorEngine, type RoomEventScope } from './engine';
import { BODY_PREVIEW_CHARS } from './events';
import { MonitorRpc } from './rpc';
import { MonitorState, defaultMonitorStateDirectory } from './state';

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
  options: {
    stateDir?: string;
    json?: boolean;
    maxRuntimeMs?: number;
    roomEvents?: RoomEventScope | false;
    /** 缺省 full：delivery 事件与 event_file 携带完整记忆参考包。 */
    memoryContext?: boolean;
  } = {},
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

  const stateDirectory =
    options.stateDir ??
    process.env.AGENTNET_MONITOR_STATE_DIR ??
    defaultMonitorStateDirectory('claude', endpoint, token);
  const keep = process.env.AGENTNET_MONITOR_KEEP === '1';
  let state: MonitorState;
  try {
    state = await MonitorState.create({ directory: stateDirectory, keep, persistent: true });
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
      json: options.json === true,
      maxRuntimeMs: options.maxRuntimeMs ?? 0,
      onDeadline: stop,
      roomEvents: options.roomEvents,
      memoryMode: options.memoryContext === false ? 'off' : 'full',
    });
    return await engine.run();
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('SIGHUP', stop);
    await state.cleanup();
  }
}
