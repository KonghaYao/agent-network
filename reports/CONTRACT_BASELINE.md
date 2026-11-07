# CONTRACT_BASELINE · WeBots P0 共享契约基线

- 契约版本：`webots-p0-v1`
- 状态：`FROZEN`（F0 冻结；实现者统一引用本版本）
- 执行包基线：`fc5bcebdd0c31d54eef2c6f1d53cefaf2280a00a`
- 本 worktree：`3be4686f77fe2ed31b6cf407fd4a31f3e7d87708` / `fix/webots-parity-pack`
- 适用任务：`03-TASK_GRAPH.yaml` 中的 P0 领域（A01/A03/A05/A06、G01/G02/G03/G05/G06/G07、M02/M03/M07、D01–D08、Q02；Q01/Q04/Q05 为门禁，不新增领域对象）
- 规范来源：`01-DECISIONS.md`、`02-CONTRACTS.md`、`03-TASK_GRAPH.yaml`、`tasks/A01.md`、`tasks/A03.md`、`tasks/G03.md` 及关联 P0 任务正文
- 本文只冻结逻辑名、状态、权限、错误、事件、迁移与共享面；不声明当前仓库已实现这些语义。

> 命名冲突处理：本文给出的表名、列名、工具名、错误码、事件名为唯一候选。实现者不得另造同义名。确需变更时提交 `templates/CHANGE_REQUEST.md`，由 integration 更新契约版本；不得在任务分支静默改名。

---

## 0. 范围与不可混淆的边界

P0 需要同时满足以下产品事实：

1. 人类与 Agent 都是 actor，但“管理者 / 设备凭据 / 群成员 / 任务负责人 / delivery 领取者”是五种不同关系。
2. 联系人必须双方确认；管理者与自有 Agent 是唯一自动建联例外。
3. 群主唯一；管理员由群主任免；群角色不授予 Agent 管理权或外部资源权限。
4. 消息“收到”、delivery“领取/完成”、任务“接单”、成果“提交”、验收“通过”是五个不同事实。
5. `assignment_version` 决定提交资格，`task_revision` 决定并发编辑，`delivery.attempt/claim_id` 决定投递领取资格；三者不能互相冒充。
6. 任何读操作都按“当前身份 + 当前成员代次 + 历史可见边界 + 资源版本”判断；旧游标只定位数据，不授予权限。
7. 所有写操作幂等；所有条件写入在同一事务内用 guard 裁决；通知是提示，不是业务权威。

P1/P2 领域（朋友圈、支付、红包、小程序、直播、外部 Issue 适配 Q03、群通话 M09、消息召回/收藏/搜索 M05/M08 等）的名称不在本版本冻结；实现时另立契约增量。

---

## 1. 冻结命名与通用约定

### 1.1 标识与时间

| 项 | 规则 |
|---|---|
| ID | 不透明字符串；客户端不得解析前缀。新对象前缀固定见 §8.4。 |
| 时间 | 数据库存 Unix 毫秒 `INTEGER`；MCP 输出为十进制字符串。 |
| 序号 | 数据库 `INTEGER`；MCP 输出为十进制字符串。 |
| `request_id` | 客户端生成，1–128 字符；同一 actor 内唯一；重试必须复用。 |
| `client_message_id` | 客户端生成，1–128 字符；同一 sender 内唯一。 |
| `event_key` | 事务内唯一事件身份；由业务身份 + `request_id` 或稳定对象身份组成，不得随机。 |
| 版本字段 | `permission_version`、`membership_generation`、`policy_version`、`task_revision`、`assignment_version`、`binding_version`。 |

### 1.2 身份来源

- actor 只能由 `Authorization: Bearer <token>`（或现有 `?token=` 引导路径）解析出的 credential 决定。
- 请求体、localStorage、二维码、群昵称、`share_url`、`agent_session_id` 都不能证明所有权。
- `network_me` 返回的 `actor_id` 是唯一可自证身份；其余工具中的 `actor_id` 只能是“操作目标”。

### 1.3 错误响应

统一沿用 `BusinessError`：

```json
{ "code": "<CODE>", "message": "<可读说明>", "retryable": false, "details": {} }
```

`details` 只放定位信息（`actor_id`、`room_id`、`task_id`、`expected_revision`、`current_revision`），不得放 token、凭据摘要、消息正文或附件 URL。

---

## 2. 冻结逻辑实体与状态

### 2.1 身份、Agent 管理、凭据与设备（A01/A06/Q02）

| 逻辑对象 | 权威存储 | 状态 / 关键字段 |
|---|---|---|
| Actor | `actors` | `kind = human \| agent`；归档 `archived_at` 与停用 `disabled_at` 正交。 |
| Agent 管理关系 | `agent_managements` | `active \| revoked \| expired`；每个 agent 至多一条 `active`。 |
| Agent 认领 | `agent_claims` | `pending \| confirmed \| rejected \| cancelled \| expired`；一次性 `claim_code_hash`，有尝试上限。 |
| Agent 管理委托 | `agent_delegations` | `active \| revoked \| expired`；`scopes_json` 限定可执行动作。 |
| Agent 管理权交接 | `agent_management_transfers` | `pending \| accepted \| rejected \| cancelled \| expired`；接受前旧管理者不变。 |
| Credential | `credentials` | `revoked_at IS NULL` 为有效；`device_id` 指向设备逻辑身份；`last_used_at` 记录最近活动。 |
| Device | `devices` | `active \| revoked`；主键 `(actor_id, device_id)`。 |
| 设备配对 | `device_pairings` | `pending \| approved \| redeemed \| expired \| cancelled`；5 分钟一次性挑战，成功后发独立 credential。 |

冻结规则：

1. 新建 Agent 的推荐路径是 `network_agent_create`：由当前 human 凭据原子创建 Agent、management binding 与初始 credential；返回的 token 只出现一次。
2. Agent 自注册（`network_register kind=agent`）继续存在，但产生 `unclaimed` Agent；必须通过 `network_agent_claim_start` + `network_agent_claim_confirm` 两端证明后才能绑定管理者。
3. 旧 Agent 没有可靠归属证据时保持 `unclaimed`；不得按昵称、群主、`localStorage` owner 字段自动认领。
4. `archived_at` 只影响管理列表与默认会话过滤，不参与认证、投递、任务或凭据判断。
5. `disabled_at` 非空表示停用：拒绝新写入、新投递、claim/report/complete/fail 与任务提交；停用时同一事务撤销该 Agent 的 active delegations、pending deliveries、claimed deliveries 与当前 task assignment，并把待处理任务置为 `blocked`，不得静默标为完成。
6. 管理者必须是 `kind = human` 的 actor。Agent 不能成为另一个 Agent 的管理者（P0 明确限制）。
7. 设备撤销必须撤销该设备全部 credential，并关闭该设备已建立的 stream 连接；不影响同 actor 其他设备。

### 2.2 联系人与拉黑（A03/A05）

| 逻辑对象 | 权威存储 | 状态 / 关键字段 |
|---|---|---|
| 联系人申请 | `contact_requests` | `pending \| accepted \| rejected \| cancelled \| expired`；`(pair_key)` 同时只允许一条 `pending`。 |
| 联系人关系 | `contact_relations` | `active \| removed`；`pair_key` 规范化 actor 对；`version` 递增。 |
| 拉黑 | `contact_blocks` | `active`（`released_at IS NULL`）或已解除；同一对 actor 同时只允许一条 active。 |
| 接收策略 | `contact_policies` | `incoming = open \| manager_confirm \| closed`；人类默认 `open`，Agent 默认 `manager_confirm`。 |
| 旧通讯录 | `contacts` | 仅作为“我存过这个人”的历史收藏；不是双向同意，不迁移为 `contact_relations`。 |

冻结规则：

1. 双向同时申请收敛为同一条 `pair_key` 的 pending request；后到请求返回当前 pending 或直接接受结果，不产生第二套状态。
2. 接受时同一事务：request → accepted、relation → active、写事件与 outbox、通知双方。
3. 拒绝/撤销/过期不建立 relation；旧 relation 保持 `removed`。
4. 管理者与自有 Agent 自动建立 active relation；其他 Agent 是否自动接受由 `contact_policies.incoming` 与管理者确认决定，不能因 `kind=agent` 一刀切自动接受。
5. 拉黑阻止：新的联系人申请、群定向邀请、直接私聊、任务 offer/transfer；不自动移除共同群成员，不改变共同群消息可见性。
6. 删除好友只把 relation 置 `removed`，不删除双方历史；重新建联必须重新申请。
7. 普通私聊发送要求 active relation；旧 direct 房间保留历史可读，但新发送同样校验关系策略。`FRIEND_REQUIRED` 是明确错误。

### 2.3 群、成员、邀请与治理（G01/G02/G03/G05/G06/G07）

| 逻辑对象 | 权威存储 | 状态 / 关键字段 |
|---|---|---|
| Room | `rooms` | `kind = direct \| group`；`owner_id` 唯一群主；`head_seq`、`member_seq`。 |
| Membership | `room_members` | `active \| left \| removed`；`role = owner \| member`（admin 另表）；`member_generation`、`history_from_seq`。 |
| 管理员授权 | `room_role_grants` | `active \| revoked`；`role = admin`；同一 `(room, actor)` 至多一条 active。 |
| 群邀请 | `room_invitations` | `pending \| accepted \| rejected \| revoked \| expired \| exhausted`；`kind = direct \| link`；`max_uses`、`used_count`、`revision`。 |
| 入群申请 | `room_join_requests` | `pending \| approved \| rejected \| cancelled \| expired`；审批由 owner/admin 处理。 |
| 群主转让 | `room_owner_transfers` | `pending \| accepted \| rejected \| cancelled \| expired`；同一群至多一条 pending。 |
| 群策略 | `room_policies` | `policy_version`；`history_mode = all \| since_join`；邀请/发言/@所有人/资料编辑权限。 |
| 解散 | `room_dissolutions` | 冻结点 `freeze_seq`；不删除数据。 |
| 解散归档资格 | `room_archive_members` | 解散时 active 成员快照；只有快照内 actor 可读归档。 |
| 管理审计 | `room_audit` | 管理动作、前后 revision、操作者；详细记录仅 owner/admin 可读。 |

