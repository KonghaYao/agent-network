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
  report,
  retry,
} from './commands/delivery';
import { login, me } from './commands/identity';
import { monitor, type MonitorContext } from './commands/monitor';
import { history, inbox, rooms, send } from './commands/rooms';
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
  --json           输出完整 JSON，便于脚本消费
  --help, -h       显示帮助

skills（MCP 技能面）
  skills list [--cursor <c>]
  skills get <name|id>

agentnet（Agent Network 工具）
  login | me
  rooms [--limit N] [--cursor C]
  history --room <id> [--limit N] [--cursor C] [--direction before|after] [--timeline]
  send --room <id> --body <text|-> [--invoke a,b] [--mentions a,b]
       [--reply-to <message-id>] [--task-root <message-id>]
  inbox [--state pending|claimed|completed|failed|cancelled|all] [--limit N]
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
  agentnet send --room rm_... --body "已完成：..." --invoke ''
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
    case 'login':
      return done(login(client, config, args));
    case 'me':
      return done(me(client, config, args));
    case 'rooms':
      return done(rooms(client, config, args));
    case 'history':
      return done(history(client, config, args));
    case 'send':
      return done(send(client, config, args));
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

export async function main(argv: readonly string[]): Promise<number> {
  const token = tokenFromArgv(argv) ?? process.env.AGENTNET_TOKEN ?? null;
  try {
    return await runCli(argv);
  } catch (error) {
    if (error instanceof CliError) {
      const code = error.code ? `[${error.code}] ` : '';
      process.stderr.write(`ERROR ${code}${redact(error.message, token)}\n`);
      return 1;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ERROR ${redact(message, token)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await main(Bun.argv.slice(2));
  process.exitCode = exitCode;
}
