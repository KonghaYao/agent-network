# G06-FIX · 群主无主退群阻断

| 字段 | 值 |
|---|---|
| 状态 | `READY_FOR_REVIEW` |
| 基线 SHA | `5b706aa`（`fix/webots-parity-pack`） |
| 修复提交 | `0cf6a41`（本报告为紧随其后的文档提交） |
| 触发 | 独立验证 P0：唯一 owner 可直接退群，留下 `owner_id = NULL AND dissolved_at = NULL` 的活跃群，旧邀请链接仍可加入 |
| 影响任务 | G06（主）、G01、G03、G05 的既有退群用例 |
| 迁移 | `0038_ownerless_room_guard.sql`（仅新增 `guard_owner_missing` 闸门表） |

## 1. 缺陷与复现

### 缺陷

修复前的 `roomLeavePreview` 与 `roomLeave` 只用“是否还有其他 active 成员”决定 owner 能否退群：

- 群内只剩 owner 时，`can_leave=true`、`owner_transfer_required=false`；
- `network_room_leave` 成功，事务把 `rooms.owner_id` 清空，但 `dissolved_at` 仍为 NULL；
- 旧退群事务只撤销 `kind = 'direct'` 的 pending 定向邀请，链接邀请（`kind = 'link'`）保持不变，外部用户仍能通过旧链接加入；
- `room_get` / `rooms_list` 继续把该群展示为 active，页面还可能显示邀请入口。

### 原始复现证据

独立验证脚本：`/tmp/qga-adv/owner-alone-link.ts`。修复前输出（摘要）：

- `唯一 owner 预览错误地允许直接退群`：`can_leave=true`、`owner_transfer_required=false`；
- `唯一 owner 直接退群成功（缺陷）`：`left=true`；
- `退群后留下无 owner 且未解散的群`：`owner_id=NULL`、`dissolved_at=NULL`；
- `旧邀请链接让外部用户进入无主群（缺陷）`：外部用户接受邀请成功。

修复后使用同一路径重跑（`/tmp/g06fix-repro.ts`，服务端 `PORT=8961`）：

- `唯一 owner 预览禁止直接退群`：`can_leave=false`、`owner_transfer_required=true`、`can_dissolve=true`；
- `唯一 owner 直接退群返回 CONFLICT/owner_transfer_required`；
- `退群失败后群仍有 owner 且未解散`；
- `owner 可解散`，`解散后旧邀请链接不能加入`（`CONFLICT`，邀请已 revoked）。

## 2. 修复内容

### 2.1 退群预览与退群裁决

- `roomLeavePreview`：未解散群中 `member.role === 'owner'`（或 `rooms.owner_id` 指向调用者）时固定返回 `can_leave=false`、`owner_transfer_required=true`、`can_dissolve=true`；不再查询其他 active 成员数。已解散群保持 `can_leave=true`，允许合法成员退出归档。
- `roomLeave`：owner 在未解散群调用一律返回 `CONFLICT`，`details.reason=owner_transfer_required`，并提示先 `network_room_owner_transfer_propose` 或 `network_room_dissolve`。预检查在在途工作检查之前执行，避免 owner 被 `in_flight_work` 掩盖。
- 事务 guard：`guard_owner_transfer_required` 的违反条件改为 `EXISTS (rooms WHERE room_id = ? AND owner_id = ? AND dissolved_at IS NULL)`；群内是否有其他 active 成员不再影响判定。并发转移后按提交时的 `rooms.owner_id` 裁决。
- 旧的 `UPDATE rooms SET owner_id = NULL ...` 保留为防御语句，但合法路径已在预检查/guard 拦截，不再可达；旧的“owner 退群撤销定向邀请”语句删除，因为 owner 已不能通过退群制造空群。
- `room_get` / `rooms_list` 的 `can_leave` 同步改为：已解散或非 owner 才为 true；`room_view` 增加 `owner_missing`。

### 2.2 遗留无主群防御（旧数据）

新增 `guard_owner_missing`（`migrations/0038_ownerless_room_guard.sql`），并在预检查 + 事务内双重拒绝以下“加人”路径：

| 路径 | 预检查 | 事务 guard |
|---|---|---|
| `network_room_invite_create`（定向/链接） | `assertOwnerPresent` | `ownerMissingGuardStatement` |
| `network_room_invite_respond` 接受（含审批策略） | `assertOwnerPresent` | `ownerMissingGuardStatement` |
| 审批策略创建 `room_join_requests` | 接受路径已拒绝 | `ownerMissingGuardStatement` |
| `network_room_join_request_respond` 批准 | `assertOwnerPresent` | `ownerMissingGuardStatement` |
| `network_room_members_update` 添加 | `assertOwnerPresent` | `ownerMissingGuardStatement` |

