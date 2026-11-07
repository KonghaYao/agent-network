# 集成报告 · A01 / A03 / G03

| 字段 | 值 |
|---|---|
| 工作树 | `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 分支 | `fix/webots-parity-pack` |
| 集成前 HEAD | `ec97ae8`（`feat(groups): G03 补充任务报告`） |
| 集成提交 | `fix: integrate A01/A03/G03` |
| 独立验收前 HEAD | `f3d97c2`（`fix: integrate A01/A03/G03`） |
| 独立验收修复提交 | `fix(groups): 修复 owner 退群并发与基础波次缺陷` |
| 合并前基础波次 HEAD | `690795a`（`docs(reports): 校正独立验收修复后的计数与证据`） |
| 合并的 main | `8c0194f`（ChatGPT 文件上传 / 群友下载语义） |
| 合并提交 | `de9ef66aadb120f24b1b44269db71770c5708e6b` |
| 运行环境 | Bun 1.4.2，macOS；临时数据目录 `/tmp/an-integration-merged-8c0194f`，端口 `8792` |
| Presence 环境 | 服务端与测试进程一致：`AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000` |
| 结论 | 合并后 typecheck、protocol、acceptance、web、events、drive 全部通过；无阻塞项 |

## 1. 命令与结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `bun install` | 跳过 | 工作树已有 `node_modules`，合并未改动依赖 |
| `bun run typecheck` | 通过 | `tsrs --noEmit`，退出码 0 |
| `bun run test:protocol` | 通过 | `协议验收通过: 731 项`（合并 main 新增检查后） |
| `bun run test:acceptance` | 通过 | `端到端验收通过: 800 项`（含新增 G03-T04 / A03-T05） |
| `bun run test:web` | 通过 | `浏览器验收通过 1743 项`（含停用待处理工作用例） |
| `bun run test:events` | 通过 | `MCP Events 验收通过: 339 项` |
| `bun run test:drive` | 通过 | `drive checks passed: 47` |
| `git diff --check` | 通过 | 无 whitespace 错误 |
| `git status --porcelain` | 干净 | 报告提交前已确认无未跟踪/未提交文件 |

服务端启动方式：

```bash
DATA_DIR=/tmp/an-integration-merged-8c0194f \
AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 \
AGENT_PRESENCE_GRACE_MS=2000 \
AGENT_PRESENCE_SWEEP_MS=1000 \
PUBLIC_ORIGIN=http://127.0.0.1:8792 \
PORT=8792 bun run start
```

`AGENTNET_URL` 未设置，协议/端到端验收默认指向 `http://127.0.0.1:8792`；`test:web` 使用自己的临时实例与随机端口。

### 1.1 合并 `origin/main`（`8c0194f`）

- `git fetch origin` 后确认 `origin/main = 8c0194fa73dd5b8388a72f6202de68860fc90951`，与基础波次 HEAD `690795a` 无冲突合并，生成 merge commit `de9ef66`。
- 自动合并 9 个文件，未产生冲突标记；`git diff --check` 通过。
- 保留 main 的文件分享修正：`publicUrl` 上传后可直接发送到消息正文，`network_room_file_bind` 只用于进入房间文件列表，不是下载前提；`src/mcp/tools.ts`、`src/mcp/skill.ts`、`public/skills/agent-network-skills.md` 与 `public/skills/harness-chatgpt-web.md` 的描述一致。
- 保留 A01/A03/G03 语义：Agent 管理授权、好友申请/策略、群角色/owner 转移/公告/审计、`0021` owner 退群 guard 均未回退；`scripts/verify-protocol.ts` 同时包含本波次工具清单检查与 main 新增的凭证/反馈检查，协议计数由 724 增至 731。
- 合并后未重设计任何任务实现，仅验证集成一致性并记录门禁结果。

## 2. 审查结论

### 2.1 工具、契约与输出