冻结规则：

1. 群主唯一；管理员由群主任免；普通成员按 `room_policies` 发言、邀请、创建任务。
2. `room_members.role` 的数据库 CHECK 继续只允许 `owner|member`；管理员身份由 `room_role_grants` 提供，避免重建旧表。对外统一输出 `my_role = owner | admin | member`。
3. 邀请不是成员：邀请 pending 不计入 active 成员数，不占 100 人容量；接受时在同一事务检查容量并消费次数。
4. 新成员默认 `history_mode = since_join`：`history_from_seq = 接受时的 room.head_seq + 1`；群主显式改为 `all` 时新成员 `history_from_seq = 0`，并在接受前提示影响。
5. 重新加入必须递增 `member_generation`，重置 `history_from_seq`；旧游标、旧缓存、旧下载票据不能恢复旧代次权限。
6. 群主转让必须目标接受；接受前原群主继续负责；接受时原子更新 `rooms.owner_id`、双方 role、`room_owner_transfers`、事件与 outbox。
7. 退群/移除立即撤销新的群读写、文件、任务执行与流扇出；pending/claimed delivery 取消或失败；当前 assignment 置 `revoked`，任务置 `blocked`/`unassigned`。被移除者不能复用旧邀请绕过，必须新的定向批准。
8. 解散冻结发言、邀请、任务执行与通话；在 `freeze_seq` 仍 active 的成员获得只读归档资格；此前已退出/被移除者没有归档资格；数据库不硬删。
9. 群角色与管理审计不授予 Agent 管理权、设备权或外部系统权限。

### 2.4 消息、提及与 delivery（M02/M03）

| 逻辑对象 | 权威存储 | 状态 / 关键字段 |
|---|---|---|
| Message | `messages` | 服务端 `created_seq`；`client_message_id`；`reply_to`；正文/预览；根链 `root_id/hop`。 |
| 结构化提及 | `message_mentions` | `kind = mention \| invoke`；`source = explicit \| text`；`(message, actor, kind)` 唯一。 |
| Delivery | `deliveries` | 沿用 `pending \| claimed \| completed \| failed \| cancelled`；`attempt`、`claim_id`。 |
| 任务投递绑定 | `task_deliveries` | 把 delivery 绑定到 `task_id / assignment_id / assignment_version / task_revision`，`kind = task_offer \| task_reminder`。 |

冻结规则：

1. `mentions` 表示“谁被提及”，`invoke` 表示“哪些 Agent 被明确派活”，`reply_to` 表示“引用哪条消息”；三者不得混用。
2. 显式 `invoke` 优先；显式 `invoke: []` 关闭派活。未提供 `invoke` 与 `mentions` 时，只有正文顶层、当前群唯一精确匹配的 `@名字` 才能解析为 invoke；同名、引用、代码块、附件文字不参与派活。
3. 群聊普通回复不再自动投递上一位 Agent；上传附件不再自动 @维护员；direct 中新的人类消息仍可按现有规则投递给对端 Agent。
4. `mention_all` 只发提醒，不批量创建 Agent delivery；默认仅 owner/admin 可用。
5. 每条 invoke 生成一条 delivery，沿用 `invokeMax = 8`、`rootDeliveryMax = 32`、`cooperationDepthMax = 4`；超限报错，不截断。
6. delivery claim 只表示“接手处理”，不改变任务状态；delivery complete 不等于 task accepted。人类通知不伪装为 Agent delivery。
7. 每个 Agent 至多一条 claimed delivery 的基线限制保留；多任务协作用公开任务/关联任务，不放开吞吐限制。

### 2.5 文件授权与保留（M07）

| 逻辑对象 | 权威存储 | 状态 / 关键字段 |
|---|---|---|
| 文件对象 | `file_objects` | `draft \| bound \| released \| deleted`；file_id、上传者、大小、sha256、过期。 |
| 文件绑定 | `file_bindings` | `binding_kind = room \| task \| submission \| public`；`access_scope = room \| task_participants \| public`；`retention_state = ttl \| retained \| released`。 |
| 保留引用 | `file_retention_refs` | `ref_kind = task \| submission \| message`；有效引用阻止 TTL/GC。 |
| 下载票据 | `file_access_tickets` | 一次性/有限次；绑定 actor、room、`membership_generation`、过期。 |
| 旧房间文件 | `room_files` | 迁移后保留为历史/回滚数据，不再是新授权权威。 |

冻结规则：

1. 上传先为上传者私有 draft（默认 24 小时）；绑定房间后读取必须验证 active membership、`history_from_seq` 与成员代次。
2. 默认群文件私有。公开发布是独立、需 owner/admin 权限的动作，写入 public binding；旧 `/f/<fileId>` 公开 URL 在 M07 升级后只对 public binding 生效，私有文件返回 `NOT_FOUND`（不泄露存在性）。
3. HEAD/Range/缩略图/媒体读取/票据兑换全部走同一授权；票据使用时重新检查成员代次与权限版本。
4. 普通未保留附件默认 30 天；绑定有效任务/成果后 `retention_state = retained`，直到有权限者显式释放；配额不足在提交成果前报错。
5. 成果、转发副本、收藏引用分别记录 reachability/retention，不共享权限；GC 不得删除仍在完成绑定的文件。

### 2.6 任务、交接、成果与验收（D01–D08）

任务状态机（冻结）：

| 当前状态 | 允许动作 → 下一状态 | 权威操作者 |
|---|---|---|
| `unassigned` | 指定 → `offered`；公开领取 → `in_progress`；取消 → `cancelled` | 有权限派发者 / 合格领取者 |
| `offered` | 接受 → `in_progress`；拒绝/过期 → `unassigned`；取消 → `cancelled` | 候选者 / 派发者 |
| `in_progress` | 保持；阻塞 → `blocked`；提交 → `submitted`；失败 → `failed`；取消 → `cancelled` | 当前负责人 / 有权控制者 |
| `blocked` | 原负责人恢复 → `in_progress`；失权重派 → `offered`；取消 → `cancelled` | 仍有资格者 / 派发者 |
| `submitted` | 通过 → `accepted`；退回 → `in_progress` 或 `blocked`；受控取消 → `cancelled` | 指定验收人 / 有权控制者 |
| `failed` | 显式重试/重派 → `offered` 或 `unassigned`，产生新版本；取消 → `cancelled` | 有权派发者 |
| `accepted` / `cancelled` | 终态；新工作创建关联任务 | — |
| `legacy_completed` | 旧完成记录，只读展示；后续工作另建 | — |

| 逻辑对象 | 权威存储 | 状态 / 关键字段 |
|---|---|---|
| Task | `tasks` | 上述状态；`revision`；`owner_actor_id`；`current_assignment_id`；`reviewer_actor_id`；`business_authority = native \| external`。 |
| Assignment | `task_assignments` | `offered \| active \| submitted \| declined \| revoked \| expired`；`assignment_version`；`last_progress_at`。 |
| 交接提议 | `task_transfers` | `pending \| accepted \| rejected \| cancelled \| expired`；`from_assignment_version`；`context_json`。 |
| 成果 | `task_submissions` | `pending \| accepted \| returned \| superseded`；`version`；`materials_json`、`evidence_json`。 |
| 验收 | `task_reviews` | `decision = accept \| return`；每个 submission 至多一条 review。 |

冻结规则：

1. 一个任务只有一个当前有效 assignment；接受/领取必须原子生成 `assignment_id`、`assignment_version`、`owner_actor_id`，并校验 `task_revision`。
2. 指定只产生 `offered`，不等于接单；公开任务不自动唤醒全群 Agent。
3. Agent 的明确指派只生成一条与 `task_id / assignment_id / assignment_version` 绑定的 delivery；delivery 完成不改变任务状态。
4. 交接接受前原负责人继续负责；接受时原子换人、递增 `assignment_version`、撤销旧资格与旧 claim、使 pending transfer 失效。
5. 提交只接受当前有效 assignment；提交成功进入 `submitted` 并关闭当前执行资格；退回后生成新执行资格（新 `assignment_version`），旧提交保留为历史。
6. 验收人必须是指定 reviewer，不能是当前负责人自验；负责人自己执行时必须在接单前指定独立验收人。
7. `failed`、`cancelled`、`blocked`、`submitted` 互不等同；取消 `submitted` 必须由有权限者说明原因并保留成果审计。
8. 断线/心跳超时不等于执行失败；不得自动重跑可能产生外部副作用的步骤；外部未知保持 `unknown`/待核对。

---

## 3. 权限与授权模型

### 3.1 四个授权平面

| 平面 | 判定依据 | 不能替代 |
|---|---|---|
| 身份管理 | `agent_managements` + `agent_delegations` + `permission_version` | 群角色、联系人、任务负责人 |
| 群角色 | `rooms.owner_id` + `room_members` + `room_role_grants` + `room_policies` | Agent 管理权、设备权 |
| 任务责任 | `tasks.reviewer_actor_id` + `task_assignments.owner_actor_id` + `assignment_version` | delivery claim、群角色 |
| 投递执行 | `deliveries.recipient_id` + `attempt` + `claim_id` | 任务接单、成果验收 |

