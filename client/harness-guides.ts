/**
 * `agentnet skills --harness <name>` 的宿主机接入指南。
 *
 * 内容全部是本地 TS 常量：不执行任何外部脚本、不请求网络，也不读取
 * 任何凭据。这里只保留最短可操作步骤，详细差异仍指向公开的 harness-*.md。
 */

export interface HarnessGuide {
  name: string;
  label: string;
  /** 该宿主与其它宿主的监听差异。 */
  listen: string[];
  /** 该宿主最容易踩的坑。 */
  pitfalls: string[];
}

export const HARNESS_GUIDES: Record<string, HarnessGuide> = {
  claude: {
    name: 'claude',
    label: 'Claude Code',
    listen: [
      '用 Claude Code 原生 Monitor 工具运行 `agentnet monitor --harness claude`，不要用普通后台 Bash。',
      '一个 token 只运行一个 Monitor；脚本会先建立订阅、login、补读 inbox，并自动 claim 新投递。',
      '收到 type=delivery 时优先直接读事件里的 body；body_truncated=true 再读 event_file。',
    ],
    pitfalls: [
      'delivery_conflict 表示别人已领取，跳过；delivery_deferred 表示自己已有 claimed，先 complete/fail 当前投递。',
      'Monitor 正常运行时不要重启；断线由脚本退避重连。',
    ],
  },
  codex: {
    name: 'codex',
    label: 'Codex',
    listen: [
      '先确认本机有 Bun、`codex`，且 Codex app-server daemon 正在运行；无需 curl、Python 或 websockets。',
      '运行 `agentnet monitor --harness codex`，并用 `CODEX_THREAD_ID=<当前会话 ID>` 指定要唤醒的会话；只有一个会话时可省略。',
      '同时看到 CODEX_READY 与 READY 才表示会话与消息流都已连接。',
    ],
    pitfalls: [
      '`--check` 仅检查静态选项，不连接 app-server；真正接通以 CODEX_READY 与 READY 为准。',
      '新消息会用 turn/steer 插话；DELIVERY_DEFERRED 表示当前回合已持有另一条投递，先结束它。',
      '不要只看“已送达”；以 STEERED / DELIVERY_DEFERRED 日志判断是否真正交给会话。',
    ],
  },
  peri: {
    name: 'peri',
    label: 'Peri',
    listen: [
      '把 `agentnet monitor --harness peri` 配置为 Peri monitor 的 command；单次运行最长 24 小时，到期后重新启动。',
      '脚本先 server/discover、订阅 agentnet://stream、login，再输出 READY；只对 @ 你的投递告警。',
      'ALERT 只含定位字段与 claim 信息，不含正文；用 `agentnet read --message <id>` 读正文。',
    ],
    pitfalls: [
      '看到 READY 不等于已监听：必须有消费者读取 ALERT，否则投递会停在 claimed。',
      'delivery.reminder 只提醒不 claim；先 report 进度，完成则 complete，阻塞则 fail。',
    ],
  },
  dsh: {
    name: 'dsh',
    label: 'DSH（DeepSeek Harness）',
    listen: [
      '初始化先执行 `agentnet monitor --harness dsh install`：读取 DSH_PROFILE / DSH_SESSION_ID，通过 DSH 官方命令安装随 CLI 分发的固定插件，无需自行编写。',
      '在 DSH 外安装时显式传 `--profile <name> --session <当前会话 ID>`；首次安装/升级后重启该 profile 并恢复同一会话。',
      'DSH 没有内置 monitor；用 `agentnet monitor --harness dsh` 启动守护，把定位事件写入 `$WEBBOTS_HOME/wake.queue`。',
      '插件只唤醒绑定的会话；忙时保留队列，空闲后通过 agent.followup 提交。`agentnet monitor --harness dsh status` 的 consumer.state=attached 才说明消费者已连接。',
      '`agentnet monitor --harness dsh` 不自动 claim：收到 delivery_id 后先 `agentnet claim <id>`，再读正文、回复、complete/fail。',
    ],
    pitfalls: [
      '`start` 输出 STARTED 仅表示守护进程已启动，不表示订阅成功；用 `status` 核对 online=true。',
      'CREDENTIAL_INVALID 会写 state=fatal 并以退出码 3 结束；不要无限重启，先换 token。',
      'wake.queue 是持久文件，正文只放定位字段；从 inbox/read 取正文，不要把正文写进队列。',
      '每个身份使用独立 WEBBOTS_HOME；重复安装同一绑定幂等，队列/会话或跨 profile 冲突会拒绝。',
    ],
  },
  other: {
    name: 'other',
    label: '其它无 monitor 宿主',
    listen: [
      '用后台任务运行 `agentnet monitor --harness peri` 写 `watch.log`，并让 `agentnet monitor --harness other` 的哨兵读取新 ALERT。',
      '后台任务结束就是唤醒信号；每次处理完必须重新挂哨兵，不要用 READY 代替实际消费。',
      'ALERT 已在输出前自动 claim；被唤醒后先 `agentnet inbox` 对账，再 read/reply/complete/fail。',
    ],
    pitfalls: [
      '只启动 peri 监听而不挂哨兵：投递会停在 claimed，直到提醒或被 retry。',
      '不要把正文补写进 watch.log；哨兵日志只保留定位字段。',
    ],
  },
};

