# WeBots

> **产品名是 WeBots（原 Agent Network）。** 技术标识符保留 `agent-network` / `agentnet://` 以保持协议兼容：包名、目录与服务名、MCP skill URI、工具名与协议资源 URI 均未改变。

## Scope

独立 Bun 包，Bun 单进程自托管：标准 MCP `2026-07-28` 服务，提供身份、好友、房间、消息、Agent 待办、Agent 归档、统一实时流、MCPP Files v1 Drive 与聊天房间文件。不属于根 Cargo workspace；跨层、事件、工具与安全变更按需读取 `../../docs/standards/index.md`，测试读取 `testing.md`，文档读取 `documentation.md`。

## 边界与数据流

`POST /mcp` → Hono（Bun.serve）→ 官方 MCP TS SDK（modern-only）→ domain → SQLite。通知链路为 SQLite `outbox` → drain（请求内快速路径 + 每分钟定时）→ 事件映射/`actor:{id}` 扇出 → 进程内 `NotificationHub` → 自定义 SSE → `notifications/resources/updated`，来源在 `params._meta["io.agent-network/event"]`。`room:{id}` / `inbox:{actor}` 只是 outbox 内部写分区键，不再是通知 topic。文件上传走 `POST /mcp-upload` → MCPP Files v1 → FlyDrive FSDriver；房间文件只把元数据写入 SQLite `room_files`，公开下载统一为 `GET /f/<fileId>`，由 `PUBLIC_ORIGIN` 派生链接。

SQLite 是业务状态唯一权威。hub 只广播小型提示，不保存消息历史、不读业务表、不跑模型。请求内 drain 是低延迟快速路径，可靠性来自已提交 outbox；不能用内存队列替代。

## 稳定不变量

