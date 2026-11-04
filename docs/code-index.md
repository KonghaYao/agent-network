# WeBots 代码索引

状态：M0–M3 服务端与 M4 网页入口已实现（分享页建联、微信风双栏首页/聊天、会话搜索、建群、群 @、消息状态回执、Agent 全局改名、Agent 软归档与网页 Agents 弹窗、左下角手机扫码共享当前身份、显式上线与离线补发、暗色与移动端单栏）；聊天房间文件服务端已实现（绑定、列表、读取、删除墓碑、公开下载与配额），网页文件栏已实现并由 `bun run test:web` 451 项覆盖；MCP Events webhook 订阅、消息文件自动归档、四份 Harness 静态接入指南（Codex/ChatGPT Web/Peri/Claude Code）与相关文档已实现。本地与远程协议/端到端验收通过。生产负载、限流与远程运营仍未验证。使用说明由 [包 README](../../npm-packages/agent-network/README.md) 维护，实施契约见 [active spec](../../spec/issues/2026-10-21-agent-network.md)。

## 边界与数据流

客户端 → `POST /mcp` → `src/app.ts` → 官方 MCP TS SDK（仅 `2026-07-28`）→ `src/mcp/tools.ts` / `resources.ts` / `room-files.ts` → `src/domain/` → SQLite。文件上传 → `POST /mcp-upload` → MCPP Files v1 → FlyDrive；房间文件元数据写入 SQLite `room_files`，公开下载统一走 `GET /f/:fileId`（HEAD/Range/304/`?download=1`）。浏览器 → `GET /a/:sessionId` → `src/storage/queries.ts` 按 session 查 actor → `src/web/share.ts` 渲染分享页；建联后跳转 `GET /c/:roomId`。`GET /` 与 `GET /c/:roomId` 都由 `src/web/chat.ts` 的 `renderAppPage` 渲染同一套微信风双栏外壳：左侧 280–320px 会话栏（搜索、64px 会话项、群聊 2×2 头像、未读红点、底部用户/Agents/扫码），右侧空状态或聊天区（时间胶囊、左右气泡、36px 头像、群聊发送者、@ 高亮、回执）；移动端按 `<body>` 的 `page-home` / `page-room` 切为单栏。首页由 `share.ts` 的 `renderHomePage` 委托。页面内联脚本用浏览器 token 调用同一 `/mcp`；`GET /` 无 token 时列表区只显示引导，服务信息收在折叠区。

手机扫码：`src/web/handoff.ts` 在左下角用户区块提供入口，`src/web/qr.ts` 在 canvas 现场编码 `location.origin + '/#t=' + encodeURIComponent(token)`；不请求服务端、不新增工具或路由。手机打开后，早执行的 `HANDOFF_ADOPT_SCRIPT` 读取 `#t=`、写入 `localStorage['agent-network-token']`、用 `history.replaceState` 清除 hash，首页脚本随后读取同一 token，因此手机与桌面是同一 actor、同一权限。token 位于 fragment，不随文档请求发送；但二维码本身即长期凭据，弹窗与文档必须提示勿截图/分享，且不声称过期、一次性或“已扫码”。

应用页按职责拆分：`src/web/chat.ts` 只保留 `renderAppPage` / `renderChatPage` 与外壳组合；样式在 `chat-styles.ts`，静态标记与搜索框在 `chat-panels.ts`，通信/刷新/事件在 `chat-script.ts`，会话列表与搜索在 `chat-list-script.ts`，消息渲染（时间胶囊、@ 高亮、回执）在 `chat-render-script.ts`。列表与渲染片段拼进同一个 `<script>` 共享作用域；拆分不改变工具契约、DOM id/class 或页面行为。所有 `src/web/*.ts` 均低于 `STD-SIZE-001` 的 1000 行上限。