- 错误统一为 `CONFLICT`，`details.reason=owner_missing`、`details.owner_missing=true`。
- 迁移 `0038_ownerless_room_guard.sql` 只创建空闸门表；**没有旧数据回填或重写**，旧无主群保留原行，由读取时的 `owner_missing` 标记与写路径 guard 防御。
- `room_get` 返回 `owner_missing=true`；网页 `roomCapability('invite_members')` 据此隐藏邀请入口。
- 拒绝入群申请、撤销邀请、读取链接列表仍允许，便于清理；不会自动解散、回填 owner、硬删业务行。
- 无活跃 owner 行的旧群当前没有工具能人工解散；这是刻意保留的遗留数据边界，需要维护者在数据库层决定归档或修复，报告已注明。

### 2.3 文档与技能

- `network_room_leave_preview`、`network_room_leave`、`network_room_get`、`network_room_invite_create`、`network_room_invite_respond`、`network_room_join_request_respond`、`network_room_members_update` 的工具描述同步新契约。
- `src/mcp/skill.ts` 与 `public/skills/agent-network-skills.md` 的“退群、移除与解散”段落同步更新，并保持 digest 一致。
- README 的 G06 条目补充 owner-alone 收紧、`owner_missing` 与迁移 `0038`。

## 3. 旧行为测试更新清单

| 文件 | 原断言 | 新断言 |
|---|---|---|
| `scripts/lib/group-role-acceptance.ts` | “owner 是唯一 active 成员时允许退群” | preview `can_leave=false`/`owner_transfer_required=true`/`can_dissolve=true`；直接退群 `CONFLICT`；改由 `network_room_dissolve` 解散并验证只读归档；解散后旧邀请不能加入；40 轮并发中 owner 退群全部被拒绝 |
| `scripts/lib/group-invite-acceptance.ts` | “owner 退群后遗留邀请被撤销” | owner 独自退群被拒绝；owner 解散后遗留定向邀请与链接均 revoked，接受返回 `CONFLICT` |
| `scripts/lib/room-lifecycle-acceptance.ts` | G06-T03 owner 带着其他成员退群被拒绝（无原因断言） | 增加 `details.reason=owner_transfer_required`；新增 G06-T05：owner-alone preview 标志、直接退群 CONFLICT、解散后旧定向邀请与链接均不能加入、归档只读可读 |
| `scripts/lib/owner-transfer-acceptance.ts` | 原用例为“已有 pending 转让时 owner 不能离群”，群内仍有其他 active 成员 | 该用例语义未变，继续断言 `CONFLICT`；本文件没有“群空时 owner 调用 room_leave”的用例，无需改动 |
| `scripts/verify-web.ts` | 群主点击退群等待 `SAFETY_LEAVE_CONFIRM` 对话框 | 群主点击退群后菜单状态显示“群主不能直接退群…”，`room_get` 仍显示 owner，不再等待退群确认框 |
| 新增 `scripts/lib/ownerless-room-unit.ts` | — | 内存 SQLite 构造旧无主群，验证邀请创建、链接接受、入群批准、添加成员全部 `CONFLICT/owner_missing`，且不改写 owner/解散状态/邀请/申请 |

## 4. 验证记录

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `bun run typecheck` | 通过 |
| G06 专项 | `AGENTNET_URL=http://127.0.0.1:8961 bun -e "…runRoomLifecycleAcceptance()"` | 119 项通过 |
| G03 专项 | 同端口，`runGroupRoleAcceptance()` | 104 项通过 |
| G01 专项 | 同端口，`runGroupInviteAcceptance()` | 65 项通过 |
| G05 专项 | 同端口，`runOwnerTransferAcceptance()` | 67 项通过 |
| 协议 | `AGENTNET_URL=http://127.0.0.1:8961 bun run test:protocol` | 991 项通过 |
| 网页 | `AGENTNET_URL=http://127.0.0.1:8961 bun run test:web` | 2012 项通过 |
| 全量验收 | `AGENTNET_URL=http://127.0.0.1:8962 … bun run test:acceptance` | 2615 项通过 |

全量验收使用唯一端口 `8962`、`DATA_DIR=/tmp/g06fix-full/data`、`PUBLIC_ORIGIN=http://127.0.0.1:8962`，并设置 `AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000`。结束后停止服务。

## 5. 剩余风险

1. **历史无主群无工具修复**：若旧库已经存在没有 active owner 行的无主群，当前只能防御新增成员；没有自动解散或 owner 回填。需要维护者按数据实际归属处理。
2. **防御依赖事务 guard 表**：新增迁移 `0038_ownerless_room_guard.sql` 必须先于新代码部署；迁移只创建空闸门表，不修改业务数据。
3. **G05/G01/G03 合法路径**：owner 转移后原 owner 成为普通成员，可以正常退群；解散后成员可以退出归档；非 owner 退群/被移除路径未收窄，专项与全量均覆盖。
4. **`owner_missing` 是只读标记**：当前只用于阻止加人和网页隐藏邀请，不把房间标成 `dissolved`，现有成员仍可读聊天；这是为不破坏历史数据而保留的最小状态。
