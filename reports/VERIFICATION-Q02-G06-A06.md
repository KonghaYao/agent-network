# Q02 / G06 / A06 独立验证报告（含 D1 修复复验）

| 字段 | 值 |
|---|---|
| 结论 | **PASS** |
| 验证 SHA | `933992fe6f628b13899c4b48bf987d525042f75a` |
| D1 修复实现 / 报告提交 | `0cf6a411b353b26385ab66bd55f7eec142a8972f` / `933992fe6f628b13899c4b48bf987d525042f75a` |
| 分支 / 工作树 | `fix/webots-parity-pack` / `/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack` |
| 契约版本 | `webots-p0-v1` |
| 验证者 | 独立验证会话（未参与 Q02/G06/A06 实现与集成） |
| 环境 | Bun 1.4.2，macOS；本地 `PORT=18994`、`DATA_DIR=/tmp/agentnet-verify-g06fix/data`、`PUBLIC_ORIGIN=http://127.0.0.1:18994`；presence 窗口 `AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、`AGENT_PRESENCE_SWEEP_MS=1000` |
| 验证范围 | Q02 配对与同步、G06 退群/移除/解散与 D1 owner 无主退群修复、A06 管理权交接；共享事务、迁移、事件、工具面与 D04–D08 回归 |
| 生产影响 | 无。未部署、未访问生产、未建 PR、未创建生产测试数据；临时服务/数据库/脚本仅在 `/tmp/agentnet-verify-g06fix`、`/tmp/qga-adv` 与 `/tmp/g06fix-*` |

## 0. 开工事实

```text
$ git status --porcelain=v1 -b
## fix/webots-parity-pack...origin/fix/webots-parity-pack
$ git log --oneline -4
933992f docs(groups): 记录 G06 owner 无主退群修复与复验
0cf6a41 fix(groups): 禁止 owner 无主退群
5b706aa docs(integration): Q02/G06/A06 集成报告
a613c96 docs(identity): 校正 A06 报告行数
$ git rev-list --left-right --count origin/fix/webots-parity-pack...HEAD
0	0
```

上轮 FAIL 报告记录的唯一阻断项是 D1：唯一 owner 可在未解散群直接退群，留下 `owner_id = NULL AND dissolved_at = NULL` 的活跃无主群，旧邀请链接仍可加入。本报告针对该缺陷在 `933992f` 上复验，并重跑受影响门禁与全量回归。上轮已通过的 Q02/A06 对抗脚本未全部重跑；本轮重跑 Q02 配对/同步与 A06 专项、D1 新增场景及全量门禁，D1 修复只触及 G06 群生命周期路径。

## 1. D1 修复复验

### 1.1 唯一 owner 的 preview / leave / 数据库状态

命令：`AGENTNET_URL=http://127.0.0.1:18994 bun /tmp/g06fix-verify.ts`

原始输出（摘要）：

```text
PASS 唯一 owner preview can_leave=false
PASS 唯一 owner preview owner_transfer_required=true
PASS 唯一 owner preview can_dissolve=true
PASS 唯一 owner 直接退群 CONFLICT
PASS 唯一 owner 退群 reason=owner_transfer_required
PASS 退群失败后 owner_id 不变
PASS 退群失败后 dissolved_at 仍 NULL
```

SQLite 直接验证：

```json
{"owner_id":"usr_0399...","dissolved_at":null}
```

结论：`roomLeavePreview` 对唯一 owner 返回 `can_leave=false`、`owner_transfer_required=true`、`can_dissolve=true`；`network_room_leave` 返回 `CONFLICT`，`details.reason=owner_transfer_required`；事务失败后 `rooms.owner_id` 与 `dissolved_at` 均未改变。D1 的直接复现已不再成立。

### 1.2 解散后旧定向邀请、邀请链接与归档

命令同上。

```text
PASS 解散前 owner 可创建定向邀请
PASS 解散前 owner 可创建链接邀请
PASS owner 可解散
PASS 解散后旧定向邀请不能加入 {"code":"CONFLICT","details":{"current_state":"revoked","expected_state":"pending"}}
PASS 解散后旧邀请链接不能加入 {"code":"CONFLICT","details":{"current_state":"revoked","expected_state":"pending"}}
PASS 归档只读成立 {"status":"dissolved","read_only":true}
PASS 外部用户仍不是归档成员 {"code":"NOT_MEMBER"}
```