- `src/mcp/tools.ts` 注册的工具与 `src/contracts/schemas.ts`、`src/mcp/outputs.ts` 一一对应；当前共 **70 个工具**（65 个核心 network 工具 + 4 个房间文件工具 + 1 个 Drive 工具），关闭 Drive 时为 **65 个**。
- A01 新增 10 个 Agent 管理工具并收紧 `rename/reissue/archive/unarchive`；A03 新增 6 个好友申请/接收策略工具；G03 新增 5 个群角色/策略/公告/审计工具。工具描述与技能正文一致。
- `GUARD_TABLES` 与迁移中的命名约束一致：`0018`、`0019`、`0020`、`0021` 新增的 guard 均已登记，并分别映射到 `PERMISSION_DENIED`、`VERSION_CONFLICT`、`CONFLICT` 等既有错误码。

### 2.2 迁移

- 只新增迁移，未修改 `0001`–`0011`：`0012_identity_management_devices.sql`、`0018_p0_guards.sql`（A01）、`0019_contact_relations.sql`（A03）、`0020_group_roles.sql`（G03）、`0021_owner_leave_guard.sql`（G03 独立验收修复）。
- 在全新临时库上按文件名顺序成功应用全部 16 个迁移，无 SQL 错误、无重复对象。
- `0020` 因 SQLite 不能修改 `CHECK` 约束，重建 `room_members`：`ALTER ... RENAME` → 建新表 → `INSERT ... SELECT` 保留全部旧行 → `DROP` 旧表；`role_revision` 对新旧行补默认值 `1`。属于数据保留型前向迁移，不是破坏性删除。
- 迁移号与 `reports/CONTRACT_BASELINE.md` 的规划号存在偏差（A03/G03 使用 `0019/0020`，而非预留的 `0013/0014`），但实现文件互不冲突、按序应用；`0013`–`0017` 保持空缺，未占用其他任务的编号。
- 验收使用 `/tmp/an-verify-webots`，未修改既有 `.data/` 数据库。

### 2.3 范围与无关文件

- A01/A03/G03 的提交只包含各自领域、共享契约/工具/网关与验收脚本；未发现 B 组文件。
- 集成修复未新增 B 组文件，也未改动与 A01/A03/G03 无关的业务代码。

## 3. 集成修复

3.1 是历史集成提交的修复（仅文档与空白字符）；3.2 是独立验收后新增的运行时修复。

### 3.1 历史集成修复（仅文档）

1. `src/mcp/skill.ts`：把 `network_agent_rename`、`network_agent_archive`/`unarchive` 从“任何已注册身份均可调用”改为“目标 Agent 的 active manager 或持有 `manage_agent` scope 的 active 委托”，并同步结尾的“开放边界”段落，与 A01 实现和工具描述一致。
2. `public/skills/agent-network-skills.md`：同步 `network_agent_rename` 的管理授权语义，移除“开放管理边界”表述。
3. `docs/code-index.md`：同步改名授权说明。
4. `README.md`：把工具总数更新为 70/65，并在房间工具清单补入 G03 的 5 个工具；把“添加成员只允许群 owner”更新为按 `room.capabilities.invite_members` 判定（owner 与管理员）。
5. `migrations/0020_group_roles.sql`、`src/domain/agent-management.ts`：删除文件末尾多余空行，使 `git diff --check` 通过。

### 3.2 独立验收修复（2026-11-07）

