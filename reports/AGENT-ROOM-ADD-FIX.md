# AGENT-ROOM-ADD-FIX

状态：READY_FOR_REVIEW

- 基线：`f841fd2`（fix/webots-parity-pack）
- 结果提交：`7ad89cc`、`aff0d73`、`b883f82`、`8417c6f` 与本报告提交
- 范围：仅 `agent-network-worktrees/webots-parity-pack`；未修改主 checkout，未新建 worktree/branch，未部署，未建 PR。

## 1. 根因

P0 回归来自两条互相放大的路径：

1. `src/domain/rooms.ts` 的群添加规则只认 `contact_relations`。生产旧数据中的 6 个 Agent 没有 `contact_relations`，且 `agent_managements` 为空（unclaimed），因此：
   - `evaluateCreateTargets` 建群预检把它们判为 `FRIEND_REQUIRED`；
   - `roomMembersUpdate` 的 `requireFriends` 预检直接拒绝；
   - 即使预检通过，事务内 `guard_friend_required` 仍只检查 active 关系，提交时再次回滚。
2. 网页选择器把“本机 Agents 注册表”中未成为好友的 Agent 当成缺口，主动调用 `network_contact_request` 补好友；对方是 unclaimed Agent 时申请停在 pending，页面显示“好友申请待确认/添加好友失败”。新建 Agent 也先发好友申请、只有申请 accepted 才创建 direct，进一步制造 pending 警告。

结果就是：群选择器看不到/选不中 Agent；添加时被当成非好友；新建 Agent 出现待确认警告。

## 2. 服务端规则（建群与添加成员一致）

统一判定顺序：

1. 双方任一方向存在 active `contact_blocks`：`BLOCKED`，优先于好友判断。
2. 目标为 Agent：
   - `agent_managements` 无 active 行（unclaimed）：直接允许；
   - active manager 是调用者：直接允许；
   - 否则若存在 active `contact_relations`：允许（建群走 pending 邀请，加成员直接 active）；
   - 否则：`FRIEND_REQUIRED`。
3. 目标为 human：必须有 active `contact_relations`；否则 `FRIEND_REQUIRED`。既有邀请/审批路径不受影响。

落点：

- `roomCreate` / `evaluateCreateTargets`：unclaimed Agent 与自有 managed Agent 标 `active`；由他人管理的非好友 Agent 标 `failed/FRIEND_REQUIRED`；人类好友仍标 `invited`。
- 建群事务内的成员插入 SQL：`active relation OR (target.kind = 'agent' AND (无 active management OR manager = caller))`。
- `roomMembersUpdate` 预检：`requireJoinableTargets` 使用同一规则；拉黑先判。
- `roomMembersUpdate` 事务 guard：沿用 `guard_friend_required` 表（CHECK `x = 0`），SQL 加入同样的 Agent 例外，不只改预检。
- `createDirect` 未改：新 Agent 由 `network_agent_create` 绑定 active manager，`directRelationStatements` 在同一事务自动建立 `auto_manager` 关系。

数据与兼容：

- 不新增迁移。
- 不自动回填 unclaimed Agent 的 manager。
- 已存在 unclaimed Agent 可被任何具备 `invite_members` 权限的人加入群；这是产品接受的边界。
- Agent 后续被认领或交接，已加入的群成员关系不变；已有黑名单仍阻止加入。

## 3. 网页真实路径

- `src/web/chat-agents-script.ts`：删除 `agentContactGaps` / `addOwnedAgentContacts` / `agentContactSyncError`，改为 `mergeAgentPickerContacts`，合并：
  - `agent-network-agents-v1:<owner>` 本机注册表；
  - `network_agents_managed_list` 分页结果（最多 5 页，每页 100）。
  - 合并项标 `kind: 'agent'`、`relation: 'local'`，按 `actor_id` 去重，不写好友关系。
- `src/web/chat-script.ts`（建群）与 `src/web/chat-members-script.ts`（加成员）都使用合并后的候选；仍排除自己、当前成员与邀请中成员；搜索、分页、计数、勾选沿用共享选择器。
- `src/web/new-agent-script.ts`：创建成功后不再调用 `network_contact_request`，直接创建 direct；失败只显示“会话添加失败”，不伪造好友成功。
- 页面不再出现“添加好友失败/好友申请待确认”。

## 4. 工具与技能

- `src/mcp/tools.ts`：更新 `network_room_create`、`network_room_members_update`、`network_contact_request` 描述。
- `src/mcp/skill.ts`：`SKILL_MARKDOWN` 中群邀请、常用流程“房间”同步新规则；`skills/list`、`skills/get` 与 SKILL.md 资源继续共享同一正文与 digest。
- `public/skills/agent-network-skills.md`：新增 Agent 入群规则与“新建 Agent 不需要好友申请”说明。
- `README.md`：新增本次修复的状态条目。

