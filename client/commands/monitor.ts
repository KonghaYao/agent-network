/**
 * `monitor --harness <name>`：宿主监听入口。
 *
 * claude / other / peri / dsh / codex 都由 `client/monitor/` 的 TypeScript
 * 实现；不再下载或执行 public/skills/*.sh。argv 由 commander 解析，本模块
 * 只校验 harness、转交选项并把 dsh 的位置参数当作子命令。
 *
 * `--check` 是真实握手：至少调用一次需要鉴权的只读接口 network_me，校验
 * 凭据、服务与本机配置；`--check-config` 保留旧静态入口检查。`up --check`
 * 仍使用静态语义，避免登录前就要求凭据。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  CLIENT_NAME,
  CLIENT_VERSION,
  CliError,
  redact,
  resolveConfig,
} from '../mcp';
import { line, asString } from '../output';
import { runClaudeMonitor } from '../monitor/claude';
import { runCodexMonitor } from '../monitor/codex';
import { socketOverride } from '../monitor/codex-transport';
import { runDshMonitor } from '../monitor/dsh';
import { ensureDshMonitorPlugin } from '../monitor/dsh-install';
import { PERI_MAX_RUNTIME_MS } from '../monitor/engine';
import { numeric, runOtherHarness } from '../monitor/other';
import { runPeriMonitor } from '../monitor/peri';
import { MonitorFatalError, MonitorRpc, MonitorTransportError } from '../monitor/rpc';

const TS_HARNESSES = new Set(['claude', 'other', 'peri', 'dsh', 'codex']);
const SUPPORTED = [...TS_HARNESSES];
/** setTimeout 的上限（2^31-1 ms）；更大的值会被宿主截断成 1ms。 */
const MAX_RUNTIME_SECONDS = 2_147_483;

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
  /** 真实握手：连接服务 + network_me。 */
  check?: boolean;
  /** 静态入口检查，不连接服务；up --check 使用。 */
  checkConfig?: boolean;
  dryRun?: boolean;
  stateDir?: string;
  log?: string;
  maxWait?: string;
  poll?: string;
  /** 每行一个 JSON 事件（claude/peri）。 */
  json?: boolean;
  /** 最长运行秒数；peri 默认 24h，0 表示不限制。 */
  maxRuntime?: string;
}

interface ConfigCheck {
  ok: boolean;
  fields: Record<string, unknown>;
  lines: string[];
}

/** 不连接服务的入口检查；保持旧的输出字段，供宿主日志与验收断言。 */
function configCheck(
  harness: string,
  options: MonitorOptions,
  scriptArgs: readonly string[],
): ConfigCheck {
  if (harness === 'claude') {
    return {
      ok: true,
      fields: { engine: 'ts', args: scriptArgs.join(' ') || null },
      lines: [`harness=claude engine=ts args=${scriptArgs.join(' ') || '-'}`],
    };
  }
  if (harness === 'peri') {
    return {
      ok: true,
      fields: {
        engine: 'ts',
        auto_claim: true,
        read_body: false,
        output: options.json === true ? 'json' : 'alert',
        stream: 'agentnet://stream',
      },
      lines: [
        `harness=peri engine=ts auto_claim=1 read_body=0 output=${
          options.json === true ? 'json' : 'alert'
        } stream=agentnet://stream`,
      ],
    };
  }
  if (harness === 'dsh') {
    return {
      ok: true,
      fields: {
        engine: 'ts',
        auto_claim: false,
        read_body: false,
        output: 'wake.queue',
        stream: 'agentnet://stream',
        args: scriptArgs.join(' ') || null,
      },
      lines: [
        `harness=dsh engine=ts auto_claim=0 read_body=0 output=wake.queue stream=agentnet://stream args=${
          scriptArgs.join(' ') || '-'
        }`,
      ],
    };
  }
  if (harness === 'codex') {
    const socket = socketOverride() ?? 'codex app-server daemon version';
    const thread = process.env.CODEX_THREAD_ID ?? 'auto';
    return {
      ok: true,
      fields: {
        engine: 'ts',
        auto_claim: true,
        read_body: true,
        transport: 'app-server-ws',
        socket,
        thread,
      },
      lines: [
        `harness=codex engine=ts auto_claim=1 read_body=1 transport=app-server-ws ` +
          `socket=${socket} thread=${thread}`,
      ],
    };
  }
  const logPath =
    options.log ?? process.env.LOG ?? join(homedir(), '.agentnet', 'watch.log');
  const maxWait = options.maxWait ?? process.env.MAX_WAIT ?? '360';
  const poll = options.poll ?? process.env.POLL ?? '3';
  if (numeric(maxWait, 360) === null) {
    return { ok: false, fields: {}, lines: ['ERROR type=configuration message=invalid_max_wait'] };
  }
  if (numeric(poll, 3) === null) {
    return { ok: false, fields: {}, lines: ['ERROR type=configuration message=invalid_poll'] };
  }
  return {
    ok: true,
    fields: { engine: 'ts', log: logPath, max_wait: maxWait, poll },
    lines: [`harness=other engine=ts log=${logPath} max_wait=${maxWait} poll=${poll}`],
  };
}

