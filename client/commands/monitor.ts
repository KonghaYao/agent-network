/**
 * `monitor --harness <name>`：宿主监听入口。
 *
 * claude / other / peri / dsh / codex 都由 `client/monitor/` 的 TypeScript
 * 实现；不再下载或执行 public/skills/*.sh。argv 由 commander 解析，本模块
 * 只校验 harness、转交选项并把 dsh 的位置参数当作子命令。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

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

/** login 之后立即启动监听；up 需要先校验 harness，避免登录后才发现参数错误。 */
export function assertHarness(harness: string | undefined): string {
  if (!harness) {
    throw new CliError(
      `缺少 --harness（支持：${SUPPORTED.join('|')}；运行 agentnet monitor --help 查看示例）`,
    );
  }
  if (!TS_HARNESSES.has(harness)) {
    throw new CliError(
      `未知 harness：${harness}（支持：${SUPPORTED.join('|')}；运行 agentnet skills --harness ${harness} 查看说明）`,
    );
  }
  return harness;
}

export interface MonitorContext {
  baseUrl: string | null;
  token: string | null;
}

export interface MonitorOptions {
  harness?: string;
  check?: boolean;
  dryRun?: boolean;
  stateDir?: string;
  log?: string;
  maxWait?: string;
  poll?: string;
}

function checkTsHarness(
  harness: string,
  options: MonitorOptions,
  scriptArgs: readonly string[],
): number {
  if (harness === 'claude') {
    line(`harness=claude engine=ts args=${scriptArgs.join(' ') || '-'}`);
    return 0;
  }
  if (harness === 'peri') {
    line('harness=peri engine=ts auto_claim=1 read_body=0 output=alert stream=agentnet://stream');
    return 0;
  }
  if (harness === 'dsh') {
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
    options.log ?? process.env.LOG ?? join(homedir(), '.agentnet', 'watch.log');
  const maxWait = options.maxWait ?? process.env.MAX_WAIT ?? '360';
  const poll = options.poll ?? process.env.POLL ?? '3';
  line(`harness=other engine=ts log=${logPath} max_wait=${maxWait} poll=${poll}`);
  return 0;
}

export async function monitor(
  context: MonitorContext,
  options: MonitorOptions,
  scriptArgs: readonly string[] = [],
): Promise<number> {
  const harness = assertHarness(options.harness);
  const extra = [...scriptArgs];
  // dsh 需要在位置参数里收子命令（start/stop/status/logs/wait）。
  if (harness !== 'dsh' && extra.length > 0) {
    throw new CliError(
      `monitor --harness ${harness} 不接受位置参数：${extra.join(' ')}（使用 --log/--max-wait/--poll 等选项）`,
    );
  }
  const checkOnly = options.check === true || options.dryRun === true;
  if (checkOnly) return checkTsHarness(harness, options, extra);
  if (harness === 'claude') return runClaudeMonitor(context, { stateDir: options.stateDir });
  if (harness === 'peri') return runPeriMonitor(context, { stateDir: options.stateDir });
  if (harness === 'dsh') return runDshMonitor(context, extra);
  if (harness === 'codex') return runCodexMonitor(context);
  return runOtherHarness({ log: options.log, maxWait: options.maxWait, poll: options.poll });
}
