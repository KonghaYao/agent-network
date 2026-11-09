# WeBots 功能矩阵（P0）

状态基线：`89572d4`（Q02/G06/A06 与 D01–D08 全部 `VERIFIED`）。本表只描述**当前仓库已实现且有测试证据**的 P0 范围；P1 项目在文末单列，不能按本表宣传为完成。

图例：

- **Web**：浏览器入口文件；空表示该能力只有 MCP/CLI 入口。
- **MCP**：已注册的 `tools/list` 工具；工具总数 135（含 Drive），关闭 Drive 时 126。
- **domain/权限**：领域实现与关键授权边界；所有写路径经 `runIdempotent` + `db.batch()` 与闸门表。
- **事件/outbox**：持久事件与内部 outbox 分区；`inbox:{actor}` / `room:{id}` 不是公开订阅 URI，公开订阅只有 `agentnet://stream`。
- **CLI/技能**：`public/skills/agentnet.sh`、`public/skills/agent_tasks.sh`、`src/mcp/skill.ts` 或静态技能/ Harness 指南。
- **验收**：专项脚本与测试编号；全量门禁见 `README.md` 与本表末节。

## 1. 身份、设备与凭据

| Web | MCP | domain/权限 | 事件/outbox | CLI/技能 | 验收 |
|---|---|---|---|---|---|
| `src/web/new-agent-script.ts`、`src/web/chat-account-rename-script.ts` | `network_issue_token`、`network_register`、`network_me`、`network_me_rename`、`network_login`、`network_profile_update` | `src/domain/identity.ts`、`src/domain/principal.ts`；Bearer/URL token 只存 SHA-256；self-only 改名 | 登录/在线走 `presence`；资料变化写 `room.membership` 或房间事件 | `agentnet.sh issue/register/login/me`；技能“身份” | A01-T01..T04、协议鉴权/注册用例 |
| `src/web/pair.ts`、`src/web/chat-identity-script.ts` | `network_device_pairing_create/join/list/approve/cancel/redeem`、`network_device_list`、`network_device_revoke`、旧方式 `network_recovery_create/redeem` | `src/domain/device-pairings.ts`、`src/domain/devices.ts`；挑战 5 分钟一次性、只存摘要；撤销只影响该设备凭据与流 | `device_pairing_requested/approved/cancelled`、`device_paired`、`device_revoked`；写 `inbox:{actor}`，`pending_count` 增量 0 | 技能“身份”；`agentnet.sh` 不封装配对，文档指向 Web/工具 | Q02-T01..T04（77/45）、`scripts/lib/device-pairing-acceptance.ts`、`device-sync-acceptance.ts` |
| 浏览器身份切换、退出登录 | 无专用工具；`network_me` 读取当前身份 | `src/web/chat-identity-script.ts` 按 actor 分区 `agent-network-token`/身份记录/草稿/队列/sync 游标；失效 token 只显示重新配对 | 不写业务事件；本地清理不影响服务端 | 技能“换设备” | Q02-T04、`bun run test:web` |
| direct Agent 右键“交接管理权” | `network_agent_transfer_propose/respond/cancel/get/list` | `src/domain/agent-transfers.ts`、`agent-transfer-store.ts`、`agent-transfer-reads.ts`；仅 active manager 发起、接任 human 接受；接受轮换凭据 | `management_transfer_*`、`agent_transfer_*`；双方 human inbox，不创建 delivery、不增加 Agent `pending_count` | 技能“身份与权限管理”；`agentnet.sh` 未封装交接 | A06-T01..T04（139）、`scripts/lib/agent-transfer-acceptance.ts` |

## 2. 联系人与拉黑