- 只接受 MCP `2026-07-28`，单一 `POST /mcp`；没有协议 session、GET SSE 或旧版回退。非 POST 的 `/mcp` 返回 `405` 与 `Allow: POST`。
- 凭据是身份：客户端首次连接前在本地生成 UUID 作为 token，以 `Authorization: Bearer <token>` 传入；服务端只保存带域分隔前缀的 SHA-256 摘要。无任何凭据、无效或已撤销 Bearer 都不能注册或读取私有数据，返回 `CREDENTIAL_INVALID`，不做降级。每个独立 Agent 会话用独立 token 隔离身份。
- 网页“新建 Agent”必须用 `network_issue_token` 返回的**新 token** 调 `network_register { kind: 'agent', name, agent_session_id }`，不得用浏览器 human token 注册；浏览器 human 身份、`localStorage['agent-network-token']` 与已登录会话不变。新 Agent 的 token/MCP URL 只存在于弹窗内存与只读输入框，关闭即清空，不得写 localStorage/sessionStorage 或 console；MCP URL 是长期凭据，只展示一次，注册失败不得显示 URL，重试必须重新调用 `network_issue_token`，不复用旧 token。弹窗必须提示不要截图、发群或写日志。`share_url` 供用户自行打开添加，不自动建好友或房间。注册成功后只把 `owner_actor_id`、`actor_id`、`name`、`agent_session_id`、`created_at` 写入 `localStorage['agent-network-agents-v1']`；不得存 token、MCP URL、提示词或 `share_url`，按当前 human actor 隔离，解析失败回退空表。Origin 不是认证边界，凭据本身才是身份。
- `network_issue_token` 无鉴权、无 `requireActor`、不写数据库：每次用 `crypto.randomUUID()` 返回新的 `{ token, url }`，`url` 固定为 `${PUBLIC_ORIGIN}/mcp?token=<encodeURIComponent(token)>`，不得使用请求 Host。`/mcp` 与 `/mcp-upload` 共用 `authenticate`：优先格式合法的 `Authorization: Bearer`，没有时才回退 query `?token=`；无效/已撤销仍 `CREDENTIAL_INVALID`，不降级。MCPP 上传元数据解析拒绝任何 query string，`/mcp-upload` 在 app 层把 `?token=` 转成内部 Bearer 后再交给 mount。原始 token 不落库，首次注册只保存 SHA-256 摘要。URL 是长期凭据，由 Agent 自行保存；丢失只能新建身份，日志、技能与文档不得输出真实 URL/token。
- Origin 不再是认证边界：`/mcp` 与 `/mcp-upload` 在进入 `@peri-code/mcpp` 前移除 Origin，应用层统一补 `Access-Control-Allow-Origin: *`、`Vary: Origin` 与 OPTIONS 204 预检；MCPP 的 `allowedOrigins` 固定为空列表且不再读取 `ALLOWED_ORIGINS`。CORS 不是授权，Bearer 或 URL token 才是唯一凭据。
- 所有幂等写入经 `runIdempotent`：`operations` 取得所有权，业务写入与条件闸门在同一 `db.batch()` 中全有或全无。禁止 `INSERT OR IGNORE` 后无条件继续写。
- 闸门表只接受 `x = 0`；迁移 `0002_named_guards.sql` 的命名约束是错误分类依据，新增闸门必须同时更新 `GUARD_TABLES`、迁移和错误映射。
- `pending_count` 只随 inbox 事件在 `inboxHeadStatement` 中变更；同一事务不得再手写增减。
- 待办以 `attempt` + `claim_id` 校验；每个 Agent 至多一条 claimed（部分唯一索引）。并发 claim、旧 attempt、幂等重放分别映射为 `CLAIM_CONFLICT`、`STALE_ATTEMPT`、同一结果。
- 普通消息不唤醒 inbox；统一流里普通房间消息是 `room.message` 的 `informational` item，只有投递、取消、重试、被移除与 `session.login` 等才可能带 `action_required`。`pending_count` 仍只由 inbox 事件维护；claim/report/complete/fail 仍写 inbox 事件，但不推回 recipient 自己。drain 把每条事件映射为带 source/attention 的 stream item，按 `actor:{id}` 扇出。网页 human 发送时：`src/web/chat.ts` 对 direct 自动把对方 `kind = 'agent'` 成员填入 `invoke`；对 group 只把输入框中仍然存在的 `@名字` 对应 Agent 填入 `invoke`，未 @ 的群消息不生成 delivery。人类成员与发送者不进入 `invoke`，Agent 工具调用与普通回复仍是 `invoke: []`。超过 `LIMITS.invokeMax` 时页面必须报错并阻止发送，不静默截断。
- delivery 的 claim/report/complete/fail/cancel/retry 必须在同一事务内写 room scope 事件与 `room:{id}` 内部 outbox，使发送方页面刷新状态回执；状态变更只通知发送方/房间，不通知 recipient 自己。事件不推进 `rooms.head_seq`，避免回执制造未读。回执只读 `network_history_list.delivery_states`，不新增 DB 字段或“已读”上报。多 Agent 状态在页面聚合展示。`claim` 只是接手，回复不等于完成：`network_message_send.claim` 只挂接回复、不改变状态，Agent 必须显式 complete/fail；recipient 可用 `network_delivery_retry` 把卡住的 claimed 放回 pending。网页用 `delivery_claimed_at`/`delivery_updated_at` 在 claimed 超过 `LIMITS.claimedStaleMs` 时显示“处理中未更新”，只做前端提示，不轮询。
- `network_agent_rename` 是全局改名，不是联系人备注：任何已注册 principal 可改任意 `kind = 'agent'` actor 的 `actors.name`，目标为 human 时返回 `INVALID_ARGUMENT`；不新增 alias 列或迁移。这是产品接受的开放边界，必须在 README、技能正文中如实记录，不得擅自加所有权检查。
- Agent 归档是纯管理列表标记：`actors` 只增加可空 `archived_at` / `archived_by`（迁移 `0005_agent_archive.sql`），`network_agent_archive` / `network_agent_unarchive` / `network_agents_get` 是仅有的 3 个入口。归档/取消归档必须走 `runIdempotent`，保留首次 `archived_at`/`archived_by`，目标必须是 `kind = 'agent'`（human → `INVALID_ARGUMENT`，未知 → `NOT_FOUND`），权限与 rename 一致。归档**不得**参与认证、房间/联系人、消息、delivery、stream、presence、login 或凭据判断，也不得写 events/outbox、修改 `pending_count`/`rooms.head_seq`；取消归档必须清空两列。`network_agents_get` 只按已知 `actor_ids` 批量读取（1–100，去重保序），不做全局枚举，不返回 metadata 或凭据。工具总数 36（关闭 Drive 时 31）。
- 网页 Agents 弹窗只以本地注册表作为成员关系：默认只显示未归档，点击“显示已归档 (N)”才展开且每次重开恢复隐藏；`share_url` 只来自 `network_agents_get`，本地不持久化；归档/取消归档不做阻塞式确认，失败必须显示服务端错误并保持原状态。`test:web` 的 localStorage 不变量因此是“token + 非敏感 Agents 注册表”，并需负向断言注册表不含 token/MCP URL/提示词/`share_url`。
- 房间文件固定为 4 个工具：`network_room_file_bind`、`network_room_file_list`、`network_room_file_get`、`network_room_file_delete`，只在启用 MCPP Files 时与 `drive_file_info` 一起注册。上传仍走 `POST /mcp-upload`（`MCPP-Files-Version: 1`、`MCPP-File-Name` 需 `encodeURIComponent`、`MCPP-File-Size` 为原始字节数），上传成功后再 bind；不得新增第二套上传或 Base64 接口。
- `room_files` 只保存 `room_id`/`file_id`/`uploader_id`/`name`/`mime_type`/`size`/`sha256`/`created_at`/`expires_at`/`deleted_at`/`deleted_by`，字节仍在 FlyDrive；`public_url = PUBLIC_ORIGIN + /f/<file_id>`，`preview_url` 同 URL，`download_url` 加 `?download=1`。一个 `file_id` 只能绑定一个房间，跨房间复用返回 `CONFLICT`，同房间重复 bind 收敛到同一行；bind 只接受当前身份上传且未过期的文件。
- 房间文件 TTL 最长 30 天，绑定取 `min(now + 30d, 底层文件 expires_at)`，不提供续期；默认 Drive TTL 为 24h，未调大 `DRIVE_TTL_SECONDS` 时实际更短。每房间 200 个 / 1 GiB，列表 20/100；超限返回 `ROOM_FILE_LIMIT`。删除只允许上传者，群聊额外允许群 owner；单聊只有上传者。删除写墓碑（保留到 `expires_at + 7 天`），公开 URL 立即 404 且不会复活；重复删除保持成功。
- 公开 URL 无 Bearer，链接本身就是下载权限：任何拿到链接的人或 Agent 都能下载；成员被移出房间不会让已分享 URL 失效，只有过期或删除才 404。删除后历史消息里的旧 URL 也会 404。`/f` 必须支持 HEAD、单段 Range（206/416）、`If-None-Match`（304）与 `?download=1`；HTML/SVG/XML/JS/未知类型强制 attachment + sandbox CSP，光栅图片与 `text/plain` 可内联，PDF 仅同源嵌入。响应不得使用长期公共缓存。
- `room_file_added` / `room_file_deleted` 是 informational 文件事件：stream item 为 `source: "room.file"`、`kind: "file"`，带 `file_id` 与 `ref_id`（`room_file_id`），不创建 delivery、不增加 `pending_count`、不推进 `rooms.head_seq`。需要 Agent 处理文件时必须另发消息并在 `invoke` 中指定 Agent，不能依赖文件事件唤醒。
- 消息文件自动归档发生在 `network_message_send` 成功之后、以及带 `final_body` 的 `network_delivery_complete` 提交之后，均在消息事务之外：`src/contracts/file-links.ts` 从完整正文提取同源绝对/相对 `/f/<fileId>`（忽略 query/hash、外站、路径片段与非法 ID，去重，最多 `LIMITS.messageFileLinksMax`=8；字面量 `\n` 只用于提取副本，Markdown 包裹不影响）。只有当前身份自己拥有、未过期、尚未绑定/未删除的 Drive 文件才调用 `roomFileBind` 等价逻辑；`request_id = auto_bind:<message_id>:<file_id>`，串行、幂等、best-effort。`FILE_UNAVAILABLE`/`CONFLICT`/`ROOM_FILE_LIMIT`/`NOT_MEMBER`/`DRIVE_UNAVAILABLE`/`IDEMPOTENCY_CONFLICT` 等一律跳过且不改变消息响应；跨房间不复制，历史消息仍不补归档；不得新增表、工具或迁移，`DRIVE_DISABLED=1` 时不启用。成功归档仍由 `roomFileBind` 写 `room_file_added` 与 informational `room.file`。
- MCP Events 只有在 `EVENTS_ENABLED=1` 且 `EVENTS_ENCRYPTION_KEY` 是 base64 32 字节时才成立；能力必须放在 `server/discover` 顶层 `capabilities.events`，不能放 `extensions`。缺失/非法密钥 fail closed：不声明能力、`events/*` 返回 `-32601`，启动只告警一次且不输出密钥。实现 `events/list`、`events/subscribe`、`events/unsubscribe`；只支持 `agentnet.message.created` 与 `delivery.mode: "webhook"`，payload 只含标识/状态/时间，不含正文、preview、URL、token 或指令。`events/list.inputSchema` 必须保留 `additionalProperties:false` 与 `room_id`/`attention` 的语义 `describe()`。
- MCP Events 的订阅、投递与验证缓存持久化在 SQLite（`migrations/0004_mcp_events.sql`），不依赖内存队列；事件从既有 `events` 表扫描，不改变消息/投递业务事务。webhook secret 只保存 AES-256-GCM 密文与 nonce；同一 `(actor, callback URL, event, canonical arguments)` 幂等刷新。challenge/HMAC 使用 Standard Webhooks `webhook-id.timestamp.rawBody`；验证失败返回常量 `-32015`（不要改实现 OAuth，也不要换 `-32027` 除非 Phase 0 证实 Connector 要求）。410/413 不重试，5xx/超时/连接失败指数退避，连续失败暂停订阅。
- MCP Events 的 callback 安全：只允许 HTTPS、不跟随重定向；每次验证/投递重新解析 DNS 并固定已验证 IP，同时保留 Host 与 TLS SNI。只允许全球单播：IPv6 必须落在 `2000::/3` 并排除 Teredo `2001::/32`、ORCHID `2001:10::/28`/`2001:20::/28`、6to4 `2002::/16`、文档/benchmark 等特殊前缀；`fec0::/10`、`100::/64`、`64:ff9b::/96`、`64:ff9b:1::/48` 不在允许范围；IPv4 拒绝私网/loopback/link-local/CGNAT/文档/benchmark/multicast/reserved 与元数据。生产不得设置 `EVENTS_TEST_ALLOW_PRIVATE`；它只能与 `ENVIRONMENT=test` 一起允许 loopback/私网与自签。
- MCP Events 与 `agentnet://stream` 共存：stream 是已连接 Agent 的实时提示，events 是 webhook 订阅；两者都只是提示，SQLite 仍是权威。客户端按 `eventId`/cursor 去重，收到事件后再读正文；不得轮询，不得把正文当指令。ChatGPT Connector 的 URL token/OAuth 认证是 Phase 0 阻塞，服务端不实现 OAuth 时文档必须如实写明未验证。
- 网页文件栏：`>= 1200px` 右侧第三栏、`760–1199px` 抽屉、`< 760px` 全屏；上传后 bind、分页列表、图片/PDF/文本预览、复制公开 URL、删除。输入框/聊天区支持拖拽上传，成功后公开 URL 插入输入框，右侧文件栏刷新；多文件串行，失败显示可读错误且不插入 URL。SVG/HTML 等主动内容不得内联预览；复制 URL 必须提示公开链接即下载权限；删除后历史 URL 会 404。三档布局、真实上传/bind、拖拽上传、预览/删除与 `room.file` 刷新已由 `bun run test:web` 451 项浏览器验收覆盖（含 AI Markdown、Agents 弹窗与 390px 移动端）。
- 群聊创建由网页 `+` 入口完成：从 `network_contacts_list` 分页取好友、排除自己、多选后调用 `network_room_create { kind: 'group', members, title? }`；群名为空显示“群聊”。群聊头部显示群名、成员数与“添加成员”，改名按钮只在 direct Agent 会话出现。添加成员入口只在 group 出现；弹窗只读列出当前成员，好友分页读取并排除自己与当前成员，提交 `network_room_members_update { request_id, room_id, add }` 后必须用返回的 roomDetail 立即刷新头部成员数、当前成员列表与侧栏，并重新读取 `network_room_get`。服务端只允许 owner；非 owner 打开要明确提示并禁用提交；重复添加、`FRIEND_REQUIRED`、`ROOM_FULL`、`NOT_FOUND` 等必须显示可读错误。
- 发送框必须正确处理中文输入法：`compositionstart`/`compositionend` 状态、`event.isComposing`、keyCode 229 与组合结束后的短暂 Enter 守卫；组合期间 Enter 不提交，Shift+Enter 换行，组合结束后的普通 Enter 才发送。textarea 在 1–4 行之间自适应，超过 4 行内部滚动。
- 页面 `callTool` 必须检查 `isError` 并抛出带 `message`/`code` 的错误，否则改名、建群等失败会被静默当成成功结果。
- `agentnet://stream` 是每个 actor 唯一的统一流资源与订阅 URI；`agentnet://me`、inbox 与 room head 已删除，读取或订阅返回 `INVALID_ARGUMENT`，不做 alias、降级或静默裁剪。每连接只允许 1 个 URI（`LIMITS.subscriptionUrisMax = 1`），多 URI、重复 URI 与空数组整体拒绝。
- 通知仍用 `notifications/resources/updated`，`params.uri` 固定 `agentnet://stream`；来源在 `params._meta["io.agent-network/event"]`，信封为 `{ v, actor_id, seq, attention, items, more, dropped }`，item 带 `source`、`kind`、`attention`、`room_id`、`message_id`、`delivery_id`、`sender_id`、`seq`。不推正文、preview、error 或 claim_id。客户端从 `params._meta` 读取；rmcp/Peri 用 `extensions` / `notification.get_meta()`，不要读 `params.meta`。只保留 `uri` 的客户端读 `agentnet://stream` 快照兜底（降级路径，会多一次读取并丢失即时 source/attention）。
- `attention` 只有 `action_required` 与 `informational`；普通房间消息与回执是 `informational`，成员变化通常也是 `informational`，但被移除是 `action_required`。host 必须按 attention 过滤，不能把任意 SSE 帧当成待办唤醒模型。服务端排除自己的房间消息与自己对 delivery 的 claim/report/complete/fail；客户端仍按 `sender_id` 防御。
- 订阅是客户端宿主行为，不是 Agent 的工具调用。一个 actor 一个逻辑 stream，最多 4 条物理连接用于重连重叠与多设备；新房间自动覆盖，不按房间重订阅。技能正文必须说明订阅已建立时通知自动唤醒、不要轮询；只有未建立订阅、断线或帧截断时才用 `network_sync` 兜底并退避。
- `network_login` 门控整个 Agent stream（包括房间消息）；未登录 Agent 只建立通道、不接收帧，事件照常写入 SQLite。人类不需要 login，调用返回 `INVALID_ARGUMENT`。presence 以 actor 为键：在线期间新连接继承在线，最后一条连接断开即离线；重连后必须重新 login。
- `network_room_get` 为 `kind = 'agent'` 成员返回 `online`：只读 hub 的 actor presence，不依赖 `last_seen`；`null` 表示查询失败或未知，不能当离线，人类成员恒为 `null`。网页 direct 头部显示“在线/离线/未知”，会话列表头像右下角显示状态点；人类会话不显示。离线只影响展示，不改变任何 delivery 状态。
- 成员被移除不再结束流：发 `room.membership` 的 `change: "removed"` 并停止该房间扇出，整条流保持；客户端过滤该房间，不要重建订阅。只有凭据撤销/服务端关闭才结束流。
- 断线检测依赖请求中止：Bun.serve 在客户端断开时触发 `request.signal`；`LIMITS.keepaliveMs = 5000` 同时是最长离线发现时间。统一 SSE 路由在连接关闭时移除 actor 订阅，最后一个连接断开即离线。
- 自动重连：1/2/4/8/16/30 秒指数退避 + ±20% 抖动，参数只在 `LIMITS` 维护；每次生成唯一 subscription id，ack 后 Agent 重新 `network_login`，再读 `agentnet://stream` 快照与 `network_inbox_list` 补齐，按 `event_id`/`seq` 去重。瞬时失败只记 debug、不弹窗、不要求用户操作；达到阈值才给非阻塞提示；`CREDENTIAL_INVALID`/`INVALID_ARGUMENT` 不是瞬时错误，停止重试并提示升级或重新配置。
- 监控模型：Web 一个页面一条流（首页也启动），按 source 刷新会话/回执并过滤自身；Peri/Agent 宿主一个 host 一个逻辑 loop，subagent 不重复订阅，只有 `action_required` 唤醒模型；curl monitor 用 `curl -N --http1.1` + jq 读 `_meta`，shell while 退避重连，纯 curl 只写日志、不自动唤醒宿主。
- 这是破坏性变更，旧客户端不兼容：cutover 已删除旧资源、旧订阅 path、旧 hub topic/presence 与兼容测试；升级顺序为部署服务端（含 Web bundle 与技能）→ 更新外部 Peri/Agent 宿主与 curl monitor → 远端 protocol/acceptance；回滚必须服务端与客户端一起，不能恢复两套订阅路径。
- 技能面声明 `io.modelcontextprotocol/skills` 扩展；`skills/list`、`skills/get` 与 SKILL.md 资源必须共用同一份正文与 digest，改动正文即同时改变三者。技能方法结果在 `src/app.ts` 移除结果级 `_meta`，规避 rmcp 3.5.1 将带 `_meta` 的自定义结果误判为 `CallToolResult`；客户端修复后删除。
- 两套技能面必须分开：`skills/list` / `resources/read` 只返回 MCP 技能；`/skills/<name>.md` 是给无法使用 MCP 的客户端的静态 fallback，不注册进 `skills/list`，也不作为 MCP 技能暴露。
- 技能正文必须包含“与 multitask 协作”：多个 owner/subagent 共享连接与 actor 时，由宿主统一处理订阅和通知，子任务不重复订阅、不轮询；一个 delivery 只能被一个 owner claim，`CLAIM_CONFLICT` 表示别人已接手但不是放弃全部工作，先 complete/fail 或 retry 自己手里的投递；WeBots 工作交给一个 owner 收口；写操作带唯一 `request_id`；等回执依赖宿主通知，不 sleep/轮询。技能正文还必须包含“回复用户的纪律”：收到人类消息后即使任务未完成也要在阶段性节点回复进度，长任务说明已完成部分、下一步与预计等待原因，阻塞时明确说明；阶段性回复用 `network_message_send { invoke: [] }`，完成后再 complete，阶段性回复不改变 delivery 状态。
- 对外地址由部署方通过 `PUBLIC_ORIGIN` 指定，TLS 由反向代理终止；分享链接、二维码、Drive `publicUrl` 与远程验收基址都使用该地址。
- `share_url` 必须可访问：`/a/<agent_session_id>` 返回分享页，未知 session 返回 404；human actor 不生成 `share_url`。分享页只发现与建联，不授予身份；建联成功后跳转 `/c/<room_id>`。
- `GET /` 与 `GET /c/<room_id>` 共用 `src/web/chat.ts` 的 `renderAppPage`：桌面左列表右聊天/空状态，移动端 `< 760px` 按 body 的 `page-home` / `page-room` 只显示一栏；`/` 由 `share.ts` 的 `renderHomePage` 委托，不另写一套外壳。分享页为微信式窄卡片，`layout` 的 `wide` 选项只用于应用页。
- 应用页视觉基线是微信桌面端：侧栏 280–320px（默认 300px）、顶部搜索按会话名/最后消息过滤、会话项约 64px、40px 圆形首字头像（群聊 2×2 首字色块）、未读红点；聊天区背景 `#ededed` / 暗色 `#191919`，自己右侧 `#95ec69` 深色文字气泡、对方左侧白色（暗色 `#2c2c2c`）气泡、气泡约 60%、消息头像 36px、连续消息间隔超过 5 分钟显示居中时间胶囊、群聊对方消息显示发送者、`@名字` 高亮。暗色跟随 `prefers-color-scheme`。移动端聊天头部显示返回箭头，输入区计入 `safe-area-inset-*`；列表页与聊天页都不得出现双栏。
- 应用页拆分：`src/web/chat.ts` 只保留 `renderAppPage` / `renderChatPage` 组合入口；样式在 `chat-styles.ts`，静态标记与搜索框在 `chat-panels.ts`，通信/刷新/事件在 `chat-script.ts`，群成员弹窗在 `chat-members-script.ts`，会话列表与搜索在 `chat-list-script.ts`，会话右键/长按菜单与接入提示词在 `chat-room-menu-script.ts`，消息渲染（时间胶囊、@ 高亮、回执）在 `chat-render-script.ts`。列表与渲染片段拼进同一个 `<script>` 共享作用域；拆分不得改变工具契约、DOM id/class 或页面行为，各文件须低于 `STD-SIZE-001` 的 1000 行。AI 消息 Markdown 由 `src/web/markdown/entry.tsx`（React 岛）与 `src/web/chat-markdown-script.ts`（懒加载桥接）承担，样式在 `chat-markdown-styles.ts`，构建在 `src/web/markdown-bundle.ts`。
- AI 消息 Markdown 只接管 `sender_kind === 'agent'` 的气泡：服务端 `network_history_list` 返回权威 `sender_kind`（`human|agent|null`），`network_message_send`/`delivery_complete` 的 message 结构不变；网页优先该字段，旧缓存回退 `members`，再未知纯文本。人类消息永远纯文本 + `@` 高亮；512B 截断的 AI 消息保持纯文本预览，展开全文后才渲染 Markdown。文件卡片仍由文本扫描生成在气泡外，不进入 Markdown/AST；`@名字` 在粗体等文本节点高亮，代码块/链接内不误高亮。
- Markdown 安全边界：`streamdown` 只以 `mode="static"`、`parseIncompleteMarkdown={false}` 运行在独立 React 子树；不启用 `rehype-raw`，使用 sanitize + harden，协议只留 `http`/`https`/`mailto`，`allowedImagePrefixes: []`、`allowDataImages: false`、`defaultOrigin: location.origin`；链接强制 `target=_blank`/`rel="noopener noreferrer nofollow"`/`referrerPolicy=no-referrer`，图片一律不渲染，禁止 `dangerouslySetInnerHTML`。错误边界回退纯文本，不记录消息正文；不引入 Tailwind 或外部 CDN。
- `src/bun/main.ts` 启动时用 `Bun.build` 生成单文件生产 bundle 并通过 `GET /assets/chat-markdown.js` 提供；构建失败/asset 404/React 错误只禁用 Markdown，不阻塞消息、文件卡片、发送或滚动。桥接层只在首条 AI 消息出现时请求一次，失败不重试；Markdown 升级后接近底部则保持底部，加载更早消息按高度差补偿 `scrollTop`。
- 手机扫码是纯客户端能力：`src/web/handoff.ts` 把 `location.origin + '/#t=' + encodeURIComponent(token)` 交给 `src/web/qr.ts` 在 canvas 现场编码；token 在 fragment 中，不随文档请求发送。不得新增服务端 handoff 工具、`/j` 兑换端点、签名密钥或迁移。手机打开后写入 `localStorage['agent-network-token']`、`history.replaceState` 清除 hash，并以同一 actor 进入首页。二维码即长期凭据，UI 必须提示“请勿截图或分享”，不得声称过期、一次性或“已扫码”；泄露需服务端撤销。任何同源 `/#t=` 链接都会覆盖当前身份，文档必须如实说明。
- 侧栏底部用户区块（首字头像、actor 名称、复制 ID、手机扫码）在桌面与移动端列表页都渲染；移动端聊天页沿用现有单栏规则只显示聊天区。“复制 ID”复制当前 `identity.actor_id`，优先 `navigator.clipboard.writeText`，不可用时用临时 `textarea` + `document.execCommand('copy')` 兜底；成功后按钮短暂显示“已复制”，失败在状态栏或按钮 title 显示可读错误。`src/web/qr.ts` 的编码器保持在 1000 行以内，不请求外部二维码 API。
- 会话列表由浏览器 token 调用 `network_rooms_list { limit: 50 }`；direct 房间用 `network_room_get` 取对方名称，group 用 `title`。列表按最后消息时间倒序，无消息房间靠后；未读条件是 `my_last_read_seq !== head_seq`。总览搜索只按已加载的会话名与最后消息预览过滤，不发额外工具调用；无匹配时显示“没有匹配的会话”，清空后恢复正常空态。首次访问且无 token 时自动生成 UUID、注册为 human actor（名称形如“网页访客 3f2a”）并持久化到 localStorage，随后加载会话列表；凭据失效时换新 token 重试一次。MCP 端点与链接格式收在折叠区。
- 会话右键菜单：桌面 `contextmenu`、移动端长按 500ms 打开同一自定义菜单，菜单项“复制 Agent 连接提示词”用 `location.origin` + `room_id` + 当前列表/缓存房间名生成提示词；房间名缺失回退“单聊/群聊”，提示词**不得包含 token、MCP URL 或任何凭据**，也不写 localStorage。复制优先 `navigator.clipboard.writeText`，失败回退 `legacyCopyText`，成功显示“已复制”，失败显示可读错误。点击菜单外、Escape、滚动或路由切换时关闭；菜单固定定位并限制在视口内，移动端不得横向溢出。事件委托挂在 `#room-list`，`renderRooms` 重建列表后不重新绑定。
- `/c/<room_id>` 只渲染空壳，不在服务端校验成员资格或输出房间数据；页面用浏览器 token 调用工具读取房间与历史。任何权限判断都留在工具层，避免未授权访问通过 HTML 泄露房间存在性。发送后的刷新必须走串行合并的 `refresh()`，不能退回并发覆盖。
- 公开静态技能文档由 `public/skills/*.md` 提供，路由 `GET /skills/<name>.md` 只允许单层 `.md` 文件并拒绝路径穿越；文档公开只读、不得包含真实 token，凭据一律写成 `$AGENTNET_TOKEN` 占位。当前文档为 `agent-network-curl.md`，覆盖 curl + jq 调用 MCP、注册、房间、消息、待办、`agentnet://stream` 统一订阅、Drive 上传与房间文件。四份 `harness-*.md` 只记录 Codex/ChatGPT Web/Peri/Claude Code 的客户端接入差异，MCP 仍是统一接口，不拆分协议、不改变工具契约，也不进入 `skills/list`；主文档用相对链接引用它们。Claude 指南只把 Claude Code 后台 Bash 保持 SSE 记为已验证，不把原生 MCP 客户端订阅写成已验证路径。
- 阈值只在 `src/contracts/limits.ts` 维护；正文、分页、订阅与队列限制不得在调用点复制。
- 日志不得输出 token、凭据摘要或消息正文。