1. **G03 owner 退群并发**：`roomLeave` 在同一 `db.batch()` 内新增 `guard_owner_transfer_required`，提交时复核 `rooms.owner_id = caller` 且不存在其他 active 成员；有其他人时返回 `CONFLICT`。`UPDATE rooms SET owner_id = NULL` 改为 `WHERE owner_id = caller`，避免并发转移后误清新 owner。新增前向迁移 `0021_owner_leave_guard.sql`，并在 `GUARD_TABLES`、`GUARD_CODES`、`GUARD_MESSAGES` 登记。
2. **G03 加人好友窗口**：`roomMembersUpdate` 对每个 `add` 目标在事务内追加 `guard_friend_required`，按 `pair_key` 复核 active 关系，关闭“预检查后解除好友再提交”的窗口。
3. **A03 幂等边界**：`network_contact_request` 的 `already_friends` 与“已有 pending”早返回也通过 `runIdempotent` 写入 `operations`；解除好友或撤销申请后，同一 `request_id` 仍返回首次结果，不再新建 pending。
4. **A01 Web 停用展示**：会话菜单在停用成功后保持打开，展示 `stopped.pending_deliveries`/`claimed_deliveries` 与 `open_tasks`（可折叠列表与空态）；启用/停用失败继续在菜单状态行显示可读错误。
5. **回归证据**：`scripts/lib/group-role-acceptance.ts` 新增 `G03-T04`（确定性拒绝、唯一 owner 退群、40 轮并发）；`scripts/lib/contact-relation-acceptance.ts` 新增 `A03-T05`（解除好友/撤销申请后重放、并发同 `request_id`）；`scripts/verify-web.ts` 新增停用/启用用例（计数、空态、失败可见）；`scripts/lib/feedback-unit.ts` 的旧库升级迁移列表加入 `0021`。
   - 专项运行：`/tmp/verify-run-a01.ts` → `A01 OK checks=67`；`/tmp/verify-run-a03.ts` → `A03 OK checks=89`；`/tmp/verify-run-g03.ts` → `G03 OK checks=95`。
   - 并发专项：`/tmp/verify-g03-owner-leave-race.ts` → `both_succeeded=0 bad_final_states=0`；`/tmp/verify-g03-orphan-repro.ts` → 40 次未复现（脚本以“未复现”退出 1）；`/tmp/verify-group-add-unfriend-race.ts` → `both_success=20 violations=0`（加人事务先提交，随后解除好友，未出现关系结束先于加人的提交）；`/tmp/verify-a03-idempotency-edge.ts` → `failures=0`。

独立验收修复后、合并 main 前的门禁：`typecheck` 通过；`protocol` 724 项；`acceptance` 800 项；`web` 1743 项；`events` 339 项；`drive` 47 项。合并 `8c0194f` 后重跑结果见第 1 节，`protocol` 为 731 项，其余计数不变。

## 4. 失败与阻塞

- 无失败用例。
- 无阻塞项。

## 5. 已知限制 / 后续任务

本 PR 只覆盖 F0 + A01/A03/G03，**不是 24 项 P0 全部完成**。以下 P0 仍未实现或未纳入本波次：

- **A 组**：A05、A06。
- **G 组**：G01、G02、G05、G06、G07。
- **M 组**：M02、M03。
- **D 组**：D01–D08。
- **Q 组**：Q01、Q02、Q04、Q05。

以下为各任务报告已声明的范围外能力，不是本次集成回归：

- **A01**：管理权交接属于 A06；设备配对属于 Q02；`room_tasks` 无 `blocked` 状态，停用后任务保持 `pending/claimed`；历史 Agent 默认 `unclaimed`，需双端认领。
- **A03**：`network_contact_add` 现在只写单侧收藏，外部依赖“添加即好友”的客户端需迁移到申请/接受流程；过期申请主要靠读取时惰性判定 + 60 秒维护扫描；未认领 Agent 默认自审。
- **G03**：入群审批属于 G02；解散群属于 G05；审计仅 owner/admin 可读；公告为纯文本；策略只影响后续操作。owner 与其他 active 成员同群时必须先转让才能退群；owner 是唯一 active 成员时允许退群，留下空群（`owner_id = NULL`，没有可孤立的成员）。
- **契约基线**：`reports/CONTRACT_BASELINE.md` 的 G03 工具行已按实际名称更新为 `network_room_members_update`、`network_room_owner_transfer`、`network_room_policy_set`、`network_room_announcement_set`、`network_room_role_history`；G02/G05/G07 规划名仍不代表已实现。
- **历史计数**：`reports/A01.md`、`reports/A03.md`、`reports/G03.md` 的验收数字是提交时快照；独立验收修复后的最终计数以本文为准。

## 6. 最终状态

- 合并代码提交：`de9ef66aadb120f24b1b44269db71770c5708e6b`（merge `origin/main` `8c0194f` 到 `fix/webots-parity-pack`）。
- 报告提交：`chore: merge origin/main and record integration gates`（仅文档，位于合并提交之后）。
- 工作树：干净。
- 合并后测试计数：typecheck 通过、protocol 731、acceptance 800、web 1743、events 339、drive 47。
- 未部署、未合并 PR、未触发生产验收；等待用户检查 draft PR。