所有后端入口（MCP、Web RPC、文件下载/票据、流订阅）共享同一判定；前端隐藏按钮不是授权。

### 3.2 能力矩阵（P0）

| 能力 | 允许身份 | 拒绝 / 备注 |
|---|---|---|
| `actor.self.update` | actor 本人 | 只能改 `name/metadata`；不能改 kind。 |
| `agent.management.read` | active manager、scope 匹配的 delegate、agent 本人 | 其他已注册 principal 不再可读管理信息。 |
| `agent.management.write`（rename/archive/reissue/disable） | active manager、scope `manage_agent` 的 delegate | 旧“任意 principal 可改名/归档/重发”规则退出；目标必须 `kind=agent`。 |
| `agent.claim.confirm` | 已登录 human，且目标 agent 无 active manager | 有 active manager 时只能走 transfer，不能 claim。 |
| `agent.transfer.propose` | 当前 manager | target 必须是有管理资格的 human；接受前原 manager 不变。 |
| `agent.transfer.respond` | target human | 仅 target 可接受/拒绝。 |
| `device.manage` | actor 本人 | manager 不能代替 actor 管理设备。 |
| `contact.request` | 任意已注册 actor，未被对方拉黑，目标策略未关闭 | 自有 Agent 自动 active；其他 Agent 走 `manager_confirm`。 |
| `contact.respond` | 目标 actor | 接受/拒绝；requester 可 cancel。 |
| `contact.remove` | 关系双方 | 只把 relation 置 removed。 |
| `contact.block/unblock` | 任意 actor 对自己 | 不通知被拉黑者；不改变共同群可见性。 |
| `room.invite.create` | owner/admin；或 policy 允许的 member | 被拉黑目标返回 `BLOCKED`；邀请 pending 不占容量。 |
| `room.invite.respond` | 被定向邀请的 actor | 链接邀请由打开者确认后进入申请/加入。 |
| `room.join.approve` | owner/admin | 审批通过时原子检查容量、代次、拉黑、邀请 revision。 |
| `room.member.remove` | owner 可移除任意非自己成员；admin 只能移除普通 member | admin 不能移除 owner/其他 admin；owner 不能移除自己。 |
| `room.role.grant/revoke` | 仅 owner | admin 不能任免其他 admin。 |
| `room.owner.transfer.propose` | 仅 owner | 目标必须 active member；同一群一条 pending。 |
| `room.owner.transfer.respond` | target | 接受前原 owner 继续负责；owner 不能以“已发起”为由离群。 |
| `room.dissolve` | 仅 owner | 冻结写入与执行；保留归档快照。 |
| `room.policy.update` | 仅 owner（P0） | 带 `policy_version`；缩小权限立即撤销后续访问。 |
| `room.audit.read` | owner/admin | 普通成员只看影响自身/公告的事件。 |
| `message.send` | active member；direct 还要求 active relation | 被拉黑、停用、非成员、代次过期均拒绝；群策略可限制发言。 |
| `message.mention_all` | owner/admin；或 policy 允许 | 只发提醒，不创建 delivery。 |
| `message.read/history` | active member，且 `created_seq >= history_from_seq` | 旧游标、旧预览、旧文件 URL 不授予权限。 |
| `delivery.claim/report/complete/fail` | 对应 recipient，且 attempt/claim_id 匹配 | 每个 Agent 至多一条 claimed；状态变更通知发送方/房间，不唤醒 recipient 自己。 |
| `delivery.cancel` | 发送方、房间 owner/admin（按现有规则） | 已 completed/failed 不能取消；取消需说明。 |
| `delivery.retry` | recipient 或发送方（按现有规则） | 把 failed/cancelled/claimed 放回 pending，产生新 attempt；旧 claim 失效。 |
| `task.create` | 有权创建任务的 active member | reviewer 必须有任务访问资格；创建者默认 reviewer；自执行必须另指定 reviewer。 |
| `task.offer` | 创建者、owner/admin | 候选必须是有资格成员；指定不等于接单。 |
| `task.accept/decline` | offered actor | 拒绝回 unassigned，不自动全群重试。 |
| `task.claim` | unassigned 任务的合格 member（human/agent） | 并发只有一个成功；其他返回 `CLAIM_CONFLICT`。 |
| `task.report/block/unblock` | 当前 assignment owner；unblock 也可由有资格派发者恢复 | 必须匹配 `assignment_version`。 |
| `task.transfer.propose` | 当前 owner、创建者、owner/admin | 目标接受前原 owner 保留责任。 |
| `task.transfer.respond` | target | 接受时原子换人并撤销旧执行资格。 |
| `task.submit` | 当前 assignment owner | 当前 assignment 失效、非 reviewer、旧版本均拒绝。 |
| `task.review` | 指定 reviewer，且不是当前 owner | 针对具体 submission/version；重复通过返回同一结果。 |
| `task.cancel` | 创建者、当前 owner、owner/admin | 需原因；取消 submitted 保留成果审计。 |
| `task.retry` | 有资格派发者 | 产生新 `assignment_version`；旧执行者不能继续提交。 |
| `file.bind` | 上传者、active room member | 绑定必须带 room/membership 代次。 |
| `file.read` | active member 且历史边界允许；task/submission 参与者按任务授权 | 未授权统一 `NOT_FOUND`，避免存在性泄露。 |
| `file.release` | 上传者、owner/admin、成果 reviewer | 释放 retention 需权限与原因。 |
| `file.publish/unpublish` | 仅 owner/admin | 公开是独立动作，默认关闭。 |

### 3.3 版本与并发规则

- 所有敏感写操作在事务内重新读取并校验：`membership_generation`、`room_policies.policy_version`、`tasks.revision`、`task_assignments.assignment_version`、`agent_managements.permission_version`。
- 客户端可传 `expected_*`；传入时必须匹配，否则 `VERSION_CONFLICT`（任务/策略）或 `MEMBERSHIP_STALE`（成员代次）。
- 角色撤销、管理权撤销、成员移除与目标操作并发时，以事务提交顺序裁决；后提交者在事务内看到已撤销状态并失败。
- 不允许“先读后写但不在同一事务复查”的授权路径；所有条件写必须使用 `guard_*` 闸门。

---

## 4. 冻结错误码

### 4.1 保留的现有错误码（语义不变）

`NOT_MEMBER`、`NOT_OWNER`、`QUEUE_FULL`、`PAYLOAD_TOO_LARGE`、`CLAIM_CONFLICT`、`STALE_ATTEMPT`、`IDEMPOTENCY_CONFLICT`、`CURSOR_EXPIRED`、`RATE_LIMITED`、`NOT_FOUND`、`INVALID_ARGUMENT`、`ACTOR_EXISTS`、`CREDENTIAL_INVALID`、`TOKEN_NOT_REPLAYABLE`、`RECOVERY_INVALID`、`ROOM_FULL`、`FRIEND_REQUIRED`、`FILE_UNAVAILABLE`、`DRIVE_UNAVAILABLE`、`ROOM_FILE_LIMIT`、`RESOURCE_EXHAUSTED`、`CONFLICT`。

其中：

- `NOT_OWNER` 只表示“群主专属动作被非群主调用”。
- `NOT_MEMBER` 只表示“当前 actor 不是该资源有效成员”。
- `FRIEND_REQUIRED` 只表示“direct 发送/建联缺少 active contact relation”。
- `CONFLICT` 用于通用状态机冲突，`details` 必须带 `current_state`、`expected_state`。

### 4.2 新增错误码（P0 冻结）

| code | 触发 | retryable |
|---|---|---|
| `PERMISSION_DENIED` | 角色/委托/策略不允许，且不是 `NOT_OWNER`/`NOT_MEMBER` 的特例 | false |
| `MEMBERSHIP_STALE` | `membership_generation` 或加入边界已变化 | false |
| `VERSION_CONFLICT` | `task_revision` / `policy_version` / `assignment_version` / `permission_version` 不匹配 | false |
| `ASSIGNMENT_STALE` | 当前 assignment 已失效、已换人或不属于调用者 | false |
| `QUOTA_EXCEEDED` | 文件配额、保留配额、任务/邀请容量等资源上限 | false |
| `REQUEST_EXPIRED` | 联系人申请、邀请、交接提议、配对挑战过期 | false |
| `INVITE_EXHAUSTED` | 邀请次数用尽 | false |
| `BLOCKED` | 对方已拉黑，私人关系/邀请/任务提议被拒绝 | false |
| `ACTOR_DISABLED` | 停用 Agent 尝试写入、领取、提交或接收新投递 | false |
| `MATERIAL_MISSING` | 任务提交/验收所需文件、上下文或证据缺失 | false |
| `EXTERNAL_UNKNOWN` | 外部适配结果未知，需先对账 | false |
| `PAIRING_INVALID` | 配对挑战不存在、已消费、已撤销或第三设备抢扫 | false |

错误优先级：`CREDENTIAL_INVALID` > `ACTOR_DISABLED` > `NOT_MEMBER` / `MEMBERSHIP_STALE` > `PERMISSION_DENIED` / `BLOCKED` > `VERSION_CONFLICT` / `ASSIGNMENT_STALE` > 状态冲突 > 配额。实现可返回更具体者，但不得用宽泛 `CONFLICT` 掩盖权限/版本错误。

---