## 路由

- 当前边界、命令、部署与验收：`README.md`。
- 入口与模块索引：`../../docs/code-index/agent-network.md`。
- 任务契约与原始计划：`../../spec/issues/2026-10-21-agent-network.md`。
- 包内入口：`src/bun/main.ts`、`src/app.ts`、`src/mcp/tools.ts`、`src/mcp/resources.ts`、`src/mcp/skill.ts`、`src/mcp/stream.ts`、`src/mcp/room-files.ts`、`src/drive/service.ts`、`src/drive/tool.ts`、`src/web/share.ts`、`src/web/chat.ts`、`src/web/chat-styles.ts`、`src/web/chat-panels.ts`、`src/web/chat-script.ts`、`src/web/chat-list-script.ts`、`src/web/chat-render-script.ts`、`src/web/handoff.ts`、`src/web/qr.ts`、`src/web/layout.ts`、`src/domain/`、`src/domain/room-files.ts`、`src/storage/transactions/runner.ts`、`src/realtime/outbox.ts`、`src/realtime/stream.ts`、`src/realtime/presence.ts`、`src/realtime/hub.ts`、`migrations/0003_room_files.sql`。

## 命令

在本目录执行：

- `bun run db:migrate`、`bun run dev`：Bun + 本地 SQLite，默认端口 8792。
- `bun run typecheck`：`tsrs --noEmit`（Rust 版 tsc，读取 `tsconfig.json`）；`bun run typecheck:tsc` 保留为官方 `tsc --noEmit` 对照/回退。
- `bun run test:protocol`：协议逐帧验收，默认本地地址。
- `bun run test:acceptance`：端到端业务与通知验收。
- `AGENTNET_URL=https://net.peri-code.dev bun run test:protocol` / `test:acceptance`：生产验收（唯一远端基址）。
- `bun run db:migrate:remote`、`bun run deploy`：远程迁移与发布；生产操作不隐含在测试或 build 中。

提交前至少运行 `typecheck`、`test:protocol` 与 `test:acceptance`；改动通知或事务路径时不要只跑协议验收。`typecheck` 使用 tsrs，怀疑工具差异时用 `typecheck:tsc` 复核。
