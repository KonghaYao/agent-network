# 长上下文性能审查与三波实施计划

- 状态：第 1 波实现完成，文档记录审查结论与计划
- 审查基线：`abd6603`（docs(reports): 记录 UI-WAVE-3 验收与限制）
- 分支：`fix/webots-parity-pack`
- 证据：本轮只使用静态审查 + 本地 small（10k 消息）基准；**没有生产环境实测**。未测量的倍数一律标注“推断/待基准”。

## 1. 结论摘要

长历史的主要成本不在单条 SQL 的索引缺失，而在三处叠加：

1. **服务端列表把正文搬进 JS 再丢弃。** `messages`、`timeline`、`getActorsByIds` 使用 `SELECT *`，每页把最多 256 KiB 的 `body` 以及 actor 的 `metadata` 读进进程；返回给页面的仍只是 512 B preview。
2. **timeline 每页对整个房间历史做双源排序。** `UNION ALL` 包住 messages 与 presence，再 `ORDER BY occurred_at DESC`，SQLite 必须建临时 B-tree；翻到第 N 页的成本与房间总消息量相关，而不是与页大小相关。
3. **客户端刷新是整表重建。** 每次事件都 `replaceChildren()`、重新挂 Markdown root、重算布局；同一批新消息还会被“最新页 + after 补拉”重复读取，事件风暴时放大为 O(N²) 布局读取。

第 1 波只做**不改语义**的服务端列投影与 delivery 覆盖索引；timeline 双源归并留在第 2 波，窗口化与缓存上限留在第 3 波。

## 2. 根因与优先级

### P0（本轮或下一波必须处理）

| # | 位置 | 问题 | 影响 | 处理 |
| --- | --- | --- | --- | --- |
| P0-1 | `src/domain/timeline.ts:141-198` | 双源 `UNION ALL` 后按 `occurred_at, commit_seq` 排序，`LIMIT` 之前必须物化并排序整个可见历史 | 时间线第 1/10/100 页成本近似相同且随房间历史线性增长；本地 10k 已约 3.6 ms/页（见 §5） | 第 2 波：双路游标归并 |
| P0-2 | `src/domain/messages.ts:1185/1196`（第 1 波后；改前 `1183/1194`） | `historyList` 两条分页 SQL 都是 `SELECT *`，读取 `body` | 每页多复制最多 50 × 256 KiB；payload 实际只有 preview | **第 1 波已修**：显式列投影 |
| P0-3 | `src/domain/timeline.ts:221/235`（第 1 波后；改前 `218/228`） | `materialize` 对 messages、presence 都是 `SELECT *` | 与 P0-2 相同，且时间线是网页人类默认路径 | **第 1 波已修**：两处显式列投影 |
| P0-4 | `src/domain/message-view-helpers.ts:66-73` | delivery 聚合按 `message_id IN (...) GROUP BY message_id, state`，只有 `(message_id)` 索引，claimed 时间需回表 | 每页一次聚合；高投递扇出时产生临时分组表 | **第 1 波已修**：`0039` 覆盖索引 |
| P0-5 | `src/web/chat-render-script.ts:507-523` | 每次刷新 `replaceChildren()` 并重建全部消息、Markdown root | 每次通知的 DOM/布局成本与已加载条数成正比 | 第 2 波：增量 DOM |
| P0-6 | `src/web/chat-session-script.ts:451-480` | 先取最新页，再用 `after` 追到最新页水位；两段在常见场景覆盖同一批消息 | 同一批新消息拉两遍 | 第 2 波：一次增量拉取 + 去重 |

### P1（第 1 波顺手修复或记录）

| # | 位置 | 问题 | 处理 |
| --- | --- | --- | --- |
| P1-1 | `src/storage/queries.ts:44-90`（第 1 波后） | `getActorsByIds` 为历史页取 actor 全行（含 `metadata`） | **第 1 波已修**：历史/时间线改用 `getActorsByIds` 的 `actor_id, kind` 窄投影；Agent 管理另用 `getActorManagementByIds` |
| P1-2 | `src/domain/rooms.ts:392-408` | reviewer 指出 `roomsList` 读整条 last message body | **复核：`abd6603` 已显式投影 `lm.preview/body_bytes/created_seq/created_at`（`rooms.ts:398-399`），列表不读 body**。本轮不改，基准与计划验证 |
| P1-3 | `src/domain/rooms.ts:325` | `roomGet` 用 `getMessage` 读整行（含 body） | 单房间详情，非列表路径；保持现状（任务约定） |
| P1-4 | `src/domain/tasks.ts:1833-1877` | `scope=mine` 先查任务，再对每条任务 `getRoom`/`getMember`/`buildTaskView`，N+1 | 第 2/3 波：批量装配；不在本轮范围 |
| P1-5 | `src/web/chat-scroll-script.ts:151-164` | 锚点 `firstVisibleChild` 线性扫描所有子节点并逐个 `getBoundingClientRect()` | 第 2 波：缓存首个可见节点/二分 |
| P1-6 | `src/web/chat-markdown-script.ts:114-138`、`chat-render-script.ts:139-146` | 每个气泡挂载/更新 Markdown 前后各读布局；配合整表重建形成 O(N²) | 第 2 波：批量测量、只处理视口附近 |
| P1-7 | `src/web/chat-stream-script.ts:406-450` | `notifications/resources/updated` 直接触发刷新，无合并/节流 | 第 2 波：按房间合并 + 单飞刷新（`refresh()` 已有串行合并，事件入口仍可风暴） |
| P1-8 | `src/web/chat-render-script.ts` | 消息列表没有 `content-visibility`，长列表全部参与布局 | 第 3 波：窗口化 + `content-visibility: auto` |
| P1-9 | `src/domain/messages.ts:969/998/1022` | 发送幂等回查仍 `SELECT * FROM messages`（按 sender+client id） | 写路径单行读取，非列表；记录，暂不改 |

