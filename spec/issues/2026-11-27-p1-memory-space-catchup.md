# P1：记忆空间首次创建后不补历史，`no_space` 窗口被静默跳过

**状态**：已修复，待 PR/CI。
**优先级**：P1。
**类型**：错误 / 数据完整性。
**创建日期**：2026-11-27。
**来源**：用户报告：Peri 维护员2 有 57 条历史消息，记忆为空；维护员误查近名账号并解释为“近期没有新消息”。
**确认方式**：explorer 只读确认 + plan 设计复核（基线 `1b8ccc6`）。

## 确认证据

- 建空间只插 space/transition，不登记历史回填：`src/memory/provision.ts:198-248`、`:312-353`。
- 回填 fanout 只返回已有 active space 的成员：`src/memory/backfill-window.ts:211-233`。
- 无 space 的消息只 `no_space++` 后继续，扫描游标已经推进：`src/memory/backfill.ts:523-535`、`:472-479`。
- 生产回填默认关闭：`src/bun/main.ts:303-317`；`network_memory_status` 只显示 jobs/context，没有“历史未回填”状态。
- 只读 insight 无 space 返回 `no_space`：`src/memory/insight/service.ts:162`；本地 pack 同样：`src/memory/injection.ts:273`。
- 计划中的用户可观察路径：Agent 已有 57 条历史消息但无 space → login/provision 创建 space → 没有 per-space 历史 catch-up → `network_memory_context_pack`/`recall` 为空，而全局回填游标已越过这些消息。

## 根因链

1. 新 Agent 的空间由 login/首消息/6h sweep 创建；创建事务只写 `memory_spaces` 与 transition。
2. 全局回填只处理“已有 space 的成员”，无 space 的消息记 `no_space` 并推进全局窗口游标，不保留待补区间。
3. 因此空间出现后，旧消息没有任何独立游标可重放；全局游标已越过，后续窗口不会回补。
4. 只读接口把“没有空间/没有本地经历”统一表现为空/`no_space`，调用方容易解释成“近期没有新消息”，而不是“历史未回填”。

## 影响面

- 用户影响：新建记忆空间的 Agent 看不到加入前的历史；对“57 条消息但记忆为空”给出错误解释。
- 受影响模块：`src/memory/provision.ts`、`backfill-window.ts`、`backfill.ts`、`src/bun/main.ts`、`src/mcp/memory.ts`/`memory-insight.ts` 状态文案、skill 记忆纪律。
- 可规避：手工 replay/显式 catchup，但普通用户不会知道；需要代码修复。

## 修复方案

- 范围（Batch B，按 `.peri/plans/memory-gap-fix.md` §3）：
  - 复用 `memory_cursors`，新增 `space_catchup_rowid` / `space_catchup_done` 两个 cursor kind，不新增表/迁移。
  - backfill runner 惰性发现没有 `space_catchup_done=1` 的 active space；按每个房间的可见边界（direct 全历史、group full、from_join `joined_seq`、archive `archive_head_seq`）以 `rowid` 分页扫描；每条仍走现有 `authorizeSourceRead`、`runIdempotent`、experience dedupe。
  - 空间首次 catch-up 与全局 `MEMORY_BACKFILL` 解耦：`MEMORY_SPACE_CATCHUP` 默认开启；`MEMORY_BACKFILL` 代码默认仍关闭，生产需显式 `1` 才持续捕获新消息。启动时对 `MEMORY_BACKFILL!='1'` 打明确 warning。
  - 单轮有界：最多 2 个空间、每空间 500 条；完成后写 done；未完成下一轮继续。
  - `no_space` 不改为卡住全局游标（会反复重扫）；通过 per-space cursor 从 0 开始保证旧消息不漏。
  - 状态/文档：`network_memory_status` 或 insight `no_space` 可区分“历史未回填/回填关闭”；skill 明确 `no_space ≠ empty`。
- 明确不做：不新增/重建 `memory_jobs` CHECK，不改 `memory_spaces` schema，不做成员重新加入/策略放宽后的自动重扫（用 replay，另开记录），不改变长期保留策略。
- 回归测试：
  - 无 space 跑一轮 → `no_space>=1` 且无 intent；建 space → catch-up 产生 intent/experience；再跑 → 零新增且 done。
  - direct/full/from_join/archive 边界与 `authorizeSourceRead` 授权。
  - 单轮空间/消息预算、失败不写 done、下一轮续跑。
  - 旧空间/已 done 空间不重复；`MEMORY_SPACE_CATCHUP=0` 不运行。
  - 协议/工具状态文案与 baseline（技能正文有改动时重录）。

## 验收标准

1. Agent 有历史消息但无 space：login/provision 后，`network_memory_context_pack`/`recall` 最终能看到这些历史，且不出现重复 experience。
2. `no_space` 不再被文档/状态解释成“没有新消息”；状态能区分 space 缺失、历史待补、回填关闭。
3. `bun run test:memory-backfill`、`test:memory-integration`、`test:memory-contracts`、`test:memory-provision`、`test:protocol`、`typecheck` 通过；不新增迁移。
4. 生产默认 `MEMORY_SPACE_CATCHUP=1`、`MEMORY_BACKFILL=1` 的推荐配置写入 README/部署文档。

## 验证记录

- `bun run typecheck`：通过。
- `bun run test:memory-backfill`：通过；拆分后三个脚本分别 125 / 56 / 60 项断言（合计 241），含预算续跑、失败不写 done、扫描期间空间停用不写 done/done 游标。
- `bun run test:memory-provision`：75 项通过。
- `bun run test:memory-integration`：288 项通过。
- `bun run test:memory-contracts`：92 项通过。
- `bun run test:memory-hindsight`：190 项通过；`HINDSIGHT_REAL_TEST!=1` 时 real contract 按设计跳过。
- `bun run test:memory-injection`：88 项通过。
- `bun run test:memory-insight`：insight 434 项、timeline 112 项通过；包含 `entities.backfill`、`disabled` 优先于 `completed` 断言。
- `bun run test:ts-monitor`：615 项通过。
- `bun run test:client`：362 项通过。
- `bun run test:mcp-parity`：通过；重录后 tools 143、toolset `e568b447…`、listing `a1b24bb4…`、总 digest `02df1ef1…`。
- 本地临时服务（`PORT=8793`、临时 `DATA_DIR`）`AGENTNET_URL=http://127.0.0.1:8793 bun run test:protocol`：1139 项通过。
- 行数：`src/memory/backfill.ts` 963、`src/memory/backfill-space-catchup.ts` 185、`src/memory/backfill-shared.ts` 80、`scripts/verify-memory-backfill.ts` 731、`scripts/verify-memory-backfill-replay.ts` 478、`scripts/verify-memory-space-catchup.ts` 690、`scripts/lib/memory-backfill-fixture.ts` 187。
- 未新增迁移、未修改 `memory_spaces` schema、未新增 `memory_jobs` CHECK；全局 `no_space` 与窗口游标语义保持不变。
