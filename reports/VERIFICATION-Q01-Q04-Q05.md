# Q01 / Q04 / Q05 与自动 @ 独立验证报告

| 字段 | 值 |
|---|---|
| 结论 | **PASS** |
| 验证 SHA | `0030c7974bd04e6f85f16976b86100f344d26531`（`docs: 记录 Agent 群消息自动 @ 语义与验收`） |
| 分支 / 工作树 | `fix/webots-parity-pack` / `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 开工状态 | `git status --porcelain=v1 -b` 无改动；`git rev-list --left-right --count origin/fix/webots-parity-pack...HEAD` = `0 0` |
| 验证者 | 独立验证会话（未参与 Q01/Q04/Q05 与自动 @ 实现） |
| 契约版本 / 迁移版本 | `webots-p0-v1` / `0038_ownerless_room_guard.sql`（34 个迁移，无新增或修改） |
| 主门禁环境 | Bun 1.4.2，macOS；`PORT=8792`、`HOST=127.0.0.1`、`DATA_DIR=/tmp/agentnet-final-verify/data`、`PUBLIC_ORIGIN=http://127.0.0.1:8792`、`AGENTNET_URL=http://127.0.0.1:8792`；服务端与测试进程一致使用 `AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000` |
| 生产影响 | 无。未部署、未访问生产、未创建 PR、未创建生产测试数据；临时服务、数据库、日志与脚本只在 `/tmp` |

## 0. 审查范围

本轮独立复核 Q01（文档/工具/CLI 对齐与旧库升级）、Q04（桌面移动端正向验收）、Q05（并发故障与越权对抗）以及 Agent 群消息自动 @ 和人类附件自动 @ 恢复。所有测试使用合成身份与临时数据库；报告不记录 token、凭据、连接串或消息正文。

## 1. 门禁实测

| # | 命令 | 实测结果 | 结论 |
|---|---|---|---|
| 1 | `bun run typecheck` | `EXIT=0`，无诊断 | PASS |
| 2 | `AGENTNET_URL=http://127.0.0.1:8792 bun scripts/q01-doc-check.ts` | `Q01 文档/工具一致性检查通过: 48 项` | PASS |
| 3 | `bun scripts/q01-upgrade-check.ts` | `Q01 升级检查通过: 24 项` | PASS |
| 4 | `bun scripts/verify-q04.ts` | `Q04 PASS checks=176`；三档视口 × 浅色/暗色、键盘、触摸、IME 均执行 | PASS |
| 5 | `Q05_SEED=20261108 bun scripts/verify-q05.ts` | `Q05 PASS · checks=24538 · 场景=10 · 失败=0 · 失败场景=0 · 39.8s`；906 轮 | PASS |
| 6 | `AGENTNET_URL=... bun -e "import { runAutoMentionAcceptance } ..."` | 73 项通过 | PASS |
| 7 | `AGENTNET_URL=http://127.0.0.1:8792 bun run test:protocol` | `协议验收通过: 991 项` | PASS |
| 8 | `AGENTNET_URL=http://127.0.0.1:8792 ... bun run test:acceptance`（短 presence） | `端到端验收通过: 2688 项` | PASS |
| 9 | `bun run test:web` | `浏览器验收通过 2015 项`；`无未捕获页面错误` | PASS |
| 10 | `bun run test:events` | `MCP Events 验收通过: 339 项` | PASS |
| 11 | `AGENTNET_URL=http://127.0.0.1:8792 bun run test:drive` | `drive checks passed: 52` | PASS |
| 12 | 新库迁移 / SQLite 检查 | 34 个迁移全部应用；`PRAGMA integrity_check` = `ok`；`PRAGMA foreign_key_check` 0 行 | PASS |

`0036_device_pairing_sync.sql`、`0037_room_lifecycle.sql`、`0038_ownerless_room_guard.sql` 的最近提交分别是 Q02/G06 的既有实现提交，本轮没有改动；`git diff 89572d4..HEAD -- migrations` 为空。

### 1.1 Q05 每场景轮数与断言

| 场景 | 轮数 | 通过 | 失败 | 断言 |
|---|---:|---:|---:|---:|
| messages | 100 | 100 | 0 | 2900 |
| claim-accept | 100 | 100 | 0 | 3800 |
| task-transfer-race | 100 | 100 | 0 | 2484 |
| review-race | 100 | 100 | 0 | 2600 |
| file-binding | 100 | 100 | 0 | 2300 |
| contacts | 100 | 100 | 0 | 2800 |
| devices | 100 | 100 | 0 | 2200 |
| agent-transfer | 100 | 100 | 0 | 3150 |
| owner-transfer | 100 | 100 | 0 | 2174 |
| faults | 6 | 6 | 0 | 119 |
| 合计 | 906 | 906 | 0 | 24538 |