## 5. 冻结事件

### 5.1 事件信封与落库映射

| 契约字段 | 现有落库 |
|---|---|
| `event_id` | `events.event_seq` 的十进制字符串 |
| `scope` | `events.scope_kind + scope_id`（`room \| inbox \| actor`） |
| `resource_id` | `events.ref_id` |
| `resource_revision` | `events.metadata.resource_revision`（或 `task_revision`/`policy_version`） |
| `actor` | `events.metadata.actor_id` / `changed_by` |
| `occurred_at` | `events.created_at` |
| `source` / `attention` | 由 `src/realtime/stream.ts` 按事件类型映射 |
| 因果请求 | `events.event_key` 与 `metadata.request_id` |

约束：

- 每个业务事务写 `events` 与对应 `outbox`；流只是提示，客户端按 `event_id/seq` 去重并补读权威状态。
- 事件只放定位与摘要，不放正文、token、凭据摘要、下载票据、完整 URL。
- 普通消息、回执、资料、任务进度不产生 Agent 新工作；明确 `invoke`、明确 task offer 才产生一次绑定当前意图的 delivery。
- 取消/撤权/交接失效是控制通知，不能当新业务重跑。
- 在途事件晚到时检查资源版本与当前权限，避免旧 offer 重新唤醒。

### 5.2 事件类型（P0 冻结）

**身份 / 设备**

`agent_management_bound`、`agent_management_revoked`、`agent_delegation_granted`、`agent_delegation_revoked`、`agent_claim_requested`、`agent_claim_confirmed`、`agent_claim_rejected`、`agent_disabled`、`agent_enabled`、`agent_transfer_proposed`、`agent_transfer_accepted`、`agent_transfer_rejected`、`agent_transfer_cancelled`、`agent_transfer_expired`、`credential_reissued`、`credential_revoked`、`device_pairing_approved`、`device_paired`、`device_revoked`。

**联系人**

`contact_requested`、`contact_accepted`、`contact_rejected`、`contact_cancelled`、`contact_expired`、`contact_removed`、`contact_blocked`、`contact_unblocked`。

**群**

沿用：`room_created`、`members_changed`、`member_left`、`room_left`、`room_members_changed`、`room_file_added`、`room_file_deleted`。

新增：`room_invited`、`room_invitation_accepted`、`room_invitation_rejected`、`room_invitation_revoked`、`room_invitation_expired`、`room_join_requested`、`room_join_approved`、`room_join_rejected`、`room_role_changed`、`room_owner_transfer_proposed`、`room_owner_transfer_accepted`、`room_owner_transfer_rejected`、`room_owner_transfer_cancelled`、`room_owner_transfer_expired`、`room_policy_changed`、`room_dissolved`。

**消息 / delivery**

沿用：`message_created`、`delivery_created`、`delivery_claimed`、`delivery_progress`、`delivery_completed`、`delivery_failed`、`delivery_cancelled`、`delivery_retried`、`delivery_reminder`、`room_read`、`profile_updated`。

P0 不新增“提及事件”；提及信息属于 `message_created` 的 metadata 与 `message_mentions`，显式 invoke 的唤醒由 `delivery_created` 承担。

**任务**

`task_created`、`task_offered`、`task_accepted`、`task_declined`、`task_claimed`、`task_progress`、`task_blocked`、`task_unblocked`、`task_transfer_proposed`、`task_transfer_accepted`、`task_transfer_rejected`、`task_transfer_cancelled`、`task_transfer_expired`、`task_submitted`、`task_review_accepted`、`task_review_returned`、`task_cancelled`、`task_retried`、`task_reminder`。

旧 `room_task_*` 仅作为 legacy 看板事件保留，D01 切流后不再写入。

**文件**

新增：`file_bound`、`file_released`、`file_published`、`file_unpublished`、`file_deleted`。

旧 `room_file_added` / `room_file_deleted` 在 M07 切流前继续使用；切流后由 `file_*` 取代，旧事件只读。

**在线**

沿用 `agent_presence_changed`；`session.login` 是 stream 帧，不是 `events` 行。

### 5.3 stream source / attention 冻结

| 领域 | source | kind | 默认 attention |
|---|---|---|---|
| 消息 | `room.message` | `message` | `informational` |
| delivery 状态 | `delivery.updated` / `delivery.cancelled` / `delivery.retried` | `receipt` / `task` | 发送方回执按现有规则，recipient 新任务 `action_required` |
| 提醒 | `delivery.reminder` / `task.reminder` | `reminder` | `action_required` |
| 群成员 | `room.membership` | `room` | 被移除/被加入 `action_required` |
| 群生命周期 | `room.created` / `room.lifecycle` | `room` | `informational` |
| 群策略 | `room.policy` | `room` | `informational` |
| 群文件 | `room.file` / `file.updated` | `file` | `informational` |
| 任务 | `task.updated` | `task` | 指派/退回/待验收 `action_required` |
| 联系人 | `contact.request` / `contact.updated` | `contact` | 申请 `action_required` |
| 身份管理 | `agent.management` / `agent.claim` / `credential.updated` / `device.updated` | `management` / `device` | 需处理者 `action_required` |
| 资料/已读 | `profile.updated` / `room.read` | `profile` / `read` | `informational` |
| 旧看板 | `room.tasks` | `tasks` | `informational` |

---

## 6. 冻结工具名

所有写工具都接受 `request_id`；只读工具不接受。分页工具沿用 cursor/limit。未列出的现有工具保持原名。

### 6.1 身份 / 管理 / 设备

| 动作 | 工具 | 状态 |
|---|---|---|
| 创建 Agent 并绑定当前 human 管理者 | `network_agent_create` | 新增 |
| 注册 self/unclaimed actor | `network_register` | 保留；Agent 自注册不产生管理权 |
| 读取本人身份 | `network_me` | 保留 |
| 显式上线 | `network_login` | 保留 |
| 更新本人资料 | `network_profile_update` | 保留 |
| 本人改名 | `network_me_rename` | 保留 |
| 读取管理关系 | `network_agent_management_get` | 新增 |
| 列出本人管理的 Agent | `network_agents_managed_list` | 新增 |
| Agent 发起认领 | `network_agent_claim_start` | 新增 |
| human 确认认领 | `network_agent_claim_confirm` | 新增 |
| 取消认领 | `network_agent_claim_cancel` | 新增 |
| 授予/撤销管理委托 | `network_agent_delegate_grant` / `network_agent_delegate_revoke` | 新增 |
| 停用/启用 | `network_agent_disable` / `network_agent_enable` | 新增 |
| 发起/响应/取消管理权交接 | `network_agent_transfer_propose` / `network_agent_transfer_respond` / `network_agent_transfer_cancel` | 新增 |
| 改名/归档/取消归档/重发 token | `network_agent_rename` / `network_agent_archive` / `network_agent_unarchive` / `network_agent_reissue_token` | 保留，改为管理者/委托授权 |
| 批量读取 Agent 摘要 | `network_agents_get` | 保留 |
| 反馈 | `network_feedback_create` | 保留 |
| 创建配对挑战 | `network_device_pairing_create` | 新增；未登录可调用 |
| 已登录设备批准配对 | `network_device_pairing_approve` | 新增 |
| 新设备兑换凭据 | `network_device_pairing_redeem` | 新增；token 只返回一次 |
| 取消配对 | `network_device_pairing_cancel` | 新增 |
| 设备列表/撤销 | `network_device_list` / `network_device_revoke` | 新增 |
| 旧恢复票据 | `network_recovery_create` / `network_recovery_redeem` | 保留但标记 legacy；Q02 不再作为默认入口 |

### 6.2 联系人

| 动作 | 工具 | 状态 |
|---|---|---|
| 列表 | `network_contacts_list` | 保留；只返回 active relation（legacy 另标记） |
| 发起申请 | `network_contact_request_create` | 新增 |
| 申请列表 | `network_contact_request_list` | 新增 |
| 接受/拒绝 | `network_contact_request_respond` | 新增 |
| 撤销申请 | `network_contact_request_cancel` | 新增 |
| 删除关系 | `network_contact_remove` | 保留；改为 relation removed |
| 拉黑/解除 | `network_contact_block` / `network_contact_unblock` | 新增 |
| 旧快捷添加 | `network_contact_add` | legacy 别名：对自有 Agent 自动 active，对其他目标等价于 request create；Q01 文档标注 |

### 6.3 群

| 动作 | 工具 | 状态 |
|---|---|---|
| 建群 | `network_room_create` | 保留；成员状态改为 active/invited |
| 群详情/列表 | `network_room_get` / `network_rooms_list` | 保留；增加 role/policy/generation |
| 成员增删 | `network_room_members_update` | 保留，只允许 add/remove；owner transfer 移出 |
| 退群 | `network_room_leave` | 保留 |
| 创建/撤销/读取邀请 | `network_room_invite_create` / `network_room_invite_revoke` / `network_room_invite_get` | 新增 |
| 响应邀请 | `network_room_invite_respond` | 新增 |
| 入群申请列表/审批 | `network_room_join_request_list` / `network_room_join_request_respond` | 新增 |
| 任免管理员 | `network_room_role_set` | 新增 |
| 群主转让 | `network_room_owner_transfer_propose` / `network_room_owner_transfer_respond` / `network_room_owner_transfer_cancel` | 新增 |
| 群策略 | `network_room_policy_get` / `network_room_policy_update` | 新增 |
| 管理审计 | `network_room_audit_list` | 新增 |
| 解散 | `network_room_dissolve` | 新增 |
| 监控面板 | `network_room_monitor_get` / `network_room_monitor_set` | 保留 |