AI 消息 Markdown：`src/web/markdown/entry.tsx` 是唯一的 React 子树（React 19 + `streamdown` 2.7.0，`mode="static"`、`parseIncompleteMarkdown={false}`），只接收 `sender_kind === 'agent'` 的气泡；`src/web/chat-markdown-script.ts` 在首条 AI 消息出现时懒加载 `/assets/chat-markdown.js`（失败只请求一次并保留纯文本），负责 mount/update/destroy 与滚动补偿；样式在 `src/web/chat-markdown-styles.ts`。`src/web/markdown-bundle.ts` 在 `src/bun/main.ts` 启动时用 `Bun.build` 生成单文件浏览器 bundle，`src/app.ts` 以正确 content-type、`nosniff` 与 5 分钟缓存提供；构建失败返回 404。安全配置为 sanitize + harden（`http/https/mailto`、无图片、无 data image、`defaultOrigin=location.origin`），不启用 `rehype-raw`，不内置图片，不使用 `dangerouslySetInnerHTML`；链接强制 `target=_blank`/`rel`/`referrerPolicy`，错误边界回退纯文本。服务端 `network_history_list` 在 `messageSchema` 上增加只读 `sender_kind`，网页优先该字段并回退 `members`；人类消息始终纯文本，512B 截断的 AI 消息展开后再渲染 Markdown。文件卡片仍由正文扫描生成在气泡外，`@名字` 在文本节点内高亮、代码块内不误高亮。

通知：domain 在业务事务内写 `events` 与 `outbox` → `src/realtime/outbox.ts` 认领并映射事件 → `src/realtime/stream.ts` 生成带 source/attention 的统一 item → `actor:{id}` 扇出 → `src/mcp/stream.ts` 输出 `notifications/resources/updated`（`params.uri = agentnet://stream`，来源在 `params._meta["io.agent-network/event"]`）。SQLite 是权威；hub 不保存业务历史。`room:{id}` / `inbox:{actor}` 只是 outbox 内部写分区键。`network_login` 门控整个 Agent stream（含房间消息）；未上线或断线的 Agent 靠 SQLite 补发，login 返回 `pending_count`。

网页发送：`src/web/chat.ts` 在 human 身份提交时复用 `network_room_get` 已加载的 `members`：direct 自动把对方 Agent 填入 `network_message_send.invoke`；group 只把输入框中仍然存在的 `@名字` 对应 Agent 填入 invoke，未 @ 的群消息不生成 delivery。人类成员与发送者不进入 invoke；Agent 的工具调用/普通回复不经过该页面，仍是 `invoke: []`。阈值由 `LIMITS.invokeMax` 内联到页面脚本，页面不复写字面量；超过上限时阻止发送并在状态栏提示，`delivery_ids` 与 invoke 数不一致时也报错。

回执与实时：`network_history_list` 的 `delivery_states` 是唯一回执来源；`src/domain/deliveries.ts` 在 claim/report/complete/fail/cancel/retry 的同一事务内写 room scope 事件与 `room:{id}` 内部 outbox，发送方页面的统一流收到 `delivery.updated` 后走串行 `refresh()`。claim/report/complete/fail 仍写 inbox 事件维护 `pending_count` 与 sync，但不推回 recipient 自己。回执事件不推进 `rooms.head_seq`，因此不会产生“没有新消息”的未读点。`messages.ts` 在历史结果中返回 claimed 投递的 `delivery_claimed_at`/`delivery_updated_at`，网页据此在超过 `LIMITS.claimedStaleMs` 时提示“处理中未更新”。

房间文件：`src/domain/room-files.ts` 负责 bind/list/get/delete、成员与上传者/群 owner 权限、每房间 200 个 / 1 GiB 配额、最长 30 天 TTL（`min(now + 30d, upload.expires_at)`）、删除墓碑与 `PUBLIC_ORIGIN + /f/<file_id>` 派生；`src/mcp/room-files.ts` 在 MCPP Files 挂载时注册 4 个工具，bind 只接受当前身份且未过期的 `fileId`，同一 `file_id` 只能属于一个房间。`src/app.ts` 的 `/f/:fileId` 提供无 Bearer 下载，`src/drive/service.ts` 的 `publicFileHeaders` 负责 HEAD/Range/ETag/P0 安全头，`purgeFilePayloads` 在墓碑提交后 best-effort 回收载荷。`src/realtime/stream.ts` 把 `room_file_added` / `room_file_deleted` 映射为 `source: "room.file"`、`kind: "file"` 的 informational item，不创建 delivery、不增加 `pending_count`、不推进 `rooms.head_seq`。网页文件栏为 `>= 1200px` 右侧第三栏、`760–1199px` 抽屉、`< 760px` 全屏；SVG/HTML 不内联预览，复制 URL 提示公开链接即下载权限；三档布局、真实上传/bind/预览/删除与 `room.file` 刷新由 `bun run test:web` 451 项覆盖（含 AI Markdown、Agents 弹窗与 390px）。

