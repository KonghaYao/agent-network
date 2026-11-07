# 集成报告 · A01 / A03 / G03

| 字段 | 值 |
|---|---|
| 工作树 | `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 分支 | `fix/webots-parity-pack` |
| 集成前 HEAD | `ec97ae8`（`feat(groups): G03 补充任务报告`） |
| 集成提交 | `fix: integrate A01/A03/G03` |
| 运行环境 | Bun 1.4.2，macOS；临时数据目录 `/tmp/an-integration-webots`，端口 `8792` |
| Presence 环境 | 服务端与测试进程一致：`AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000` |
| 结论 | 四道门禁全部通过；无阻塞项；工作树仅包含本报告与集成修复 |

## 1. 命令与结果

| 命令 | 结果 | 说明 |
|---|---|---|
| `bun install` | 通过 | 安装 1 个包，耗时 81.19s |
| `bun run typecheck` | 通过 | `tsrs --noEmit`，退出码 0 |
| `bun run test:protocol` | 通过 | `协议验收通过: 724 项` |
| `bun run test:acceptance` | 通过 | `端到端验收通过: 737 项` |
| `bun run test:web` | 通过 | `浏览器验收通过 1730 项` |
| `git diff --check` | 通过 | 无 whitespace 错误 |
| `git status --porcelain` | 干净 | 提交后无未跟踪/未提交文件 |

服务端启动方式：

```bash
DATA_DIR=/tmp/an-integration-webots \
AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 \
AGENT_PRESENCE_GRACE_MS=2000 \
AGENT_PRESENCE_SWEEP_MS=1000 \
PUBLIC_ORIGIN=http://127.0.0.1:8792 \
PORT=8792 bun run start
```

`AGENTNET_URL` 未设置，协议/端到端验收默认指向 `http://127.0.0.1:8792`；`test:web` 使用自己的临时实例与随机端口。

## 2. 审查结论

### 2.1 工具、契约与输出

- `src/mcp/tools.ts` 注册的工具与 `src/contracts/schemas.ts`、`src/mcp/outputs.ts` 一一对应；当前共 **70 个工具**（65 个核心 network 工具 + 4 个房间文件工具 + 1 个 Drive 工具），关闭 Drive 时为 **65 个**。
- A01 新增 10 个 Agent 管理工具并收紧 `rename/reissue/archive/unarchive`；A03 新增 6 个好友申请/接收策略工具；G03 新增 5 个群角色/策略/公告/审计工具。工具描述与技能正文一致。
- `GUARD_TABLES` 与迁移中的命名约束一致：`0018`、`0019`、`0020` 新增的 guard 均已登记，并分别映射到 `PERMISSION_DENIED`、`VERSION_CONFLICT`、`CONFLICT` 等既有错误码。

### 2.2 迁移

- 只新增迁移，未修改 `0001`–`0011`：`0012_identity_management_devices.sql`、`0018_p0_guards.sql`（A01）、`0019_contact_relations.sql`（A03）、`0020_group_roles.sql`（G03）。
- 在全新临时库上按文件名顺序成功应用全部 15 个迁移，无 SQL 错误、无重复对象。
- `0020` 因 SQLite 不能修改 `CHECK` 约束，重建 `room_members`：`ALTER ... RENAME` → 建新表 → `INSERT ... SELECT` 保留全部旧行 → `DROP` 旧表；`role_revision` 对新旧行补默认值 `1`。属于数据保留型前向迁移，不是破坏性删除。
- 迁移号与 `reports/CONTRACT_BASELINE.md` 的规划号存在偏差（A03/G03 使用 `0019/0020`，而非预留的 `0013/0014`），但实现文件互不冲突、按序应用；`0013`–`0017` 保持空缺，未占用其他任务的编号。
- 验收使用 `/tmp/an-integration-webots`，未修改既有 `.data/` 数据库。

### 2.3 范围与无关文件

- A01/A03/G03 的提交只包含各自领域、共享契约/工具/网关与验收脚本；未发现 B 组文件。
- 集成修复未新增 B 组文件，也未改动与 A01/A03/G03 无关的业务代码。

## 3. 集成修复

仅修复文档与空白字符，不改变运行时行为：

1. `src/mcp/skill.ts`：把 `network_agent_rename`、`network_agent_archive`/`unarchive` 从“任何已注册身份均可调用”改为“目标 Agent 的 active manager 或持有 `manage_agent` scope 的 active 委托”，并同步结尾的“开放边界”段落，与 A01 实现和工具描述一致。
2. `public/skills/agent-network-skills.md`：同步 `network_agent_rename` 的管理授权语义，移除“开放管理边界”表述。
3. `docs/code-index.md`：同步改名授权说明。
4. `README.md`：把工具总数更新为 70/65，并在房间工具清单补入 G03 的 5 个工具；把“添加成员只允许群 owner”更新为按 `room.capabilities.invite_members` 判定（owner 与管理员）。
5. `migrations/0020_group_roles.sql`、`src/domain/agent-management.ts`：删除文件末尾多余空行，使 `git diff --check` 通过。

修改后重新运行 `bun run typecheck` 与 `bun run test:protocol`，结果分别通过、724 项。文档修改不参与 acceptance/web 的行为断言，故未重复执行这两套（其 737/1730 项结果产生于同一运行时代码）。

## 4. 失败与阻塞

- 无失败用例。
- 无阻塞项。

## 5. 已知限制 / 后续任务

以下为各任务报告已声明的范围外能力，不是本次集成回归：

- **A01**：管理权交接属于 A06；设备配对属于 Q02；`room_tasks` 无 `blocked` 状态，停用后任务保持 `pending/claimed`；历史 Agent 默认 `unclaimed`，需双端认领。
- **A03**：`network_contact_add` 现在只写单侧收藏，外部依赖“添加即好友”的客户端需迁移到申请/接受流程；过期申请主要靠读取时惰性判定 + 60 秒维护扫描；未认领 Agent 默认自审。
- **G03**：入群审批属于 G02；解散群属于 G05；审计仅 owner/admin 可读；公告为纯文本；策略只影响后续操作。
- **契约基线**：`reports/CONTRACT_BASELINE.md` 尚未列入 G03 的 5 个工具名，本次已先并入 README 工具清单；基线报告作为冻结快照未修改。
- **历史计数**：README 与 `docs/code-index.md` 的旧变更日志仍保留当时的测试项数与工具计数（历史记录），当前工具清单已更新。

## 6. 最终状态

- 最终 HEAD：`fix: integrate A01/A03/G03` 提交（父提交 `ec97ae8`）。
- 工作树：干净。
- 测试计数：protocol 724、acceptance 737、web 1730。