报告与仓库证据 `reports/evidence/q05/q05-summary.json` 记录的是另一次运行：`24,548` 项，其中 `owner-transfer` 为 `2,184`。本轮实测少 10 项，原因见 §5。

### 1.2 既有签收状态

`reports/D04.md`、`D05.md`、`D06.md`、`D07.md`、`D08.md`、`Q02.md`、`G06.md`、`A06.md` 仍为 `VERIFIED`；`reports/VERIFICATION-D04-D08.md` 与 `reports/VERIFICATION-Q02-G06-A06.md` 的 PASS 结论未被本轮改动回退。

## 2. Q01：文档、工具面与旧库升级

1. `q01-doc-check` 实测 `tools/list` 为 129 个唯一工具、无重复；README、CLAUDE、功能矩阵、代码索引、技能文件、CLI 与 Harness 未引用未注册工具。
2. README 与 CLAUDE 的当前计数与 HEAD 实测一致：protocol 991、acceptance 2688、web 2015、events 339、drive 52、迁移 34、工具 129、任务工具 32。`reports/Q01.md` 中的 2615/2012 是 Q01 实现 SHA `44e730b` 时的历史计数；自动 @ 合入后 acceptance 增加 73 项、web 增加 3 项，所以当前为 2688/2015。该差异有明确来源，不是伪造。
3. `docs/code-index.md` 无 `../../` 祖先路径；对其路径令牌做存在性扫描，除通配模式 `src/web/*.ts` 外无缺失文件。README 中的 `src/mcp/subscriptions.ts`、`src/realtime/bus.ts` 位于“已删除旧订阅”历史清单，不是可点击的现行入口。
4. `docs/feature-matrix.md` 覆盖 P0 的 Web → MCP → domain/权限 → 事件 → CLI/技能 → 验收映射，并单列 P1 未实现：A02、A04、G04、M01、M04、M05、M06、M08、M09、Q03、Q06；没有把这些能力宣称为已完成。
5. 技能一致性：`skills/list` 返回 1 个技能，URI 正确；`SKILL.md` digest 与 `src/mcp/skill.ts` 正文一致；`resources/read` 正文一致；静态技能与主技能的“Markdown 写法”和“multitask 异步分发”section digest 一致。
6. 旧库升级：`q01-upgrade-check` 从 `0035_task_recovery.sql` 合成旧库升级到 `0038`，恰好应用 0036/0037/0038；34 个迁移顺序正确；`integrity_check=ok`、`foreign_key_check` 无违规；旧 `credentials` 只回填 `devices`，不新增 credentials/actors/members；旧配对保持 pending；历史无主群仍 `owner=NULL` 且未解散；`guard_owner_missing` / `guard_room_dissolved` 只接受 `x=0`；旧审计行保留。迁移文件中没有虚构 owner、好友同意或验收记录。
7. 已知限制：Q01-T01 是对敏感操作的抽样（Web 操作后以 MCP/SQLite 对账），没有为 129 个工具逐一做 Web/MCP 双入口测试；Q04 的 P1 路径也未覆盖。这是任务包认可的剩余范围。

## 3. Q04：桌面移动端正向验收

1. 在 HEAD 重跑 `bun scripts/verify-q04.ts`，176 项全部通过，包含：
   - 1280×900、768×1024、390×844 三档 × 浅色/暗色；390px 单栏、侧栏隐藏、返回箭头、`body.page-room`；桌面/平板双栏。
   - 键盘：Tab 聚焦、Esc 关闭建群弹窗、遮罩关闭、Shift+Enter 只换行、Enter 发送。
   - 中文输入法：组合期间 Enter 不提交、组合内容保留、`compositionend` 后短暂守卫、守卫结束后 Enter 正常发送。
   - 触摸：返回会话列表、打开/关闭建群弹窗、触摸发送。
   - 空态、列表失败可读错误与重试恢复。
2. 群/联系人/设备/任务主链均通过 UI 操作并以 MCP/SQLite 对账：owner 不能直接退群（仍为 owner）、无主群加入返回 `CONFLICT/owner_missing` 且 UI 不使用成功文案、设备配对/挑战重放拒绝/单设备撤销/旧 token 失效、任务创建/接受/进度/阻塞/恢复/转交/交接包/提交 v1/退回/v2/逐项验收、解散归档只读、Agent 管理权交接与旧管理者失权。
3. 无横向溢出：`q04-harness.ts` 的 `noHorizontalOverflow` 在文档或 body 宽度超过视口时抛出错误；三档 × 明暗共 6 个上下文均未抛错（该辅助函数不计入 176 项断言，但失败会使整轮中止）。
4. 证据目录 `reports/evidence/q04/` 的 17 张 PNG 尺寸与三档视口一致；浅色背景约 `#ededed`/`#f7f7f7`，暗色约 `#191919`/`#2b2b2b`。OCR 扫描未发现 token、Bearer、连接串或凭据模式；设备配对截图的挑战/二维码区域由不透明色块遮蔽。报告的每个分组都有操作、观察和服务端对账，不只以截图代替动作；页面断言明确检查通话/语音/视频/收藏/置顶/转发/撤回入口不存在，未伪造 P1。
5. 重跑会重写截图（测试 ID/时间不同）。验证者已在重跑后从 `/tmp` 备份逐字节恢复 `reports/evidence/q04/`，恢复后哈希与开工前一致，工作区保持干净；仓库内证据仍是 Q04 实现 SHA `4644a0f` 的原始证据，未改写报告计数或结论。