| Web | MCP | domain/权限 | 事件/outbox | CLI/技能 | 验收 |
|---|---|---|---|---|---|
| `src/web/chat-contacts-script.ts` | `network_contacts_list`、`network_contact_add`、`network_contact_remove`、`network_contact_request`、`network_contact_requests_list`、`network_contact_request_respond`、`network_contact_request_cancel`、`network_contact_policy_get/set` | `src/domain/contacts.ts`、`contact-relations.ts`、`contact-requests.ts`、`contact-policies.ts`；双向确认、单向旧关系不伪造同意 | `contact_request_pending/review/accepted/rejected/cancelled/expired`、`contact_relation_ended`；写收件人 `inbox:{actor}` | `agentnet.sh contacts/contact-add/contact-remove`；技能“联系人” | A03-T01..T04、协议/acceptance 好友用例 |
| `src/web/chat-contacts-script.ts` 好友链接面板、首页 `#friend=` | `network_contact_link_create/preview/redeem/list/revoke` | `src/domain/contact-invite-links.ts`；一次性 token 只存摘要、24h、owner-only 撤销、pending 上限 5；兑换复用 `contact_relations`/`contacts`，source=`invite_link`，不建 pending 申请 | `contact_link_redeemed`；human-only informational，不产生 delivery、不增加 `pending_count`、不推进房间 head | 技能“好友邀请链接” | A07 专项 54、`test:web` 好友链接 20 |
| `src/web/chat-safety-script.ts` | `network_contact_block`、`network_contact_unblock`、`network_contact_blocks_list`、`network_contact_report`、`network_contact_reports_list` | `src/domain/contact-blocks.ts`；拉黑拒绝私人关系/邀请/任务提议，不自动移除共同群；举报只追加审计 | `contact_blocked`、`contact_unblocked`；向双方写 inbox，不推进房间 head | 技能“联系人/安全” | A05-T01..T04、`scripts/lib/contact-block-acceptance.ts` |

## 3. 群、角色、邀请与生命周期

| Web | MCP | domain/权限 | 事件/outbox | CLI/技能 | 验收 |
|---|---|---|---|---|---|
| `+` 建群、`chat-group-create-script.ts`、`chat-member-picker.ts` | `network_room_create`、`network_rooms_list`、`network_room_get` | `src/domain/rooms.ts`；群容量 100、成员代次与历史边界 | `room_created`、`room.membership` | `agentnet.sh room-create/rooms/room`；技能“房间” | G01-T01..T04、G07-T01..T04 |
| `src/web/chat-invites-script.ts`、`src/web/chat-members-script.ts` | `network_room_invite_create/get/revoke/respond`、`network_room_join_request_list/respond`、`network_room_members_update`、`network_room_role_set`、`network_room_role_history` | `src/domain/room-invitations.ts`、`room-invite-links.ts`、`room-join-requests.ts`、`room-access.ts`；定向邀请与链接邀请分离，审批原子检查容量与成员资格 | `invite_created/revoked`、`room_invited`、`room_join_requested/approved/rejected`、`room_role_changed`；invite 走 `inbox:{actor}`，成员/角色走 `room:{id}` | `agentnet.sh room-members`；技能“群组交流” | G01/G02-T01..T04、`scripts/lib/group-invite-acceptance.ts`、`group-invite-link-acceptance.ts` |
| `src/web/chat-room-menu-script.ts`、`src/web/chat-announcement-script.ts` | `network_room_policy_set`、`network_room_announcement_set`、`network_room_notice_list`、`network_room_owner_transfer_propose/respond/cancel`、`network_room_owner_transfer` | `src/domain/owner-transfers.ts`、`room-notices.ts`、`room-history.ts`；唯一 owner、管理员/成员角色，转让需接受 | `room_owner_transfer_*`、`room_policy_changed`、`room_announcement_updated`；只写 room 事件，不产生未读 | 技能“群组交流”；`agentnet.sh room-members --transfer-owner` | G03-T01..T04、G05-T01..T04、G07 |
| `src/web/chat-members-script.ts`、群菜单“解散群聊” | `network_room_leave_preview`、`network_room_leave`、`network_room_dissolve` | `src/domain/room-lifecycle.ts`、`room-audit.ts`；owner 未解散必须先 G05 转让或解散；退群/移除撤销任务执行资格与投递 | `room_left`、`room_members_changed`、`room_dissolved`；room scope，`media_revoke: true` 仅作未来媒体钩子 | 技能“退群、移除与解散” | G06-T01..T05（119）、`scripts/lib/room-lifecycle-acceptance.ts`、`ownerless-room-unit.ts` |
| `chat-group-profile-script.ts` 群设置改名 | `network_room_rename` | `room-profile.ts`、`room-access.ts`；edit_profile / member_profile_policy，expected_title CAS，无迁移 | `room_profile_updated` → `room.membership`；不产生消息或未读 | 标准 MCP 调用 | `test:hotpaths`：UI、越权、并发、重放 |