### 1.3 遗留无主群：所有加人路径返回 `CONFLICT/owner_missing`

先在内存 SQLite 应用全部 34 个迁移并构造 `owner_id IS NULL AND dissolved_at IS NULL` 的遗留群，执行仓库内置单元：

```
$ bun -e "import { runOwnerlessRoomUnitChecks } from './scripts/lib/ownerless-room-unit'; await runOwnerlessRoomUnitChecks()"
  ✓ G06 无主群不能创建邀请链接
  ✓ G06 无主群旧邀请链接不能加入
  ✓ G06 无主群不能批准入群申请
  ✓ G06 无主群不能添加成员
  ✓ G06 无主群防御不改写 owner_id
  ✓ G06 无主群防御不自动解散
  ✓ G06 无主群防御不消费邀请
  ✓ G06 无主群防御不改写申请状态
  ✓ G06 无主群防御不写入成员
OWNERLESS_UNIT_OK checks=13
```

再以独立脚本 `/tmp/ownerless-approval.ts` 构造带 `member_join_policy='approval'` 的遗留无主群，覆盖定向邀请与审批路径：

```text
PASS 无主群定向邀请创建返回 CONFLICT/owner_missing {"code":"CONFLICT","details":{"reason":"owner_missing","owner_missing":true}}
PASS 无主群审批策略下邀请接受返回 CONFLICT/owner_missing {"code":"CONFLICT","details":{"reason":"owner_missing","owner_missing":true}}
PASS 无主群批准入群申请返回 CONFLICT/owner_missing {"code":"CONFLICT","details":{"reason":"owner_missing","owner_missing":true}}
PASS 无主群未自动回填 owner / 未自动解散
PASS 无主群未消费邀请
PASS 无主群未改写入群申请
PASS 无主群未新增成员
SUMMARY total=7 failed=0
```

覆盖矩阵：定向邀请创建、链接邀请创建、邀请链接接受、审批策略邀请接受、批准入群申请、管理员加人均返回 `CONFLICT`（`reason=owner_missing`）；owner、解散状态、邀请状态、申请状态、成员数均未被改写。

### 1.4 普通成员退群/移除、G05 转移、G01 建群邀请

同一脚本的剩余输出：

```text
PASS G05 转移成功
PASS 转移后原 owner can_leave=true
PASS 转移后原 owner 可正常退群
PASS 新 owner 仍不能直接退群
PASS 普通成员可正常退群
PASS 普通成员可正常被移除
PASS G01 有 owner 群邀请正常
SUMMARY total=21 failed=0
```

结论：修复只收窄“未解散群 owner 直接退群”，未破坏普通成员退群/移除、G05 转移和 G01 建群邀请。

## 2. 门禁复跑

| # | 检查 | 命令 | 实测 | 结果 |
|---|---|---|---|---|
| 1 | TypeScript | `bun run typecheck` | 无诊断，EXIT=0 | PASS |
| 2 | G06 专项 | `runRoomLifecycleAcceptance()` | 119 项（含 G06-T05） | PASS |
| 3 | G03 专项 | `runGroupRoleAcceptance()` | 104 项；40 轮 owner 退群全部被拒绝 | PASS |
| 4 | G01 专项 | `runGroupInviteAcceptance()` | 65 项 | PASS |
| 5 | G05 专项 | `runOwnerTransferAcceptance()` | 67 项 | PASS |
| 6 | 协议 | `AGENTNET_URL=http://127.0.0.1:18994 bun run test:protocol` | 991 项；`tools/list` 129 个工具 | PASS |
| 7 | 全量验收 | `AGENTNET_URL=http://127.0.0.1:18994 AGENT_PRESENCE_ACTIVITY_TTL_MS=5000 AGENT_PRESENCE_GRACE_MS=2000 AGENT_PRESENCE_SWEEP_MS=1000 bun run test:acceptance` | 2615 项 | PASS |
| 8 | 网页 | `bun run test:web` | 2012 项；`加载更早随消息一起滚动` 通过 | PASS |
| 9 | Q02 配对 | `runDevicePairingAcceptance()` | 77 项 | PASS |
| 10 | Q02 同步 | `runDeviceSyncAcceptance()` | 45 项 | PASS |
| 11 | A06 交接 | `runAgentTransferAcceptance()` | 139 项 | PASS |
| 12 | Events | `bun run test:events` | 339 项 | PASS |
| 13 | Drive | `AGENTNET_URL=http://127.0.0.1:18994 bun run test:drive` | 52 项 | PASS |