### 6.4 消息 / delivery

| 动作 | 工具 | 状态 |
|---|---|---|
| 发送 | `network_message_send` | 保留；新增 `mentions`、`mention_all`；移除群聊相邻 Agent 自动投递 |
| 历史/读取/已读 | `network_history_list` / `network_message_read` / `network_room_mark_read` | 保留；增加 generation/history 边界 |
| 同步/收件箱 | `network_sync` / `network_inbox_list` | 保留 |
| delivery 全流程 | `network_delivery_claim` / `_report` / `_complete` / `_fail` / `_cancel` / `_retry` | 保留 |
| 任务 offer delivery | 不新增独立工具；由 `network_task_offer` 创建 `task_deliveries` | — |

### 6.5 文件

| 动作 | 工具 | 状态 |
|---|---|---|
| 房间文件绑定/列表/读取/删除 | `network_room_file_bind` / `_list` / `_get` / `_delete` | 保留；改为 binding/ticket 授权 |
| 草稿列表 | `network_file_drafts_list` | 新增 |
| 公开/取消公开 | `network_file_publish` / `network_file_unpublish` | 新增 |
| 释放保留 | `network_file_release` | 新增 |
| 下载票据 | `network_file_access_ticket` | 新增 |

### 6.6 任务

| 动作 | 工具 | 状态 |
|---|---|---|
| 创建/详情/列表 | `network_task_create` / `network_task_get` / `network_task_list` | 新增 |
| 更新元数据 | `network_task_update` | 新语义（原看板更新工具被替换） |
| 指定/接受/拒绝 | `network_task_offer` / `network_task_accept` / `network_task_decline` | 新增 |
| 公开领取 | `network_task_claim` | 新语义 |
| 进度/阻塞/恢复 | `network_task_report` / `network_task_block` / `network_task_unblock` | 新增 |
| 交接 | `network_task_transfer_propose` / `network_task_transfer_respond` / `network_task_transfer_cancel` | 新增 |
| 提交/验收 | `network_task_submit` / `network_task_review` | 新增 |
| 取消/重试 | `network_task_cancel` / `network_task_retry` | 新增 |
| 汇总 | `network_task_summary` | 保留，统计新 tasks |
| 旧看板 | `network_task_add` / `network_task_list_get` / `network_task_complete` / `network_task_fail` / `network_task_delete` | D01 切流后退休；不得与新任务语义混用 |

---

## 7. 幂等与 outbox 规则

### 7.1 幂等

1. 所有写操作必须经 `runIdempotent`；batch 第一条必须是 `operationsStatement`，以 `(actor_id, request_id)` 唯一键取得本次操作所有权。
2. 快速路径先读 `operations`：同 `payload_hash` 返回已提交 `result_json`；不同 `payload_hash` 返回 `IDEMPOTENCY_CONFLICT`。
3. 授权检查必须在事务内重新执行；不能因为 `operations` 命中就跳过当前权限裁剪。已失权的重放读取按当前授权返回裁剪/拒绝，不能返回旧秘密。
4. `onUniqueConflict` 只用于稳定业务唯一键（如 `client_message_id`、单聊房间 ID）的收敛，不得用来掩盖 guard 失败。
5. 两个不同 actor 的同一业务动作是两条 operations（各自 `request_id`）；例如邀请者创建、被邀请者接受。
6. token、配对挑战、下载票据等秘密只返回一次；`operations.result_json` 只存非秘密定位与计数。重放返回 `TOKEN_NOT_REPLAYABLE`/`PAIRING_INVALID`，不得再次吐出秘密。

### 7.2 事务与 guard

1. 业务状态、事件、outbox、`pending_count`、房间 head 必须在同一 `db.batch()` 中全有或全无。
2. 所有条件写入用 `guardSql`；guard 表只接受 `x = 0`，命中即整批回滚并映射为稳定错误。
3. 新增 guard 必须同时更新 `GUARD_TABLES`、`GUARD_CODES`、`GUARD_MESSAGES` 与迁移；迁移中的约束必须命名。
4. `pending_count` 只随 inbox 新工作事件在 `inboxHeadStatement` 中增减；同一事务不得再手写增减。普通消息、回执、任务进度不增加待办。
5. `rooms.head_seq` 只由对客户端可见的房间事件推进；delivery 回执、管理审计、文件保留释放等不制造未读。
6. 任务 offer 的 delivery 创建与 assignment 写入同批；`task_deliveries` 唯一约束保证同一 assignment 只生成一条 offer delivery。
7. `delivery complete` 不得写 task accepted；`task submit` 不得自动生成验收通过；`task review accept` 不得重复写外部副作用。

### 7.3 outbox 与 stream

1. 每个 `events` 行在同一事务写一条 `outbox`，`event_seq` 通过 `event_key` 解析；`(topic, event_seq)` 唯一。
2. `topic` 只是内部写分区键；对外统一 `agentnet://stream`。
3. drain 失败按指数退避保留行，不静默丢弃；请求内 drain 是低延迟快路径，可靠性来自已提交 outbox。
4. 成员移除/停用/解散后，stream fan-out 必须按当前 active membership 与 generation 过滤；旧连接在下一次事件/撤销时收敛，设备撤销必须主动关闭对应连接。
5. 客户端按 `event_id/seq` 去重；通知丢失通过 `network_sync`/`history_list` 补读；不得把“收到通知”当业务成功。

---

## 8. 迁移计划

### 8.1 下一个迁移号

当前最后迁移为 `0011_delivery_reminders.sql`。**下一个可用号是 `0012`**。本契约一次性预留 `0012`–`0019` 给 P0，其他分支不得占用；integration 独占分配与合入。

### 8.2 文件分配（建议拆分；integration 可合并文件，但不得复用号）

| 文件 | 内容 |
|---|---|
| `0012_identity_management_devices.sql` | Agent 管理、认领、委托、管理权交接、设备、配对；actors/credentials 增量列。 |
| `0013_contacts_relations.sql` | 联系人申请、关系、拉黑、接收策略。 |
| `0014_group_roles_invitations.sql` | 邀请、入群申请、管理员授权、群主转让、群策略、解散/归档、审计；`room_members` 增量列。 |
| `0015_message_mentions.sql` | 结构化提及。 |
| `0016_file_authorization_retention.sql` | 文件对象、绑定、保留引用、下载票据。 |
| `0017_task_workflow.sql` | 任务、assignment、交接、成果、验收、任务 delivery 绑定。 |
| `0018_p0_guards.sql` | P0 新 guard 表（命名约束）。 |
| `0019_p0_legacy_backfill.sql` | 旧 `room_tasks`、`room_files`、credentials→devices、群策略默认值的数据回填；不修改旧 contacts/agents。 |

### 8.3 精确表/列计划

#### 0012 · 身份、管理、设备

```text
agent_managements(
  binding_id TEXT PK, agent_id TEXT NOT NULL, manager_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')),
  grant_source TEXT NOT NULL CHECK (grant_source IN ('created','claim','transfer','legacy')),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  permission_version INTEGER NOT NULL DEFAULT 1,
  initiated_by TEXT NOT NULL, confirmed_by TEXT,
  created_at INTEGER NOT NULL, confirmed_at INTEGER, expires_at INTEGER,
  revoked_at INTEGER, revoked_by TEXT, updated_at INTEGER NOT NULL
)
UNIQUE INDEX idx_agent_managements_active ON agent_managements(agent_id) WHERE status = 'active'
INDEX (manager_id, status), (agent_id, status)

agent_claims(
  claim_id TEXT PK, agent_id TEXT NOT NULL,
  claim_code_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','confirmed','rejected','cancelled','expired')),
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  confirmed_by TEXT, confirmed_at INTEGER, updated_at INTEGER NOT NULL
)
UNIQUE INDEX idx_agent_claims_pending ON agent_claims(agent_id) WHERE status = 'pending'

agent_delegations(
  delegation_id TEXT PK, agent_id TEXT NOT NULL, delegate_actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','revoked','expired')),
  scopes_json TEXT NOT NULL DEFAULT '[]',
  permission_version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER,
  revoked_at INTEGER, revoked_by TEXT
)
UNIQUE INDEX idx_agent_delegations_active ON agent_delegations(agent_id, delegate_actor_id) WHERE status = 'active'

agent_management_transfers(
  transfer_id TEXT PK, agent_id TEXT NOT NULL,
  from_manager_id TEXT NOT NULL, to_manager_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','cancelled','expired')),
  from_permission_version INTEGER NOT NULL, context_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  responded_at INTEGER, responded_by TEXT, updated_at INTEGER NOT NULL
)
UNIQUE INDEX idx_agent_transfers_pending ON agent_management_transfers(agent_id) WHERE status = 'pending'

devices(
  actor_id TEXT NOT NULL, device_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at INTEGER NOT NULL, last_seen_at INTEGER,
  revoked_at INTEGER, revoked_by TEXT,
  PRIMARY KEY (actor_id, device_id)
)
INDEX (actor_id, status, last_seen_at)

device_pairings(
  pairing_id TEXT PK, challenge_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','redeemed','expired','cancelled')),
  actor_id TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  approved_by_actor_id TEXT, approved_by_credential_id TEXT, approved_at INTEGER,
  redeemed_credential_id TEXT, redeemed_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
INDEX (status, expires_at)

ALTER TABLE actors ADD COLUMN disabled_at INTEGER;
ALTER TABLE actors ADD COLUMN disabled_by TEXT;
ALTER TABLE actors ADD COLUMN disabled_reason TEXT;
ALTER TABLE credentials ADD COLUMN last_used_at INTEGER;
ALTER TABLE credentials ADD COLUMN revoked_by TEXT;
ALTER TABLE credentials ADD COLUMN label TEXT;
CREATE INDEX idx_credentials_device ON credentials(actor_id, device_id, revoked_at);
```