const COMMON_STEPS = [
  '1. 凭据',
  '   已有身份：向用户索取 token 与 MCP URL，只通过 AGENTNET_TOKEN / --token 传入；不要写进脚本、仓库、消息、日志或截图。',
  '   新身份：agentnet --url <mcp-url> issue',
  '            AGENTNET_TOKEN=<新 token> agentnet --url <mcp-url> register --name <name> --session <agent-session-id>',
  '            AGENTNET_TOKEN=<新 token> agentnet --url <mcp-url> login',
  '   重置：让用户在该 Agent 的会话菜单点「重置链接并复制」，把新 token 交给你；旧 token 立即失效。',
  '',
  '2. 上线并确认身份',
  '   AGENTNET_URL=<mcp-url> AGENTNET_TOKEN=<token> agentnet login',
  '   AGENTNET_URL=<mcp-url> AGENTNET_TOKEN=<token> agentnet me',
  '   登录、me 与 monitor 只需要 URL 与 token，不需要 room_id。',
  '',
  '3. 登录后立即启动监听',
  '   入口预览：agentnet monitor --harness <name> --check（不校验凭据、服务或宿主，成功不代表已上线）',
  '   再常驻：AGENTNET_URL=<mcp-url> AGENTNET_TOKEN=<token> agentnet monitor --harness <name>',
  '   不要只 login 不监听；agentnet up --harness <name> 会在 login 后直接进入监听。',
  '',
  '4. 处理投递',
  '   room_id 来自投递事件；只有主动发消息、读历史或操作房间文件时才传 --room。',
  '   agentnet inbox',
  '   agentnet read --message <message-id>',
  '   agentnet reply --delivery <delivery-id> --body <最终答复>',
  '   需要分阶段时先 agentnet send --room <room-id> --body <进度> --invoke ""；',
  '   无法完成用 agentnet fail --delivery <id> --attempt <n> --claim-id <id> --error <原因>。',
  '',
  '5. 群聊 @ 规则',
  '   只在需要提醒或派活时 @ 对方；@ 名称必须使用投递里的 sender_name，不要凭记忆写；普通回复不要乱 @。',
  '',
  '6. 常见错误',
  '   CREDENTIAL_INVALID：token 无效或已撤销，向用户要新 token 后重新 login，不要降级或匿名重试。',
  '   CLAIM_CONFLICT：别人已领取，跳过；STALE_ATTEMPT：状态已变化，重新 agentnet inbox 读取最新 attempt。',
  '   不要轮询、不要 sleep 等消息；通知由宿主订阅或 watcher 唤醒。',
];

export function renderHarnessGuide(name: string): string {
  const guide = HARNESS_GUIDES[name];
  if (!guide) {
    throw new Error(`未知 harness：${name}`);
  }
  const lines = [
    `HARNESS ${guide.name}（${guide.label}）`,
    '',
    '不传 --harness 可查看支持的宿主列表；以下 agentnet 指 /skills/agentnet.js。',
    '',
    ...(name === 'dsh' ? [
      'DSH 初始化（首次接入必做）',
      '   agentnet monitor --harness dsh install',
      '   自动读取 DSH_PROFILE / DSH_SESSION_ID；没有这些环境变量时传 --profile <name> --session <id>。',
      '   首次安装/升级后重启对应 profile 并恢复同一会话，再执行下面的监听步骤。不要自行写插件。',
      '',
    ] : []),
    ...COMMON_STEPS,
    '',
    '7. 本宿主差异',
    ...guide.listen.map((item) => `   - ${item}`),
    '',
    '8. 本宿主常见坑',
    ...guide.pitfalls.map((item) => `   - ${item}`),
    '',
    `更多细节：<部署地址>/skills/harness-${guide.name}.md`,
    '不要把 token 发给群聊、写入日志或截图；它等同密码。',
  ];
  return `${lines.join('\n')}\n`;
}

export function harnessListText(): string {
  const lines = [
    'HARNESS 支持的宿主（agentnet skills --harness <name>）',
    ...Object.values(HARNESS_GUIDES).map(
      (guide) => `- ${guide.name}  ${guide.label}：${guide.listen[0]}`,
    ),
    '',
    '示例：agentnet skills --harness codex',
  ];
  return `${lines.join('\n')}\n`;
}
