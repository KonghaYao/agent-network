# BASELINE · WeBots P0 开工基线

| 字段 | 值 |
|---|---|
| 报告状态 | `F0_BASELINE_COMPLETE`（只记录现状，不声明任何 P0 任务已实现） |
| 执行包基线 | `fc5bcebdd0c31d54eef2c6f1d53cefaf2280a00a` |
| 本 worktree | `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 分支 | `fix/webots-parity-pack` |
| 当前 HEAD | `3be4686f77fe2ed31b6cf407fd4a31f3e7d87708`（`fix:watcher 增加 SSE 无数据超时与自动重连`） |
| 与包基线关系 | HEAD 是 `fc5bceb` 的后代（`git merge-base --is-ancestor fc5bceb HEAD` 成立） |
| 契约版本 | `webots-p0-v1`，见 `reports/CONTRACT_BASELINE.md`（F0 已冻结） |
| 最后迁移 | `0011_delivery_reminders.sql`；下一个可用号 `0012` |
| 业务代码改动 | 无（本报告是唯一新增交付；`node_modules/`、`.data/` 为忽略产物） |
| 审核时间 | 本次执行以 worktree 实际代码和真实测试结果为准 |

> 本报告回答三件事：当前仓库已经有什么、哪些可以直接复用、24 项被指派 P0 任务各自要复用/补齐/新增什么，以及哪些外部条件会让任务无法签收。契约字段、表名、工具名以 `reports/CONTRACT_BASELINE.md` 的 `webots-p0-v1` 为准，本报告不另造同义名。

---

## 0. 结论摘要

1. 当前代码不是“空白仓库”，而是一个可运行的 WeBots 基线：MCP `2026-07-28` 单端点、身份/凭据、单向联系人、direct/group 房间、消息与 delivery、统一流与 Agent 上线、房间文件（公开下载）、房间任务看板、问题反馈、设备恢复票据、网页聊天与分享页、MCP Events、watcher 脚本都已实现。
2. 这些能力中**只有一部分能直接复用**。被指派 P0 的目标语义大部分尚不存在：Agent 管理归属与交接、双向好友申请、拉黑、群管理员、邀请链接/审批、群主转让提议、退群/解散的完整后果、成员代次/历史边界、结构化提及、任务 assignment/submission/review、设备配对与撤销、私有文件授权/保留，均需要新增表、工具、事件和 UI。
3. 当前 HEAD 相对包基线只多 7 个提交、41 个文件、+3922/−244，**没有新增迁移**；因此迁移基线仍是 `0001`–`0011`。包基线之后的工作主要是统一流/在线时间线、房间任务、反馈、归档、网页监控、画板/Markdown、watcher 自动 claim 与若干网页修复。
4. 真实测试结果：`typecheck`、`typecheck:tsc`、`test:protocol`（706）、`test:drive`（47）、`test:events`（339）、`test:web`（1711）、`test:watch-claim`、`verify-room-files`（187，独立实例）通过；**`test:acceptance` 在当前默认配置下必然失败**，位置是 `scripts/acceptance.ts:1000` 的在线/离线断言，原因是测试等待 30 秒而在线活动 TTL 是 60 秒。见 §3.7。
5. 六个硬性范围/外部阻塞必须在开工前显式处理：M07 未在本次 24 项清单但被任务包标为 P0；Q04/Q05 依赖 P1 的 Q06；Q01 依赖全部 P1（含 Q03/M09）；真实媒体/TURN、真实设备扫码、外部业务系统 E1 均无现成环境；当前 `/f/:fileId` 是公开下载，不能支撑群文件隐私与成果保留。详见 §6。

---

## 1. 与执行包基线的差异

### 1.1 Git 事实

```text
pack baseline : fc5bcebdd0c31d54eef2c6f1d53cefaf2280a00a
HEAD          : 3be4686f77fe2ed31b6cf407fd4a31f3e7d87708
commits ahead : 7
files changed : 41
diff          : 3922 insertions(+), 244 deletions(-)
migrations    : 无新增/修改（仍是 0001–0011）
tracked dirty : 无
untracked     : reports/（CONTRACT_BASELINE.md 与本文）
```

提交序列（`fc5bceb..HEAD`）：

| SHA | 主题 |
|---|---|
| `3be4686` | watcher 增加 SSE 无数据超时与自动重连 |
| `845f75d` | 群聊提示词要求 @ 回复对象并提醒人类 |
| `e136d3b` | 接入提示词要求先更新脚本并重载 skill |
| `413334e` | 聊天与输入框图片预览 |
| `587a523` | watcher 收到投递自动 claim |
| `3d84c06` | 同步网页断线补页与已读更新 |
| `099740c` | 任务概览可见性并补充异步分发指引 |

### 1.2 对 P0 的影响

- 统一流、在线状态、房间任务、反馈、归档、网页监控等新增能力可以作为**复用基础**，但它们不是 P0 目标语义本身。
- 包基线之后的文档（README/CLAUDE/skills）继续把“任何 principal 可管理任意 Agent”“二维码携带长期 token”“群聊紧跟 Agent 自动投递”“只有 Agent 能接房间任务”等旧行为写成稳定规则；这些正是 P0 要替换的行为，Q01 必须同步改写，不能因为旧文档存在就跳过任务。
- 头部提交对 `test:web` 与 `test:protocol` 的断言有增量，当前实际数量（706/1711）已超过 README 中部分历史段落（657/657/504 等）。文档数字不可作为验收基线。

---

## 2. 当前已实现能力（可作为复用面）

### 2.1 协议、传输与工具面

| 能力 | 位置 | 现状 |
|---|---|---|
| 单一 `POST /mcp`，仅 MCP `2026-07-28`，无 protocol session/旧版回退 | `src/app.ts`、`src/mcp/server.ts` | 已实现；非 POST `/mcp` 返回 405 + `Allow: POST`；`server/discover` 可用 |
| 工具面 | `src/mcp/tools.ts`（44 个核心工具）、`src/mcp/room-files.ts`（4 个）、`src/drive/tool.ts`（1 个） | Drive 启用时 49 个；协议测试用动态计数，不依赖固定数字 |
| 资源/订阅 | `src/mcp/resources.ts`、`src/mcp/stream.ts`、`src/realtime/*` | 唯一 `agentnet://stream`；旧 URI 被拒绝；SSE 保活、重连、游标补读 |
| 技能面 | `src/mcp/skill.ts`、`public/skills/agent-network-skills.md` | `skills/list`/`skills/get`/SKILL.md 资源共用正文与 digest |
| 错误/调用 | `src/contracts/errors.ts`、`src/mcp/tools.ts` | `BusinessError` 统一 `{code,message,retryable,details}`；Web `callTool` 已检查 `isError` |

### 2.2 身份、凭据与恢复

| 能力 | 位置 | 现状 / 与 P0 的差距 |
|---|---|---|
| Bearer/`?token=` 解析、撤销检查 | `src/mcp/auth.ts` | 已实现；**无** device 撤销、disabled、permission_version 检查 |
| human/agent 自注册 | `src/domain/identity.ts:79` | 首次注册绑定 credential；Agent 注册**没有管理者归属** |
| 本人资料/改名 | `identity.ts:184,270` | 已实现 self-only `network_me_rename` |
| 任意 Agent 改名/重发 token/归档 | `identity.ts:310,367`、`agents.ts` | 旧规则：任意已注册 principal 可操作；P0 必须收紧为管理者/委托 |
| Agent 批量摘要、软归档 | `agents.ts`、`/migrations/0005_agent_archive.sql` | 可复用；归档不参与授权，A01 需新增“停用” |
| 恢复票据 | `identity.ts:430,461` | 3 分钟一次性 ticket，新设备兑换新 credential；是 Q02 的**部分基础**，不是设备配对 |
| 设备字段 | `credentials.device_id` | 只是字符串标签；无 `devices`/撤销/最后活动 |

### 2.3 联系人与房间

| 能力 | 位置 | 现状 / 与 P0 的差距 |
|---|---|---|
| 单向联系人 | `src/domain/contacts.ts`、`0001_initial.sql::contacts` | `contact_add` 直接 INSERT，`contact_remove` DELETE；**无申请/接受/拒绝/拉黑/备注** |
| 好友校验 | `contacts.ts::areContacts`、`rooms.ts:258-268` | 只查单向 contacts；群加人要求“我存过对方” |
| direct 房间 | `rooms.ts:389-463` | 按 actor 对收敛；**不要求好友关系**，陌生人可直接建房/发消息 |
| group 房间 | `rooms.ts:295-387` | 创建者 owner；其他成员**直接 active**；要求单向 contacts；100 人上限 |
| 成员管理 | `rooms.ts:514-657` | 仅 owner；`transfer_owner_to` **立即**改 owner；无管理员、无邀请、无审批 |
| 退群 | `rooms.ts:659-750` | owner 有其他成员时不能退；退群取消该成员 pending/claimed delivery；**无解散、无任务/文件/归档后果** |
| 群资料/策略/审计 | — | 只有 `title`；无公告、群昵称、policy、audit |

### 2.4 消息、提及与 delivery

| 能力 | 位置 | 现状 / 与 P0 的差距 |
|---|---|---|
| `client_message_id` + operations 幂等 | `messages.ts:483-585` | 同 ID 同正文返回同一消息；同 ID 不同正文 `IDEMPOTENCY_CONFLICT`；已满足 M02 的服务端基础 |
| 群 @ 名字解析 | `messages.ts:363-429` | 省略 `invoke` 时按当前 active 成员名精确匹配；同名 Agent 报错；**会参与隐式派活** |
| 相邻 Agent 自动投递 | `messages.ts:431-465,509-514` | human 群聊未 @ 时自动投递上一条 active Agent；P0 M03 要求删除 |
| 附件自动 @ 维护员 | `src/web/chat-upload-script.ts:13,273` | 上传附件后正文固定追加 `@WeBots 维护员`；P0 M03 要求删除 |
| 显式 `invoke` | `schemas.ts:107-117`、`messages.ts:467-476` | 最多 8 个、不能含自己、显式优先；可复用 |
| delivery 状态机 | `src/domain/deliveries.ts`、`0001_initial.sql` | pending/claimed/completed/failed/cancelled、attempt/claim_id、单 claimed 唯一索引；claim/report/complete/fail/cancel/retry 已实现 |
| 3 分钟提醒 | `src/domain/delivery-reminders.ts`、`0011` | 已实现，可作为 D08 的基础 |
| 历史/补读 | `messages.ts:654`、`src/domain/sync.ts` | keyset 游标、快照上界、sync scope；**只校验 active membership，没有 joined_seq/历史边界** |
| reply/root/hop 预算 | `messages.ts` | `reply_to`、root/hop、root delivery 上限已存在；可作为 M04/D05 基础 |

### 2.5 文件、Drive 与保留

| 能力 | 位置 | 现状 / 与 P0 的差距 |
|---|---|---|
| MCPP Files v1 上传 | `src/app.ts` `/mcp-upload`、`src/drive/service.ts` | 已实现，FlyDrive FSDriver，public URL 由 `PUBLIC_ORIGIN` 派生 |
| 房间文件 bind/list/get/delete | `src/domain/room-files.ts`、`src/mcp/room-files.ts`、`0003_room_files.sql` | 已实现；30 天 TTL、墓碑、配额/类型限制 |
| 公开下载 | `src/app.ts:748` `/f/:fileId` | **无 Bearer、无成员校验**，只检查 room_file 未删除/未过期；这是 M07 的核心缺口 |
| 文件消息/自动归档 | `src/contracts/file-links.ts`、web 渲染 | 正文 `/f/` 链接解析、文件卡片、自动归档最多 8 个；可复用 UI 基础 |
| 保留引用/成果绑定 | — | 无 `file_objects/file_bindings/tickets`，不能支撑 D06/D07/G06 的成果保留与撤权 |

### 2.6 任务（当前是“房间任务看板”，不是 P0 任务模型）

| 能力 | 位置 | 现状 / 与 P0 的差距 |
|---|---|---|
| `room_tasks` 表 | `0010_room_tasks.sql` | 每房间默认列表；`pending/claimed/done/failed`；短文本 ≤120 码点 |
| 任务工具 | `src/domain/tasks.ts`、`src/mcp/tools.ts` | `task_add/list_get/summary/claim/complete/fail/update/delete` |
| 领取/完成权限 | `tasks.ts:179-183` | **只有 Agent** 可以 claim/complete/fail；human 只读/可添加 |
| 事件/通知 | `tasks.ts:217-241`、`src/realtime/stream.ts` | room scope `room_task_*`，只通知 active human；不写 inbox/pending/head |
| 任务 UI | `src/web/chat-tasks-script.ts` | 只展示 done/total、状态与结果；**没有创建/接单/转交/提交/验收操作** |
| P0 缺失 | — | 无 `tasks/assignments/submissions/reviews/transfers/context`；没有 `unassigned/offered/in_progress/blocked/submitted/accepted/failed/cancelled` 状态机 |

### 2.7 实时、在线与事件

| 能力 | 位置 | 现状 |
|---|---|---|
| 统一流 | `src/realtime/hub.ts`、`src/mcp/stream.ts`、`src/realtime/stream.ts` | `agentnet://stream` 单 URI；房间/收件箱/任务/文件/成员/在线事件映射 |
| Agent 显式上线 | `src/realtime/presence.ts`、`presence-timeline.ts`、`0006/0007` | 只有 login 后 Agent 接收 inbox 提示；人类 login 报 `INVALID_ARGUMENT` |
| 在线判定 | `presence.ts::presenceOf` | hub 连接/最近活动（默认 60 秒）+ grace（30 秒）；pending 仍算在线 |
| 上下线时间线 | `0006_agent_presence.sql`、`src/domain/timeline.ts` | 仅 direct human↔Agent；`history_list view:"timeline"` 人类可读 |
| outbox/drain | `src/realtime/outbox.ts`、`src/storage/events.ts` | SQLite outbox + 请求内快速路径 + 定时 drain；可靠性基础 |
| MCP Events | `src/events/*`、`src/mcp/events.ts`、`0004_mcp_events.sql` | webhook 订阅、challenge、签名、重试、日志脱敏；`test:events` 339 项 |

### 2.8 网页

| 能力 | 位置 | 现状 |
|---|---|---|
| 应用页/分享页 | `src/web/chat.ts`、`share.ts`、`layout.ts` | 微信风双栏、移动端单栏、`/c/:roomId` 服务端只渲染空壳 |
| 会话列表/搜索/未读/分类 | `chat-list-script.ts`、`chat-session-script.ts` | 已实现；搜索只过滤已加载会话 |
| 消息渲染/Markdown/图片/文件卡片/回执 | `chat-render-script.ts`、`chat-message-files-script.ts`、`chat-markdown-*` | 已实现；群聊发送者、@ 高亮、时间胶囊 |
| 建群/成员添加 | `chat-members-script.ts`、`chat-panels.ts` | 双栏“已在群/未在群”、好友/本地 Agent 合并；**没有 invited/admin/邀请链接/审批** |
| @ 选择器 | `chat-script.ts:416-464` | 只插入 `@名字` 文本，不保存 actor_id；群聊仍省略 `invoke` |
| 发送 | `chat-script.ts:624-641` | 每次随机 `client_message_id`，超时直接报错；无持久重试/发送中状态 |
| 文件栏/监控/画板/头像/退出/归档 | `chat-files-*`、`chat-monitor-*`、`drawboard/*`、`chat-avatar-*`、`chat-logout-*`、`chat-archive-*` | 已实现；文件下载仍是公开 URL |
| 手机扫码 | `handoff.ts`、`qr.ts` | 纯客户端生成 `/#t=<长期 token>`；无服务端配对/设备撤销 |
| 新建 Agent | `new-agent-script.ts` | 浏览器 `issue_token` → `register(agent)` → `contact_add` → `room_create(direct)`；无管理者绑定 |

### 2.9 技能、CLI 与 watcher

- 主技能：`public/skills/agent-network-skills.md`（428 行）；静态脚本：`agentnet.sh`（1077 行）、`agent_tasks.sh`、`claude-watch.sh`、`codex-watch.sh`、`peri-watch.sh`、`other-sentinel.sh`。
- Harness 指南：`harness-claude.md`、`harness-codex.md`、`harness-chatgpt-web.md`、`harness-other.md`、`harness-peri.md`。
- watcher 已实现自动 claim、SSE 重连/无数据超时、delivery reminder 处理；`test:watch-claim` 覆盖。
- Q01 必须把新增工具/错误/事件/迁移同步到主技能、静态技能、CLI、Harness 和 README/CLAUDE，并保持 `skills/list`/`skills/get`/资源 digest 一致。

---

## 3. 测试基线

### 3.1 环境

| 项 | 值 |
|---|---|
| OS | macOS 26.5.1 |
| Bun | 1.4.2 |
| Node | v26.9.0 |
| Python | 3.12.8 |
| TypeScript | 7.0.2（`tsrs` 与 `tsc`） |
| Playwright | 1.64.1，Chromium 已安装（`chromium_headless_shell-1243/1248`、`chromium-1243/1248`） |
| 依赖 | `bun install --frozen-lockfile` 安装 294 个包；未改 `bun.lock`/`package.json` |
| 数据 | `bun run db:migrate` 生成 `.data/agent-network.sqlite`（忽略目录） |

### 3.2 真实命令（在本目录执行）

```bash
# 依赖与本地库
bun install --frozen-lockfile
bun run db:migrate

# 本地服务（必须让 PUBLIC_ORIGIN 与测试基址一致；否则 protocol 的 issue_token 断言会失败）
PUBLIC_ORIGIN=http://127.0.0.1:8792 bun run start

# 静态检查
bun run typecheck          # tsrs --noEmit
bun run typecheck:tsc      # tsc --noEmit

# 协议/业务验收（需要上面的服务）
bun run test:protocol
bun run test:acceptance
bun run test:drive

# 自带实例的验收
bun run test:events        # 自签 HTTPS receiver + 独立实例
bun run test:web           # Playwright，自托管随机端口实例
bun run test:watch-claim   # verify-watch-claim.ts + python3 test_codex_watch.py

# 房间文件独立实例（脚本存在，但不在 package.json 的 scripts 中）
DATA_DIR=/tmp/an-roomfiles-verify PORT=18880 PUBLIC_ORIGIN=http://127.0.0.1:18880 bun run start
AGENTNET_URL=http://127.0.0.1:18880 DATA_DIR=/tmp/an-roomfiles-verify bun scripts/verify-room-files.ts

# 远端验收（只在有明确授权的目标上执行；不要运行不存在的 deploy/remote migrate）
AGENTNET_URL=https://<authorized-host> bun run test:protocol
AGENTNET_URL=https://<authorized-host> bun run test:acceptance
```

补充说明：

- `scripts/verify-room-files.ts`、`scripts/verify-watch-claim.ts`、`scripts/test_codex_watch.py` 是真实脚本；`package.json` 只注册了 `test:watch-claim`，没有 `test:room-files` 脚本。
- `scripts/lib/harness.ts::baseUrl()` 默认 `http://127.0.0.1:8792`，可用 `AGENTNET_URL` 覆盖；服务端默认 `PUBLIC_ORIGIN` 是 `http://localhost:<port>`，两者不一致时 `network_issue_token` 的 URL 断言会失败。本次通过 `PUBLIC_ORIGIN=http://127.0.0.1:8792` 修正。
- `test:acceptance` 在默认配置下不能作为当前门禁，原因见 §3.7；Q01/Q04/Q05 开始前必须先修复或明确测试期望。

### 3.3 实际运行结果

| 命令 | 结果 | 通过数 | 说明 |
|---|---|---|---|
| `bun run typecheck` | 通过，exit 0 | — | `tsrs --noEmit` 无输出 |
| `bun run typecheck:tsc` | 通过，exit 0 | — | `tsc --noEmit` 无输出 |
| `bun run test:protocol` | 通过，exit 0 | 706 | 需要 `PUBLIC_ORIGIN` 与基址一致 |
| `bun run test:acceptance` | **失败，exit 1** | 113 项后中止 | 失败点 `scripts/acceptance.ts:1000`，`关闭最后一个连接后成员显示离线: 等待条件超时` |
| `bun run test:drive` | 通过，exit 0 | 47 | 服务端 Drive 启用 |
| `bun run test:events` | 通过，exit 0 | 339 | 独立实例 + 自签 HTTPS |
| `bun run test:web` | 通过，exit 0 | 1711 | Playwright，三档视口 |
| `bun run test:watch-claim` | 通过，exit 0 | Bun 脚本通过；Python 12 tests OK | watcher 自动 claim/重连/reminder |
| `bun scripts/verify-room-files.ts`（独立实例） | 通过，exit 0 | 187 | 需要独立 `DATA_DIR` 与本机 SQLite |

未执行/不能声称通过：

- 远端 `AGENTNET_URL=https://...` 验收（无授权目标；README 中生产域名有新旧两个，不能猜）。
- 真实群音视频/TURN、真实手机扫码、外部业务系统（Q03/M09/Q02 的外部部分）。
- Q06 的 100 人/10 万历史/1 万任务/25 msg/s 负载与 Q05 的 100 次并发故障矩阵（当前仓库没有对应 runner/数据集）。

### 3.4 测试脚本清单与可复用点

| 脚本 | 行数/组成 | 覆盖 | 可复用给 |
|---|---|---|---|
| `scripts/verify-protocol.ts` | 2947 行；`scripts/lib/stream-protocol.ts` 等 | 协议帧、工具 schema/描述、资源、技能、CORS、静态网页断言 | Q01、A01/G03/M03 工具契约 |
| `scripts/acceptance.ts` | 1299 行 + 10 个子套件 | 注册、好友、房间、消息、delivery、流、presence、房间文件、归档、监控、房间任务、反馈、提及、自动投递、events | A01/A03/G01/G05/G06/M02/M03/Q02/Q05 |
| `scripts/verify-web.ts` | 16239 行；Playwright | 三档视口、真实上传/bind、SSE、IME、暗色、分享页、扫码、任务浮层、文件栏、画板 | Q04、M02/M03、G01/G02/G03 |
| `scripts/verify-drive.ts` | 279 行 | MCPP upload、公开下载、Range/HEAD、drive_file_info | M07/Q04 基础 |
| `scripts/verify-events.ts` | 1389 行 | challenge、签名、重试、重启、日志脱敏 | Q05 故障点基础 |
| `scripts/verify-room-files.ts` | 820 行 | bind/list/get/delete、配额、墓碑、`/f` 的 HEAD/Range/304 | M07/G06/D06 |
| `scripts/verify-watch-claim.ts` + `test_codex_watch.py` | 833 + 427 行 | watcher claim/冲突/重试/重连/分类 | Q01 技能/CLI 更新 |
| `scripts/lib/presence-*` | 多个套件 | 上线/离线/时间线/重启/空闲 | Q02/A06/G06 |
| `scripts/lib/mention-acceptance.ts` | 415 行 | 群 @ 名字解析全部边界 | M03（需要改写旧期望） |
| `scripts/lib/auto-deliver-acceptance.ts` | 295 行 | 相邻 Agent 自动投递 | M03（旧行为必须删除并改测试） |
| `scripts/lib/room-task-acceptance.ts` / `room-task-summary-unit.ts` | 621 / 208 行 | 旧 room_tasks 状态机/权限/摘要 | D01–D08 仅作 legacy 回归，不可当新任务语义证据 |

测试组织特点：没有 Jest/Vitest 单元测试框架；所有脚本是断言+`console.log`，失败抛 `CheckFailure`。新增任务应沿用现有 harness、DB 直连 helper 和 `check/checkEqual` 风格，不要引入并行的测试体系。

### 3.5 旧测试会与新 P0 语义冲突的明确位置

这些测试不是“实现证据”，而是必须随任务更新/退休的旧行为：

| 位置 | 旧期望 | 所属任务 |
|---|---|---|
| `scripts/lib/auto-deliver-acceptance.ts:126` 等 | human 紧跟 Agent 无 @ 自动创建 delivery | M03 删除 |
| `scripts/lib/mention-acceptance.ts` 多处 | 省略 invoke 时按名字解析、未知名字不阻断自动投递 | M03 改为显式 mentions/有限唯一回退 |
| `scripts/verify-protocol.ts` 静态网页/文档断言 | 手机扫码 `#t=` 长期 token、Agent 全局改名入口、房间任务 | Q01/Q02/M03 |
| `scripts/acceptance.ts` 好友/房间/成员测试 | 单向 contact、group 直接 active、owner 直接 transfer | A03/G01/G05 |
| `scripts/verify-web.ts` 新建 Agent/扫码/成员 | 浏览器注册 Agent、长期 token QR、owner-only 成员 | A01/A03/Q02/G03 |
| README/CLAUDE/技能正文 | 旧开放边界、长期 token、自动投递、Agent-only 任务 | Q01 |

### 3.6 测试环境注意

- `test:web` 会启动自己的临时 Bun 实例和随机端口，不需要主服务；首次运行若没有 Chromium 需 `bunx playwright install chromium`（本机已有）。
- `test:events` 需要自签证书和回环 callback；不要把它指向生产。
- `test:drive` 需要主服务启用 Drive（默认启用，`DRIVE_DISABLED=1` 时关闭）。
- `test:acceptance`/`test:protocol` 可用 `EVENTS_ACCEPTANCE=1` 额外覆盖 events，但需要目标实例允许测试私网 callback。
- 验收脚本会创建新身份/房间，重复运行会累积数据；重置需删 `.data/` 后重新 `db:migrate`，不要清空生产数据。
- 测试日志会包含 token；交付证据时必须脱敏，不能把原始日志直接发群或写入仓库。

### 3.7 `test:acceptance` 失败详情（重要）

**默认配置**：

- 失败位置：`scripts/acceptance.ts:1000`。
- 断言标签：`关闭最后一个连接后成员显示离线`。
- 实际：`waitUntil` 30 秒超时；`network_room_get` 仍返回 Agent `online === true`。
- 代码依据：`LIMITS.agentPresenceActivityTtlMs = 60_000`、`agentPresenceGraceMs = 30_000`（`src/contracts/limits.ts`）；`presenceOf` 在 `pending_offline` 时仍返回 `online: true`（`src/realtime/presence.ts`）。最后连接断开后，要先等“最后活动 + 60 秒”，再等 grace，才会确认离线；测试只等 30 秒。
- 结论：这是**测试期望与后续 presence 功能不一致**，不是本次改动引入的回归。它阻止 `test:acceptance` 作为 Q01-T04/Q04/Q05 的门禁。

**诊断运行**（只改测试环境变量，不改产品）：

```bash
AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 AGENT_PRESENCE_GRACE_MS=2000 \
AGENT_PRESENCE_SWEEP_MS=1000 PUBLIC_ORIGIN=http://127.0.0.1:8792 bun run start
bun run test:acceptance
```

结果：主套件通过到 284 项，随后在 `scripts/lib/presence-acceptance.ts:378` 的 `grace 前不写下线` 失败（期望 0 条 offline，实际 1 条）。说明 presence 子套件自己的时间假设也与缩短后的 TTL/grace 不一致。

**建议处置（需 integration/verification 裁决）**：把 `acceptance.ts:1000` 的等待改为 `TTL + grace + 扫描余量`，或为该用例注入可控时钟/测试专用 TTL；不要通过放宽产品语义或删除断言来“通过”。在该测试修复前，任何“acceptance 通过”声明都不成立。

---

## 4. P0 任务复用 / 补齐 / 新增地图

图例：

- **复用**：现有代码/表/工具/测试可直接使用，不需要改变其语义。
- **补齐（patch）**：已有路径需要改权限、状态、事务或 UI 行为。
- **新增（new）**：当前不存在，需要新表/新工具/新事件/新 UI/新测试。
- 迁移号按 `reports/CONTRACT_BASELINE.md` 的 `0012`–`0019`；禁止各任务自行占用/重排。
- 本表只列“实现起点”，实际文件可按契约拆分；共享面（`src/contracts/*`、`src/storage/rows.ts`、`src/mcp/tools.ts`、`src/mcp/outputs.ts`、`src/app.ts`、事件定义/映射、`migrations/*`、`package.json`/锁文件、共享 UI 入口/全局样式）只允许 integration 指定单写者。

### 4.1 身份与关系（A01/A03/A05/A06）

| 任务 | 复用 | 补齐（patch） | 新增（new） | 前置/阻塞 |
|---|---|---|---|---|
| **A01** 身份归属与管理授权 | `src/mcp/auth.ts`、`actors/credentials`、`register`、`me`、`profile_update`、`renameMe/renameAgent`、`reissueAgentToken`、`archiveAgent`、`agents_get`、`runIdempotent`、events/outbox | `register` 的 Agent 自注册保持 unclaimed；`renameAgent`/`reissueAgentToken`/`archiveAgent` 只允许 active manager/delegate；`profile_update` 区分本人/管理者；auth/stream 检查 disabled/permission_version；归档与停用分离；Web 新建 Agent 改走管理创建 | `agent_managements`、`agent_claims`、`agent_delegations`；`network_agent_create`、`management_get`、`agents_managed_list`、`claim_start/confirm/cancel`、`delegate_grant/revoke`、`disable/enable`；权限版本、审计事件、0012；A01-T01..04 | 无功能前置；Q02/A06 共享 0012/管理模型 |
| **A03** 好友申请与关系闭环 | `contacts`/`contactsList`/`areContacts`、`roomCreate` 的 `requireFriends`、share/new-agent 的 `contact_add`、`runIdempotent`、通知/outbox | `contactAdd` 改为“申请或自有 Agent 自动 active”；`contactRemove` 结束 relation 而非删历史；`areContacts` 只认 active relation；direct 创建/发送、群加人检查关系策略；Web 联系人列表区分 pending/legacy/active；share 页改为发申请 | `contact_requests`、`contact_relations`、接收策略；`contact_request_create/list/respond/cancel`；通知与幂等；0013；A03-T01..04 | 依赖 A01；旧 `contacts` 只作个人收藏/历史，不回填同意 |
| **A05** 删除拉黑与骚扰控制 | A03 的 relation/block 基础、`messageSend`/delivery、G02 邀请、D01 任务提议、`LIMITS`、events | `contactRemove` 只解除关系保留历史；block 检查覆盖私聊、申请、邀请、定向任务提议、直接 @；被拉黑者群消息仍按群权限可见但个人通知静默；Web 文案区分删除/拉黑/举报/退群 | `contact_blocks`、`contact_reports`；`contact_block/unblock/report`；申请/邀请/陌生私聊冷却与限额；错误 `PERMISSION_DENIED`/`BLOCKED`；A05-T01..03 | 依赖 A03、G03；举报只进受控流程 |
| **A06** Agent 管理权交接 | A01 管理关系、D04 转交模式、Q02 设备/凭据、任务 assignment/eligibility、events/audit | 交接接受时原子更新 management、permission_version++、撤销旧委托/旧管理凭据、轮换运行凭据；任务进入待核对/待重派；不自动转移原管理者私聊、外部仓库/API key 权限 | `agent_management_transfers`；`agent_transfer_propose/respond/cancel`；交接清单/审计；A06-T01..04 | 依赖 A01、D04、Q02；不能把管理权交接当成 D04 任务转交 |

### 4.2 群组（G01/G02/G03/G05/G06/G07）

| 任务 | 复用 | 补齐（patch） | 新增（new） | 前置/阻塞 |
|---|---|---|---|---|
| **G01** 建群与批量选人 | `roomCreate/createDirect`、`room_members`、`requireFriends`、`chat-members-script.ts` 双栏选择器、`runIdempotent`、100 人上限 | group 创建：创建者 owner、自己管理的 Agent active、其他成员 invited；所有计数只算 active；逐对象结果（成功/邀请/失败）；重复 `request_id` 收敛同一群；UI 显示 invited 而非“已加入” | 复用 G02 的 invitation 记录；成员选择器状态（类型/备注/已选/已在群/搜索分页）；0014；G01-T01..03 | 依赖 A03、G03；邀请预留默认不占名额 |
| **G02** 邀请链接/二维码/审批 | G01 的 invited、`src/web/qr.ts`、`share.ts/layout`、成员计数、A05 block、G07 policy | 邀请包含群引用/发起者/有效期/次数/撤销；分享页先展示最小群介绍并确认；审批开启时进入 join request；Agent 入群要管理授权；过期/撤销/用尽/被移除后重新加入给出稳定错误；二维码只含邀请 URL，不含凭据 | `room_invitations`、`room_join_requests`；`room_invite_create/revoke/get/respond`、`room_join_request_list/respond`；7 天/20 次可配置 LIMITS；0014；G02-T01..04 | 依赖 G01、G07、A03、A05 |
| **G03** 群主/管理员/成员权限 | `room_members.role`、owner-only 检查、`guard_not_owner`、stream 成员扇出、Web 成员 UI | 引入 admin 角色（契约选择独立 `room_role_grants`，避免重建旧表）；所有 domain 入口共用一份权限判定；管理员可审批入群/维护公告/移除普通成员，不能移除群主、任免其他管理员、转让/解散；角色变更有版本与审计；Web/MCP 结果一致 | `room_role_grants`、`network_room_role_set`、权限模块、审计；0014；G03-T01..03 | 依赖 A01；管理员不等同 Agent 管理者/外部权限 |
| **G05** 群主转让确认 | `rooms.owner_id`、`room_members.role`、owner guard、Web 成员菜单 | 移除 `room_members_update.transfer_owner_to` 的直接切换；owner 离群前必须完成 G05 或解散；同一群只允许一条有效提议；目标离群/被移除/解散/过期使提议失效；接受原子换 owner、原 owner 降 member | `room_owner_transfers`；`network_room_owner_transfer_propose/respond/cancel`；24 小时默认；0014；G05-T01..03 | 依赖 G01、G03；旧 transfer 测试必须改 |
| **G06** 退群/移除/解散与在途工作 | `roomLeave`、成员移除 + `cancelDeliveriesForMemberStatements`、active member 文件检查、stream membership、`room_tasks`/deliveries | 退群/移除立即撤销新读写、文件、流扇出、任务执行资格；pending/claimed delivery 取消；任务进入 blocked/unassigned 交由有权限者重派；并发交接/移除按条件事务裁决；owner 离群只能先转让或解散；解散冻结发言/邀请/任务/通话，保留合法成员截至解散点的只读归档；不硬删数据库 | `rooms.status`/解散记录、归档快照、`network_room_dissolve`、审计；接入 D04/D08/M07 的撤销钩子；G06-T01..04 | 依赖 G01、D04、D08、**M07（未在本次清单）** |
| **G07** 群策略/历史边界/管理记录 | `room_members.joined_seq`（已有但未用于读）、`historyList`/`messageRead`/`sync`、`room_files`、task 读取、stream | 新增 `history_from_seq`/`membership_generation` 并在**所有**读取路径生效：history、message_read 按 ID、sync、文件 bind/get/download、引用预览、任务上下文；默认新成员只看本次加入后；群主可开全历史并提示；策略（审批/邀请/资料/发言/@all）带版本；管理审计只对有权限者可见 | `room_policies`、`room_audit`、`network_room_policy_get/update`、`network_room_audit_list`；`@all` 权限基础；0014；G07-T01..03 | 依赖 G01、G03；旧游标只定位，不授权 |

### 4.3 消息与提及（M02/M03）

| 任务 | 复用 | 补齐（patch） | 新增（new） | 前置/阻塞 |
|---|---|---|---|---|
| **M02** 发送状态与可靠补读 | `client_message_id` + operations 幂等、`messageSend` 单事务、history/sync、统一流、delivery_ids | Web 为同一发送意图持久保留 `client_message_id`；超时/断线用原 ID 重试，改正文必须新意图；显示 sending/submitted/failed + 可重试；成功响应丢失先按 client_message_id/history 对账；切房/刷新不串草稿；服务端同 ID 不同正文冲突已存在，保留 | 客户端 pending 发送队列/状态 UI（按 room 隔离）；测试 M02-T01..04；可能不需要迁移 | 依赖 A01、G01；不要承诺外部工具恰好一次（D08/Q03） |
| **M03** 结构化提及与确定性唤醒 | `invoke`/`invokeMax`/root budget、mention picker、服务端名字解析、delivery/stream、技能文档 | Web 选择 @ 时保存 `actor_id`，显示名只负责展示；**删除** `messages.ts:431-465,509-514` 相邻 Agent 自动投递；**删除** `chat-upload-script.ts:273` 附件自动 `@WeBots 维护员`；显式 `invoke: []` 永不派活；纯文本 @ 只在未显式给 invoke 时解析当前群唯一精确成员；同名报歧义；@all 只发提醒且受权限；旧测试（mention/auto-deliver/README/技能）同步改期望 | `message_mentions` 表；`mentions`/`mention_all` schema；0015；M03-T01..04 | 依赖 M02、G03、G07；@all 不生成批量 Agent 工作 |

### 4.4 任务交付（D01–D08）

> 当前 `room_tasks` 是**旧看板**，不是 D01–D08 的目标任务模型。可以复用其表/工具作为 legacy 回归，但新语义必须用新 `tasks` 体系；旧 `done` 只能标 `legacy_completed`，不能回填为 accepted。

| 任务 | 复用 | 补齐（patch） | 新增（new） | 前置/阻塞 |
|---|---|---|---|---|
| **D01** 消息转任务与任务卡片 | messages/rooms/deliveries、task summary、Web task popover、`runIdempotent`、events | 旧 `room_tasks` 切换为 legacy 只读；从消息/任务面板创建任务；短标题 + 详细目标/附件/创建者/候选负责人/验收人/期限/验收条件；卡片在聊天、群任务面板、我的任务定位同一 `task_id`；引用/转发不复制任务/授权 | `tasks`、任务详细正文/附件引用、`network_task_create/get/list`；task card；0017；D01-T01..04 | 依赖 A01、G01、M03 |
| **D02** 接单/拒单/原子领取 | D01 tasks、delivery claim 协议、operations/guards、Web task panel | human 与 Agent 都可 accept/decline/claim；接受时原子生成 assignment_id/assignment_version/owner；用 expected task_revision 防迟到覆盖；delivery claim 只表示处理接单通知，不等于业务接单/验收 | `task_assignments`（或等价）、`network_task_offer/accept/decline/claim`；guards；D02-T01..03 | 依赖 D01；一个任务一个当前 owner |
| **D03** 业务状态与进度统一展示 | D02、events/stream、`src/mcp/outputs.ts`、Web task popover | 权威状态 `unassigned/offered/in_progress/blocked/submitted/accepted/failed/cancelled`；旧 `done` → `legacy_completed`；负责人可报告进度/阻塞/恢复；submitted 仅表示待验收；accepted 只能由 D07 产生；delivery 状态不复用为任务状态；普通进度不制造新未读/delivery | 状态迁移/进度事件、`network_task_report/block/resume`、统一投影；D03-T01..03 | 依赖 D02 |
| **D04** 任务转交与接任确认 | D02/D03 assignment/version、deliveries、`runIdempotent`、stream、Web | 当前 owner 可提议转给合格人/Agent；创建者/群主可发起重派但接任者必须接受；确认前原 owner 继续负责；提交成果使待处理提议失效；接受原子换 owner、assignment_version++、撤销旧 claim/执行令牌；旧执行者不能写进度/提交/继续转派 | `task_transfers`、`network_task_transfer_propose/respond/cancel`；交接事件；D04-T01..04 | 依赖 D02、D03；不能声称撤销令牌能停止外部进程 |
| **D05** 可授权的交接上下文包 | D04、M04 引用/原文（**未实现**）、M07 文件授权/保留（**未实现**）、tasks/messages/files | 版本化上下文：目标、已完成、当前结果、未解决问题、下一步、相关消息/文件/分支/提交/测试证据、原执行版本；接任时校验可见性/保留期，列出缺项，不把空内容当完整交接；跨群只迁移明确成果与必要摘要，私有材料逐项授权；上下文是工作数据，不扩大权限；材料不齐进 blocked | `task_context_packs`/manifest、`network_task_context_get/declare_missing`；D05-T01..03 | 依赖 D04、**M04（未在清单）**、**M07（未在清单）**；缺 M04/M07 时只能做只读设计/桩，不能签收 |
| **D06** 成果提交与版本 | D03 tasks/assignment、M07 文件保留（**未实现**）、`runIdempotent`、events | 提交成果摘要、文件/链接、实现 SHA、验证证据、已知限制；只接受当前有效 assignment；生成 submission_id/version、冻结材料引用与校验值；提交成功进入 submitted、关闭执行资格、失效未决交接；文件保留与状态改变原子；外链记录版本/摘要/可用性；退回后重提产生新版本 | `task_submissions`、`submission_files`、`network_task_submit`；0017；D06-T01..03 | 依赖 D03、**M07（未在清单）**；文件失败不能留空成果 |
| **D07** 验收/退回/重新交付 | D06 submissions、D03 状态机、roles、events、Web task panel | 指定 reviewer 对指定 `submission_id/version` accept/return；默认创建者验收，负责人不能自验；创建者执行时接单前另指定验收人；验收人失权/退群时 submitted/blocked，由有权限者显式指定；退回进入 in_progress + 新执行资格，原 owner 失权则 blocked；accepted 终态；旧版本验收不覆盖 v2 | `task_reviews`、`network_task_review`；D07-T01..03 | 依赖 D06；外部验收按 Q03 |
| **D08** 催办/取消/异常恢复 | `delivery-reminders.ts` 3 分钟提醒、`src/maintenance.ts`、tasks/deliveries、outbox、retry、presence/restart | 记录进度/期限/阻塞；提醒与 delivery 提醒去重，不新建任务/派活链；取消由有资格者执行，原子失效执行版本/未决提议；断线/心跳超时只标 unknown/待核对，不自动重跑外部副作用；重派需新意图/新版本；服务重启从持久任务/事件/outbox 恢复；外部 action_id 去重 | 任务提醒/计时器表、`network_task_cancel/retry/recover`、恢复事件；D08-T01..04 | 依赖 D02、D03、M03 |

### 4.5 集成、设备与验收（Q01/Q02/Q04/Q05）

| 任务 | 复用 | 补齐（patch） | 新增（new） | 前置/阻塞 |
|---|---|---|---|---|
| **Q01** Web/MCP/CLI/文档全量对齐 | `src/mcp/tools.ts`/`contracts/schemas.ts`/`outputs.ts`/`skill.ts`、主技能/静态技能/CLI/Harness、README/CLAUDE/code-index、protocol 静态断言 | 为每个新功能同步 schema/描述/错误/事件/客户端；逐项建立 Web→MCP→domain 权限→事件→CLI/技能→验收用例映射；退休/别名旧工具；删除被替代的全局 Agent 管理、长期 token QR、隐式 @、Agent-only 任务说明；修正 `CLAUDE.md:7` 的 `../../docs/standards/index.md`、`docs/code-index.md:3` 的 `../../npm-packages/...`/`../../spec/...`（当前均不存在）；全量门禁 | 映射表、迁移报告、文档与测试更新；Q01-T01..04 | **依赖全部 P0 + P1**（A02/A04/G04/M01/M04/M05/M06/M08/M09/Q03/Q06）；仅 P0 子集不能签收 |
| **Q02** 安全设备配对与离线同步 | `recovery_tickets`/`credentials.device_id`、`handoff.ts`/`qr.ts`、auth/stream、sync cursor、login/presence、Web account | 手机二维码改为 5 分钟一次性配对挑战；新设备独立 credential，由已登录设备确认；旧 `#t=` 长期 token 只做过渡提示，不再生成；设备列表/最后活动/单设备撤销；撤销后停止该设备私有读取/工具调用/流扇出；身份切换显示原/目标身份、草稿按身份隔离；重连用服务端游标补读、去重 | `devices`、`device_pairings`；`network_device_pairing_create/approve/redeem/cancel`、`network_device_list/revoke`；0012；Q02-T01..04 | 依赖 A01、M02、G07、D03；真实手机扫码需要人工证据 |
| **Q04** 桌面/移动端正向验收 | `scripts/verify-web.ts` 的 Playwright 三档视口、故障注入、自托管实例；share/chat/成员/任务 UI | 覆盖联系人申请/拉黑、群邀请/审批/角色/转让/解散、actor_id @、任务创建/接单/转交/提交/验收、文件授权/设备配对；空/加载/失败/冲突/无权限态都有下一步；焦点/Esc/遮罩/滚动锚点/长消息/窄屏/附件预览；截图/录像与 DB 对账 | 新测试场景、fixture、截图/录像证据；Q04-T01..03 | **依赖 Q01、Q02、Q06（P1，未在清单）**；独立验证者签收，不能自验 |
| **Q05** 并发/故障/越权对抗验收 | acceptance/events/presence/room-file harness、DB 直连、自签 HTTPS、重启；`runIdempotent`/guards | 至少 100 次同意图写入、抢单、接受/撤销交接、移人/提交、旧凭据/重连、撤回/领取、文件清理/绑定；故障点覆盖提交前、提交后响应前、outbox 发布前/后、媒体断线、外部回写未知；固定种子/重放；断言 DB/权限/可观察事件，不以 HTTP 200 推断；缺陷回流原任务 | 并发/fault runner、种子/重放证据、缺陷台账；Q05-T01..03 | **依赖 Q01、Q04、Q06**；外部未知需 Q03/M09 |

### 4.6 被任务包标为 P0、但不在本次 24 项清单的任务

| 任务 | 为什么必须处理 | 影响 |
|---|---|---|
| **M07** 私有文件授权与成果保留 | 任务包 `TASK_INDEX.md` 标 P0；`CONTRACT_BASELINE.md` 把它放入 P0 迁移 0016；G06（文件撤权）、D05（私有材料）、D06（成果保留）、D07（成果验收）、Q01（全功能）都依赖它 | 当前 `/f/:fileId` 公开、无成员校验、无 retention references。若不实现 M07，G06/D05/D06/D07 只能标 BLOCKED，不能签收；Q01 也不能完成 |
| **Q06** 长历史/容量/性能 | 任务包标 P1，但 Q04/Q05 的完成前置都包含 Q06 | P0 全量门禁不能在没有 Q06 数据集/指标的情况下签收 |
| **Q03** 外部业务关联 | 任务包标 P1，Q01 前置包含 Q03 | 外部 Issue 绑定/回写/对账无法用本地 mock 替代，Q01/Q04 的 E20 证据缺失 |
| **M09** 群音视频 | 任务包标 P1，Q01 前置包含 M09；G06-T04/Q04 E19 涉及媒体撤权 | 需要真实 TURN/SFU/媒体网络；当前仓库无媒体模块 |
| **M04** 引用回复与原文定位 | 任务包标 P1，D05 前置包含 M04 | D05 的“相关消息/引用摘要”需要 M04 的原文定位；缺 M04 时 D05 只能部分设计 |

> 这不是把 P1 责任推给用户；这是任务图本身的前置关系。正确做法是：P0 任务完成自身范围并如实标依赖 BLOCKED，主控决定是否把 M07/Q06/Q03/M09/M04 纳入本轮集成，不能宣称“P0 完成 = 36/36”。

---

## 5. 跨任务实现约束（从现有代码继承）

1. **幂等与事务**：所有写操作走 `runIdempotent`（`src/storage/transactions/runner.ts`）；business write + 条件闸门 + operations 在同一 `db.batch()` 全有或全无。禁止 `INSERT OR IGNORE` 后无条件继续写。新增条件必须用命名 guard 表，不能临时加列绕过。
2. **guard 三处同步**：新增/修改 guard 时同时更新 `src/storage/guards.ts` 的 `GUARD_TABLES`、`migrations/0018`（或对应迁移）的命名约束、`runner.ts` 的 `GUARD_CODES`/`GUARD_MESSAGES`/`GUARD_DETAILS`。合同要求 0018 集中新增 P0 guard。
3. **迁移**：只做加法（新表/列/索引），不重建旧表、不改已发布迁移、不建临时双写表；旧数据按 0019 回填，旧 `done` 不回填 accepted，旧联系人不回填同意，旧 Agent 不猜管理归属。迁移号 0012–0019 由 integration 独占。
4. **事件/outbox**：业务事实先落 SQLite events/outbox；hub 只发提示，不做权威。新事件要进 `src/contracts/events.ts`、`src/events/definitions.ts`、`src/realtime/stream.ts` 的映射，并考虑客户端去重/补读。普通消息不新增 Agent 工作，除非有明确 invoke/任务 offer。
5. **权限**：不能只在工具层检查；domain 入口、stream 订阅、文件下载/票据、任务上下文、Web/MCP 必须同一授权结果。群角色不授予 Agent 管理权/外部资源权限；Agent 管理权不授予群管理权。
6. **凭据**：token 只在受控交付端出现一次；不得写入 `operations.result_json`、群消息、日志、测试证据或仓库文件。`recover`/配对/重发 token 的响应要单独处理“只返回一次”。
7. **阈值**：所有时长/数量进 `src/contracts/limits.ts`，不得在调用点复制；新增默认值（如 5 分钟配对、7 天邀请、24 小时交接、24 小时草稿、30 天附件）只在这里维护。
8. **共享文件**：`src/contracts/*`、`src/storage/rows.ts`、`src/mcp/tools.ts`、`src/mcp/outputs.ts`、`src/app.ts`、事件定义/映射、`migrations/*`、`package.json`/锁文件、共享 UI 入口/全局样式为单写者面。功能分支提 patch，由 integration 排队合入并发布新集成 SHA。
9. **测试证据**：每个任务至少覆盖自己的验收编号；通知/事务变更不能只跑协议；真实浏览器/文件/重启/并发要保留原始日志、截图/录像、固定种子。静态检查/模拟/真实联调必须分开标注。
10. **日志脱敏**：不得输出 token、凭据摘要、消息正文、完整 callback URL、secret。现有 events 测试已有脱敏断言，新增路径沿用。

---

## 6. 已知缺口与阻塞（含外部条件）

### 6.1 硬范围/依赖阻塞

| ID | 问题 | 影响任务 | 需要的决策/条件 |
|---|---|---|---|
| BLOCK-01 | **M07 未在本次 24 项清单，但包标 P0**；当前文件公开下载、无保留引用 | G06、D05、D06、D07、Q01 | integration/主控明确把 M07 纳入并分配 0016，或把上述任务标 BLOCKED；不能两全其美 |
| BLOCK-02 | **Q06（P1）是 Q04/Q05 前置**；无 100 人/10 万历史/1 万任务/25 msg/s 数据集和可复测指标 | Q04、Q05、Q01 | 把 Q06 纳入并先建 seed/指标；否则 Q04/Q05 只能完成不依赖容量的部分 |
| BLOCK-03 | **Q03（P1）是 Q01 前置**；无外部业务系统/Issue/CI 授权 | Q01、Q04（E20） | 提供 E1（授权外部测试系统或 self-hosted 实例）、API token/网络出口；不能 mock 代替 |
| BLOCK-04 | **M09（P1）是 Q01 前置**，G06-T04/Q04 E19 需要真实媒体 | Q01、G06、Q04 | 提供 TURN/SFU 地址、端口/证书、凭据、浏览器媒体权限；当前仓库无媒体模块 |
| BLOCK-05 | **M04（P1）是 D05 前置**；当前只有 `reply_to` 字段，无原文定位/引用预览 API | D05 | 纳入 M04 或缩小 D05 的“相关消息摘要”范围（需变更申请） |

### 6.2 外部媒体/TURN

- 当前仓库没有 `src/media`、通话表、TURN/STUN/SFU 配置、编解码/设备权限处理；`G06-T04` 的“媒体发布/订阅资格立即终止”和 `Q04` 的通话路径没有可执行目标。
- 需要部署方提供：TURN/SFU 地址与端口、TLS 证书、短期媒体凭据、NAT/防火墙策略；测试需要真实浏览器（Chromium 可用）和麦克风/摄像头权限；受限网络（强制 TURN）需要可控网络环境。
- 不能用 mock/截图/假 SDP 代替“双向媒体可连通、撤权后停止”的证据。

### 6.3 设备配对（Q02）

- 当前只有 `recovery_tickets`（3 分钟）与 `/#t=<长期 token>` 二维码；没有 `devices`、`device_pairings`、设备列表/撤销、credential→stream 关闭。
- 自动化可用两个 Playwright context/两个 token 模拟两台设备；**真实手机扫码**需要人工和实体设备，属于必须单独记录的“真实联调/未自动化”。
- 设备撤销必须同时停止该设备的 MCP 调用、SSE 流、私有读取；仅在 UI 隐藏设备不算通过。

### 6.4 外部业务（Q03）

- 当前没有 `external_bindings`/`outward_operations`/适配器，也没有远端 Issue/CI 权限；`D07` 的外部验收只能在 Q03 之后。
- 需要：授权的外部测试系统（E1）或 self-hosted 实例、API 凭据、网络出口、可查询的 action_id/对账接口。外部结果未知必须保留 unknown，不能假设本地命令成功。

### 6.5 负载/性能（Q06）

- 当前测试没有并发/负载框架；`test:acceptance` 是单线程顺序调用，不能替代 `Q05` 的 100 次竞争。
- 需要：基线数据库副本、可控时钟、故障注入开关、至少 100 人/10 万消息/1 万任务/25 msg/s 的 seed 工具与可复测指标；SQLite + 单 Bun 进程的写入瓶颈要先测出来，不能先承诺容量。
- `Q04` 的 UI 有界加载、`Q05` 的故障重放都依赖这些数据。

### 6.6 仓库/测试本身的缺口

| ID | 缺口 | 证据 | 处置 |
|---|---|---|---|
| TEST-01 | `test:acceptance` 默认失败 | `scripts/acceptance.ts:1000` 等 30s，而 `LIMITS.agentPresenceActivityTtlMs=60s`；诊断环境又触发 `presence-acceptance.ts:378` | integration/verification 决定改测试等待/注入时钟；不要放宽产品 |
| DOC-01 | 祖先文档路径不存在 | `CLAUDE.md:7` → `../../docs/standards/index.md`；`docs/code-index.md:3` → `../../npm-packages/agent-network/README.md`、`../../spec/issues/2026-10-21-agent-network.md` 均缺失 | Q01 改为独立仓库真实路径；不伪造内容 |
| DOC-02 | README/CLAUDE/技能含旧规则与旧计数 | README 第 13/14/19/20/30/353/484 行等；技能第 90/302/348 行 | Q01 逐段替换；旧计数以实际测试为准 |
| DOC-03 | 生产域名新旧不一致 | README 第 18 行同时出现 `networks.peri-code.dev` 与 `net.peri-code.dev` | Q01/deploy 文档只保留部署方确认的地址；不要猜 |
| SEC-01 | `/f/:fileId` 公开且无成员校验 | `src/app.ts:748` | M07 改为授权下载/票据；旧公开 URL 的迁移策略单独写 |
| SEC-02 | 任意 principal 可改名/重发/归档任意 Agent | `identity.ts:310/367`、`agents.ts` | A01 收紧；旧文档删除 |
| SEC-03 | 陌生人可建 direct/发消息；群加人只查单向 contacts | `rooms.ts:389` 无关系检查、`messages.ts:491` 只查成员 | A03/A05 加关系/block 校验 |
| TEST-02 | 旧测试把旧行为写成期望 | `auto-deliver-acceptance.ts`、`mention-acceptance.ts`、`verify-web.ts` 扫码/新建 Agent、`verify-protocol.ts` 文档断言 | 对应任务改测试；不能删断言了事 |
| TEST-03 | 无并发/fault runner、无可控时钟 | 现有 acceptance 顺序执行 | Q05/Q06 新建 harness |
| GAP-01 | 无管理/群管理审计表、无邀请/申请限流 | 现有 events 不是审计；`LIMITS` 无 request/invite/block 冷却 | A01/A05/G02/G07 增表/阈值 |
| GAP-02 | 归档/停用未分离 | `archived_at` 只影响列表；无 `disabled_at` | A01 新增停用语义 |
| GAP-03 | 在线判定与测试期望不一致 | `presence.ts` 把 `pending_offline` 当在线；测试等 30s | TEST-01 修复前不要把 acceptance 当门禁 |

### 6.7 环境/命令坑

- 默认服务 `PUBLIC_ORIGIN=http://localhost:8792`，默认测试基址 `http://127.0.0.1:8792`；协议测试的 issue_token URL 断言要求两者一致。启动时显式设置 `PUBLIC_ORIGIN`。
- `test:web`/`test:events` 自带临时实例；不要复用主服务端口/数据目录。
- `verify-room-files.ts` 需要独立 `DATA_DIR` 且能直连 SQLite；远端目标没有本地库时会跳过数据库级用例，不能把跳过当通过。
- 生产/远端验收必须使用明确授权的 `AGENTNET_URL`；仓库 README 的域名和部署命令不能直接当授权。

---

## 7. 建议的 P0 开工顺序（在依赖缺失已知的前提下）

> 该顺序只用于组织工作，不改变任务图的正式依赖；共享迁移/契约文件必须先由 integration 发布集成 SHA。

| 顺序 | 可开始 | 说明 |
|---|---|---|
| 0 | 契约冻结（已完成 `webots-p0-v1`） | 所有分支引用同一版本；迁移 0012–0019 由 integration 分配 |
| 1 | A01 + Q02 的 0012 设计 | A01 管理关系、claims、delegations、停用；Q02 devices/pairings 共享 0012，必须同一负责人先落表 |
| 2 | A03 + G03 | 0013 联系人关系；0014 群角色/邀请骨架；A03 是所有 direct/群加入的前置 |
| 3 | A05 + G01 | 拉黑/限流；建群 invited/active 语义 |
| 4 | G05 + G07 + M02 | 群主转让提议、历史边界/策略、客户端发送重试 |
| 5 | G02 + M03 | 邀请链接/审批；结构化提及/删除隐式投递 |
| 6 | D01 | 新任务对象/卡片；旧 room_tasks 切 legacy |
| 7 | D02 | assignment/接受/拒绝/领取 |
| 8 | D03 | 统一状态机/进度 |
| 9 | D04 + D06 + D08 + Q02 设备完成 | 转交、成果、提醒/取消/恢复、设备撤销 |
| 10 | A06 + D05 + D07 | 管理权交接、上下文包、验收/退回 |
| 11 | Q01 → Q04 → Q05 | 全量文档/契约门禁 → 正向验收 → 对抗验收；**必须先解决 BLOCK-01/02/03/04/05 与 TEST-01** |

如果主控先做 24 项中的“可独立完成”部分，建议优先 A01/A03/G03/G01/M02/M03/D01/D02/D03；G02/G05/G06/G07/A05/A06/D04–D08 的签收必须等对应前置和外部条件。**不要在没有 M07 的情况下把 D06/D07/G06 标 VERIFIED。**

---

## 8. 证据索引

| 主题 | 文件/位置 |
|---|---|
| 包基线/任务图/验收 | `/tmp/webots-execution-pack/webots-execution-pack/{README.md,00-EXECUTION.md,01-DECISIONS.md,02-CONTRACTS.md,03-TASK_GRAPH.yaml,04-ACCEPTANCE.md,05-DELIVERY.md,07-SOURCE_BASELINE.md}` |
| 本仓库冻结契约 | `reports/CONTRACT_BASELINE.md`（`webots-p0-v1`，含 0012–0019 表/工具/事件/错误命名） |
| 协议/工具 | `src/app.ts`、`src/mcp/tools.ts`、`src/mcp/room-files.ts`、`src/drive/tool.ts`、`src/mcp/auth.ts` |
| 身份/关系 | `src/domain/identity.ts`、`src/domain/agents.ts`、`src/domain/contacts.ts` |
| 群/消息/任务 | `src/domain/rooms.ts`、`src/domain/messages.ts`、`src/domain/tasks.ts`、`src/domain/deliveries.ts`、`src/domain/delivery-reminders.ts` |
| 事务/guard | `src/storage/transactions/runner.ts`、`src/storage/guards.ts`、`migrations/0001`–`0011` |
| 实时/事件 | `src/realtime/{hub,outbox,stream,presence,presence-timeline}.ts`、`src/events/*`、`src/mcp/stream.ts` |
| 文件 | `src/domain/room-files.ts`、`src/drive/*`、`src/app.ts:748` |
| 网页 | `src/web/*`、`scripts/verify-web.ts` |
| 测试 | `scripts/verify-protocol.ts`、`scripts/acceptance.ts`、`scripts/verify-drive.ts`、`scripts/verify-events.ts`、`scripts/verify-room-files.ts`、`scripts/verify-watch-claim.ts`、`scripts/lib/*` |
| 文档缺口 | `CLAUDE.md:7`、`docs/code-index.md:3`、README 第 13/14/18/19/20/30/353/484 行、`public/skills/agent-network-skills.md` 第 90/302/348 行 |

### 8.1 本次原始结果（未提交，位置在 `/tmp`）

- `/tmp/an-acceptance-baseline.log`：默认 `test:acceptance` 失败日志（113 项后 `关闭最后一个连接后成员显示离线`）。
- `/tmp/an-acceptance-short-ttl.log`：缩短 presence TTL 的诊断日志（284 项后 `grace 前不写下线`）。
- `/tmp/an-web-baseline.log`：`test:web` 1711 项通过。
- `/tmp/an-events-baseline.log`：`test:events` 339 项通过。
- `/tmp/an-roomfiles-baseline.log`：`verify-room-files` 187 项通过。
- `/tmp/an-watch-baseline.log`：`test:watch-claim` 通过（Python 12 tests OK）。

> 交付到最终 evidence 时必须脱敏（token、callback URL、消息正文、用户路径），并复制到仓库内可追溯位置；当前 `/tmp` 只用于本次 F0 核对。