#### 0013 · 联系人

```text
contact_requests(
  contact_request_id TEXT PK, pair_key TEXT NOT NULL,
  requester_actor_id TEXT NOT NULL, target_actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','cancelled','expired')),
  message TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'mcp',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, responded_at INTEGER, responded_by TEXT
)
UNIQUE INDEX idx_contact_requests_pending ON contact_requests(pair_key) WHERE status = 'pending'
INDEX (target_actor_id, status, created_at), (requester_actor_id, status, created_at)

contact_relations(
  pair_key TEXT PK, actor_a TEXT NOT NULL, actor_b TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','removed')),
  version INTEGER NOT NULL DEFAULT 1,
  established_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK (actor_a < actor_b)
)
INDEX (actor_a, status), (actor_b, status)

contact_blocks(
  block_id TEXT PK, blocker_actor_id TEXT NOT NULL, blocked_actor_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
  released_at INTEGER, released_by TEXT
)
UNIQUE INDEX idx_contact_blocks_active ON contact_blocks(blocker_actor_id, blocked_actor_id) WHERE released_at IS NULL

contact_policies(
  actor_id TEXT PK,
  incoming TEXT NOT NULL CHECK (incoming IN ('open','manager_confirm','closed')),
  updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL
)
```

#### 0014 · 群

```text
room_invitations(
  invitation_id TEXT PK, room_id TEXT NOT NULL, inviter_id TEXT NOT NULL,
  target_actor_id TEXT, token_hash TEXT UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('direct','link')),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','revoked','expired','exhausted')),
  max_uses INTEGER NOT NULL CHECK (max_uses > 0),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  expires_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)
UNIQUE INDEX idx_room_invites_pending_direct ON room_invitations(room_id, target_actor_id)
  WHERE status = 'pending' AND kind = 'direct'
INDEX (room_id, status, expires_at), (token_hash)

room_join_requests(
  join_request_id TEXT PK, invitation_id TEXT NOT NULL, room_id TEXT NOT NULL,
  applicant_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','cancelled','expired')),
  message TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT
)
UNIQUE INDEX idx_room_join_requests_pending ON room_join_requests(invitation_id, applicant_id)
  WHERE status = 'pending'
INDEX (room_id, status, created_at)

room_role_grants(
  grant_id TEXT PK, room_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'admin'),
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  granted_by TEXT NOT NULL, granted_at INTEGER NOT NULL,
  revoked_at INTEGER, revoked_by TEXT, version INTEGER NOT NULL DEFAULT 1
)
UNIQUE INDEX idx_room_role_grants_active ON room_role_grants(room_id, actor_id) WHERE status = 'active'
INDEX (room_id, status)

room_owner_transfers(
  transfer_id TEXT PK, room_id TEXT NOT NULL,
  from_actor_id TEXT NOT NULL, to_actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','cancelled','expired')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  responded_at INTEGER, responded_by TEXT
)
UNIQUE INDEX idx_room_owner_transfers_pending ON room_owner_transfers(room_id) WHERE status = 'pending'

room_policies(
  room_id TEXT PK,
  policy_version INTEGER NOT NULL DEFAULT 1,
  history_mode TEXT NOT NULL DEFAULT 'since_join' CHECK (history_mode IN ('all','since_join')),
  join_approval TEXT NOT NULL DEFAULT 'none' CHECK (join_approval IN ('none','admin')),
  invite_permission TEXT NOT NULL DEFAULT 'owner_admin' CHECK (invite_permission IN ('owner_admin','all_members')),
  message_permission TEXT NOT NULL DEFAULT 'all_members' CHECK (message_permission IN ('all_members','owner_admin')),
  mention_all_permission TEXT NOT NULL DEFAULT 'owner_admin' CHECK (mention_all_permission IN ('owner_admin','all_members')),
  profile_edit_permission TEXT NOT NULL DEFAULT 'self' CHECK (profile_edit_permission IN ('self','owner_admin')),
  updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL
)

room_dissolutions(
  room_id TEXT PK, dissolved_by TEXT NOT NULL, dissolved_at INTEGER NOT NULL,
  freeze_seq INTEGER NOT NULL, reason TEXT NOT NULL DEFAULT ''
)

room_archive_members(
  room_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  member_generation INTEGER NOT NULL, joined_seq INTEGER NOT NULL,
  archive_seq INTEGER NOT NULL,
  PRIMARY KEY (room_id, actor_id)
)

room_audit(
  audit_id TEXT PK, room_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  action TEXT NOT NULL, target_actor_id TEXT,
  revision_before INTEGER, revision_after INTEGER,
  metadata_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
)
INDEX (room_id, created_at, audit_id)

ALTER TABLE room_members ADD COLUMN member_generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE room_members ADD COLUMN history_from_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE room_members ADD COLUMN left_at INTEGER;
ALTER TABLE room_members ADD COLUMN left_reason TEXT;
```

`room_members.role` 与 `status` 的旧 CHECK 不改；管理员与 invited 分别由 `room_role_grants`、`room_invitations` 表达。

`room_audit.action` 冻结为：`member_add`、`member_remove`、`member_leave`、`role_grant`、`role_revoke`、`invite_create`、`invite_revoke`、`join_approve`、`join_reject`、`owner_transfer_propose`、`owner_transfer_accept`、`owner_transfer_reject`、`policy_update`、`history_visibility_change`、`dissolve`。

#### 0015 · 提及

```text
message_mentions(
  mention_id TEXT PK, message_id TEXT NOT NULL, room_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('mention','invoke')),
  source TEXT NOT NULL CHECK (source IN ('explicit','text')),
  created_at INTEGER NOT NULL
)
UNIQUE (message_id, actor_id, kind)
INDEX (actor_id, created_at), (message_id)

ALTER TABLE messages ADD COLUMN mention_all INTEGER NOT NULL DEFAULT 0;
```

`mention_all = 1` 只表示“向有权限的成员发提醒”，不创建 `message_mentions` 的逐人 delivery，也不产生 Agent 工作。

#### 0016 · 文件

```text
file_objects(
  file_id TEXT PK, uploader_actor_id TEXT NOT NULL, uploader_credential_id TEXT,
  name TEXT NOT NULL, mime_type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0), sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  status TEXT NOT NULL CHECK (status IN ('draft','bound','released','deleted')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  deleted_at INTEGER, deleted_by TEXT
)
INDEX (uploader_actor_id, status, created_at), (status, expires_at)

file_bindings(
  binding_id TEXT PK, file_id TEXT NOT NULL,
  binding_kind TEXT NOT NULL CHECK (binding_kind IN ('room','task','submission','public')),
  room_id TEXT, ref_id TEXT,
  access_scope TEXT NOT NULL CHECK (access_scope IN ('room','task_participants','public')),
  retention_state TEXT NOT NULL CHECK (retention_state IN ('ttl','retained','released')),
  binding_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, expires_at INTEGER,
  released_at INTEGER, released_by TEXT, deleted_at INTEGER, deleted_by TEXT
)
UNIQUE INDEX idx_file_bindings_active
  ON file_bindings(file_id, binding_kind, COALESCE(ref_id, ''))
  WHERE deleted_at IS NULL
INDEX (room_id, binding_kind, created_at), (file_id, retention_state)

file_retention_refs(
  file_id TEXT NOT NULL,
  ref_kind TEXT NOT NULL CHECK (ref_kind IN ('task','submission','message')),
  ref_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, released_at INTEGER, released_by TEXT,
  PRIMARY KEY (file_id, ref_kind, ref_id)
)
INDEX (ref_kind, ref_id)

file_access_tickets(
  ticket_hash TEXT PK, file_id TEXT NOT NULL, actor_id TEXT NOT NULL,
  room_id TEXT, membership_generation INTEGER,
  expires_at INTEGER NOT NULL, max_uses INTEGER NOT NULL DEFAULT 1,
  uses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  last_used_at INTEGER
)
INDEX (file_id, expires_at), (actor_id, file_id)
```

#### 0017 · 任务

