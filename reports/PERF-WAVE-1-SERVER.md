# PERF-WAVE-1-SERVER：历史查询列投影与 delivery 覆盖索引

- 状态：READY_FOR_REVIEW
- 基线：`abd6603`（docs(reports): 记录 UI-WAVE-3 验收与限制）
- 实现提交（结果 SHA）：`108f3fe`（perf(server): 历史查询列投影与 delivery 索引）+ `0787bd8`（test(perf): 长历史基准夹具与查询计划守卫）
- 分支：`fix/webots-parity-pack`
- 部署：未部署。按约定由主控执行发布；未建 PR。

## 1. 改动

### A. 历史/时间线显式列投影

- `src/domain/messages.ts`
  - `historyList` 的 before/after 两条分页 SQL 从 `SELECT *` 改为显式列：
    `message_id, room_id, sender_id, created_seq, preview, body_bytes, created_at, reply_to, root_id, hop`。
  - 不读取 `body`；分页、排序、游标、`snapshot`、`has_more` 逻辑未改。
- `src/domain/timeline.ts`
  - `materialize` 对消息使用同一列投影，对 presence 显式选择
    `presence_event_id, room_id, agent_id, transition, occurred_at, recorded_at, timeline_seq, time_basis`。
  - **未改** `keyPage` 的 `UNION ALL`、排序与游标；双源归并留给第 2 波。
- `src/domain/message-view-helpers.ts`
  - 新增 `HistoryMessageRow` 与 `HISTORY_MESSAGE_COLUMNS`，messages/timeline 共用同一投影，避免两处漂移，也避免 messages ↔ timeline 的运行时循环依赖。

### B. actor 查询分离

- `src/storage/queries.ts`
  - `getActorsByIds` 现在只返回 `actor_id, kind`（`ActorKindRow`），供历史/时间线判定 `sender_kind`。
  - 新增 `getActorManagementByIds`，只取 Agent 管理摘要需要的字段
    （`actor_id, kind, agent_session_id, name, archived_at, archived_by, disabled_at, disabled_by, disabled_reason`），不再读取 `metadata`。
- `src/domain/agents.ts`
  - `network_agents_get` 改用 `getActorManagementByIds`；`agentSummaryView`/`shareUrl` 收窄到实际读取的字段。返回结构不变。

### C. delivery 覆盖索引

- 新增正式迁移 `migrations/0039_delivery_message_state_index.sql`：
  `CREATE INDEX idx_deliveries_message_state ON deliveries(message_id, state, claimed_at, updated_at)`。
- 现有迁移未修改；不新增 guard 表、不改写入事务、不改状态机。
- 预期让 `deliveryStatesFor` 的 `WHERE message_id IN (...) GROUP BY message_id, state` 走覆盖索引，避免临时分组表与回表。

### D. 基准与门禁

- 新增 `scripts/lib/perf-fixture.ts`：固定分布、直接 SQLite 批量插入，支持
  `PERF_SCALE=small|full`（10k / 100k 消息）。
- 新增 `scripts/verify-perf.ts`：EXPLAIN QUERY PLAN 断言、分页 p50/p95、payload 字节、SQL 条数；small 默认 21 个样本。
- `package.json` 新增 `test:perf`（`PERF_EXPECT_INDEX=1`）。
- 方案与阈值见 `reports/PERF-REVIEW.md`。

### 复核但不改

- `src/domain/rooms.ts` 的 `roomsList` 在基线 `abd6603` 已经显式投影
  `lm.preview / lm.body_bytes / lm.created_seq / lm.created_at`（`rooms.ts:398-399`），列表不读取 last message 的 body；本轮没有为改而改。`roomGet` 仍按任务约定保持现状。
- `messages` 发送幂等回查（`messages.ts:969/998/1022`）仍是单行 `SELECT *`；不在列表热路径，未改。

## 2. 基准对比（small / 10k）

同机、同 fixture、同脚本；基线为 `abd6603` 工作区，优化后为本次改动 + `0039`。
原始 JSON：`reports/evidence/perf-baseline-small.json`、`reports/evidence/perf-wave1-small.json`。

