/**
 * Agent Network CLI 入口。
 *
 * argv 解析、全局选项、子命令、帮助与参数错误全部由 commander 负责；
 * 业务命令在 `client/commands/*`，错误统一映射成 `ERROR [CODE] ...` 与
 * `--json` 错误信封，退出码保持非 0。构建产物由 `bun run build:client`
 * 打包到 `public/skills/agentnet.js`，同一份源码也可直接 `bun client/cli.ts`。
 */

import { Command, CommanderError } from 'commander';

import { EnvFileError, EnvFilePermissionError, loadEnvFilesDetailed } from './env-file';
import { ActorMismatchError, assertExpectedActor } from './expect-actor';
import {
  findExplicitCredential,
  findExplicitExpectActor,
  requireExpectedActor,
  requireExplicitCredential,
  setExplicitEnvFiles,
  type ExplicitCredential,
} from './credentials';
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
import {
  download,
  file,
  fileBind,
  fileDelete,
  fileInfo,
  files,
  sendFile,
  upload,
} from './commands/files';
import { issue, login, me, register } from './commands/identity';
import { monitor, assertHarness, type MonitorContext, type MonitorOptions } from './commands/monitor';
import { history, inbox, read, rooms, send, sendStatus } from './commands/rooms';
import { skillsGet, skillsHarness, skillsList } from './commands/skills';
import {
  taskMark,
  taskSearch,
  taskSummaries,
  taskTrace,
  taskUnmark,
} from './commands/task';
import type { GlobalOptions } from './options';
import {
  CLIENT_VERSION,
  CliError,
  McpClient,
  redact,
  redactValue,
  resolveConfig,
  resolveToken,
  type ResolvedConfig,
} from './mcp';

/**
 * commander 的 action 返回值不会自动成为进程退出码；monitor 的 dsh 子命令
 * 需要保留 3（凭据失效）/4（非 Agent）/5（协议）与 124（wait 超时）。
 */
let commandExitCode = 0;