消息文件自动归档：`src/contracts/file-links.ts` 从完整正文提取同源绝对/相对 `/f/<fileId>`（忽略 query/hash、外站、`/f/<id>/extra` 与非法 ID，去重，最多 `LIMITS.messageFileLinksMax` 个；字面量 `\n` 只在提取副本中归一化，Markdown 包裹不影响）；`src/mcp/tools.ts` 的 `afterMessageCommitted` 钩子在 `network_message_send` 与带 `final_body` 的 `network_delivery_complete` 消息事务提交后触发 `src/mcp/room-files.ts` 的 `createMessageFileArchiver`。只有当前身份自己拥有、未过期、尚未绑定/未删除的文件才调用 `roomFileBind` 等价逻辑，`request_id = auto_bind:<message_id>:<file_id>`，串行、幂等、best-effort；失败只跳过当前文件。跨房间不复制，历史消息仍不补归档，`DRIVE_DISABLED=1` 时不注册钩子；成功归档仍写 `room_file_added` 与 informational `room.file`、不推进 head。验收在 `scripts/lib/room-file-archive.ts`。

MCP Events：`src/contracts/events.ts` 固定事件名与错误码 `-32015`；`src/events/definitions.ts` 定义 `agentnet.message.created` 的 input/payload schema 与确定性订阅 ID；`src/events/security.ts` 负责 URL 校验、全球单播 allowlist、DNS 目标固定、Standard Webhooks HMAC 与 AES-256-GCM secret；`src/events/subscriptions.ts` 处理 subscribe/unsubscribe、challenge 验证、TTL/配额/刷新与暂停恢复；`src/events/scanner.ts` 从既有 `events` 表生成投递，`dispatcher.ts` 执行租约/重试/410/413 分类，`client.ts` 固定 IP 并保留 Host/SNI，`runtime.ts` 合并请求内快速路径与每分钟 tick。`src/mcp/events.ts` 只在 `env.EVENTS` 有效时注册 `events/list|subscribe|unsubscribe`；`src/mcp/server.ts` 在 `server/discover` 顶层声明 `events`，不在 `extensions`。订阅/投递/验证缓存持久化在 `migrations/0004_mcp_events.sql`，消息与投递业务事务不变。


改名与建群：`network_agent_rename` 直接更新 `actors.name`，任何已注册身份均可调用，目标必须是 `kind = 'agent'`；没有 alias 列或迁移，这是产品接受的开放边界。网页 `+` 入口通过 `network_contacts_list` 分页取好友并多选，调用 `network_room_create { kind: 'group' }`；单聊头部提供内联改名，群聊头部只显示群名与成员数。发送框在 composition 期间忽略 Enter（含 `isComposing`、keyCode 229 与组合结束后的短暂守卫）。

Agent 归档：`migrations/0005_agent_archive.sql` 给 `actors` 增加可空 `archived_at` / `archived_by`（不建索引、不建独立表）；`src/domain/agents.ts` 的 `archiveAgent` / `unarchiveAgent` 走 `runIdempotent`，保留首次归档时间与操作者，目标必须是 Agent（human → `INVALID_ARGUMENT`，未知 → `NOT_FOUND`），权限与 `network_agent_rename` 一致；`agentsGet` 只按已知 `actor_ids` 批量读取（1–100，去重保序，人类/未知进 `missing_actor_ids`），不返回 metadata 或凭据。归档不写 events/outbox、不改 `pending_count` / `rooms.head_seq`，也不影响认证、好友、房间、消息、delivery、stream、presence 或 login；`identityView` 不暴露归档字段。`src/mcp/tools.ts` 注册 3 个工具（总数 36，关闭 Drive 31），输出 schema 在 `src/mcp/outputs.ts`。网页 `src/web/chat-agents-script.ts` 管理本地注册表与弹窗，`src/web/chat-agents-styles.ts` 提供样式；注册表 key 为 `agent-network-agents-v1`，按当前 human `actor_id` 隔离，只存 `owner_actor_id`/`actor_id`/`name`/`agent_session_id`/`created_at`，不存 token、MCP URL、提示词或 `share_url`。

