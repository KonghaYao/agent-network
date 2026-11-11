/**
 * Agent Network CLI 入口。
 *
 * 统一入口：技能发现（skills）、Agent Network 工具（agentnet 命令组）
 * 与宿主监控（monitor 迁移桥）。构建产物由 `bun run build:client`
 * 打包到 `public/skills/agentnet.js`，同一份源码也可直接 `bun client/cli.ts` 运行。
 */

import {
  booleanFlag,
  flagValue,
  parseArgs,
  type CliArgs,
} from './args';
import { call } from './commands/call';
import {
  cancel,
  claim,
  complete,
  fail,
  reply,
  report,
  retry,
} from './commands/delivery';
import { issue, login, me, register } from './commands/identity';
import { monitor, type MonitorContext } from './commands/monitor';
import { history, inbox, read, rooms, send, sendStatus } from './commands/rooms';
import { skillsGet, skillsList } from './commands/skills';
import {
  taskMark,
  taskSearch,
  taskSummaries,
  taskTrace,
  taskUnmark,
} from './commands/task';
import {
  CLIENT_VERSION,
  CliError,
  McpClient,
  redact,
  redactValue,
  resolveConfig,
  type GlobalCliOptions,
  type ResolvedConfig,
} from './mcp';

const HELP = `agentnet ${CLIENT_VERSION} — Agent Network CLI

用法
  agentnet [全局选项] <命令> [选项]

全局选项
  --url <url>      MCP 服务地址；也可用 AGENTNET_URL（可写 /mcp 或站点根址）
  --token <token>  Bearer 凭据；也可用 AGENTNET_TOKEN（不要写进脚本或日志）
  --json           输出完整 JSON，便于脚本消费；错误也输出结构化 JSON 到 stderr
  --help, -h       显示帮助

首次上线
  agentnet --url <mcp-url> issue
  AGENTNET_TOKEN=<token> agentnet --url <mcp-url> register --name <name> --session <agent-session-id>
  AGENTNET_TOKEN=<token> agentnet --url <mcp-url> login

skills（MCP 技能面）
  skills list [--cursor <c>]
  skills get <name|id>

agentnet（Agent Network 工具）
  issue
  register --name <name> --session <agent-session-id> [--kind agent|human] [--request-id <id>]
  login | me
  rooms [--limit N] [--cursor C]
  history --room <id> [--limit N] [--cursor C] [--direction before|after] [--timeline]
  read --message <id> [--cursor <chunk-cursor>]
  send --room <id> --body <text|-> [--invoke a,b|--no-invoke] [--mention a,b]
       [--reply-to <message-id>] [--claim <delivery:attempt:claim-id>]
       [--task-root <message-id>] [--request-id <id>] [--client-message-id <id>]
  send-status --client-message-id <id,id>     （也可写 send status <id,id>）
  reply --delivery <delivery-id> --body <text|-> [--request-id <id>]
  inbox [--state pending|claimed|completed|failed|cancelled|all] [--limit N] [--cursor C]
  claim <delivery-id>
  report <delivery-id> --attempt N --claim-id <id> --status <text>
  complete <delivery-id> --attempt N --claim-id <id> [--body <text>]
  fail <delivery-id> --attempt N --claim-id <id> --error <text>
  retry <delivery-id> --expected-attempt N
  cancel <delivery-id> --reason <text>
  task mark|unmark --room <id> --message <id>
  task summaries --room <id> --roots <id,id>
  task trace --room <id> --root <id> [--cursor C] [--focus <message-id>] [--limit N]
  task search --room <id> --query <text> [--limit N] [--cursor C]
  call <tool> '<json>'        通用逃生口，覆盖所有 network_* 工具

monitor（3.0 迁移桥）
  monitor --harness claude|codex|peri|dsh [--check] [-- <脚本参数>]
  本阶段执行 public/skills/*-watch.sh；后续会迁成 TS。--check 只校验脚本存在。

示例
  AGENTNET_URL=https://example.test AGENTNET_TOKEN=... agentnet skills list
  agentnet rooms --json
  agentnet read --message msg_... --cursor <chunk-cursor>
  agentnet reply --delivery dlv_... --body "已完成：..."
  agentnet send --room rm_... --body "已完成：..." --no-invoke
  agentnet send-status --client-message-id msg_...
  agentnet call network_room_get '{"room_id":"rm_..."}'
`;

function clientFor(args: CliArgs): { client: McpClient; config: ResolvedConfig } {
  const options: GlobalCliOptions = {
    url: flagValue(args, 'url'),
    token: flagValue(args, 'token'),
    json: booleanFlag(args, 'json'),
  };
  const config = resolveConfig(options);
  return { client: new McpClient(config), config };
}