## 3. 三波实施计划

### 第 1 波（本报告所在提交）：服务端低风险收益

- `historyList` 与 timeline `materialize` 显式列投影，不读 `body`。
- 历史/时间线 sender kind 只取 `actor_id, kind`；Agent 管理摘要单独投影，去掉 `metadata`。
- 新迁移 `0039_delivery_message_state_index.sql`：`(message_id, state, claimed_at, updated_at)`。
- 新增 `scripts/lib/perf-fixture.ts`、`scripts/verify-perf.ts`、`bun run test:perf`。
- **不改**排序/游标/分页语义，不改客户端。

预期收益：
- 列表页跨层复制的字节数从“正文大小”降为“preview 大小”。本地 10k fixture 的 payload 为 24.9 KB/页；真实 256 KiB 正文下，单页最多少读 12.5 MiB（推断/待生产分布基准）。
- delivery 聚合计划从“索引定位 + 临时分组/回表”变为覆盖索引范围扫描（已用 EXPLAIN 验证）。
- 风险：列投影漏字段会导致视图字段变 `undefined`；靠 typecheck + timeline/history 专项 + 协议/验收兜底。

### 第 2 波：timeline 双路归并与增量 DOM

- 服务端：把 messages、presence 两条 keyset 查询各取 `limit+1`，在 JS 中按 `(occurred_at, commit_seq)` 归并，保持现有 cursor 字段、snapshot、`has_more` 语义；不再对整个历史排序。需要新增/固定游标回归用例（首屏、翻旧页、after 追新、presence 与消息同毫秒）。
- 客户端：`renderMessageList` 改为按 message key 的增量 patch（首屏全量、后续 append/prepend/更新回执）；一次增量请求替代“最新页 + after 补拉”；事件按房间合并。
- 依赖：第 1 波的 EXPLAIN 守卫与 payload 基线；timeline 专项（G07/presence）必须先行覆盖。
- 风险：归并边界与游标快照不一致会造成重复/漏条；需要新旧实现对同一 fixture 的逐条对比。

### 第 3 波：窗口化、缓存上限与任务 N+1

- 客户端消息窗口化（保留可视区 ±N 页）、`content-visibility: auto`、Markdown root 数量上限、滚动锚点索引。
- 服务端 `tasks.scope=mine` 批量读取 room/member/task 视图；评估 `roomsList` 的 `r.*` 是否进一步收窄。
- 风险：窗口化改变“已加载历史”语义与滚动位置恢复；必须有长历史 UI 回归。

## 4. 基准设计

### 夹具

`scripts/lib/perf-fixture.ts`：

- `PERF_SCALE=small`：主房间 10,000 条消息、1,000 条 presence、10,000 条 delivery、21 个房间、24 个 actor；每 20 条一条 8 KiB 大消息，其余约 160 B。
- `PERF_SCALE=full`：100,000 / 10,000 / 100,000；每 20 条一条 2 KiB 大消息。**full 为手动运行**，不进入默认门禁。
- 所有时间/序号为固定偏移；先跑迁移，再单事务批量插入，最后 `ANALYZE`。
- 20 个 recipient，前 20 条 delivery 为 `claimed`（满足每 recipient 至多一条 claimed 的部分唯一索引），其余在 pending/completed/failed/cancelled 间轮转。

### 指标与断言

`scripts/verify-perf.ts` 通过 D1 兼容层的计数包装执行领域函数：

- 每个场景记录 p50/p95/min/max（默认 small 21 个样本，warmup 3）、整页 JSON 字节数、SQL 条数、返回条数。
- 场景：messages 第 1/10/100 页、timeline 第 1/10/100 页、rooms_list 第 1 页。
- `EXPLAIN QUERY PLAN` 捕获真实 SQL 后断言：
  - messages 分页走 `idx_messages_room_seq`，无 `SCAN messages`、无 `TEMP B-TREE`；
  - timeline 双源分别走 `idx_messages_room_seq` / `idx_room_presence_seq`，无全表扫描；当前仍允许并记录 `TEMP B-TREE`（第 2 波目标）；
  - rooms_list 走 `idx_room_members_actor`，last_message 走主键，不扫 messages；
  - delivery 聚合在 `PERF_EXPECT_INDEX=1` 下必须使用 `idx_deliveries_message_state` 且无 `TEMP B-TREE`；
  - 当前页 SQL 不得出现 `SELECT * FROM messages/actors/deliveries`。