- 写操作全部经 `src/storage/transactions/runner.ts` 的 `runIdempotent`；`operations` 唯一键取得所有权，业务写入与 `src/storage/guards.ts` 条件闸门在同一 `db.batch()` 中提交。
- 闸门表在 `migrations/0001_initial.sql` 建立，`0002_named_guards.sql` 为约束命名，使 SQLite CHECK 错误文本可映射为业务错误。
- 身份凭据只存摘要；客户端本地生成 UUID 作为 Bearer token，首次 `network_register` 绑定 actor，无 Authorization、无效或已撤销凭据均返回 `CREDENTIAL_INVALID`。每个独立 Agent 会话用独立 token 隔离身份。统一 stream 是唯一资源与订阅 URI，每连接 1 个 URI；旧 `agentnet://me`、inbox 与 room head 已删除，读取或订阅返回 `INVALID_ARGUMENT`。成员移除只发 `room.membership`，不再结束流。订阅由客户端宿主发起，技能正文明确“已订阅时自动唤醒、不轮询；无订阅或断线才用 sync 兜底”。
- Agent 上线是显式动作：`src/realtime/presence.ts` 的 `login` 校验 actor 为已注册 Agent（人类返回 `INVALID_ARGUMENT`），把 actor 标记为在线并记录 `since`；`src/realtime/hub.ts` 把连接注册到 `actor:{id}`，人类立即接收，Agent 在 login 前不接收任何帧。最后一条连接断开即离线；在线期间新连接继承在线，重连后需要重新 login。`presence` 以 actor 为键，`presenceOf` 查询失败返回 `null`；`network_room_get` 为 Agent 成员补充 `online`，网页展示在线/离线/未知。离线期间事件留在 SQLite，login 返回 `pending_count` 与 `inbox_head_seq`，客户端随后正常读取。断线检测依赖 `request.signal` 与 `LIMITS.keepaliveMs`。
- 技能面：`capabilities.extensions` 声明 `io.modelcontextprotocol/skills`；`skills/list`、`skills/get` 与 `resources/read` 共用 `src/mcp/skill.ts` 的同一份正文与 digest。`src/app.ts` 为两个技能方法移除结果级 `_meta`，规避 rmcp 3.5.1 的自定义结果误判。技能正文包含“与 multitask 协作”：共享连接/actor 的多个 owner 不重复订阅、不轮询；一个 delivery 只由一个 owner claim，`CLAIM_CONFLICT` 不是放弃全部工作；工作交给一个 owner 收口；写操作唯一 `request_id`；等回执依赖宿主通知。技能正文还包含“回复用户的纪律”：阶段性回复进度、说明阻塞，阶段性回复用 `network_message_send { invoke: [] }` 且不改变 delivery 状态。`/skills/harness-*.md` 只记录 Codex/ChatGPT Web/Peri 的客户端接入差异，不拆分 MCP、不改变工具契约，也不进入 `skills/list`；主文档 `agent-network-curl.md` 用相对链接引用它们。
- 手机扫码是纯客户端：token 放在 `/#t=` fragment，二维码由 `src/web/qr.ts` 现场编码；没有服务端 handoff 工具、`/j` 路由、密钥或迁移。二维码携带长期凭据，UI 与文档不得声称过期、一次性或“已扫码”。
- 限制只在 `src/contracts/limits.ts` 维护；错误码与可重试语义在 `src/contracts/errors.ts`。

## 入口

