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

import { ActorMismatchError } from '../expect-actor';
import {
  CLIENT_NAME,
  CLIENT_VERSION,
  CliError,
  McpClient,
  redact,
  resolveConfig,
} from '../mcp';
import { line, asString } from '../output';
import { runClaudeMonitor } from '../monitor/claude';
import { runCodexMonitor } from '../monitor/codex';
import { socketOverride } from '../monitor/codex-transport';
import { runDshMonitor } from '../monitor/dsh';
import { ensureDshMonitorPlugin } from '../monitor/dsh-install';
import { PERI_MAX_RUNTIME_MS, type RoomEventScope } from '../monitor/engine';
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
  /** 只包含显式来源的 token；宿主环境中的 AGENTNET_TOKEN 不再兜底。 */
  token: string | null;
  /** 显式预期身份；传入 dsh 子进程并用于启动前校验。 */
  expectActor?: string;
  /** CLI 预检已确认的 actor；仅 claude/peri/codex 引擎会用它跳过重复 network_me。 */
  verifiedActor?: string;
  /** 显式凭据来源；dsh start 优先转发 env-file/token-file，避免 token 进入子进程 argv。 */
  credential?: { source: '--token' | '--token-file' | '--env-file'; path?: string };
}

export interface MonitorOptions {
  harness?: string;
  /** network_me 校验通过后才允许 login、订阅或 claim。 */
  expectActor?: string;
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
  /** 房间/信息事件：默认 all，`--no-room-events` 关闭。 */
  roomEvents?: string | boolean;
  /** delivery 记忆参考包：默认开，`--no-memory-context` 关闭。 */
  memoryContext?: boolean;
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
      'credentials_required',
      '缺少显式凭据',
      '每个 Agent 使用自己的 env 文件：--env-file <file>；也可显式 --token 或 --token-file',
    );
  }
  if (!options.expectActor) {
    return checkFailure(
      harness,
      json,
      'actor_required',
      '缺少显式身份',
      '使用 --expect-actor <actor_id>，或在 --env-file 文件中设置 AGENTNET_EXPECT_ACTOR',
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
    if (options.expectActor !== undefined && actorId !== options.expectActor) {
      process.stderr.write(
        `ERROR actor_mismatch expected=${options.expectActor} actual=${actorId}\n`,
      );
      return 1;
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

/**
 * `--room-events [all]`：监听所有房间与 informational stream item，默认开启；
 * `--no-room-events` 关闭。不再支持房间白名单。
 */
export function parseRoomEvents(raw: string | boolean | undefined): RoomEventScope | false {
  if (raw === false) return false;
  if (raw === undefined || raw === true || raw === '' || raw === 'all') return 'all';
  throw new CliError('--room-events 只接受 all（默认监听所有房间）');
}

export async function monitor(
  context: MonitorContext,
  options: MonitorOptions,
  scriptArgs: readonly string[] = [],
): Promise<number> {
  const harness = assertHarness(options.harness);
  const roomEvents = parseRoomEvents(options.roomEvents);
  const extra = [...scriptArgs];
  const dshCommand = harness === 'dsh' ? (extra[0] ?? 'run') : null;
  // dsh 需要在位置参数里收子命令（run/start/stop/status/logs/wait）。
  if (harness !== 'dsh' && extra.length > 0) {
    throw new CliError(
      `monitor --harness ${harness} 不接受位置参数：${extra.join(' ')}（使用 --log/--max-wait/--poll 等选项）`,
    );
  }
  if (options.checkConfig === true) return checkHarnessConfig(harness, options, extra);
  let runtimeContext = context;
  const checkOnly = options.check === true || options.dryRun === true;
  const localOnly =
    harness === 'other' ||
    (harness === 'dsh' && !['run', 'start'].includes(dshCommand!));
  if (localOnly) {
    // 本地-only 入口（other；dsh 的 stop/status/logs/wait）不连接服务。
    // --expect-actor 被接受以保持命令形态统一，但本地模式不校验身份，
    // 也不会调用 network_me；需要真实校验时加 --check。
    if (checkOnly) return await checkHarnessLive(harness, context, options, extra);
  } else if (checkOnly) {
    // checkHarnessLive 自己按 URL → 凭据 → 身份 → network_me 的顺序输出诊断，
    // 并在返回身份后立即核对 actor；不在这里重复连接。
    return await checkHarnessLive(harness, context, options, extra);
  } else {
    if (!context.token) {
      throw new CliError('缺少显式凭据：使用 --env-file、--token 或 --token-file', {
        code: 'credentials_required',
      });
    }
    if (!options.expectActor) {
      throw new CliError(
        '缺少显式身份：使用 --expect-actor 或在 env 文件内设置 AGENTNET_EXPECT_ACTOR',
        { code: 'actor_required' },
      );
    }
    try {
      const config = resolveConfig({
        url: context.baseUrl ?? undefined,
        token: context.token,
        json: false,
      });
      const me = await new McpClient(config, { expectActor: options.expectActor })
        .verifyActor(options.expectActor);
      // 只有确认是 agent 才把预检结果交给引擎跳过重复 network_me；
      // human token 仍由引擎输出既有的 agent_token_required 诊断。
      if (asString(me.kind) === 'agent') {
        runtimeContext = { ...context, verifiedActor: asString(me.actor_id) };
      }
    } catch (error) {
      if (error instanceof ActorMismatchError) {
        process.stderr.write(`${redact(error.message, context.token)}\n`);
        return 1;
      }
      // dsh 的 run/start 自己把 CREDENTIAL_INVALID / NOT_AGENT / PROTOCOL
      // 映射为既有退出码、ALERT 与 fatal state；这里放行，避免抢占它的
      // 故障语义。actor 不匹配仍由上面的 ActorMismatchError 先拦截。
      if (harness !== 'dsh') throw error;
    }
  }

  const runtimeMs = maxRuntimeMs(harness, options.maxRuntime);
  if (harness === 'claude') {
    return runClaudeMonitor(runtimeContext, {
      stateDir: options.stateDir,
      json: options.json,
      maxRuntimeMs: runtimeMs,
      roomEvents,
      memoryContext: options.memoryContext !== false,
    });
  }
  if (harness === 'peri') {
    return runPeriMonitor(runtimeContext, {
      stateDir: options.stateDir,
      json: options.json,
      maxRuntimeMs: runtimeMs,
      roomEvents,
      memoryContext: options.memoryContext !== false,
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
    return runDshMonitor(runtimeContext, extra, { roomEvents: roomEvents !== false });
  }
  if (harness === 'codex') {
    return runCodexMonitor(runtimeContext, {
      roomEvents: roomEvents !== false,
      memoryContext: options.memoryContext !== false,
    });
  }
  return runOtherHarness({ log: options.log, maxWait: options.maxWait, poll: options.poll });
}