- 基线模式：`PERF_BASELINE=1 PERF_EXPECT_INDEX=0`，把 `SELECT *` 与缺索引记为 note，用于在改动前留档。

### 阈值（门禁）

- 计划断言：必须全部通过（默认 `bun run test:perf` 即 strict）。
- 相对回归：同机对比基线，p95 ≥ 1 ms 的场景不得劣化 > 20%；p95 < 1 ms 的场景按绝对噪声带处理（允许 ±0.5 ms），避免把亚毫秒抖动当成回归；payload 不得增长 > 2%。
- 绝对护栏（small，参考机器）：messages 任一页 p95 < 2 ms；timeline 任一页 p95 < 25 ms；rooms_list p95 < 5 ms。当前实测远低于护栏，留出 CI 抖动空间。
- 字节护栏：单页 payload < 200 KiB（50 条 × preview 上限 + 回执/提及），与正文大小无关。
- full（100k）：只记录，不设默认门禁；若纳入 CI，建议 timeline p95 < 250 ms（待基准确认，当前未测）。

## 5. 第 1 波前后实测（small / 10k）

同一台机器、同一 fixture、同一脚本；基线为 `abd6603` 工作区（未改业务代码），结果提交为第 1 波代码 + `0039`。原始 JSON：

- `reports/evidence/perf-baseline-small.json`
- `reports/evidence/perf-wave1-small.json`

| 场景 | 基线 p95 (ms) | 第 1 波 p95 (ms) | 基线 payload (B) | 第 1 波 payload (B) | SQL 条数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| messages 第 1 页 | 0.420 | 0.254 | 24,896 | 24,896 | 6 |
| messages 第 10 页 | 0.217 | 0.301 | 24,896 | 24,896 | 6 |
| messages 第 100 页 | 0.424 | 0.559 | 24,896 | 24,896 | 6 |
| timeline 第 1 页 | 3.884 | 3.846 | 26,047 | 26,047 | 6 |
| timeline 第 10 页 | 3.786 | 4.073 | 26,047 | 26,047 | 6 |
| timeline 第 100 页 | 3.750 | 3.812 | 26,047 | 26,047 | 6 |
| rooms_list | 0.159 | 0.123 | 28,772 | 28,772 | 1 |

解读：

- messages/timeline 的 payload 与 SQL 条数完全不变，证明返回契约未变。
- 第 1 波把 2 条 `SELECT *`（messages、actors）消除；delivery 聚合计划由临时分组变为覆盖索引（EXPLAIN 断言通过）。**在 8 KiB 大消息、50 行/页的本地夹具上，messages 各页 p95 在 0.18–0.56 ms 间跨运行波动，耗时差落在噪声带内，不能据此声称生产倍数。**
- timeline 的 3–4 ms 主要来自双源临时排序，列投影只减少回表字节；第 2 波才有数量级变化（推断）。
- rooms_list 在 `abd6603` 已做 last_message 投影，因此本轮无计划/ payload 变化；0.159→0.123 ms 属噪声。
- 同一改动连续两次运行：messages 第 1/10/100 页 p95 分别为 0.230/0.182/0.414 ms 与 0.254/0.301/0.559 ms；亚毫秒场景的排序稳定性有限，报告取最近一次并保留该波动说明。

### 未测量 / 限制

- 未跑 `PERF_SCALE=full`（100k）的前后对比；full 夹具可用，但运行时间与磁盘占用更高，标记 manual。
- 未在生产数据上测量；真实 body 分布、delivery 扇出、SQLite page cache 命中率都会影响绝对值。
- 未测浏览器渲染；P0-5/P0-6/滚动锚点的改善留给第 2 波 UI 基准。
- 本地耗时包含 Bun D1 适配层与领域函数，不是 MCP/HTTP 端到端延迟。

## 6. 第 2 波依赖与验收入口

第 1 波必须先合入并保持以下契约，供第 2 波做新旧对比：

- `historyList` 的 `items/next_cursor/has_more/snapshot/authorization` 字段与游标编码不变。
- timeline 的 `timeline_items/timeline_next_cursor/timeline_has_more/timeline_snapshot/timeline_resume_cursor` 不变；presence 与消息的展示 key 不变。
- `scripts/verify-perf.ts` 的计划断言与 payload 护栏保持可执行；第 2 波应把 timeline 的 `TEMP B-TREE` note 升级为硬失败。
- G07/presence/timeline 专项继续保持通过；任何双源归并都先补“同毫秒、after 追新、成员边界”用例。