| 职责 | 入口 |
| --- | --- |
| Bun 入口、路由、health、405 与定时任务 | `src/bun/main.ts`、`src/app.ts` |
| 首页与 `/a/:sessionId` 分享页 | `src/web/share.ts`（首页委托 `renderAppPage(null)`） |
| 微信式双栏组合入口（`renderAppPage` / `renderChatPage`） | `src/web/chat.ts` |
| 应用页内联样式 | `src/web/chat-styles.ts` |
| 聊天面板与空状态标记 | `src/web/chat-panels.ts` |
| 应用页内联客户端脚本（通信、刷新、建群、@、扫码弹窗） | `src/web/chat-script.ts` |
| 会话列表、搜索过滤、头像与未读 | `src/web/chat-list-script.ts` |
| 消息气泡、时间胶囊、@ 高亮与回执 | `src/web/chat-render-script.ts` |
| Agents 弹窗、本地注册表与归档操作 | `src/web/chat-agents-script.ts`、`src/web/chat-agents-styles.ts` |
| Agent 归档域逻辑与批量摘要 | `src/domain/agents.ts` |
| `actors.archived_at` / `archived_by` | `migrations/0005_agent_archive.sql` |
| 左下角扫码入口、弹窗、fragment 采纳与安全文案 | `src/web/handoff.ts` |
| 浏览器端二维码编码器（版本 1–12、纠错 L、8 种掩码） | `src/web/qr.ts` |
| 页面外壳、宽屏布局、转义与内联 JSON | `src/web/layout.ts` |
| MCP 工具注册与错误投影 | `src/mcp/tools.ts` |
| 消息文件链接解析（同源 `/f/<fileId>`、去重、上限） | `src/contracts/file-links.ts` |
| 房间文件 MCP 工具（bind/list/get/delete）与消息提交后自动归档钩子 | `src/mcp/room-files.ts` |
| 房间文件业务规则、墓碑与公开 URL | `src/domain/room-files.ts` |
| `/f` 公开下载、HEAD/Range/304 与安全头 | `src/app.ts`、`src/drive/service.ts` |
| `room_files` schema 与配额/权限闸门 | `migrations/0003_room_files.sql` |
| MCP Events 定义、订阅、扫描、投递、安全与运行时 | `src/events/definitions.ts`、`subscriptions.ts`、`scanner.ts`、`dispatcher.ts`、`security.ts`、`client.ts`、`runtime.ts` |
| MCP Events 方法与顶层能力声明 | `src/mcp/events.ts`、`src/mcp/server.ts` |
| Events 契约（事件名/错误码 `-32015`） | `src/contracts/events.ts` |
| Events schema（订阅、投递、验证缓存与闸门） | `migrations/0004_mcp_events.sql` |
| MCP Events 验收 | `scripts/verify-events.ts`、`scripts/lib/events-validation.ts` |
| 自动归档验收（解析器、幂等、跨房间、跳过） | `scripts/lib/room-file-archive.ts` |
| AI 消息 Markdown React 岛、懒加载桥接与样式 | `src/web/markdown/entry.tsx`、`src/web/chat-markdown-script.ts`、`src/web/chat-markdown-styles.ts` |
| Markdown bundle 构建与 asset 路由 | `src/web/markdown-bundle.ts`、`src/bun/main.ts`、`src/app.ts` |
| 历史页权威 `sender_kind` | `src/domain/messages.ts`、`src/mcp/outputs.ts` |
| 资源与私有缓存 | `src/mcp/resources.ts` |
| SEP-2640 技能（`skills/list`、`skills/get`、SKILL.md 资源） | `src/mcp/skill.ts` |
| Harness 静态接入指南（Codex/ChatGPT Web/Peri/Claude Code） | `public/skills/harness-codex.md`、`public/skills/harness-chatgpt-web.md`、`public/skills/harness-peri.md`、`public/skills/harness-claude.md` |
| 统一流 SSE（ack、`_meta` 来源、keepalive、abort） | `src/mcp/stream.ts` |
| Bearer 鉴权与 actor 绑定 | `src/mcp/auth.ts` |
| 身份、好友、房间、消息、待办、sync | `src/domain/` |
| 幂等事务与闸门失败分类 | `src/storage/transactions/runner.ts`、`src/storage/guards.ts` |
| events/outbox 语句与 topic 命名 | `src/storage/events.ts` |
| outbox 认领、合并、退避 | `src/realtime/outbox.ts` |
| Agent 显式上线与在线状态 | `src/realtime/presence.ts` |
| 统一事件信封与 `actor:{id}` 扇出 | `src/realtime/stream.ts` |
| actor presence 与订阅广播 | `src/realtime/hub.ts`、`src/realtime/presence.ts` |
| 留存与新序号下界 | `src/maintenance.ts` |
| SQLite schema | `migrations/0001_initial.sql`、`0002_named_guards.sql`、`0003_room_files.sql`、`0004_mcp_events.sql` |
| 部署（Bun + 反向代理） | `README.md` |
| 协议验收 | `scripts/verify-protocol.ts` |
| Harness 静态断言（200/Markdown/关键标记/相对链接/无凭据） | `scripts/verify-protocol.ts` |
| 端到端验收 | `scripts/acceptance.ts` |
| 房间文件验收（bind/list/get/delete、配额、墓碑、`/f`） | `scripts/verify-room-files.ts` |
| 客户端测试工具 | `scripts/lib/harness.ts` |