## 4. Q05：并发、故障与越权对抗

1. Harness 是真实并发：`q05-harness.ts` 的 `burst` 先注册全部 Promise，再统一放行，使用 `Promise.allSettled`；各场景每轮 100 个并发工具调用，另有独立连接与身份。固定种子 `20261108` 派生轮次随机数；`--scenario` / `--round` 支持独立重放。
2. 完整运行 906 轮、0 失败；每轮结束读取权威 SQLite 检查单 active assignment、单群主、单 pending submission、无双 active 关系/拉黑、无悬挂文件引用、任务卡唯一、Agent 单有效运行凭据、无重复投递、accepted 任务有独立验收记录。
3. 竞争分布与报告一致：task-transfer submitted 24 / transferred 17 / blocked 34 / cancelled 25；review accept 100、重复 accept 2,000 次全部拒绝、独立 return 路径 100；file-binding 提交成功 50 / 回滚 50 / 移除 100；contacts 拉黑先到 100 次接受被拒；devices 撤销后 10,000 次调用全部 `CREDENTIAL_INVALID`；agent-transfer 交接接受 100、旧管理者重发成功 0、确定性重发后失效 50；owner-transfer 解散 71 / 转让 29 / 原 owner 保留 0。
4. 故障注入 6/6、119 项通过：事务回滚、提交后响应丢失（同 request_id / client_message_id 重试同一结果）、outbox 持锁与同 DATA_DIR 重启补发、重启后任务/提醒/claimed 投递恢复、`execution_unknown` 重启后仍 blocked 且不自动重跑、旧设备凭据撤销后读写与流全部失效。日志中的 `q05 response dropped after commit` 是测试代理主动注入的响应丢失，不是产品错误。
5. 独立补跑 `Q05_SEED=20261108 bun scripts/verify-q05.ts --scenario=owner-transfer --rounds=10`，10/10 通过、219 项场景断言（总 230 含配额检查），分布解散 6 / 转让 4 / 原 owner 保留 0，证明单场景可重放。
6. `Q05-OBS-01`（P1，Q06 范围）属实：`src/domain/rooms.ts` 的房间上限闸门统计 `room_members.status='active'`，没有排除 `rooms.dissolved_at IS NOT NULL`；已解散群仍占用 `activeRoomsPerActor=200` 额度。本轮按用户边界记录为 Q06 容量问题，不据此判 Q05 FAIL。

## 5. 自动 @：Agent 群消息与人类附件

### 5.1 Agent 群消息自动 @

领域实现位于 `src/domain/messages.ts` 的 `agentAutoMentionPlan`，`messageSend` 统一调用；触发条件为 Agent 发送者、group、正文非空、未提供 `invoke`、`mentions` 为空。目标为最近 20 条内不同 actor、仍 active、按发送者历史边界可见、名字在当前 active 成员中唯一的发送者；跳过自己、同名歧义、目标移除、正文上限。

权威 SQLite 抽查（合成数据）：

- 人类目标：自动 @ 生成 `text` 提及与 `mention_reminder` inbox 事件，delivery 数为 0。
- Agent 目标：自动 @ 生成 `text` 提及，delivery 数为 0；发送者与目标 `pending_count` 均为 0。
- direct 房间：不追加、不记录 mentions、无 delivery。
- 正文已包含该目标 @：不重复追加，只保留一条提及，无 delivery。
- 显式 `invoke`：只投递指定 Agent，自动 @ 不追加；`invoke: []` 不追加、无 mentions、无 delivery；非空 `mentions` 不追加、只保留显式人类提醒、无 delivery。
- 前一条发送者被移除：回退到更早 active 成员；没有更早成员：不追加。
- 同名歧义：跳过、不记录 mentions、无 delivery。
- 正文接近上限：追加会超过 `LIMITS.messageBodyBytes` 时跳过，原正文按 262,144 字节发送、无 mentions、无 delivery。
- `request_id` / `client_message_id` 重放：返回原消息与原文，正文只追加一次、不新增 delivery。
- 自动 @ 不推进房间 `head_seq`：抽查的自动提及房间 `head_seq` 与最大消息 `created_seq` 完全相等。