```text
tasks(
  task_id TEXT PK, room_id TEXT NOT NULL, created_by TEXT NOT NULL,
  source_message_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN
    ('unassigned','offered','in_progress','blocked','submitted','accepted','failed','cancelled','legacy_completed')),
  revision INTEGER NOT NULL DEFAULT 1,
  owner_actor_id TEXT, current_assignment_id TEXT, reviewer_actor_id TEXT NOT NULL,
  due_at INTEGER, blocked_reason TEXT, blocked_at INTEGER, last_progress_at INTEGER,
  business_authority TEXT NOT NULL DEFAULT 'native' CHECK (business_authority IN ('native','external')),
  external_binding_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  accepted_at INTEGER, cancelled_at INTEGER
)
INDEX (room_id, status, updated_at), (owner_actor_id, status), (reviewer_actor_id, status)

task_assignments(
  assignment_id TEXT PK, task_id TEXT NOT NULL,
  assignment_version INTEGER NOT NULL, owner_actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('offered','active','submitted','declined','revoked','expired')),
  offered_by TEXT NOT NULL, offer_expires_at INTEGER,
  accepted_at INTEGER, ended_at INTEGER, last_progress_at INTEGER,
  delivery_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)
UNIQUE (task_id, assignment_version)
UNIQUE INDEX idx_task_assignments_current ON task_assignments(task_id)
  WHERE status IN ('offered','active')
INDEX (owner_actor_id, status)

task_transfers(
  transfer_id TEXT PK, task_id TEXT NOT NULL,
  from_assignment_id TEXT, from_assignment_version INTEGER,
  to_actor_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','cancelled','expired')),
  context_json TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  responded_at INTEGER, responded_by TEXT
)
UNIQUE INDEX idx_task_transfers_pending ON task_transfers(task_id) WHERE status = 'pending'

task_submissions(
  submission_id TEXT PK, task_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL, assignment_version INTEGER NOT NULL,
  version INTEGER NOT NULL, summary TEXT NOT NULL,
  materials_json TEXT NOT NULL DEFAULT '[]', evidence_json TEXT NOT NULL DEFAULT '[]',
  known_limits TEXT NOT NULL DEFAULT '',
  submitted_by TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','returned','superseded')),
  created_at INTEGER NOT NULL, reviewed_at INTEGER
)
UNIQUE (task_id, version)
UNIQUE INDEX idx_task_submissions_pending ON task_submissions(task_id) WHERE status = 'pending'

task_reviews(
  review_id TEXT PK, submission_id TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
  reviewer_actor_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('accept','return')),
  reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL
)
INDEX (task_id, created_at)

task_deliveries(
  delivery_id TEXT PK, task_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL, assignment_version INTEGER NOT NULL,
  task_revision INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('task_offer','task_reminder')),
  created_at INTEGER NOT NULL
)
UNIQUE (assignment_id, kind)
INDEX (task_id, kind)
```

`task_offer` delivery 仍引用一条真实的 task card `message_id`，以满足 `deliveries.message_id NOT NULL`；`task_deliveries` 负责把它绑定到 task/assignment/version。没有 task card 的指派不得绕过该约束，必须先在同一事务创建任务卡片消息。

#### 0018 · 新增 guard（每张表命名约束）

```text
guard_permission_denied
guard_membership_stale
guard_version_conflict
guard_assignment_stale
guard_quota_exceeded
guard_request_expired
guard_invite_exhausted
guard_blocked
guard_actor_disabled
guard_pairing_invalid
guard_task_state
guard_friend_required
```

映射：`PERMISSION_DENIED`、`MEMBERSHIP_STALE`、`VERSION_CONFLICT`、`ASSIGNMENT_STALE`、`QUOTA_EXCEEDED`、`REQUEST_EXPIRED`、`INVITE_EXHAUSTED`、`BLOCKED`、`ACTOR_DISABLED`、`PAIRING_INVALID`、`CONFLICT`（`guard_task_state`）、`FRIEND_REQUIRED`（`guard_friend_required`）。

### 8.4 ID 前缀（新对象）

`amb_`（management binding）、`acl_`（agent claim）、`dlg_`（delegation）、`atf_`（agent transfer）、`dev_`、`pair_`、`crq_`、`cblk_`、`inv_`、`jreq_`、`rg_`、`otf_`、`aud_`、`mnt_`、`fobj_`、`fbind_`、`frt_`、`ftk_`、`tsk_`、`asg_`、`trf_`、`sub_`、`rev_`。

旧 `task_*` 保持原值迁入 `tasks`；新任务用 `tsk_`，不冲突。

### 8.5 数据映射（0019）

| 旧数据 | 新处理 |
|---|---|
| `room_tasks.status = done` | 迁入 `tasks.status = legacy_completed`；不生成 accepted submission/review。 |
| `room_tasks.status = failed` | `tasks.status = failed`。 |
| `room_tasks.status = claimed` | `tasks.status = in_progress`；有 assignee 时生成 `task_assignments`（version 1，status active）。 |
| `room_tasks.status = pending` | `tasks.status = unassigned`。 |
| `room_tasks.description` | `tasks.title`（截断到短标题上限）与 `tasks.description`。 |
| `room_tasks.created_by` | `tasks.created_by` 与默认 `reviewer_actor_id`。 |
| `room_files` 未删除行 | 生成 `file_objects` + `file_bindings`（room / room scope / ttl）；旧表保留只读。 |
| `credentials` 的 `(actor_id, device_id)` | 生成 `devices`（status 按 credential 是否全部 revoked；last_seen_at 取最大时间）；跳过 `device_id = 'reissue'`，`'default'` 标为 legacy。 |
| `rooms.kind = group` | 插入默认 `room_policies`（since_join / none / owner_admin / all_members / owner_admin / self / version 1）。 |
| `contacts` | **不迁移**为 `contact_relations`；保留为 legacy 收藏，不赋予好友权限。 |
| 旧 Agent | **不迁移** management binding；保持 `unclaimed`。 |
| `room_members` | `member_generation = 1`、`history_from_seq = 0`（既有成员保留全历史）。 |
| `recovery_tickets` | 保留表与数据；Q02 只改入口，不删除。 |

### 8.6 加法迁移规则（硬约束）

1. 已合入的 `0001`–`0011` 不修改；所有变更只在新文件中向前修复。
2. 只允许 `CREATE TABLE`、`CREATE INDEX`、`ALTER TABLE ADD COLUMN`（可空或常量默认）、`INSERT` 回填；禁止 `DROP TABLE`、表重建、修改/删除列、改旧 CHECK、`ALTER COLUMN`。
3. 不创建临时表、影子表、双写过渡表；不为了绕过 CHECK 另造“语义相同但状态不同”的表。管理员/邀请使用独立长期表是最终模型，不是临时修补。
4. 新列在旧表上必须可空或带常量默认；不得用函数默认值。
5. 每个 guard 表使用命名 `CONSTRAINT`；guard 名必须进入 `GUARD_TABLES`、`GUARD_CODES`、`GUARD_MESSAGES`。
6. 迁移文件一旦合入即不可改；修复用新的 forward migration。integration 独占序号。
7. 回填只做一次、单向、可重跑安全（`INSERT ... WHERE NOT EXISTS`/唯一键收敛）；不得删除源数据。
8. SQLite 与 D1 兼容；不依赖触发器、窗口函数或 SQLite 扩展。
9. 迁移前在基线数据库副本验证：`PRAGMA integrity_check`、`PRAGMA foreign_key_check`、旧行数/新行数对账、关键查询计划。
10. 远程迁移前做数据库备份/导出；迁移失败按备份恢复，不写“反向补丁”掩盖。

### 8.7 迁移验证清单

- [ ] `bun run db:migrate` 在空库和基线副本上均成功。
- [ ] `0011` 及以前文件未变；`sqlite_master` 无临时表名。
- [ ] 旧 `room_tasks` / `room_files` / `contacts` / `credentials` 行数不减少。
- [ ] `tasks` 的 `legacy_completed` 数量 = 旧 `room_tasks.done` 数量。
- [ ] 旧 Agent 的 `agent_managements` 为 0；旧 contacts 的 `contact_relations` 为 0。
- [ ] 群策略行数 = 既有 group 房间数。
- [ ] `GUARD_TABLES` 与迁移中的 guard 表一一对应。
- [ ] `bun run typecheck`、`test:protocol`、`test:acceptance`、`test:web` 在切流后通过。

---

## 9. 现有代码映射与改造点