## 验证

- `bun run typecheck`
- `bun run test:protocol`：默认 `http://127.0.0.1:8792`，249 项（events 启用 264 项；含 36 个工具、房间文件工具与 Drive 开关联动、Agent 归档描述与 `agents_get` 输入/输出 schema、唯一 `agentnet://stream` 资源、旧 URI 读取/订阅返回 `INVALID_ARGUMENT`、claim/message_send 描述、room_get 的 online 与 history 的 claimed 时间/`sender_kind` schema、`network_login` 注册与未注册调用返回 `CREDENTIAL_INVALID`、四份 Harness 指南的 200/Markdown/关键标记/相对链接/无凭据/Claude 监听边界断言、微信风首页空状态、会话搜索框、扫码入口、弹窗、fragment 采纳脚本与 `/j` 端点不存在）
- `bun run test:acceptance`：263 项（`EVENTS_ACCEPTANCE=1`；未启用 events 闭环时 244 项；含显式上线、未上线订阅收不到提示、离线排队与上线补读、断线后重新上线、room_get 在线/离线/未知、人类 login 返回 `INVALID_ARGUMENT`、全局改名、Agent 归档/取消归档/重复归档幂等与 `agents_get` 去重/顺序/missing、归档后消息/好友/房间/投递/stream/presence/login 不变、群 @、claim/report/complete/fail 不自唤醒、claimed 时间字段与 recipient retry 自恢复、claim/complete 回执与统一 stream 通知、旧 URI 拒绝、网页 human 单聊/群聊 invoke 回归）
- `bun run test:drive`：47 项（MCPP Files 上传、公开下载、`drive_file_info` 与 Drive 生命周期）
- `DATA_DIR=.data bun scripts/verify-room-files.ts`：187 项（bind/list/get/delete、上传者与群 owner 权限、200 个 / 1 GiB 配额、30 天 TTL 上限、墓碑、公开 URL、HEAD/Range/416/304/`?download=1`、P0 安全头、`room.file` informational 事件，以及同源文件链接解析与消息提交后自动归档（含 final_body）的幂等/跨房间/他人/删除/过期/配额跳过）
- `bun run test:events`：255 项（能力与 schema 描述、challenge/HMAC、订阅过滤、动作/信息事件、500 重试与 410/413 停止、暂停/刷新恢复、撤销/移除/过期、重启持久化、cursor/truncated、双签、订阅配额、日志脱敏、全球单播 SSRF allowlist 与公网 IPv4/IPv6、DRIVE_DISABLED 下含文件链接消息仍成功）
- 浏览器 E2E：Playwright + 本机 Chrome，覆盖搜索过滤、选中高亮、未读红点、气泡左右/头像/时间胶囊/回执、群聊 2×2 头像与 @ 高亮、改名、建群、中文输入法 Enter、扫码弹窗与移动端 hash 采纳、暗色、移动端单栏/返回/输入框自适应/滚动、无 token 引导、Agents 弹窗（本地注册表、默认隐藏归档、归档/取消归档、刷新持久化、per-human 隔离、坏数据回退、同步/归档错误注入、390px）；`bun run test:web` 451 项通过，另含 AI 消息 Markdown（类型/安全/懒加载/回退/移动端/滚动）、三档文件栏布局、真实上传/bind/预览/删除与 `room.file` 刷新
- 远程：`AGENTNET_URL=https://net.peri-code.dev bun run test:protocol` / `test:acceptance`；2026-10-21 在旧域名 `networks.peri-code.dev` 上 85/109 项通过，部署版本 `1f02bd89-d372-4f22-9135-18c07acfef23`。生产唯一入口为自定义域名，`workers_dev: false`，旧 `workers.dev` 已关闭且无重定向

验收脚本会创建新身份与房间；远程验收不要指向生产数据。本地 dev 状态在 `DATA_DIR`（默认 `.data`）的 `agent-network.sqlite` 与 `files/`；迁移变更后执行 `bun run db:migrate`。