## 4. 消息、提及与补读

| Web | MCP | domain/权限 | 事件/outbox | CLI/技能 | 验收 |
|---|---|---|---|---|---|
| `src/web/chat-script.ts`、`src/web/chat-mention-script.ts` | `network_message_send`、`network_message_send_status`、`network_history_list`、`network_message_read`、`network_room_mark_read`、`network_sync` | `src/domain/messages.ts`、`message-view-helpers.ts`、`sync.ts`；`client_message_id` 长期去重；显式 `invoke` 最多 8 个，同名文本 @ 必须消歧；成员代次/历史边界 | `room.message`、`room.read`、`delivery.created/updated`、`mention.reminder`；普通消息不唤醒 inbox，`@所有人` 只提醒 | `agentnet.sh send/reply/history/mark-read/sync`；技能“消息与投递” | M02-T01..T04、M03-T01..T04、`mention-acceptance.ts`、`no-implicit-delivery-acceptance.ts` |
| 发送框附件/chips | 同发送工具；文件 URL 由 `src/contracts/file-links.ts` 解析 | 仅同源 `/f/<fileId>`，忽略 query/hash、外站与非法 ID | 自动归档写 `room_file_added`，不创建 delivery | 技能“文件协作” | M02、M07-T01..T04、`room-file-archive.ts` |

## 5. 文件、成果与保留

| Web | MCP | domain/权限 | 事件/outbox | CLI/技能 | 验收 |
|---|---|---|---|---|---|
| `src/web/chat-upload-script.ts`、`src/web/chat-files-script.ts`、`src/web/chat-message-files-script.ts` | `network_room_file_bind/list/get/delete`、`network_file_publish`、`drive_file_info` | `src/domain/room-files.ts`、`file-access.ts`、`file-ticket.ts`；草稿 24h、附件 30 天、配额 200 个/1 GiB；票据绑定房间成员代次与 `policy_revision` | `room_file_added/deleted/published/unpublished`；informational，不增加 `pending_count` | `agentnet.sh upload/send-file/bind/files/file/file-delete/download/file-info`；技能“文件协作” | M07-T01..T04、`verify-room-files.ts` 193、`test:drive` 52 |
| `src/web/chat-files-actions-script.ts`、消息文件入口 | `network_artifact_submit/list/release` | `src/domain/artifacts.ts`；成果版本绑定房间并 `retained`；`file_references` 统计 task/artifact/forward/favorite；显式释放且无活跃引用恢复 30 天 TTL | `artifact_submitted/released`；informational | 技能“成果与保留” | M07-T01..T04、`scripts/lib/m07-acceptance.ts` |

## 6. 任务生命周期（D01–D08）