function emitConfigCheck(harness: string, result: ConfigCheck, json: boolean): number {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        type: 'check',
        kind: result.ok ? 'control' : 'error',
        scope: 'entry',
        ok: result.ok,
        harness,
        connected: false,
        ...result.fields,
      })}\n`,
    );
    return result.ok ? 0 : 1;
  }
  line('CHECK scope=entry connected=false');
  for (const text of result.lines) line(text);
  return result.ok ? 0 : 1;
}

function checkHarnessConfig(
  harness: string,
  options: MonitorOptions,
  scriptArgs: readonly string[],
): number {
  return emitConfigCheck(harness, configCheck(harness, options, scriptArgs), options.json === true);
}

function checkFailure(
  harness: string,
  json: boolean,
  code: string,
  message: string,
  hint: string,
): number {
  if (json) {
    process.stderr.write(
      `${JSON.stringify({
        type: 'check',
        kind: 'error',
        scope: 'live',
        ok: false,
        harness,
        code,
        message,
        hint,
      })}\n`,
    );
    return 1;
  }
  process.stderr.write(`CHECK ok=0 harness=${harness} error=${code} hint=${hint}\n`);
  return 1;
}

/**
 * 真实握手：server/discover + network_me。network_me 是需要鉴权的只读接口，
 * 能同时证明服务可达、token 有效且身份是 agent。失败一律返回非 0，并给出
 * 可操作提示；任何输出都不包含 token。
 */
async function checkHarnessLive(
  harness: string,
  context: MonitorContext,
  options: MonitorOptions,
  scriptArgs: readonly string[],
): Promise<number> {
  const json = options.json === true;
  if (!context.baseUrl) {
    return checkFailure(
      harness,
      json,
      'missing_agentnet_url',
      '缺少服务地址',
      '设置 --url 或 AGENTNET_URL 后重试；只检查参数可改用 --check-config',
    );
  }
  if (!context.token) {
    return checkFailure(
      harness,
      json,
      'missing_token',
      '缺少 token',
      '通过 --token、AGENTNET_TOKEN 或 AGENTNET_TOKEN_FILE 提供 token 后重试',
    );
  }

  let endpoint: string;
  try {
    endpoint = resolveConfig({ url: context.baseUrl, token: context.token, json: false }).endpoint;
  } catch (error) {
    return checkFailure(
      harness,
      json,
      'invalid_agentnet_url',
      '服务地址不是合法 URL',
      '检查 --url 或 AGENTNET_URL 是否为 http(s) 地址',
    );
  }

  const config = configCheck(harness, options, scriptArgs);
  if (!config.ok) return emitConfigCheck(harness, config, json);

  const rpc = new MonitorRpc({
    endpoint,
    token: context.token,
    clientName: CLIENT_NAME,
    clientVersion: CLIENT_VERSION,
    signal: AbortSignal.timeout(15_000),
  });

  try {
    await rpc.discover();
    const me = await rpc.callTool('network_me', {});
    if (!me.ok) {
      return checkFailure(
        harness,
        json,
        me.code || 'network_me_failed',
        me.message || 'network_me 失败',
        '按错误码修复凭据或服务配置后重试',
      );
    }
    const actorId = asString(me.data.actor_id);
    const actorKind = asString(me.data.kind);
    if (actorId.length === 0) {
      return checkFailure(
        harness,
        json,
        'identity_missing',
        'network_me 未返回 actor_id',
        '确认服务与协议版本后重试',
      );
    }
    if (actorKind !== 'agent') {
      return checkFailure(
        harness,
        json,
        'agent_token_required',
        `token 属于 ${actorKind || 'unknown'} 身份`,
        'monitor 需要 kind=agent 的 token；向用户索取目标 Agent 的 token',
      );
    }

    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          type: 'check',
          kind: 'control',
          scope: 'live',
          ok: true,
          harness,
          connected: true,
          actor_id: actorId,
          actor_kind: actorKind,
          ...config.fields,
        })}\n`,
      );
      return 0;
    }
    line('CHECK scope=live connected=true');
    for (const text of config.lines) line(text);
    line(`CHECK ok=1 harness=${harness} actor=${actorId} kind=${actorKind} service=reachable`);
    return 0;
  } catch (error) {
    if (error instanceof MonitorFatalError) {
      if (error.kind === 'credential') {
        return checkFailure(
          harness,
          json,
          'credential_invalid',
          '凭据无效或已撤销',
          '向用户索取新 token，更新 AGENTNET_TOKEN 或 AGENTNET_TOKEN_FILE 后重试',
        );
      }
      return checkFailure(
        harness,
        json,
        'protocol_error',
        redact(error.message, context.token),
        '确认服务支持 MCP 2026-07-28，且地址指向 /mcp',
      );
    }
    if (error instanceof MonitorTransportError) {
      return checkFailure(
        harness,
        json,
        'service_unreachable',
        redact(error.message, context.token),
        `确认 ${context.baseUrl} 可访问，检查网络、代理与 TLS 后重试`,
      );
    }
    return checkFailure(
      harness,
      json,
      'check_failed',
      redact(error instanceof Error ? error.message : String(error), context.token),
      '检查网络与配置后重试',
    );
  }
}