专项 `runAutoMentionAcceptance` 73 项全部通过，覆盖上述路径；`test:acceptance` 2688 项与 `test:web` 2015 项也包含自动 @ 回归。

### 5.2 人类附件自动 @ 恢复

`src/web/chat-upload-script.ts` 的 `composerAutoMention` 只在当前群恰有一个 `kind='agent'` 且名称精确等于维护员的 active 成员、且不是发送者时追加；direct、同名多个、正文已包含该字符串时不追加；附件与自动 @ 按 `room_id` 读取。`test:web` 实测通过“唯一精确维护员只追加一次”“正文已有不重复”“同名不追加”“单聊不追加”“切房不串”“发送快照包含当前群附件与自动 @”等断言。

### 5.3 边界观察（P2，不构成 P0/P1）

当前实现和 README 的“已有 @”口径是“正文已包含该目标的 @”。独立探针发现：若正文已经 @ 了另一个成员，自动 @ 仍会追加前一条发送者作为 `text` 提及/人类提醒；它不会新增 delivery，不会增加 `pending_count`，不会推进 `head_seq`，原 @ 目标的投递数仍为 1。若验收口径要求“正文出现任意 @ 就完全不追加”，这是一个低风险语义缺口；本轮按仓库文档的 target-specific 口径记录为 P2 残余限制，不判 FAIL。

### 5.4 变更面

自动 @ 没有新增迁移、没有新增 `src/` 文件；变更集中在 `src/domain/messages.ts`、`src/web/chat-upload-script.ts`、`src/mcp/skill.ts`、`src/mcp/tools.ts`（描述）与 `public/skills/agent-network-skills.md`；Q04 的两处 UI 修复为 `src/web/join.ts` 与 `src/web/chat-script.ts`。`src/contracts` 与 `migrations` 未改。

## 6. 跨切面检查

- 工具面 129；任务工具 32；迁移 34；技能 digest 一致。
- `reports/Q01.md`、`Q04.md`、`Q05.md`、`AUTO-MENTION.md` 在签收前为 `READY_FOR_REVIEW`；D04–D08、Q02、G06、A06 为 `VERIFIED`，未回退。
- 报告与证据未发现 token、Bearer、连接串或消息正文；Q04 截图 OCR 无凭据模式。
- `git diff --check` 退出码 0（无尾随空行问题）；验证结束时工作区无改动，分支与 `origin/fix/webots-parity-pack` 同步。
- 未发现未关闭的 BUG-P0/BUG-P1、任务静默丢失、双 owner、旧执行者/旧设备仍可写、文件越权、自动通过验收或重复不可逆副作用。

## 7. 缺陷与残余限制

1. **Q05 计数差 10**：实测 `24,538`，报告/证据 `24,548`；差异只在 `owner-transfer`（2,174 vs 2,184）。该场景对每个失败操作有条件追加“失败有稳定错误码”断言（`scripts/lib/q05-owners.ts:228-233`），固定种子下的 OS 调度会改变四路竞争中哪些操作成功/失败，从而改变断言条数；100 轮终态分布与全部不变量一致，属可接受的调度差异。
2. **自动 @ 的“已有其他成员 @”边界**：见 §5.3，P2；无隐式 delivery、无 pending 增量、无 head 推进。
3. **Q05-OBS-01**：已解散群占用 activeRoomsPerActor 额度，属 Q06 P1 容量范围，本轮不修闸门。
4. **Q04 证据为历史证据**：仓库内截图仍是 `4644a0f` 的原始证据；HEAD 重跑 176 项通过后已逐字节恢复，未把新截图写入仓库。
5. **既有 P1 缺口**：A02、A04、G04、M01、M04、M05、M06、M08、M09、Q03、Q06；D05 的 M04 原文交接、D08 外部停付、G06 M09 媒体终止、A06 外部授权、Q02 真实相机/多实例等限制沿用各自验证报告，未在本轮伪造。
6. **Q01-T01 为抽查**：未为 129 个工具逐一建立 Web/MCP 双入口测试；Q04 的 P1 路径未覆盖。

## 8. 最终判定

在 `0030c7974bd04e6f85f16976b86100f344d26531` 上，typecheck、Q01 文档 48、Q01 升级 24、Q04 176、Q05 906 轮/0 失败、自动 @ 73、protocol 991、acceptance 2688、web 2015、events 339、drive 52、迁移 34 与完整性检查全部通过；Q01/Q04/Q05 与自动 @ 的验收证据成立，P1 缺口如实保留，未发现 P0/P1 缺陷。

**PASS**