| Web | MCP | domain/权限 | 事件/outbox | CLI/技能 | 验收 |
|---|---|---|---|---|---|
| `src/web/chat-tasks-script.ts`、`src/web/chat-task-detail-script.ts` | `network_task_summary`、`network_task_list`、`network_task_get`、`network_task_create`、`network_task_offer`、`network_task_accept`、`network_task_decline`、`network_task_claim`、`network_task_cancel`、`network_task_retry` | `src/domain/tasks.ts`；创建/改派由创建者、群 owner/管理员；接受/拒绝限候选；公开领取 human/Agent 均可，验收人不能领自己待审任务 | `task_created/offered/offer_accepted/offer_declined/claimed/cancelled/retried`；`task.updated` informational 只通知 active human，不写 inbox | `agent_tasks.sh list/summary/get/create/offer/accept/decline/claim/cancel/retry`；技能“任务” | D01-T01..T04、D02-T01..T04、`task-assignment-acceptance.ts`、`room-task-summary-unit.ts` |
| `chat-task-progress-script.ts` | `network_task_progress`、`network_task_block`、`network_task_resume` | `src/domain/task-progress.ts`；仅当前 active assignment 的负责人；`revision` CAS | `task_progress_reported/blocked/resumed`；room scope informational | `agent_tasks.sh progress/block/resume` | D03-T01..T04、`task-status-acceptance.ts` |
| `chat-task-transfer-script.ts` | `network_task_transfer_propose/accept/reject/cancel/get/list` | `src/domain/task-transfers.ts`；提议/取消限负责人/创建者/owner/管理员，接受/拒绝限目标；接受前责任不变 | `task_transfer_proposed/accepted/rejected/cancelled/expired`；room scope，不创建 delivery | `agent_tasks.sh transfer-*`（Q01 补齐） | D04-T01..T04（128）、`task-transfer-acceptance.ts` |
| `chat-task-handoff-script.ts` | `network_task_handoff_pack_create/get/authorize/request_more` | `src/domain/task-handoff-packs.ts`、`handoff-file-grant.ts`；版本追加、只存引用；跨范围材料默认 `omitted`，需源范围授权 | `task_handoff_pack_created`、`task_handoff_item_authorized/revoked`、`task_handoff_context_requested`；room scope | `agent_tasks.sh handoff-*`（Q01 补齐） | D05-T01..T04、`task-handoff-acceptance.ts` |
| `chat-task-submission-script.ts` | `network_task_submit`、`network_task_submission_get/list/return` | `src/domain/task-submissions.ts`；仅当前 active assignment 负责人、任务 `in_progress`；材料冻结 sha256/size/mime，外链只记录声明 | `task_submitted/returned`；room scope | `agent_tasks.sh submit/submissions/submission-get`（Q01 补齐） | D06-T01..T04、`task-submission-acceptance.ts` |
| `chat-task-review-script.ts` | `network_task_review_accept`、`network_task_review_return`、`network_task_reviewer_set` | `src/domain/task-submissions.ts`；仅当前验收人，必须绑定 `submission_id`/`version` 与逐项 checklist；退回生成新 assignment 版本 | `task_accepted/returned/reviewer_changed`；room scope | `agent_tasks.sh review-*`（Q01 补齐） | D07-T01..T04、`task-review-acceptance.ts` |
| `chat-task-recovery-script.ts` | `network_task_execution_unknown`、`network_task_execution_resolve`；催办自动产生 `task_reminder` | `src/domain/task-reminders.ts`、`task-recovery.ts`；3 分钟窗口、同窗口唯一；取消原子失效 assignment/投递/交接并保留审计；未知外部结果不得自动重放 | `task_reminder`（inbox，`pending_count` 增量 0）；`task_cancelled`、`task_execution_unknown/resolved`（room scope） | `agent_tasks.sh execution-unknown/execution-resolve`；催办不是 CLI 命令 | D08-T01..T04、`task-recovery-acceptance.ts` |

## 7. Agent 认领、管理与交接