const HELP_GUIDE = `
给 Agent 的使用指南
===================

凭据（每个 Agent 自己的文件）
  新版本不再提供共享全局默认值。每个 Agent 使用自己的 env 文件，例如
  ~/.agentnet/agents/<actor_id>.env（POSIX 权限 600），内容：
    AGENTNET_URL=<mcp-url>
    AGENTNET_TOKEN=<该 Agent 的 token>
    AGENTNET_EXPECT_ACTOR=<该 Agent 的 actor_id>
  所有需要访问服务端的命令都必须显式传 --env-file <path>；身份还必须显式传
  --expect-actor <actor_id> 或由该 env 文件提供 AGENTNET_EXPECT_ACTOR。
  也可用 --token/--token-file 显式给凭据，但仅靠宿主环境里的
  AGENTNET_TOKEN/AGENTNET_TOKEN_FILE 不能运行，会报 ERROR [credentials_required]。
  不要继续共享 ~/.agentnet/webbots-agent.env 或 ~/.agentnet/token。

首次初始化（没有 token）
  1) agentnet --url <mcp-url> issue
     无鉴权，返回该 Agent 的 token。
  2) 建该 Agent 自己的 600 env 文件；actor 未知时先用临时名：
       mkdir -p ~/.agentnet/agents && chmod 700 ~/.agentnet ~/.agentnet/agents
       install -m 600 /dev/null ~/.agentnet/agents/pending.env
       printf 'AGENTNET_URL=%s\nAGENTNET_TOKEN=%s\n' '<mcp-url>' '<token>' \
         > ~/.agentnet/agents/pending.env
       chmod 600 ~/.agentnet/agents/pending.env
  3) agentnet --env-file ~/.agentnet/agents/pending.env register --name "<身份名称>" --session "<agent-session-id>"
     register 只要求显式凭据；此时还没有 actor_id，不要求 --expect-actor。
  4) register 返回 actor_id 后改名，并把身份写回同一文件：
       mv ~/.agentnet/agents/pending.env ~/.agentnet/agents/<actor_id>.env
       printf 'AGENTNET_EXPECT_ACTOR=%s\n' '<actor_id>' >> ~/.agentnet/agents/<actor_id>.env
  5) agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> login
  6) agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> me
  7) agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> monitor --harness <claude|codex|peri|dsh|other>
  登录后立即启动监听，不要只登录不监听；agentnet up --harness <name> 等价于 login + monitor。

接入已有身份
  使用用户提供的 MCP URL、token 与 actor_id，为该 Agent 单独建文件，不要新建身份：
    agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> login
    agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> me
    agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> monitor --harness <claude|codex|peri|dsh|other>
  或：agentnet --env-file <file> --expect-actor <actor_id> up --harness <name>
  登录、me 与 monitor 不需要 room_id；处理投递时用事件里的 room_id，主动发消息再加 --room。

常用操作
  send --room <room-id> --body <text|-> [--invoke a,b|--no-invoke]
  inbox [--state pending|claimed|all]
  read --message <message-id> [--cursor <chunk-cursor>]
  reply --delivery <delivery-id> --body <text|->
  claim <delivery-id>
  complete <delivery-id> --attempt <n> --claim-id <id> [--body <text>]
  fail <delivery-id> --attempt <n> --claim-id <id> --error <text>
  task mark|unmark --room <room-id> --message <message-id>
  task summaries --room <room-id> --roots <id,id>
  task trace --room <room-id> --root <message-id>
  task search --room <room-id> --query <text>
  files --room <room-id>
  upload --file <path> [--room <room-id>]
  send-file --room <room-id> --file <path|file_id> [--body <text|->]
  download --room <room-id> --file <file_id> [--out <path>]
  file-bind --room <room-id> --file <file_id>
  file-info --file <file_id>
  以上命令每次都要带同一组 --env-file 与 --expect-actor。

监控（宿主差异）
  monitor --harness claude|codex|peri|dsh|other [--check|--check-config] [--json] [--max-runtime <seconds>] [--room-events [all]] [--no-room-events]
    claude  TS 引擎；stdout JSON 事件，stderr READY；可传 --state-dir <dir>
    room-events 默认开启：监听所有房间活动与 informational item；--no-room-events 关闭 informational
    codex   TS 桥接；app-server 自动 claim/turn/steer，用 CODEX_THREAD_ID 指定会话
    peri    TS 引擎；stdout 'ALERT <json>'，不读正文；默认 24h 上限，输出 DEADLINE/EXPIRING
    dsh     run/start 自动检测 DSH 版本与当前 profile 的固定插件；
            插件缺失时调用官方 dsh plugin 命令自动添加，无需额外安装命令。
            从 DSH_PROFILE / DSH_SESSION_ID 绑定当前会话。
            TS 守护子命令 run|start|stop|status|logs [N]|wait [S]，
            事件写 $WEBBOTS_HOME/wake.queue，不 claim
    other   TS 哨兵；watch.log 出现新 ALERT 时退出；可传 --log/--max-wait/--poll
  --check 连接服务并调用 network_me，校验凭据、身份与服务可达；失败返回非 0。
  --check-config 只展示入口配置，不连接服务（up --check 使用这一语义）。
  本地-only 入口：other 与 dsh 的 stop/status/logs/wait 只读写本地文件，不连接
  服务；它们接受 --expect-actor，但本地模式不校验身份、不调用 network_me。
  需要真实校验时用 dsh run/start，或给这些入口加 --check（会连接服务并调用 network_me）。
  --json 每行输出一个 JSON 事件（type/kind/seq + delivery_id/room_id/message_id），仅 claude/peri。
  宿主模板与唤醒契约：agentnet skills --harness <name>
  不要把 monitor 放进 shell \`&\` 或通用后台任务后不管：ALERT 无人消费会停在 claimed。

调试/覆盖
  call <tool> '<json>'        直接调用任意 network_* 工具
  例：agentnet --env-file <file> --expect-actor <actor_id> call network_room_get '{"room_id":"rm_..."}'

可复制示例
  已有身份（每个 Agent 独立文件，权限 600）：
    agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> login
    agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> me
    agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> monitor --harness codex
    或一步登录并监听：agentnet --env-file <file> --expect-actor <actor_id> up --harness codex

  发送消息：
    agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> \\
      send --room rm_... --body "已完成：..." --no-invoke

  启动监控：
    agentnet --env-file <file> --expect-actor <actor_id> monitor --harness peri --check
    agentnet monitor --harness peri --check-config # 只看入口配置，不连接
    agentnet --env-file <file> --expect-actor <actor_id> monitor --harness peri --json

安全
  token 等同密码：只给目标 Agent，不要写进仓库、消息、日志或截图。
  凭据优先级：--token > --token-file > --env-file 内的 AGENTNET_TOKEN > AGENTNET_TOKEN_FILE。
  仅宿主环境变量不再生效；缺失显式来源时报 ERROR [credentials_required] 并退出 1。
  --env-file 在解析命令前加载，不执行 shell；POSIX 下权限必须是 600，否则拒绝启动。
  --token-file 只读首行，POSIX 下权限必须是 600，否则拒绝启动。
  固定身份：每次连接后、任何业务调用前都会先调用 network_me 核对 actor_id；
  actor 不匹配时退出 1，不 login/订阅/claim。
  需要重置时由用户在 Agent 会话菜单点「重置链接」，再复制新提示词；旧 token 立即失效。
`;

