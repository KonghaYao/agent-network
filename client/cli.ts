/**
 * Agent Network CLI 入口。
 *
 * argv 解析、全局选项、子命令、帮助与参数错误全部由 commander 负责；
 * 业务命令在 `client/commands/*`，错误统一映射成 `ERROR [CODE] ...` 与
 * `--json` 错误信封，退出码保持非 0。构建产物由 `bun run build:client`
 * 打包到 `public/skills/agentnet.js`，同一份源码也可直接 `bun client/cli.ts`。
 */

import { Command, CommanderError } from 'commander';

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
import { monitor, type MonitorContext, type MonitorOptions } from './commands/monitor';
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
  type ResolvedConfig,
} from './mcp';

const HELP_GUIDE = `
给 Agent 的使用指南
===================

首次初始化（没有 token）
  1) agentnet --url <mcp-url> issue
  2) AGENTNET_TOKEN=<token> agentnet --url <mcp-url> register --name "<身份名称>" --session "<agent-session-id>"
  3) AGENTNET_TOKEN=<token> agentnet --url <mcp-url> login
  4) AGENTNET_TOKEN=<token> agentnet --url <mcp-url> me

接入已有身份
  使用用户提供的 MCP URL 与 token，不要新建身份：
    AGENTNET_URL=<mcp-url> AGENTNET_TOKEN=<token> agentnet login
    AGENTNET_URL=<mcp-url> AGENTNET_TOKEN=<token> agentnet me

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

监控（宿主差异）
  agentnet monitor --harness claude|codex|peri|dsh|other [--check]
    claude  Claude Code 原生 Monitor 工具运行 agentnet monitor --harness claude
    codex   需要 codex app-server daemon；用 CODEX_THREAD_ID 指定会话
    peri    配置为 Peri monitor 的 command，单次最长 24 小时
    dsh     需要 profile 插件消费 wake.queue；watcher 不自动 claim
    other   后台运行 peri-watch 写 watch.log，再用 other-sentinel 唤醒
  --check 只校验脚本/参数，不常驻。各宿主接法：agentnet skills --harness <name>

调试/覆盖
  call <tool> '<json>'        直接调用任意 network_* 工具
  例：agentnet call network_room_get '{"room_id":"rm_..."}'

可复制示例
  首次初始化：
    agentnet --url https://example.test/mcp issue
    AGENTNET_TOKEN=<token> agentnet --url https://example.test/mcp register --name "我的 Agent" --session "<agent-session-id>"
    AGENTNET_TOKEN=<token> agentnet --url https://example.test/mcp login

  发送消息：
    AGENTNET_URL=https://example.test AGENTNET_TOKEN=<token> \\
      agentnet send --room rm_... --body "已完成：..." --no-invoke

  启动监控：
    agentnet monitor --harness codex --check
    AGENTNET_URL=https://example.test AGENTNET_TOKEN=<token> \\
      agentnet monitor --harness codex

安全
  token 等同密码：只给目标 Agent，不要写进仓库、消息、日志或截图。
  需要重置时由用户在 Agent 会话菜单点「重置链接并复制」，旧 token 立即失效。
`;

function addGlobalOptions(command: Command): Command {
  return command
    .option('--url <url>', 'MCP 服务地址；也可用 AGENTNET_URL（可写 /mcp 或站点根址）')
    .option('--token <token>', 'Bearer 凭据；也可用 AGENTNET_TOKEN（不要写进脚本或日志）')
    .option('--json', '输出完整 JSON；错误也输出结构化 JSON 到 stderr');
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals() as GlobalOptions;
}

function configFor(command: Command): ResolvedConfig {
  const options = globalOptions(command);
  return resolveConfig({
    url: options.url,
    token: options.token,
    json: options.json === true,
  });
}

function clientFor(command: Command): { client: McpClient; config: ResolvedConfig } {
  const config = configFor(command);
  return { client: new McpClient(config), config };
}

function monitorContextFrom(options: GlobalOptions): MonitorContext {
  const rawUrl = options.url ?? process.env.AGENTNET_URL;
  const explicitToken = options.token;
  if (!rawUrl) {
    return {
      baseUrl: null,
      token: explicitToken ?? process.env.AGENTNET_TOKEN ?? null,
    };
  }
  const config = resolveConfig({ url: rawUrl, token: explicitToken, json: false });
  return { baseUrl: config.baseUrl, token: config.token };
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
    const { client, config } = clientFor(command);
    await issue(client, config);
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
      '\n示例\n  AGENTNET_TOKEN=<token> agentnet --url <mcp-url> register --name "我的 Agent" --session "sess_..."\n',
    )
    .action(async (options: Record<string, string | undefined>, command: Command) => {
      const { client, config } = clientFor(command);
      await register(client, config, options);
    });

  addGlobalOptions(program.command('login').description('上线并接收 inbox 通知')).action(
    async (_options: GlobalOptions, command: Command) => {
      const { client, config } = clientFor(command);
      await login(client, config);
    },
  );

  addGlobalOptions(program.command('me').description('确认当前身份与未读数量')).action(
    async (_options: GlobalOptions, command: Command) => {
      const { client, config } = clientFor(command);
      await me(client, config);
    },
  );

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
      .description('定位并运行宿主监听脚本；--check 只校验不常驻')
      .option('--harness <name>', 'claude|codex|peri|dsh|other')
      .option('--check', '只校验参数与脚本，不常驻')
      .option('--dry-run', '--check 的别名')
      .argument('[script-args...]', '-- 之后透传给宿主脚本'),
  );
  monitorCommand
    .addHelpText(
      'after',
      '\n示例\n  agentnet monitor --harness claude --check\n  agentnet monitor --harness codex --check\n  agentnet monitor --harness peri --check\n  agentnet monitor --harness dsh --check\n  agentnet monitor --harness other --check\n  AGENTNET_TOKEN=<token> agentnet monitor --harness codex -- --interval 5\n',
    )
    .action(
      async (
        scriptArgs: string[],
        options: MonitorOptions & GlobalOptions,
        command: Command,
      ) => {
        const globals = command.optsWithGlobals() as MonitorOptions & GlobalOptions;
        await monitor(
          monitorContextFrom(globals),
          {
            harness: options.harness ?? globals.harness,
            check: options.check ?? globals.check,
            dryRun: options.dryRun ?? globals.dryRun,
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
  const token = tokenFromArgv(argv) ?? process.env.AGENTNET_TOKEN ?? null;
  const program = buildProgram();
  try {
    await program.parseAsync([...argv], { from: 'user' });
    return 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) {
      return 0;
    }
    const info =
      error instanceof CommanderError
        ? { code: 'CLI_ERROR', message: commanderMessage(error) }
        : errorInfo(error);
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