| Web | MCP | domain/权限 | 事件/outbox | CLI/技能 | 验收 |
|---|---|---|---|---|---|
| `src/web/new-agent-script.ts` | `network_agent_create`、`network_agent_management_get`、`network_agents_managed_list` | `src/domain/agents.ts`、`agent-management.ts`；当前 human 原子创建 Agent、`agent_managements` 与凭据；raw token 只返回一次 | `agent_management_bound`、`credential_reissued`；只通知管理者 | 技能“身份与权限管理” | A01-T01..T04、`agent-identity-acceptance.ts` |
| 无独立 Web 入口（Agent 侧发起，human 侧确认） | `network_agent_claim_start/confirm/cancel`、`network_agent_delegate_grant/revoke` | `src/domain/agent-access.ts`、`agent-management.ts`；旧 Agent 保持未认领，错误 code 限次；委托只授予 human 且默认 `manage_agent` | `agent_claim_requested/confirmed/rejected`、`agent_delegation_granted/revoked` | 技能“身份与权限管理” | A01、`agent-identity-acceptance.ts` |
| direct Agent 右键停用/归档、已归档浮层 | `network_agent_disable/enable`、`network_agent_archive/unarchive`、`network_agents_get`、`network_agent_rename`、`network_agent_reissue_token` | `src/domain/agent-lifecycle.ts`、`agents.ts`、`identity.ts`；全部要求 active manager 或 `manage_agent` 委托；停用不自动完成任务 | `agent_disabled/enabled`、`credential_reissued`、归档只改 `network_agents_get` | 技能“身份与权限管理” | A01、`agent-archive-acceptance.ts` |
| `chat-transfer-script.ts` | `network_agent_transfer_propose/respond/cancel/get/list` | `src/domain/agent-transfers.ts`；接受事务切换管理者、`permission_version + 1`、撤销旧委托/凭据，任务置 `blocked`/`unassigned` | `management_transfer_proposed/accepted/rejected/cancelled/expired`、`agent_transfer_*`；双方 human inbox，不创建 delivery | 技能“身份与权限管理” | A06-T01..T04（139）、`agent-transfer-acceptance.ts` |

## 8. P1 未实现（不得按 P0 验收）

| 任务 | 未实现范围 |
|---|---|
| A02 | 管理员对 Agent 的全局管理边界（本波次只有 active manager/委托）。 |
| A04 | 联系人备注、分组与更完整的隐私策略。 |
| G04 | 群名编辑已实现；头像、其余完整资料与成员备注未实现。 |
| M01 | 置顶、草稿云端同步、静音、个人清空、隐藏等消息管理。 |
| M04 | 引用/转发/撤回等完整消息操作与媒体能力。 |
| M05 | 图片/语音/视频/名片等全部媒体。 |
| M06 | 媒体转发、撤回与引用更新。 |
| M08 | 10 万历史/1 万任务等有界加载与性能指标。 |
| M09 | 群音视频与真实 TURN 媒体面；G06 的 `media_revoke` 只是未来钩子。 |
| Q03 | 外部 Issue/员工绑定、结果回写与外部权威对账。 |
| Q06 | 100 人/大规模并发、限流、告警、备份恢复与远程运营指标。 |

本表不声称 A02/A04/G04/M01/M04/M05/M06/M08/M09/Q03/Q06 已完成。Q01（本表与文档一致性）、Q04（发布/运维检查）、Q05（最终交付）只能按 P0 范围验收。消息原文交接、撤回、搜索、收藏、通话与外部业务回写不在本波次。

## 9. Q01-T01 敏感操作一致性抽查

以下抽查基于现有 `scripts/acceptance.ts` / `scripts/verify-web.ts` 与专项脚本，不新增 135 个工具的逐项测试。结论为“Web 入口与 MCP 工具调用同一 domain 与同一事务”，具体断言详见对应文件；未覆盖的组合列在“缺口”。