## 5. 测试

新增 `scripts/lib/agent-room-add-acceptance.ts`，注册在 `scripts/acceptance.ts`，覆盖：

- unclaimed Agent 建群 active；
- unclaimed Agent 加入既有群 active；
- 自有 managed Agent 建群/加成员 active；
- 他人 managed Agent 且非好友 `FRIEND_REQUIRED`；
- 人类非好友 `FRIEND_REQUIRED`；
- 拉黑 `BLOCKED`（建群与加成员）；
- 他人 managed Agent 成为好友后可加入；
- 新建 Agent direct 成功、关系 `auto_manager`、无 pending 申请；
- 添加成员同一 `request_id` 幂等重放；
- 6 个“无关系、无 active manager”的旧 Agent 一次性全部 active（生产数据回放）。

现有预期调整：

- `scripts/acceptance.ts`：把 unclaimed Agent 的“非好友不能加入群聊”改为“未认领 Agent 无需好友即可加入群聊”。
- `scripts/verify-web.ts`：更新新建 Agent 不再发好友申请的断言；选择器候选改为注册表 + managed list；新增候选合并、勾选入群、添加成员成功、无 pending 文案、390px 不溢出的断言。
- `src/domain/agent-management.ts`：修复 `agentsManagedList` cursor 分支少绑定一个 `manager_id` 的问题（网页改为分页读取 managed list 后暴露）。

人类好友规则未放宽：非好友人类在建群、加成员、direct 中仍返回 `FRIEND_REQUIRED`。

## 6. 验证结果

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| P0 专项 `agent-room-add-acceptance` | 29 项通过 |
| G01 `group-invite-acceptance` | 通过 |
| A03 `contact-relation-acceptance` | 通过 |
| G03 `group-role-acceptance` | 通过 |
| G06 `room-lifecycle-acceptance` | 通过 |
| G07 `group-history-acceptance` | 通过 |
| G07 `group-policy-acceptance` | 通过 |
| M02 `m02-acceptance` | 通过 |
| 统一流 `stream-acceptance` | 通过 |
| `bun run test:protocol` | 991 项通过 |
| `bun run test:web` | 2051 项通过 |
| `bun run test:acceptance` | 在既有 presence 断连检查处中止，见下 |

全量 acceptance 的阻塞不是本次改动引入：在 `/tmp` 用基线 `f841fd2` 启动独立服务（8793）跑同一脚本，同样在“关闭最后一个连接后成员显示离线”超时。最小复现显示，当前 Bun/SDK 组合下关闭订阅和关闭客户端都不会触发服务端 `request.signal`，`agent_presence_state` 始终停在 `online`，因此“关闭最后一个连接”断言无法成立。该问题与入群规则无关，未在本任务中修改产品 presence 逻辑。

为验证其余套件，在 `/tmp` 的当前代码副本中仅跳过该环境检查后运行全量。首轮在 G07 发现两处“unclaimed Agent 直接 active”导致的夹具时序问题，已改为先创建消息/任务/文件、再显式加入 Agent；随后 G07、G07 策略、M02 在真实 worktree 服务上分别重跑通过。因此本次改动覆盖的其余套件均已验证，但没有得到单次完整 `2688+29` 的全绿计数。worktree 本身保留真实 presence 断言（等待窗口从 30s 放宽到 45s，仅覆盖 grace+sweep 的观测窗口）。

## 7. 生产数据验证

生产库不在本 worktree 的可访问范围内，未直接连接生产 SQLite。按用户提供的生产事实构建等价回放：6 个 Agent 均无 `contact_relations`、无 active `agent_managements`，用 6 个未认领 Agent 一次性建群，结果为 7 名成员（建群者 + 6 个 Agent）全部 active、0 个 pending 邀请。该路径同时由 `roomCreate` 事务内 SQL 与预检共同保证。

## 8. 残余限制

- unclaimed Agent 的入群边界是开放的：任何有 `invite_members` 权限的人都能直接加入它。这是本次产品接受的规则，未增加邀请确认。
- 认领/交接不回溯已建立的群成员关系。
- 不自动回填历史 unclaimed Agent 的 manager，不新增迁移。
- 生产 6 个 Agent 的真实数据只做了等价回放，未执行生产写入或线上验收。
- 全量 acceptance 在当前环境的 presence 断连检查上被既有问题阻塞；协议、web、P0 与 G01/G03/G06/A03 专项均通过。

## 提交记录

（待提交后补充）