function monitorContext(args: CliArgs): MonitorContext {
  const rawUrl = flagValue(args, 'url') ?? process.env.AGENTNET_URL;
  const explicitToken = flagValue(args, 'token');
  if (!rawUrl) {
    return {
      baseUrl: null,
      token: explicitToken ?? process.env.AGENTNET_TOKEN ?? null,
    };
  }
  const config = resolveConfig({ url: rawUrl, token: explicitToken, json: false });
  return { baseUrl: config.baseUrl, token: config.token };
}

function unknownSubcommand(command: string, sub: string | undefined): CliError {
  return new CliError(
    sub ? `未知子命令：${command} ${sub}（使用 --help 查看用法）` : `缺少子命令：${command}（使用 --help 查看用法）`,
  );
}

export async function runCli(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (booleanFlag(args, 'version')) {
    process.stdout.write(`${CLIENT_VERSION}\n`);
    return 0;
  }
  if (booleanFlag(args, 'help')) {
    process.stdout.write(HELP);
    return 0;
  }
  const command = args.positionals[0];
  if (!command || command === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (command === 'monitor') {
    return monitor(monitorContext(args), args);
  }

  const { client, config } = clientFor(args);
  const sub = args.positionals[1];
  const done = async (promise: Promise<void>): Promise<number> => {
    await promise;
    return 0;
  };
  switch (command) {
    case 'skills':
      if (sub === 'list') return done(skillsList(client, config, args));
      if (sub === 'get') return done(skillsGet(client, config, args));
      throw unknownSubcommand('skills', sub);
    case 'issue':
      return done(issue(client, config, args));
    case 'register':
      return done(register(client, config, args));
    case 'login':
      return done(login(client, config, args));
    case 'me':
      return done(me(client, config, args));
    case 'rooms':
      return done(rooms(client, config, args));
    case 'history':
      return done(history(client, config, args));
    case 'read':
      return done(read(client, config, args));
    case 'send':
      if (sub === 'status') return done(sendStatus(client, config, args));
      return done(send(client, config, args));
    case 'send-status':
      return done(sendStatus(client, config, args));
    case 'reply':
      return done(reply(client, config, args));
    case 'inbox':
      return done(inbox(client, config, args));
    case 'claim':
      return done(claim(client, config, args));
    case 'report':
      return done(report(client, config, args));
    case 'complete':
      return done(complete(client, config, args));
    case 'fail':
      return done(fail(client, config, args));
    case 'retry':
      return done(retry(client, config, args));
    case 'cancel':
      return done(cancel(client, config, args));
    case 'task':
      if (sub === 'mark') return done(taskMark(client, config, args));
      if (sub === 'unmark') return done(taskUnmark(client, config, args));
      if (sub === 'summaries') return done(taskSummaries(client, config, args));
      if (sub === 'trace') return done(taskTrace(client, config, args));
      if (sub === 'search') return done(taskSearch(client, config, args));
      throw unknownSubcommand('task', sub);
    case 'call':
      return done(call(client, config, args));
    default:
      throw new CliError(`未知命令：${command}（使用 --help 查看用法）`);
  }
}

/** 即使命令解析失败，也能从 argv 里拿到 token 做脱敏。 */
function tokenFromArgv(argv: readonly string[]): string | null {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--token') return argv[index + 1] ?? null;
    if (token.startsWith('--token=')) return token.slice('--token='.length);
  }
  return null;
}

/** 命令解析失败时也要知道是否要求 JSON 错误信封。 */
function jsonFromArgv(argv: readonly string[]): boolean {
  let enabled = false;
  for (const token of argv) {
    if (token === '--json') {
      enabled = true;
      continue;
    }
    if (token.startsWith('--json=')) {
      const value = token.slice('--json='.length);
      enabled = value === '1' || value === 'true' || value === 'yes';
    }
  }
  return enabled;
}

function errorInfo(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof CliError) {
    return {
      code: error.code ?? 'CLI_ERROR',
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    code: 'CLI_ERROR',
    message: error instanceof Error ? error.message : String(error),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const token = tokenFromArgv(argv) ?? process.env.AGENTNET_TOKEN ?? null;
  try {
    return await runCli(argv);
  } catch (error) {
    const info = errorInfo(error);
    if (jsonFromArgv(argv)) {
      const payload = {
        error: {
          code: info.code,
          message: redact(info.message, token),
          ...(info.details === undefined
            ? {}
            : { details: redactValue(info.details, token) }),
        },
      };
      process.stderr.write(`${JSON.stringify(payload)}\n`);
      return 1;
    }
    process.stderr.write(`ERROR [${info.code}] ${redact(info.message, token)}\n`);
    if (info.details !== undefined) {
      process.stderr.write(
        `DETAILS ${JSON.stringify(redactValue(info.details, token))}\n`,
      );
    }
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await main(Bun.argv.slice(2));
  process.exitCode = exitCode;
}