function maxRuntimeMs(harness: string, raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return harness === 'peri' ? PERI_MAX_RUNTIME_MS : 0;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new CliError('--max-runtime 必须是非负整数秒（0 表示不限制）');
  }
  const seconds = Number(raw);
  if (seconds > MAX_RUNTIME_SECONDS) {
    throw new CliError(`--max-runtime 不能超过 ${MAX_RUNTIME_SECONDS} 秒`);
  }
  return seconds * 1000;
}

export async function monitor(
  context: MonitorContext,
  options: MonitorOptions,
  scriptArgs: readonly string[] = [],
): Promise<number> {
  const harness = assertHarness(options.harness);
  const extra = [...scriptArgs];
  const dshCommand = harness === 'dsh' ? (extra[0] ?? 'run') : null;
  // dsh 需要在位置参数里收子命令（run/start/stop/status/logs/wait）。
  if (harness !== 'dsh' && extra.length > 0) {
    throw new CliError(
      `monitor --harness ${harness} 不接受位置参数：${extra.join(' ')}（使用 --log/--max-wait/--poll 等选项）`,
    );
  }
  if (options.checkConfig === true) return checkHarnessConfig(harness, options, extra);
  const checkOnly = options.check === true || options.dryRun === true;
  if (checkOnly) return await checkHarnessLive(harness, context, options, extra);

  const runtimeMs = maxRuntimeMs(harness, options.maxRuntime);
  if (harness === 'claude') {
    return runClaudeMonitor(context, {
      stateDir: options.stateDir,
      json: options.json,
      maxRuntimeMs: runtimeMs,
    });
  }
  if (harness === 'peri') {
    return runPeriMonitor(context, {
      stateDir: options.stateDir,
      json: options.json,
      maxRuntimeMs: runtimeMs,
    });
  }
  if (harness === 'dsh') {
    if (
      (dshCommand === 'run' || dshCommand === 'start') &&
      context.token !== null &&
      context.baseUrl !== null
    ) {
      const detected = await ensureDshMonitorPlugin();
      process.stderr.write(
        `DSH_PLUGIN status=${detected.installed ? 'installed' : 'present'} ` +
          `dsh_version=${detected.dshVersion}\n`,
      );
    }
    return runDshMonitor(context, extra);
  }
  if (harness === 'codex') return runCodexMonitor(context);
  return runOtherHarness({ log: options.log, maxWait: options.maxWait, poll: options.poll });
}