门禁日志位于 `/tmp/agentnet-verify-g06fix/`：`g06.log`、`g03.log`、`g01.log`、`g05.log`、`protocol.log`、`acceptance.log`、`web.log`、`q02-pairing.log`、`q02-sync.log`、`a06.log`、`events.log`、`drive.log`。

### 2.1 迁移与完整性

```text
applied migrations: 0001_initial.sql, ..., 0037_room_lifecycle.sql, 0038_ownerless_room_guard.sql
migrations=34
duplicates=false
first=0001_initial.sql last=0038_ownerless_room_guard.sql
integrity=ok
fk_rows=0
guards=51 owner_missing=true
```

`0038_ownerless_room_guard.sql` 顺序正确、只新增 `guard_owner_missing`：

```json
{"sql":"CREATE TABLE guard_owner_missing (\n  x INTEGER NOT NULL,\n  CONSTRAINT guard_owner_missing CHECK (x = 0)\n)"}
```

实际插入验证：

```text
x0=accepted
x1=rejected
```

`git diff 5b706aa..HEAD -- migrations/` 只有 `0038_ownerless_room_guard.sql` 新增 15 行；0036/0037 未被修改。

### 2.2 D04–D08 与 Q02/A06 回归

- D04–D08 报告状态仍为 `VERIFIED`，未回退。
- Q02 配对 77、Q02 同步 45、A06 交接 139 全部通过。
- 全量验收 2615 项包含 Q02/G06/A06 与 D01–D08 的共同回归。
- 新库全量运行后 `ownerless_active_groups=0`，`multi_active_assignments=0`。

## 3. 报告与文档核对

- `reports/G06-FIX.md` 记录的 D1 复现、修复范围、旧行为测试更新清单与本轮实测一致。
- G06 报告新增的 119/104/65/67/991/2012/2615 计数与本次实测一致。
- Q02 77/45、A06 139 与本次实测一致。
- 工具面 129、迁移 34、`guard_owner_missing` 映射与本轮实测一致。
- 未发现 token、凭据摘要或消息正文写入报告、日志或页面；测试只使用随机合成身份。

## 4. 残余限制

1. **遗留无主群只做防御，不自动修复**：旧库若已存在 `owner_id IS NULL AND dissolved_at IS NULL` 的群，当前版本禁止再邀请/加入成员，但没有工具自动解散、回填 owner 或硬删；需要维护者在数据库层决定归档或修复。本轮未发现它影响新库路径。
2. **G06 T04 媒体终止仍是依赖缺口**：M09 未实现，只验证了 `member_removed`/`room_dissolved` 的 `media_revoke` 事件钩子，不能声称媒体发布/订阅已终止。
3. **Q02 已知边界**：真实相机扫码未自动化；第三设备先 join 的人工拒绝流程由 `device_mismatch`/审批语义覆盖；旧 `/#t=` 长期 token 入口仍保留为明确标注的旧方式；多实例广播不在当前范围。
4. **A06 已知边界**：offered 任务回 `unassigned` 而非 blocked；不声称旧执行进程已停止；并发覆盖 6 轮 + 确定性顺序；没有真实外部发布系统联调。
5. **测试稳定性**：本轮 `test:web` 一次通过 2012 项，滚动断言通过。上一轮曾出现一次既有滚动断言偶发失败；本轮未复现，不作为本次修复回归。

## 5. 签收

- 验证 SHA：`933992fe6f628b13899c4b48bf987d525042f75a`
- D1 修复：**PASS**
- Q02 / G06 / A06：**PASS**，可标记 `VERIFIED`
- 工作区收工：`git status --porcelain=v1 -b` 为空，与 origin 同步；临时服务已停止，端口 `18994` 已释放。