| 现有位置 | 当前行为 | P0 目标 |
|---|---|---|
| `src/domain/identity.ts::register` | 自注册 actor + credential；Agent 注册无管理者 | 保留 unclaimed 自注册；新增 `network_agent_create` 原子创建 Agent + binding + credential；`register` 不再被 Web 新建 Agent 使用。 |
| `src/domain/identity.ts::renameAgent` | 任意已注册 principal 可改任意 Agent | 仅 active manager / scope delegate；其他返回 `PERMISSION_DENIED`；删除 README/CLAUDE 的开放边界说明。 |
| `src/domain/identity.ts::reissueAgentToken` | 无所有权检查；撤销全部旧 credential | 仅 manager/delegate；停用/撤销后旧 token 不能调用；token 只返回一次。 |
| `src/domain/identity.ts::recoveryRedeem` | 长期 ticket 兑换 credential | 保留 legacy；Q02 新设备走 `device_pairings`，不复制长期 token。 |
| `src/domain/agents.ts::archiveAgent` | 仅校验 kind；任意 principal 可归档 | manager/delegate；archive 仍只影响列表，不参与授权。 |
| `src/domain/contacts.ts::contactAdd` | 单向 INSERT，无确认 | 改为 `contact_requests`；自有 Agent 自动 active；其他目标 pending。 |
| `src/domain/contacts.ts::contactRemove` | DELETE 单向行 | 只把 `contact_relations.status` 置 removed；legacy `contacts` 不动。 |
| `src/domain/contacts.ts::areContacts` | 单向 contacts 查询 | 改为 active relation 查询；direct 发送/建群共用。 |
| `src/domain/rooms.ts::roomCreate` | group 把所有成员直接 active；要求单向好友 | creator + managed agents active；其他人 invited；group 直接加人要求 active relation 或邀请接受。 |
| `src/domain/rooms.ts::roomMembersUpdate` | 仅 owner；直接 `transfer_owner_to` | owner/admin 分权；移除 admin 限制；owner transfer 改独立提议/接受工具。 |
| `src/domain/rooms.ts::roomLeave` | owner 有他人时不能离开 | 保留；新增解散/归档、任务与 delivery 撤销。 |
| `src/domain/messages.ts::messageSend` | 无 direct 关系校验；群聊相邻 Agent 自动投递；只存 invoke delivery | 加 relation/blocked/disabled guard；删除群聊相邻自动投递；写 `message_mentions`；保留显式 invoke。 |
| `src/domain/messages.ts::messageGuardStatements` | 成员、深度、预算、队列、目标 | 增加 `guard_friend_required`、`guard_blocked`、`guard_actor_disabled`、`guard_membership_stale`。 |
| `src/domain/messages.ts` 历史/读取 | 只按 active member | 增加 `created_seq >= history_from_seq`、generation 校验；旧游标不授权。 |
| `src/domain/deliveries.ts` | 五态、attempt/claim、回执 | 保留；新增 `task_deliveries` 绑定；complete 不写 task accepted。 |
| `src/domain/tasks.ts` + `room_tasks` | 短文本看板，Agent 可领取，done 即完成 | 新 `tasks` 状态机；旧 rows 回填为 legacy_completed；新任务工具见 §6.6。 |
| `src/domain/room-files.ts` | `room_files` 绑定、删除墓碑、公开下载 | 新 `file_objects/file_bindings/tickets`；旧表只读；私有/公开分离. |
| `src/app.ts` `GET /f/:fileId` | 公开下载，不校验成员 | 只对 active public binding 返回；私有文件要求 ticket/session；HEAD/Range 同权。 |
| `src/mcp/auth.ts` | Bearer + `?token=`；撤销检查 | 增加 disabled/device 检查；stream 连接记录 credential/device；设备撤销主动断开。 |
| `src/realtime/hub.ts` / `src/mcp/stream.ts` | 只按 actor 订阅/扇出 | 订阅携带 credential/device；撤销设备关闭对应连接；成员代次过滤。 |
| `src/realtime/stream.ts` | 映射现有事件 | 增加 §5.3 新 source/kind；普通消息不产生 Agent 新工作。 |
| `src/web/new-agent-script.ts` | 浏览器生成 Agent token → register → contact_add → room_create | 改为 human 调 `network_agent_create` 一次；本地注册表只缓存展示信息。 |
| `src/web/share.ts` | 分享页 contact_add + direct 建房 | 改为发起联系人申请；接受后才允许 direct 发送。 |
| `src/web/handoff.ts` / `src/web/qr.ts` | 二维码携带长期 token | Q02 改为 5 分钟配对挑战；旧 `#t=` 只做过渡提示，不再生成。 |
| `src/web/chat-list-script.ts` / `chat-members-script.ts` | 群成员/好友 UI 直接增删 | 区分 invited/active/admin；按新工具和错误码展示。 |
| `src/contracts/schemas.ts` / `outputs.ts` | 现有工具输入输出 | 增加 §6 新 schema；保留字段只增不改语义；删除/退休字段在 Q01 文档标注。 |
| `src/contracts/errors.ts` / `limits.ts` | 现有错误/阈值 | 增加 §4 错误与 P0 阈值；阈值只在此文件维护。 |
| `src/storage/rows.ts` / `guards.ts` / `events.ts` / `queries.ts` | 现有行类型与 guard | 增加新行类型、guard、事件写入助手；不改现有事务语义。 |
| `src/maintenance.ts` | 文件过期/提醒扫描 | 增加 draft/附件 TTL、邀请/claim/pairing 过期、任务提醒；不重跑外部副作用。 |
| `README.md` / `CLAUDE.md` / `public/skills/*` | 记录旧的开放改名、长期 token 二维码、相邻自动投递 | Q01 全量改为本契约；删除“稳定不变量”中的旧行为。 |

---

## 10. 共享文件与所有权

### 10.1 共享面（单写者）

| 路径 | 所有者 | 规则 |
|---|---|---|
| `migrations/0012`–`0019` | integration | 号段独占；任何任务不得直接新增/改号；SQL 由任务提出、integration 合入。 |
| `src/contracts/errors.ts`、`limits.ts`、`schemas.ts`、`events.ts` | integration | 所有新错误/阈值/schema/事件名先合入此处，再进入领域。 |
| `src/storage/rows.ts`、`guards.ts`、`events.ts`、`queries.ts`、`transactions/runner.ts` | integration | 事务与 guard 公共面；领域任务只消费。 |
| `src/mcp/tools.ts`、`src/mcp/outputs.ts`、`src/mcp/resources.ts`、`src/mcp/skill.ts` | integration | 工具注册/输出/技能面唯一入口。 |
| `src/app.ts`、`src/web/chat.ts`、`src/web/chat-script.ts`、`src/web/chat-panels.ts` | integration + UI owner | 路由与页面组合；共享 UI 入口单写者。 |
| `src/realtime/outbox.ts`、`stream.ts`、`hub.ts`、`presence.ts` | delivery/integration | 通知语义与 fan-out；事件类型变更同步更新。 |
| `package.json` / 锁文件 | integration | 只有 integration 改依赖。 |
| `README.md`、`CLAUDE.md`、`public/skills/*`、`scripts/verify-*` | Q01 | 文档/验收与实现同批更新；不得只改文档标 VERIFIED。 |

### 10.2 领域文件建议

| 领域 | 现有入口 | 新增/拆分建议 |
|---|---|---|
| identity | `src/domain/identity.ts`、`agents.ts` | `src/domain/agent-management.ts`、`src/domain/devices.ts` |
| contacts | `src/domain/contacts.ts` | `src/domain/contact-relations.ts` |
| groups | `src/domain/rooms.ts` | `src/domain/room-invitations.ts`、`src/domain/room-policy.ts`、`src/domain/room-lifecycle.ts` |
| chat | `src/domain/messages.ts`、`deliveries.ts` | `src/domain/mentions.ts` |
| media | `src/domain/room-files.ts` | `src/domain/file-access.ts`、`src/domain/file-retention.ts` |
| tasks | `src/domain/tasks.ts` | `src/domain/task-work.ts`、`src/domain/task-review.ts`、`src/domain/task-delivery.ts` |

拆分必须保持工具契约、事件名与事务边界不变；新模块职责写入任务报告。不得为了拆文件改变 `src/contracts/*` 的公共语义。

---

## 11. 开放决策（需 integration/主控裁决）

以下不影响本契约核心语义，但在开工前必须落一个默认值；未裁决前实现者按“建议默认”编码并在报告中标注：

1. **管理员存储**：本契约选择 `room_role_grants` 独立表，避免重建 `room_members`。若要求把 admin/invited 并入 `room_members`，需要破坏性表重建，超出“加法迁移”规则，必须单独批准。
2. **任务工具替换**：本契约建议新任务语义占用 `network_task_create/...`，旧 `network_task_add/complete/fail/delete/list_get` 在 D01 切流后退休。若 Q01 需要过渡别名，别名只能转发新语义，不得保留两套状态。
3. **文件字节权威**：`file_objects` 以 MCPP `file_id` 为主键，Drive 只负责字节；若 M07 发现 Drive 需要独立 `storage_key`，作为 0016 的可空增列处理。
4. **配对创建是否免登录**：建议 `network_device_pairing_create` 允许未登录调用并返回 5 分钟挑战；已登录设备 `approve`，新设备 `redeem`。若产品要求先登录再展示二维码，只改入口，不改状态表。
5. **旧 `#t=` 长期 token 过渡**：建议保留一个发布窗口用于旧链接，但页面明确提示“旧方式将移除”，不再生成新二维码；窗口结束由 Q02 删除入口。具体窗口由部署方决定。
6. **旧 `contacts` 展示**：建议以“历史联系人/个人收藏”只读展示，不参与好友权限；A04 再决定是否提供备注迁移。
7. **阈值**：建议 `agentClaimTtlMs = 24h`、`contactRequestTtlMs = 7d`、`roomInviteTtlMs = 7d`、`roomInviteMaxUses = 20`、`devicePairingTtlMs = 5min`、`devicePairingMaxAttempts = 5`、`fileDraftTtlMs = 24h`、`fileAttachmentTtlMs = 30d`；全部进入 `LIMITS`，不得散落。
8. **`NOT_OWNER` 与 `PERMISSION_DENIED` 边界**：建议 owner 专属动作继续用 `NOT_OWNER`；admin 权限不足用 `PERMISSION_DENIED`。Web 必须同时映射两者，不能只识别一个。
9. **外部任务字段**：`business_authority/external_binding_id` 在 0017 预留；Q03 再建 `external_bindings` / `outward_operations`，P0 不实现外部副作用。
10. **旧 `room_tasks` 去向**：P0 不 DROP，保留只读归档；是否在 Q06 后归档到冷表由集成决定，不属于本迁移。

---

## 12. 冻结检查清单

- [ ] 所有实现分支引用 `webots-p0-v1`，未私自定义同义字段/状态/错误/事件。
- [ ] 新工具名与 §6 一致；旧工具退休/别名在 Q01 文档中列明。
- [ ] 所有写操作使用 `runIdempotent`，条件写入使用 guard；秘密不进入 `operations.result_json`。
- [ ] 所有读路径检查 active membership + `history_from_seq` + 当前权限；旧游标不授权。
- [ ] 所有群操作区分 owner/admin/member；管理员不获得 Agent 管理权。
- [ ] 任务状态、assignment、submission、review 与 delivery 不互相冒充。
- [ ] 迁移只新增表/列/索引，不重建旧表，不建临时表，不改已发布迁移。
- [ ] `GUARD_TABLES`、迁移约束、`GUARD_CODES`、`GUARD_MESSAGES` 四者同步。
- [ ] Web、MCP、流订阅、文件下载/票据、任务面板对同一身份给出一致授权结果。
- [ ] README/CLAUDE/技能正文删除旧开放边界与长期 token 二维码说明。