| 场景 | 基线 p95 (ms) | 优化后 p95 (ms) | payload 基线/后 (B) | SQL 条数 |
| --- | ---: | ---: | ---: | ---: |
| messages 第 1 页 | 0.420 | 0.254 | 24,896 / 24,896 | 6 |
| messages 第 10 页 | 0.217 | 0.301 | 24,896 / 24,896 | 6 |
| messages 第 100 页 | 0.424 | 0.559 | 24,896 / 24,896 | 6 |
| timeline 第 1 页 | 3.884 | 3.846 | 26,047 / 26,047 | 6 |
| timeline 第 10 页 | 3.786 | 4.073 | 26,047 / 26,047 | 6 |
| timeline 第 100 页 | 3.750 | 3.812 | 26,047 / 26,047 | 6 |
| rooms_list | 0.159 | 0.123 | 28,772 / 28,772 | 1 |

结论与限制：

- payload 与 SQL 条数不变，说明返回契约、分页与聚合次数未变。
- 守卫确认：当前页查询不再出现 `SELECT * FROM messages/actors/deliveries`；delivery 聚合使用
  `idx_deliveries_message_state` 且无 `TEMP B-TREE`；messages/rooms_list 无全表扫描或临时排序。
- **本夹具每 20 条一条 8 KiB 大消息，messages 各页 p95 跨运行在 0.18–0.56 ms 波动，列投影的耗时差落在噪声带内，不能据此声称生产倍数。** 真实 256 KiB 正文下单页最多少复制约 12.5 MiB（推断/待生产分布基准）。
- 同一改动连续两次运行：messages 第 1/10/100 页 p95 = 0.230/0.182/0.414 ms 与 0.254/0.301/0.559 ms；阈值对 <1 ms 场景使用 ±0.5 ms 绝对噪声带。
- timeline 的 3–4 ms 仍由双源临时排序主导；第 1 波只减少回表字节，数量级改善依赖第 2 波。
- rooms_list 基线已投影，因此 0.159→0.123 ms 属噪声，不作为收益声明。
- 未跑 full（100k）前后对比；命令保留为手动项。

## 3. 门禁

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run test:protocol` | 通过，991 项 |
| `bun run test:acceptance`（短 presence 窗口） | 通过，2718 项 |
| `bun run test:perf`（small） | 通过，19 项 |
| `bun scripts/q01-upgrade-check.ts` | 通过，24 项（迁移总数 35，序列到 0039） |
| G07 / presence / timeline 专项 | 由 `test:acceptance` 内的 presence、group policy/history 用例覆盖并通过（见验收日志） |

迁移列表断言同步更新：

- `scripts/lib/feedback-unit.ts`（协议验收中的旧库升级）
- `scripts/lib/task-create-replay-unit.ts`（D01 旧库重放）
- `scripts/q01-upgrade-check.ts`（Q01 升级检查，0036–0039）

## 4. 限制

- 基准为本地 SQLite + Bun D1 适配层 + 领域函数，不含 MCP/HTTP 网络与浏览器渲染；不能外推为端到端延迟。
- 未在生产库上执行 `0039`。在大 `deliveries` 表上建索引会持有写锁并耗时，部署时需按主控窗口执行；索引只读优化，不回填数据。
- 未测 100k（full）与真实 256 KiB 正文分布；相关收益标注为推断。
- `timeline` 双源归并、客户端增量 DOM、滚动锚点与 `content-visibility` 均未在本轮修改。
- 未部署、未建 PR、未 force push。

## 5. 第 2 波依赖

- 保持 `historyList` 与 timeline 的返回字段、游标编码、snapshot 语义不变；第 1 波的列投影常量应作为时间线物化的唯一消息投影。
- `bun run test:perf` 继续作为计划守卫；第 2 波把 timeline 的 `TEMP B-TREE` 从 note 升级为硬失败，并新增“同毫秒、after 追新、presence 与消息交错”的归并用例。
- 客户端增量 DOM 依赖当前 timeline item key 与 `timeline_resume_cursor`；本轮未改这些契约。
