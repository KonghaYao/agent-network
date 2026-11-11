/**
 * `monitor --harness <name>`：宿主监听入口。
 *
 * claude / other / peri / dsh / codex 都由 `client/monitor/` 的 TypeScript
 * 实现；不再下载或执行 public/skills/*.sh。命令形状与参数保持不变。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CliArgs } from '../args';
import { assertKnownFlags, booleanFlag, flagValue } from '../args';
import { CliError } from '../mcp';
import { line } from '../output';
import { runClaudeMonitor } from '../monitor/claude';
import { runCodexMonitor } from '../monitor/codex';
import { socketOverride } from '../monitor/codex-transport';
import { runDshMonitor } from '../monitor/dsh';
import { runOtherHarness } from '../monitor/other';
import { runPeriMonitor } from '../monitor/peri';

const TS_HARNESSES = new Set(['claude', 'other', 'peri', 'dsh', 'codex']);
const SUPPORTED = [...TS_HARNESSES];

export interface MonitorContext {
  baseUrl: string | null;
  token: string | null;
}

function checkTsHarness(harness: string, args: CliArgs): number {
  if (harness === 'claude') {
    const scriptArgs = args.positionals.slice(1);
    line(`harness=claude engine=ts args=${scriptArgs.join(' ') || '-'}`);
    return 0;
  }
  if (harness === 'peri') {
    line('harness=peri engine=ts auto_claim=1 read_body=0 output=alert stream=agentnet://stream');
    return 0;
  }
  if (harness === 'dsh') {
    const scriptArgs = [...args.positionals.slice(1), ...args.rest];
    line(
      `harness=dsh engine=ts auto_claim=0 read_body=0 output=wake.queue stream=agentnet://stream args=${
        scriptArgs.join(' ') || '-'
      }`,
    );
    return 0;
  }
  if (harness === 'codex') {
    const socket = socketOverride() ?? 'codex app-server daemon version';
    const thread = process.env.CODEX_THREAD_ID ?? 'auto';
    line(
      `harness=codex engine=ts auto_claim=1 read_body=1 transport=app-server-ws ` +
        `socket=${socket} thread=${thread}`,
    );
    return 0;
  }
  const logPath =
    flagValue(args, 'log') ?? process.env.LOG ?? join(homedir(), '.agentnet', 'watch.log');
  const maxWait = flagValue(args, 'max-wait') ?? process.env.MAX_WAIT ?? '360';
  const poll = flagValue(args, 'poll') ?? process.env.POLL ?? '3';
  line(`harness=other engine=ts log=${logPath} max_wait=${maxWait} poll=${poll}`);
  return 0;
}

export async function monitor(context: MonitorContext, args: CliArgs): Promise<number> {
  assertKnownFlags(args, [
    'harness',
    'check',
    'dry-run',
    'url',
    'token',
    'json',
    'help',
    'log',
    'max-wait',
    'poll',
    'state-dir',
  ]);
  const harness = flagValue(args, 'harness');
  if (!harness) {
    throw new CliError(`缺少 --harness（支持：${SUPPORTED.join('|')}）`);
  }
  if (!TS_HARNESSES.has(harness)) {
    throw new CliError(`未知 harness：${harness}（支持：${SUPPORTED.join('|')}）`);
  }
  const checkOnly = booleanFlag(args, 'check') || booleanFlag(args, 'dry-run');

  const extra = [...args.positionals.slice(1), ...args.rest];
  // dsh 需要在位置参数里收子命令（start/stop/status/logs/wait）。
  if (harness !== 'dsh' && extra.length > 0) {
    throw new CliError(
      `monitor --harness ${harness} 不接受位置参数：${extra.join(' ')}（使用 --log/--max-wait/--poll 等选项）`,
    );
  }
  if (checkOnly) return checkTsHarness(harness, args);
  if (harness === 'claude') return runClaudeMonitor(context, args);
  if (harness === 'peri') return runPeriMonitor(context, args);
  if (harness === 'dsh') return runDshMonitor(context, args);
  if (harness === 'codex') return runCodexMonitor(context, args);
  return runOtherHarness(args);
}
