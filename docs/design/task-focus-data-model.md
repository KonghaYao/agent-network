# Task Focus 数据模型（v4.0 实施契约）

状态：待用户批准。范围对应 `2026-11-27-task-focus-v4.md` 第 3–5 节；只描述 WeBots 自有 SQLite，不涉及 Peri-Swarm 的 PostgreSQL 状态。

## 1. 原则

1. 个人卡主键与消息 ID 解耦；同一卡可挂多条来源，同一线程可承载多个独立事项。
2. 证据只存定位、用途与来源修订；正文、标题预览在读取时按当前成员代次、历史边界与撤回状态重新取证。
3. 秘书只能写业务内容，卡主只能归档；两者的事务都校验 owner、启用代次、作业租约、来源修订、卡版本与归档屏障。
4. 归档保留识别同一工作的定位；迟到、重放、改标题或重复发包均不能复活。
5. 旧 `messages.task_*` 与两代 Task 表在 0053 迁移中删除，不做导入、映射、双写或影子表。

## 2. 新增表

| 表 | 关键列 | 作用与约束 |
| --- | --- | --- |
| `focus_bindings` | `owner_actor_id` PK、`secretary_actor_id` UNIQUE、`provisioning_key` UNIQUE、`session_id` UNIQUE、`root_session_id`、`status`、`generation`、`event_from_seq`、`enabled_at`、`paused_at` | 每位 Human 一名秘书、一个固定 Swarm 会话。`provisioning_key` 供 `sessions.create` 幂等；`generation` 在暂停/重开时递增，旧作业写入被拒；`event_from_seq` 是首开/重开水位。 |
| `focus_items` | `item_id` PK、`owner_actor_id`、`secretary_actor_id`、`title`、`column_key`、`next_step`、`waiting_on`、`due_at`/`due_text`、`summary`、`version`、`archived_at`/`archived_by`、`updated_at` | 三列 `needs_me` / `tracking` / `done`；归档是独立维度，不删列值。版本递增用于并发冲突与跨作业去重。 |
| `focus_evidence` | `evidence_id` PK、`item_id`、`owner_actor_id`、`source_kind`、`room_id`、`message_id`、`delivery_id`、`source_revision`、`purpose`、`occurred_at` | 每条证据绑定 owner 与用途；`(item_id, source, purpose)` 唯一，重放收敛到同一行。不存正文与私群标题。 |
| `focus_revisions` | `revision_id` PK、`item_id`、`version`、`decision_id` UNIQUE、`changes_json`、`reason`、`evidence_json` | 每次实质变更一行；`decision_id` 业务幂等；较旧报告不能覆盖新事实。 |
| `focus_jobs` | `job_id` PK、`owner_actor_id`、`secretary_actor_id`、`attempt_ref` UNIQUE、`submission_key` UNIQUE、`status`、`generation`、`event_from_seq`/`event_to_seq`、`turn_id`/`input_id`、`lease_until`、`last_error` | 每人同时至多一个活跃作业（部分唯一索引）；`attempt_ref` 绑定本次授权；`event_from_seq`/`to` 是本次输入覆盖的事件区间。 |
| `focus_candidates` | `candidate_id` PK、`owner_actor_id`、`job_id`、`source_kind`、`event_seq`、`room_id`、`message_id`、`delivery_id`、`reason`、`state`、`decision` | Watch 的持久候选索引；`(owner, event_seq, source)` 唯一。作业只读取分配给自己的候选，秘书不能借引用读范围外证据。 |
| `focus_scan_state` | 单行 `id=1`、`event_seq`、`last_scan_at` | 逻辑 Watch 中心共用一份已提交事件读取进度；服务重启与补扫从这里继续。 |
| `focus_delivery_claims` | `delivery_id` PK、`room_id`、`message_id`、`recipient_actor_id`、`claimed_by`、`attempt`、`event_seq`、`claimed_at` | 在既有 `deliveryClaim()` 同一批次追加；无论是否开启秘书都留流水，事件回收后仍可核对「谁在何时领了」。 |

### 索引与闸门

- `idx_focus_items_owner(owner_actor_id, archived_at, column_key, updated_at DESC, item_id DESC)`：看板分列 keyset 分页。
- `idx_focus_evidence_item(item_id, created_at, evidence_id)`：详情按时间取证。
- `idx_focus_jobs_one_active`：`WHERE status IN ('queued','submitted','running','waiting')`。
- `idx_focus_candidates_pending(owner_actor_id, state, event_seq)`；`idx_focus_candidates_job(job_id, state)`。
- 新增 guard：`guard_focus_archive_conflict`（已归档仍更新）、`guard_focus_stale_attempt`（代次/租约/修订失效）。与现有 guard 一样只接受 `x=0`。

## 3. 写入与读取不变量

1. `enable`：同一事务创建秘书 actor、凭据摘要、绑定和 `provisioning_key`；再以幂等键调用 Swarm。远端响应丢失时用同一行重试，不产生第二个根会话。
2. `commit`：先校验服务身份、`attempt_ref`、owner/秘书匹配、启用代次、租约、候选归属与每个证据的当前可读性；新建/更新/忽略/待判断与回执同事务。归档屏障命中时整批拒绝，不静默跳过。
3. `archive`：校验 owner 与 `expected_version`；重复请求返回同一归档；写 `focus_updated` actor 事件，只通知卡主。
4. 读取：列表、详情、搜索、通知和归档回看都先按当前权限重算证据；任一证据失权时隐藏依赖它的标题、下一步、摘要与来源计数，全部失权则整卡不可见（归档记录保留定位，不泄露正文）。
5. 权限：秘书工具从 `attempt_ref` 解析 owner；普通 Agent 或另一位秘书持引用直接调用一律拒绝。卡主工具从 Bearer 身份推导 owner，不接受 owner 参数。
6. 通知：只写 `scope_kind='actor'` 的 `focus_updated` 事件与 outbox，不写 inbox、不增加 `pending_count`、不推进 `head_seq`、不产生 delivery。

## 4. 旧结构删除

- `messages`：删除 `task_root_id`、`task_marked_by`、`task_marked_at`、`task_completed_at`、`task_completed_by`；删除 `idx_messages_task_root`；删除 `guard_task_mark_unavailable`、`guard_task_mark_conflict`。
- 若存在早期 `room_tasks` / `tasks` 及指派、进度、交接、成果关联表，一并删除；升级前先盘点实际结构。
- 清理 `operations` 中旧 Task 写结果、`events`/`outbox` 中 `message_task_*`、`task.updated`，以及 `task_offer` 派生记录。混合载荷只移除任务字段。
- 保留：消息、`reply_to`、普通线程 `root_id`、附件、人员身份、房间权限、delivery、未读与历史边界。

## 5. 待批准

本文件列出的 8 张新表、2 个 guard 与 `messages` 五列删除，需在实施前由用户明确批准。批准后 0052/0053 迁移按此实施，不再增加过渡表、双写或兼容入口。