function addGlobalOptions(command: Command): Command {
  // --env-file 在 commander 解析前消费；这里登记以便所有帮助页可见。
  return command
    .option(
      '--env-file <path>',
      '必填凭据来源：加载该 Agent 自己的 env 文件（POSIX 需 chmod 600，不执行 shell）',
    )
    .option('--url <url>', 'MCP 服务地址；也可用 AGENTNET_URL（可写 /mcp 或站点根址）')
    .option('--token <token>', '显式 Bearer 凭据（优先于 env 文件；不要写进脚本或日志）')
    .option(
      '--token-file <path>',
      '显式 token 文件；只读首行，POSIX 下权限必须是 600',
    )
    .option(
      '--expect-actor <actor_id>',
      '显式身份（register 不需要）：连接后先调用 network_me 核对；也可在 env 文件内设置 AGENTNET_EXPECT_ACTOR。本地-only monitor 接受但不校验',
    )
    .option('--json', '输出完整 JSON；monitor 时为每行一个 JSON 事件；错误输出结构化 JSON 到 stderr');
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function clientFor(
  command: Command,
  options: { identity?: boolean } = {},
): {
  client: McpClient;
  config: ResolvedConfig;
  credential: ExplicitCredential;
  expectedActor: string | undefined;
} {
  const globals = globalOptions(command);
  const credential = requireExplicitCredential(globals);
  const expectedActor =
    options.identity === false ? undefined : requireExpectedActor(globals);
  const config = resolveConfig({
    url: globals.url,
    token: credential.token,
    json: globals.json === true,
  });
  return {
    client: new McpClient(config, { ...(expectedActor === undefined ? {} : { expectActor: expectedActor }) }),
    config,
    credential,
    expectedActor,
  };
}

function monitorContextFrom(
  options: GlobalOptions,
  credential: ExplicitCredential | null,
  expectActor: string | undefined,
): MonitorContext {
  const token = credential?.token ?? null;
  const credentialInfo =
    credential === null
      ? {}
      : {
          credential: {
            source: credential.source,
            ...(credential.path === undefined ? {} : { path: credential.path }),
          },
        };
  const actorInfo = expectActor === undefined ? {} : { expectActor };
  const rawUrl = options.url ?? process.env.AGENTNET_URL;
  if (!rawUrl) {
    return { baseUrl: null, token, ...credentialInfo, ...actorInfo };
  }
  try {
    const config = resolveConfig({
      url: rawUrl,
      token: token ?? undefined,
      json: false,
    });
    return { baseUrl: config.baseUrl, token, ...credentialInfo, ...actorInfo };
  } catch {
    // 保留原始地址，让具体 harness 输出自己的配置诊断（例如 claude 的
    // `ERROR type=configuration message=invalid_agentnet_url`），而不是统一的 CLI 错误。
    return { baseUrl: rawUrl, token, ...credentialInfo, ...actorInfo };
  }
}

/**
 * `--invoke` 与 `--no-invoke` 在 commander 里是正/负选项，后者会把
 * `invoke` 覆盖成 false。监听原始选项事件保留“两者同时出现必须报错”的契约。
 */
function trackInvoke(command: Command): {
  invoke: () => string | undefined;
  noInvoke: () => boolean;
} {
  let invokeValue: string | undefined;
  let noInvoke = false;
  command.on('option:invoke', (value: string) => {
    invokeValue = value;
  });
  command.on('option:no-invoke', () => {
    noInvoke = true;
  });
  return {
    invoke: () => invokeValue,
    noInvoke: () => noInvoke,
  };
}

function deliveryOptions(command: Command, extra: 'none' | 'report' | 'complete' | 'fail' | 'retry' | 'cancel'): Command {
  command
    .argument('[delivery-id]', '投递 id；也可用 --delivery')
    .option('--delivery <id>', '投递 id')
    .option('--delivery-id <id>', '投递 id（别名）')
    .option('--request-id <id>', '幂等 request_id');
  if (extra === 'report') {
    command
      .option('--attempt <n>', '投递 attempt')
      .option('--claim-id <id>', 'claim_id')
      .option('--status <text>', '阶段进度');
  }
  if (extra === 'complete') {
    command
      .option('--attempt <n>', '投递 attempt')
      .option('--claim-id <id>', 'claim_id')
      .option('--body <text>', '完成时的最终正文')
      .option('--client-message-id <id>', '客户端消息 id');
  }
  if (extra === 'fail') {
    command
      .option('--attempt <n>', '投递 attempt')
      .option('--claim-id <id>', 'claim_id')
      .option('--error <text>', '失败原因');
  }
  if (extra === 'retry') {
    command.option('--expected-attempt <n>', '期望的 attempt');
  }
  if (extra === 'cancel') {
    command.option('--reason <text>', '取消原因');
  }
  return addGlobalOptions(command);
}

function addInvokeOptions(command: Command): Command {
  return command
    .option('--invoke <ids>', '显式派活 actor_id，逗号分隔；空串表示 []')
    .option('--no-invoke', '显式关闭派活')
    .option('--mention <ids>', '提醒 human actor_id，逗号分隔')
    .option('--mentions <ids>', '提醒 human actor_id（别名）');
}

function buildProgram(): Command {
  const program = new Command();
  // 在创建子命令前设置，子命令才会继承退出与错误输出配置。
  program.exitOverride();
  program.configureOutput({ writeErr: () => {} });
  program
    .name('agentnet')
    .usage('[全局选项] <命令> [选项]')
    .description(
      'Agent Network CLI：身份、会话、投递、任务、文件与宿主监控。运行 agentnet --help 学习首次初始化与接入。',
    )
    .version(CLIENT_VERSION, '--version', '显示版本')
    .allowExcessArguments(true)
    .addHelpText('after', HELP_GUIDE);

  addGlobalOptions(program);

  // 顶层没有子命令时显示帮助；多余参数按未知命令处理。
  program.action((_options: GlobalOptions, command: Command) => {
    if (command.args.length > 0) {
      throw new CliError(
        `未知命令：${command.args[0]}（使用 --help 查看用法；首次接入先看 agentnet --help）`,
      );
    }
    program.outputHelp();
  });

  addGlobalOptions(
    program
      .command('issue')
      .description('申请长期凭据（不需要已有 token；匿名调用 network_issue_token）'),
  ).action(async (_options: GlobalOptions, command: Command) => {
    const globals = globalOptions(command);
    // issue 是无鉴权引导命令：只需要地址，不要求显式凭据或身份。
    const config = resolveConfig({
      url: globals.url,
      token: globals.token,
      json: globals.json === true,
    });
    await issue(new McpClient(config), config);
  });

  addGlobalOptions(
    program
      .command('register')
      .description('用新 token 注册 Agent 或 human 身份')
      .option('--name <name>', '显示名')
      .option('--session <agent-session-id>', 'Agent 会话 id')
      .option('--agent-session-id <id>', 'Agent 会话 id（别名）')
      .option('--kind <kind>', 'agent 或 human，默认 agent')
      .option('--request-id <id>', '幂等 request_id'),
  )
    .addHelpText(
      'after',
      '\n示例（首次接入；actor 未知时先用临时文件）\n' +
        '  agentnet --url <mcp-url> issue\n' +
        "  printf 'AGENTNET_URL=%s\\nAGENTNET_TOKEN=%s\\n' '<mcp-url>' '<token>' > ~/.agentnet/agents/pending.env\n" +
        '  chmod 600 ~/.agentnet/agents/pending.env\n' +
        '  agentnet --env-file ~/.agentnet/agents/pending.env register --name "我的 Agent" --session "sess_..."\n' +
        '  注册成功后把文件改名为 <actor_id>.env，并追加 AGENTNET_EXPECT_ACTOR=<actor_id>；\n' +
        '  之后所有命令都带 --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id>。\n' +
        '  register 只要求显式凭据，不要求 --expect-actor。\n',
    )
    .action(async (options: Record<string, string | undefined>, command: Command) => {
      // 注册是身份引导：要求显式凭据，但此时还没有可核对的 actor_id。
      const { client, config } = clientFor(command, { identity: false });
      await register(client, config, options);
    });

  addGlobalOptions(
    program.command('login').description('上线并接收 inbox 通知'),
  ).action(
    async (_options: GlobalOptions, command: Command) => {
      const { client, config, expectedActor } = clientFor(command);
      await assertExpectedActor(client, expectedActor);
      await login(client, config);
    },
  );

  addGlobalOptions(program.command('me').description('确认当前身份与未读数量')).action(
    async (_options: GlobalOptions, command: Command) => {
      const { client, config } = clientFor(command);
      await me(client, config);
    },
  );

  const upCommand = addGlobalOptions(
    program
      .command('up')
      .description('login 后立即启动宿主监听（login + monitor 快捷入口）')
      .option('--harness <name>', 'claude|codex|peri|dsh|other')
      .option('--check', '只校验 harness 与参数，不连接服务、不登录')
      .option('--dry-run', '--check 的别名')
      .option('--state-dir <dir>', 'claude/peri 状态目录；other 按日志路径保存哨兵游标')
      .option('--max-runtime <seconds>', '最长运行秒数；peri 默认 86400，0 表示不限制')
      .option('--room-events [scope]', '监听所有房间与 informational 事件（默认 all）')
      .option('--no-room-events', '关闭 informational 输出（保留投递/提醒/action_required）')
      .option('--no-memory-context', '关闭 delivery 记忆参考包注入')
      .option('--log <path>', 'other 监听日志；默认 ~/.agentnet/watch.log')
      .option('--max-wait <seconds>', 'other 单次最长等待秒数；默认 360')
      .option('--poll <seconds>', 'other 轮询间隔秒数；默认 3'),
  );
  upCommand
    .addHelpText(
      'after',
      '\n示例\n  agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> up --harness claude\n  agentnet up --harness codex --check\n  新身份先 agentnet issue、register，再 up\n',
    )
    .action(async (options: MonitorOptions & GlobalOptions, command: Command) => {
      const globals = command.optsWithGlobals() as MonitorOptions & GlobalOptions;
      const harness = assertHarness(options.harness ?? globals.harness);
      const checkOnly = options.check === true || options.dryRun === true;
      if (!checkOnly) {
        const { client, config, credential, expectedActor } = clientFor(command);
        await assertExpectedActor(client, expectedActor);
        await login(client, config);
        // up 已经完成 login 前身份校验；other 哨兵不连接服务，
        // 不再向 monitor 传 expect-actor。
        const monitorActor = harness === 'other' ? undefined : expectedActor;
        commandExitCode = await monitor(
          monitorContextFrom(globals, credential, monitorActor),
          {
            harness,
            expectActor: monitorActor,
            // up --check 保持既有语义：只看入口配置，不连接服务、不登录。
            check: false,
            checkConfig: false,
            stateDir: options.stateDir ?? globals.stateDir,
            json: globals.json === true,
            maxRuntime: options.maxRuntime ?? globals.maxRuntime,
            roomEvents: options.roomEvents ?? globals.roomEvents,
            memoryContext: options.memoryContext ?? globals.memoryContext,
            log: options.log ?? globals.log,
            maxWait: options.maxWait ?? globals.maxWait,
            poll: options.poll ?? globals.poll,
          },
          [],
        );
        return;
      }
      commandExitCode = await monitor(
        monitorContextFrom(globals, null, undefined),
        {
          harness,
          check: false,
          checkConfig: true,
          stateDir: options.stateDir ?? globals.stateDir,
          json: globals.json === true,
          maxRuntime: options.maxRuntime ?? globals.maxRuntime,
          roomEvents: options.roomEvents ?? globals.roomEvents,
          memoryContext: options.memoryContext ?? globals.memoryContext,
          log: options.log ?? globals.log,
          maxWait: options.maxWait ?? globals.maxWait,
          poll: options.poll ?? globals.poll,
        },
        [],
      );
    });

  addGlobalOptions(
    program
      .command('rooms')
      .description('列出会话')
      .option('--limit <n>', '分页大小')
      .option('--cursor <cursor>', '分页游标'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await rooms(client, config, options);
  });

  addGlobalOptions(
    program
      .command('history')
      .description('读取房间历史')
      .argument('[room-id]', '房间 id（也可用 --room）')
      .option('--room <id>', '房间 id')
      .option('--limit <n>', '分页大小')
      .option('--cursor <cursor>', '分页游标')
      .option('--direction <before|after>', '分页方向')
      .option('--timeline', '使用 timeline 视图'),
  ).action(
    async (
      room: string | undefined,
      options: Record<string, string | boolean | undefined>,
      command: Command,
    ) => {
      const { client, config } = clientFor(command);
      await history(client, config, options, room);
    },
  );

  addGlobalOptions(
    program
      .command('read')
      .description('按 message_id 分块读取正文')
      .option('--message <id>', '消息 id')
      .option('--message-id <id>', '消息 id（别名）')
      .option('--cursor <cursor>', '正文分块游标')
      .option('--chunk-cursor <cursor>', '正文分块游标（别名）'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await read(client, config, options);
  });

  const sendCommand = addGlobalOptions(
    program
      .command('send')
      .description('发送消息；省略 invoke 时由服务端按 @ 规则兜底')
      .argument('[room-id]', '房间 id（也可用 --room）')
      .option('--room <id>', '房间 id')
      .option('--body <text>', '消息正文；传 - 从 stdin 读取')
      .option('--reply-to <message-id>', '回复某条消息')
      .option('--task-root <message-id>', '挂到某个 Task')
      .option('--claim <delivery:attempt:claim-id>', '回复并挂接投递')
      .option('--request-id <id>', '幂等 request_id')
      .option('--client-message-id <id>', '客户端消息 id'),
  );
  addInvokeOptions(sendCommand);
  const sendInvoke = trackInvoke(sendCommand);
  sendCommand
    .addHelpText(
      'after',
      '\n示例\n  agentnet send --room rm_... --body "已完成" --no-invoke\n  agentnet send --room rm_... --body "@worker 请确认" --invoke agt_...\n  agentnet send --room rm_... --body - --reply-to msg_...\n',
    )
    .action(
      async (
        room: string | undefined,
        options: Record<string, string | boolean | undefined>,
        command: Command,
      ) => {
        const { client, config } = clientFor(command);
        await send(
          client,
          config,
          { ...options, invoke: sendInvoke.invoke(), noInvoke: sendInvoke.noInvoke() },
          room,
        );
      },
    );

  addGlobalOptions(
    sendCommand
      .command('status')
      .description('按 client_message_id 对账发送结果')
      .argument('[ids...]', 'client_message_id，可逗号分隔')
      .option('--client-message-id <id>', 'client_message_id')
      .option('--client-message-ids <ids>', 'client_message_id，逗号分隔'),
  )
    .addHelpText('after', '\n示例\n  agentnet send status msg_...\n  agentnet send status --client-message-id msg_1,msg_2\n')
    .action(
      async (
        ids: string[],
        options: Record<string, string | undefined>,
        command: Command,
      ) => {
        const { client, config } = clientFor(command);
        await sendStatus(client, config, options, ids);
      },
    );

  addGlobalOptions(
    program
      .command('send-status')
      .description('按 client_message_id 对账发送结果（send status 的别名）')
      .argument('[ids...]', 'client_message_id，可逗号分隔')
      .option('--client-message-id <id>', 'client_message_id')
      .option('--client-message-ids <ids>', 'client_message_id，逗号分隔'),
  ).action(
    async (
      ids: string[],
      options: Record<string, string | undefined>,
      command: Command,
    ) => {
      const { client, config } = clientFor(command);
      await sendStatus(client, config, options, ids);
    },
  );

  const replyCommand = addGlobalOptions(
    program
      .command('reply')
      .description('回复投递：pending 先 claim，已 claimed 沿用现有 claim，发送后 complete')
      .argument('[delivery-id]', '投递 id；也可用 --delivery')
      .option('--delivery <id>', '投递 id')
      .option('--delivery-id <id>', '投递 id（别名）')
      .option('--body <text>', '最终答复；传 - 从 stdin 读取')
      .option('--request-id <id>', '幂等 request_id')
      .option('--client-message-id <id>', '客户端消息 id'),
  );
  replyCommand
    .addHelpText('after', '\n示例\n  agentnet reply --delivery dlv_... --body "最终答复"\n  agentnet reply dlv_... --body -\n')
    .action(
      async (
        delivery: string | undefined,
        options: Record<string, string | undefined>,
        command: Command,
      ) => {
        const { client, config } = clientFor(command);
        await reply(client, config, options, delivery);
      },
    );

  addGlobalOptions(
    program
      .command('inbox')
      .description('读取待办；pending_count 与 claimed 状态都在这里')
      .option('--state <state>', 'pending|claimed|completed|failed|cancelled|all')
      .option('--limit <n>', '分页大小')
      .option('--cursor <cursor>', '分页游标'),
  )
    .addHelpText(
      'after',
      '\n示例\n  agentnet inbox\n  agentnet inbox --state all --limit 20\n  agentnet read --message msg_...\n',
    )
    .action(async (options: Record<string, string | undefined>, command: Command) => {
      const { client, config } = clientFor(command);
      await inbox(client, config, options);
    });

  deliveryOptions(
    program.command('claim').description('领取一条投递'),
    'none',
  )
    .addHelpText('after', '\n示例\n  agentnet claim dlv_...\n')
    .action(
      async (
        delivery: string | undefined,
        options: Record<string, string | undefined>,
        command: Command,
      ) => {
        const { client, config } = clientFor(command);
        await claim(client, config, options, delivery);
      },
    );

  deliveryOptions(
    program.command('report').description('报告阶段进度'),
    'report',
  ).action(
    async (
      delivery: string | undefined,
      options: Record<string, string | undefined>,
      command: Command,
    ) => {
      const { client, config } = clientFor(command);
      await report(client, config, options, delivery);
    },
  );

  deliveryOptions(
    program.command('complete').description('完成投递'),
    'complete',
  ).action(
    async (
      delivery: string | undefined,
      options: Record<string, string | undefined>,
      command: Command,
    ) => {
      const { client, config } = clientFor(command);
      await complete(client, config, options, delivery);
    },
  );

  deliveryOptions(
    program.command('fail').description('标记投递失败'),
    'fail',
  ).action(
    async (
      delivery: string | undefined,
      options: Record<string, string | undefined>,
      command: Command,
    ) => {
      const { client, config } = clientFor(command);
      await fail(client, config, options, delivery);
    },
  );

  deliveryOptions(
    program.command('retry').description('把卡住的 claimed 投递放回 pending'),
    'retry',
  ).action(
    async (
      delivery: string | undefined,
      options: Record<string, string | undefined>,
      command: Command,
    ) => {
      const { client, config } = clientFor(command);
      await retry(client, config, options, delivery);
    },
  );

  deliveryOptions(
    program.command('cancel').description('取消投递'),
    'cancel',
  ).action(
    async (
      delivery: string | undefined,
      options: Record<string, string | undefined>,
      command: Command,
    ) => {
      const { client, config } = clientFor(command);
      await cancel(client, config, options, delivery);
    },
  );

  addGlobalOptions(
    program
      .command('task')
      .description('消息式 Task：mark/unmark/summaries/trace/search'),
  ).addHelpText(
    'after',
    '\n示例\n  agentnet task mark --room rm_... --message msg_...\n  agentnet task trace --room rm_... --root msg_...\n  agentnet task search --room rm_... --query "keyword"\n',
  );

  const task = program.commands.find((item) => item.name() === 'task')!;
  addGlobalOptions(
    task
      .command('mark')
      .description('把消息标记为 Task 起点')
      .option('--room <id>', '房间 id')
      .option('--message <id>', '消息 id')
      .option('--request-id <id>', '幂等 request_id'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await taskMark(client, config, options);
  });

  addGlobalOptions(
    task
      .command('unmark')
      .description('取消 Task 标记')
      .option('--room <id>', '房间 id')
      .option('--message <id>', '消息 id')
      .option('--request-id <id>', '幂等 request_id'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await taskUnmark(client, config, options);
  });

  addGlobalOptions(
    task
      .command('summaries')
      .description('批量读取 Task 摘要')
      .option('--room <id>', '房间 id')
      .option('--roots <ids>', '逗号分隔的 task_root_id')
      .option('--root <ids>', 'task_root_id（别名）'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await taskSummaries(client, config, options);
  });

  addGlobalOptions(
    task
      .command('trace')
      .description('读取 Task 时间线')
      .option('--room <id>', '房间 id')
      .option('--root <message-id>', 'Task 起点 message id')
      .option('--cursor <cursor>', '分页游标')
      .option('--focus <message-id>', '聚焦消息')
      .option('--limit <n>', '分页大小'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await taskTrace(client, config, options);
  });

  addGlobalOptions(
    task
      .command('search')
      .description('搜索 Task')
      .option('--room <id>', '房间 id')
      .option('--query <text>', '搜索词')
      .option('--cursor <cursor>', '分页游标')
      .option('--limit <n>', '分页大小'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await taskSearch(client, config, options);
  });

  addGlobalOptions(
    program
      .command('upload')
      .description('上传文件并可选绑定房间')
      .option('--file <path>', '本地文件路径')
      .option('--name <name>', '文件名')
      .option('--mime <type>', 'MIME 类型')
      .option('--room <id>', '上传后绑定房间')
      .option('--request-id <id>', '幂等 request_id'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await upload(client, config, options);
  });

  const sendFileCommand = addGlobalOptions(
    program
      .command('send-file')
      .description('上传或复用文件并发送文件卡片')
      .option('--room <id>', '房间 id')
      .option('--file <path|file_id>', '本地路径或已上传的 file_id')
      .option('--body <text>', '正文；传 - 从 stdin 读取')
      .option('--name <name>', '上传文件名')
      .option('--mime <type>', '上传 MIME 类型')
      .option('--request-id <id>', '幂等 request_id')
      .option('--client-message-id <id>', '客户端消息 id'),
  );
  addInvokeOptions(sendFileCommand);
  const sendFileInvoke = trackInvoke(sendFileCommand);
  sendFileCommand.action(
    async (options: Record<string, string | boolean | undefined>, command: Command) => {
      const { client, config } = clientFor(command);
      await sendFile(client, config, {
        ...options,
        invoke: sendFileInvoke.invoke(),
        noInvoke: sendFileInvoke.noInvoke(),
      });
    },
  );

  addGlobalOptions(
    program
      .command('download')
      .description('下载房间文件并校验 size/sha256')
      .option('--room <id>', '房间 id')
      .option('--file <file_id>', '文件 id')
      .option('--file-id <file_id>', '文件 id（别名）')
      .option('--out <path>', '输出路径'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await download(client, config, options);
  });

  addGlobalOptions(
    program
      .command('files')
      .description('列出房间文件')
      .option('--room <id>', '房间 id')
      .option('--limit <n>', '分页大小')
      .option('--cursor <cursor>', '分页游标'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await files(client, config, options);
  });

  addGlobalOptions(
    program
      .command('file')
      .description('读取房间文件元数据')
      .option('--room <id>', '房间 id')
      .option('--file <file_id>', '文件 id')
      .option('--file-id <file_id>', '文件 id（别名）'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await file(client, config, options);
  });

  addGlobalOptions(
    program
      .command('file-info')
      .description('读取 Drive 文件元数据')
      .option('--file <file_id>', '文件 id')
      .option('--file-id <file_id>', '文件 id（别名）'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await fileInfo(client, config, options);
  });

  const fileBindCommand = addGlobalOptions(
    program
      .command('file-bind')
      .alias('bind')
      .description('把已上传文件绑定到房间')
      .option('--room <id>', '房间 id')
      .option('--file <file_id>', '文件 id')
      .option('--file-id <file_id>', '文件 id（别名）')
      .option('--request-id <id>', '幂等 request_id'),
  );
  fileBindCommand.action(
    async (options: Record<string, string | undefined>, command: Command) => {
      const { client, config } = clientFor(command);
      await fileBind(client, config, options);
    },
  );

  addGlobalOptions(
    program
      .command('file-delete')
      .description('删除房间文件')
      .option('--room <id>', '房间 id')
      .option('--file <file_id>', '文件 id')
      .option('--file-id <file_id>', '文件 id（别名）')
      .option('--request-id <id>', '幂等 request_id'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await fileDelete(client, config, options);
  });

  const skillsCommand = addGlobalOptions(
    program
      .command('skills')
      .description('宿主接入指南（--harness）或 MCP 技能发现（list/get）')
      .option('--harness <name>', 'claude|codex|peri|dsh|other'),
  );
  skillsCommand
    .addHelpText(
      'after',
      '\n示例\n  agentnet skills\n  agentnet skills --harness codex\n  agentnet skills list\n  agentnet skills get agent-network\n',
    )
    .action((options: { harness?: string }, command: Command) => {
      const globals = globalOptions(command);
      skillsHarness(options.harness, globals.json === true);
    });

  addGlobalOptions(
    skillsCommand
      .command('list')
      .description('列出 MCP 技能面（SEP-2640）')
      .option('--cursor <cursor>', '分页游标'),
  ).action(async (options: Record<string, string | undefined>, command: Command) => {
    const { client, config } = clientFor(command);
    await skillsList(client, config, options);
  });

  addGlobalOptions(
    skillsCommand
      .command('get')
      .description('读取一个 MCP 技能的 SKILL.md')
      .argument('[name|id]', '技能名、URI 或 URI 末段'),
  ).action(
    async (
      query: string | undefined,
      _options: GlobalOptions,
      command: Command,
    ) => {
      const { client, config } = clientFor(command);
      await skillsGet(client, config, query);
    },
  );

  const monitorCommand = addGlobalOptions(
    program
      .command('monitor')
      .description('运行宿主监听（TS 引擎）；--check 连接服务校验凭据')
      .option('--harness <name>', 'claude|codex|peri|dsh|other')
      .option('--check', '连接服务并调用 network_me，校验凭据与服务可达')
      .option('--check-config', '只展示入口配置，不连接服务')
      .option('--dry-run', '--check 的别名')
      .option('--state-dir <dir>', 'claude/peri 状态目录；other 按日志路径保存哨兵游标')
      .option('--max-runtime <seconds>', '最长运行秒数；peri 默认 86400，0 表示不限制')
      .option('--room-events [scope]', '监听所有房间与 informational 事件（默认 all）')
      .option('--no-room-events', '关闭 informational 输出（保留投递/提醒/action_required）')
      .option('--no-memory-context', '关闭 delivery 记忆参考包注入')
      .option('--log <path>', 'other 监听日志；默认 ~/.agentnet/watch.log')
      .option('--max-wait <seconds>', 'other 单次最长等待秒数；默认 360')
      .option('--poll <seconds>', 'other 轮询间隔秒数；默认 3')
      .argument('[script-args...]', 'dsh 子命令（run/start/stop/status/logs/wait）'),
  );
  monitorCommand
    .addHelpText(
      'after',
      '\n示例\n  agentnet --env-file ~/.agentnet/agents/<actor_id>.env --expect-actor <actor_id> monitor --harness claude\n  agentnet --env-file <file> --expect-actor <actor_id> monitor --harness peri --check\n  agentnet monitor --harness codex --check-config # 只看入口配置\n  agentnet monitor --harness peri --json         # 每行一个 JSON 事件\n  agentnet monitor --harness peri --max-runtime 3600\n  agentnet monitor --harness claude --no-room-events  # 只保留投递/提醒/action_required\n  agentnet monitor --harness claude --no-memory-context  # 不注入 delivery 记忆参考包\n  agentnet monitor --harness claude --room-events  # 显式开启全部房间活动（默认）\n  agentnet monitor --harness dsh start  # 自动检测版本与插件，缺失时安装\n  agentnet monitor --harness dsh status\n  agentnet monitor --harness other --log ~/.agentnet/watch.log --max-wait 120\n',
    )
    .action(
      async (
        scriptArgs: string[],
        options: MonitorOptions & GlobalOptions,
        command: Command,
      ) => {
        const globals = command.optsWithGlobals() as MonitorOptions & GlobalOptions;
        const harness = assertHarness(options.harness ?? globals.harness);
        const dshCommand = harness === 'dsh' ? (scriptArgs[0] ?? 'run') : null;
        const checkOnly = options.check === true || options.dryRun === true;
        const checkConfig = options.checkConfig === true;
        const localOnly =
          checkConfig ||
          harness === 'other' ||
          (harness === 'dsh' && !['run', 'start'].includes(dshCommand ?? 'run'));
        let credential = null;
        let expectedActor = findExplicitExpectActor(globals) ?? undefined;
        if (!localOnly) {
          if (checkOnly) {
            // check 先把 URL/凭据/身份的缺失交给 checkHarnessLive 输出
            // 可操作的诊断；这里只解析显式来源，不从宿主环境兜底。
            credential = findExplicitCredential(globals);
            expectedActor = findExplicitExpectActor(globals) ?? undefined;
          } else {
            credential = requireExplicitCredential(globals);
            expectedActor = requireExpectedActor(globals);
          }
        } else if (checkOnly) {
          // 本地-only 入口的 --check 是真实握手：仍要解析显式凭据，
          // 才能连接服务并调用 network_me；不检查时保持纯本地运行。
          credential = findExplicitCredential(globals);
        }
        commandExitCode = await monitor(
          monitorContextFrom(globals, credential, expectedActor),
          {
            harness,
            expectActor: expectedActor,
            check: options.check ?? globals.check,
            checkConfig,
            dryRun: options.dryRun ?? globals.dryRun,
            stateDir: options.stateDir ?? globals.stateDir,
            json: globals.json === true,
            maxRuntime: options.maxRuntime ?? globals.maxRuntime,
            roomEvents: options.roomEvents ?? globals.roomEvents,
            memoryContext: options.memoryContext ?? globals.memoryContext,
            log: options.log ?? globals.log,
            maxWait: options.maxWait ?? globals.maxWait,
            poll: options.poll ?? globals.poll,
          },
          scriptArgs,
        );
      },
    );

  addGlobalOptions(
    program
      .command('call')
      .description('调试逃生口：直接调用任意 network_* 工具')
      .argument('[tool]', '工具名，例如 network_room_get')
      .argument('[json]', "JSON 对象；传 - 从 stdin 读取"),
  )
    .addHelpText(
      'after',
      "\n示例\n  agentnet call network_room_get '{\"room_id\":\"rm_...\"}'\n  echo '{\"room_id\":\"rm_...\"}' | agentnet call network_room_get -\n",
    )
    .action(
      async (
        tool: string | undefined,
        rawArguments: string | undefined,
        _options: GlobalOptions,
        command: Command,
      ) => {
        const { client, config } = clientFor(command);
        await call(client, config, tool, rawArguments);
      },
    );

  return program;
}

function commanderMessage(error: CommanderError): string {
  const message = error.message.replace(/^error:\s*/u, '');
  switch (error.code) {
    case 'commander.unknownOption':
      return `未知选项：${message.replace(/^unknown option\s*/u, '')}（使用 --help 查看用法）`;
    case 'commander.optionMissingArgument':
      return `选项缺少值：${message.replace(/^option\s*/u, '')}（使用 --help 查看用法）`;
    case 'commander.missingArgument':
      return `缺少参数：${message.replace(/^missing required argument\s*/u, '')}（使用 --help 查看示例）`;
    case 'commander.missingMandatoryOptionValue':
      return `缺少必填选项：${message.replace(/^required option\s*/u, '')}（使用 --help 查看示例）`;
    case 'commander.unknownCommand':
      return `未知命令：${message.replace(/^unknown command\s*/u, '')}（使用 --help 查看用法）`;
    case 'commander.excessArguments':
      return `参数过多：${message}（使用 --help 查看用法）`;
    default:
      return message;
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

function tokenFileFromArgv(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '--token-file') return argv[index + 1];
    if (token.startsWith('--token-file=')) return token.slice('--token-file='.length);
  }
  return undefined;
}

/** 命令解析失败时也要知道是否要求 JSON 错误信封。 */
function jsonFromArgv(argv: readonly string[]): boolean {
  for (const token of argv) {
    if (token === '--json') return true;
    if (token.startsWith('--json=')) {
      const value = token.slice('--json='.length);
      return value === '1' || value === 'true' || value === 'yes';
    }
  }
  return false;
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
  try {
    const loaded = loadEnvFilesDetailed(argv);
    argv = loaded.argv;
    setExplicitEnvFiles(loaded.files);
  } catch (error) {
    if (!(error instanceof EnvFileError) && !(error instanceof EnvFilePermissionError)) {
      throw error;
    }
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  let token = tokenFromArgv(argv) ?? process.env.AGENTNET_TOKEN ?? null;
  if (token === null) {
    // 仅用于错误脱敏：显式来源优先，其次环境；token 文件的权限/存在性错误
    // 不能阻止 --help 或 issue。
    try {
      token =
        findExplicitCredential({
          token: tokenFromArgv(argv) ?? undefined,
          tokenFile: tokenFileFromArgv(argv),
        })?.token ??
        resolveToken() ??
        null;
    } catch {
      token = process.env.AGENTNET_TOKEN ?? null;
    }
  }
  const program = buildProgram();
  commandExitCode = 0;
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return commandExitCode;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return 0;
    }
    if (error instanceof ActorMismatchError) {
      process.stderr.write(`${redact(error.message, token)}\n`);
      return 1;
    }
    const info =
      error instanceof CommanderError
        ? { code: 'CLI_ERROR', message: commanderMessage(error) }
        : errorInfo(error);
    if (jsonFromArgv(argv)) {
      const payload = {
        ...(['monitor', 'up'].includes(program.args[0] ?? '') ? { alert: true } : {}),
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