| 敏感操作 | Web 入口 | MCP 工具 | 权限/状态/错误 | 事件 | 抽查证据 |
|---|---|---|---|---|---|
| 注册/登录/凭据失效 | 首页 `ensureIdentity`、`/pair` | `network_register`、`network_login`、`network_me` | 无/无效 Bearer → `CREDENTIAL_INVALID`；human login → `INVALID_ARGUMENT` | `session.login` / presence | `verify-protocol` 鉴权断言；`acceptance` 显式上线 |
| 好友邀请链接 | 好友申请弹窗、首页 `#friend=` | `network_contact_link_create/preview/redeem/list/revoke` | 无鉴权预览；owner-only 撤销；一次性/24h；自己 `INVALID_ARGUMENT`、拉黑 `BLOCKED`、失效 `CONTACT_LINK_INVALID` | `contact_link_redeemed` informational | A07 专项、`test:web` 好友链接 |
| 设备撤销 | 配对弹窗、设备列表 | `network_device_revoke`、`network_device_list` | 只撤销当前 actor 该设备；旧 token 立即拒绝、该设备流关闭 | `device_revoked` + `inbox:{actor}` | Q02-T01/T02 |
| 拉黑/解除 | 联系人/安全面板 | `network_contact_block/unblock` | 双向关系终止、邀请/任务提议被 `BLOCKED`；不自动移群 | `contact_blocked/unblocked` | A05-T01..T04 |
| 群邀请/角色/退群/解散 | 群成员与群菜单 | `network_room_invite_*`、`network_room_role_set`、`network_room_leave*`、`network_room_dissolve` | owner 不能无主退群；非 owner 解散 `PERMISSION_DENIED`；在途工作需确认 | `room_invited`、`room_role_changed`、`room_left`、`room_dissolved` | G01/G03/G06-T01..T05 |
| 文件绑定/下载 | 文件栏、消息文件卡片 | `network_room_file_bind/get`、`drive_file_info` | 成员/上传者/群 owner；票据绑定成员代次与 `policy_revision`；撤权后新读取失败 | `room_file_added/deleted` | M07、`verify-room-files` |
| 任务转交/提交/验收/交接包 | 任务详情各面板 | `network_task_transfer_*`、`network_task_submit`、`network_task_review_*`、`network_task_handoff_pack_*` | 角色/版本/状态四层 CAS；旧 assignment `ASSIGNMENT_STALE`，revision 变化 `VERSION_CONFLICT` | `task_transfer_*`、`task_submitted`、`task_accepted/returned`、`task_handoff_*` | D04/D05/D06/D07 专项 |
| Agent 交接/停用 | direct Agent 菜单 | `network_agent_transfer_*`、`network_agent_disable` | 仅 active manager/委托；旧管理者 `PERMISSION_DENIED`，旧 token `CREDENTIAL_INVALID` | `management_transfer_*`、`agent_disabled` | A06、A01 |

**缺口（如实列出）**：网页没有独立的“设备列表/撤销”管理页，只在配对流内展示；`agentnet.sh` 未封装设备配对、联系人拉黑、群邀请审批与任务交接；`agent_tasks.sh` 的设备/身份操作仍需直接用 MCP 工具。D06 提交弹窗、版本徽标与退回入口只有页面加载/既有任务回归，没有独立浏览器断言；D07 验收清单与改派验收人同样以 MCP 专项为主，`test:web` 只覆盖既有任务详情不回归。以上均为入口/浏览器覆盖缺口，不是服务端权限或状态语义缺口。

## 10. 全量门禁（Q01-T04）

| 命令 | 当前计数 |
|---|---|
| `bun run typecheck` | 0 错误 |
| `bun run test:protocol` | 998 |
| `bun run test:acceptance`（短 presence 窗口） | 2772 |
| `bun run test:web` | 2198 |
| `bun run test:events` | 339 |
| `bun run test:drive` | 52 |
| Q02 专项 | pairing 77 / sync 45 |
| G06 / A06 专项 | 119 / 139 |
| A07 好友邀请链接专项 | 54 |
| Q04 浏览器验收 | 176 |
| 迁移 | 36 个（0001–0012、0017–0040） |

聊天/群组热点专项：26 组真实服务浏览器回归覆盖稳定消息节点、切换隔离、公告冲突、群名 CAS、成员候选、创建重试、迟到列表、跨设备退群/移除、归档切换与移动端按钮可达性。详见 [重构报告](../reports/2026-11-09-web-hotpaths.md)。
