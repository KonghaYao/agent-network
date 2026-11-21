import {
  roomRenameSchema,
  roomAnnouncementSetSchema,
  roomCreateSchema,
  roomDissolveSchema,
  roomGetSchema,
  roomInviteCreateSchema,
  roomInviteGetSchema,
  roomInviteRespondSchema,
  roomInviteRevokeSchema,
  roomJoinRequestListSchema,
  roomJoinRequestRespondSchema,
  roomLeavePreviewSchema as roomLeavePreviewQuerySchema,
  roomLeaveSchema,
  roomMembersUpdateSchema,
  roomMonitorGetSchema,
  roomMonitorSetSchema,
  roomOwnerTransferCancelSchema,
  roomOwnerTransferProposeSchema,
  roomOwnerTransferRespondSchema,
  roomOwnerTransferSchema,
  roomPolicySetSchema,
  roomNoticeListSchema,
  roomRoleHistorySchema as roomRoleHistoryQuerySchema,
  roomRoleSetSchema,
  roomsListSchema,
} from '../contracts/schemas';
import {
  roomAnnouncementSet,
  roomCreate,
  roomGet,
  roomLeave,
  roomMembersUpdate,
  roomPolicySet,
  roomRoleHistory,
  roomRoleSet,
  roomsList,
} from '../domain/rooms';
import { roomRename } from '../domain/room-profile';
import { roomMonitorGet, roomMonitorSet } from '../domain/room-monitors';
import { roomNoticeList } from '../domain/room-notices';
import {
  roomInvitationAccept,
  roomInvitationList,
  roomInvitationReject,
} from '../domain/room-invitations';
import {
  roomInviteCreate,
  roomInviteLinkList,
  roomInvitePreview,
  roomInviteRevoke,
} from '../domain/room-invite-links';
import { roomJoinRequestList, roomJoinRequestRespond } from '../domain/room-join-requests';
import { roomDissolve, roomLeavePreview } from '../domain/room-lifecycle';
import {
  roomOwnerTransferCancel,
  roomOwnerTransferPropose,
  roomOwnerTransferRespond,
} from '../domain/owner-transfers';
import type { Env } from '../env';
import { requireActor } from './auth';
import {
  leaveResultSchema,
  roomDissolveResultSchema,
  roomLeavePreviewSchema as roomLeavePreviewResultSchema,
  roomDetailSchema,
  roomCreateResultSchema,
  roomInvitationPageSchema,
  roomInvitationRespondSchema,
  roomInvitationSchema,
  roomInviteCreateResultSchema,
  roomJoinRequestPageSchema,
  roomJoinRequestRespondResultSchema,
  roomMonitorResultSchema,
  roomPageSchema,
  roomNoticePageSchema,
  roomPolicySetResultSchema,
  roomRoleHistorySchema as roomRoleHistoryResultSchema,
} from './outputs';
import type { Principal } from '../domain/principal';
import type { RegistrationServer } from './registration';
import { register } from './tool-registration';
import { withRoomMemberPresence, withRoomListPresence } from './room-presence';

export function registerRoomTools(
  server: RegistrationServer,
  env: Env,
  principal: Principal,
): void {
  const db = env.DB;
  const origin = env.PUBLIC_ORIGIN;

  register(
    server,
    'network_room_create',
    '创建单聊或群聊。单聊按 actor 对唯一收敛；群聊创建者成为 owner。群聊中被拉入的人直接成为 active 成员，不生成待确认邀请、不需要对方接受：人类须好友；Agent 有 active 好友关系、未认领（无 active manager）或由创建者管理时可直接加入，由其他人管理的非好友 Agent 返回 FRIEND_REQUIRED，拉黑优先返回 BLOCKED。返回 results 逐对象给出 active/failed（invited 仅为历史兼容保留，新调用不再返回）。预检不合格会在创建前整体拒绝并列出对象；提交时的竞态失效只影响对应目标，已成功成员不会重复添加。',
    roomCreateSchema,
    roomCreateResultSchema,
    async (input) => {
      requireActor(principal);
      return roomCreate(db, principal, input);
    },
  );

  register(
    server,
    'network_rooms_list',
    '分页读取自己参与的活跃房间摘要、head 与已读位置。已解散群默认不返回；仍可用 network_room_get 读取只读归档。每条 direct 记录返回 peer 对端摘要（actor_id、name、kind、online 批量快照），群聊 peer 为 null；旧客户端可忽略该字段。direct 记录还返回 peer_can_manage，只表示当前调用者能否管理对端 Agent，不暴露 manager_id；群聊不返回该字段。direct 会话仍返回 peer_archived 供网页默认列表隐藏已归档 Agent。删除好友后，双方的该 direct 会话都默认不返回；房间、消息与详情读取不受影响，历史仍可用 network_room_get 与 network_history_list 显式读取。拉黑保留会话入口，便于解除拉黑。',
    roomsListSchema,
    roomPageSchema,
    async (input) => {
      requireActor(principal);
      return withRoomListPresence(env, await roomsList(db, principal, input));
    },
  );

  register(
    server,
    'network_room_get',
    '读取房间摘要与当前有效成员；Agent 成员的 online 表示可用性（保持 SSE 连接，或最近 60 秒内有 MCP 请求），null 表示未知，人类成员恒为 null。direct 房间的 peer_can_manage 只表示当前调用者能否管理对端 Agent，不暴露 manager_id；群聊不返回该字段。顶层 pinned_messages 是当前查看者按 historyBoundary 可见的置顶消息（预览取当前消息，已撤回消息排除，direct 与无置顶为 []）。遗留无主群（历史数据中 owner_id 为空且未解散）返回 owner_missing=true，不能再邀请或加入成员，但不会自动解散。',
    roomGetSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return withRoomMemberPresence(env, await roomGet(db, principal, input.room_id));
    },
  );

  register(
    server,
    'network_room_invite_get',
    '读取群邀请。默认分页读取当前身份收到的定向邀请（只保留历史遗留 pending；新版人拉人直接入群，不再产生新的定向邀请）；带 invite_key 时只返回该链接的最小群介绍（群名、人数、邀请人、有效期、审批策略），不返回消息正文；带 room_id 时读取本群有效链接，需要邀请权限。pending 是待确认，不是已加入。can_respond 只对可继续处理的 pending 为 true。',
    roomInviteGetSchema,
    roomInvitationPageSchema,
    async (input) => {
      requireActor(principal);
      if (input.invite_key) return roomInvitePreview(db, principal, input);
      if (input.room_id) return roomInviteLinkList(db, principal, input);
      return roomInvitationList(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_invite_create',
    '创建群邀请或直接拉人入群。不指定 target_actor_id 时创建可分享链接/二维码：默认 7 天、20 次成功加入，明文 invite_key 与 /j/<key> 分享 URL 只在本次响应出现一次，服务端只保存 SHA-256 摘要；同一 request_id 重放返回 TOKEN_NOT_REPLAYABLE，不会重放明文。指定 target_actor_id 时目标直接成为 active 成员：不创建邀请、不需要对方接受，返回 member 摘要；权限、拉黑、好友/Agent 例外、容量、群状态与 owner_missing 校验与 network_room_members_update 相同，重复 request_id 返回首次结果。邀请不包含任何 actor 登录凭据。遗留无主群（owner_id 为空且未解散）不能创建邀请或加人，返回 CONFLICT（reason=owner_missing）。',
    roomInviteCreateSchema,
    roomInviteCreateResultSchema,
    async (input) => {
      requireActor(principal);
      return roomInviteCreate(db, principal, input, origin);
    },
  );

  register(
    server,
    'network_room_invite_revoke',
    '立即撤销群邀请。邀请人、owner 或 admin 可撤销；同一事务把该邀请的 pending 入群申请置为 expired。撤销后旧二维码/链接在所有设备失效，明文 key 不能从服务端恢复。',
    roomInviteRevokeSchema,
    roomInvitationSchema,
    async (input) => {
      requireActor(principal);
      return roomInviteRevoke(db, principal, input);
    },
  );

  register(
    server,
    'network_room_join_request_list',
    '分页读取某群的入群申请；只有 owner/admin 可读。pending 申请不是成员，不计入成员数。expires_at 来自邀请，邀请过期/撤销/用尽时该申请按 expired 展示且不能批准。',
    roomJoinRequestListSchema,
    roomJoinRequestPageSchema,
    async (input) => {
      requireActor(principal);
      return roomJoinRequestList(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_join_request_respond',
    '批准或拒绝入群申请；只有 owner/admin 可操作。批准时在同一事务重新检查邀请 pending、有效期、次数、拉黑、申请人移除状态与 100 人上限，并消费一次邀请、写入 active 成员；并发批准同一申请只有一个成功。拒绝不消费邀请。重复 request_id 返回首次结果。遗留无主群不允许批准（返回 CONFLICT/reason=owner_missing），仍可拒绝以清理申请。',
    roomJoinRequestRespondSchema,
    roomJoinRequestRespondResultSchema,
    async (input) => {
      requireActor(principal);
      return roomJoinRequestRespond(db, principal, input);
    },
  );

  register(
    server,
    'network_room_invite_respond',
    '接受或拒绝自己的群邀请（仅历史遗留的定向邀请与链接邀请；新版人拉人直接入群，不再产生定向邀请）。链接邀请必须同时出示 invite_key；定向邀请忽略该字段。开启审批策略时接受只创建 pending 入群申请（返回 requested），不写成员；否则在同一事务复核 pending、有效期、拉黑、次数与 100 人上限后成为 active 成员。重复 request_id 返回首次结果。遗留无主群不接受邀请加入，返回 CONFLICT（reason=owner_missing）。',
    roomInviteRespondSchema,
    roomInvitationRespondSchema,
    async (input) => {
      requireActor(principal);
      return input.action === 'accept'
        ? roomInvitationAccept(db, principal, input)
        : roomInvitationReject(db, principal, input);
    },
  );

  register(
    server,
    'network_room_monitor_get',
    '读取当前 human 身份在该会话私有的网页监控地址；仅本人可见，其他成员与 Agent 不可读。只保存 http/https URL，服务端不访问目标地址；目标站点可能用 X-Frame-Options 或 CSP frame-ancestors 拒绝 iframe 嵌入。无配置时 monitor 为 null。不写 events/outbox，不改变未读、head 或 pending_count。',
    roomMonitorGetSchema,
    roomMonitorResultSchema,
    async (input) => {
      requireActor(principal);
      return roomMonitorGet(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_monitor_set',
    '设置或清除当前 human 身份在该会话私有的网页监控地址；仅本人可见，其他成员与 Agent 不可见。url 为 null、空串或纯空白时删除配置；只允许 http/https，拒绝 javascript/data/file 等协议。设置与清除均需幂等 request_id，重放返回同一结果，同一 request_id 不同参数返回 IDEMPOTENCY_CONFLICT。服务端不访问该地址；目标站点可能用 X-Frame-Options 或 CSP frame-ancestors 禁止 iframe 嵌入。不写 events/outbox，不改变未读、head 或 pending_count。仅人类网页身份可用，Agent 调用返回 INVALID_ARGUMENT。',
    roomMonitorSetSchema,
    roomMonitorResultSchema,
    async (input) => {
      requireActor(principal);
      return roomMonitorSet(db, principal, input);
    },
  );


  register(
    server,
    'network_room_members_update',
    '群 owner 或管理员添加/移除成员；管理员只能移除普通成员，不能移除 owner 或其他管理员。普通成员是否可邀请由群策略决定。添加即直接成为 active 成员，不需要对方确认，也不生成待确认邀请；加人规则与建群一致：人类须好友；Agent 有 active 好友关系，或未认领，或当前调用者是它的 active manager 时可直接加入；由其他人管理的非好友 Agent 返回 FRIEND_REQUIRED。拉黑优先返回 BLOCKED。链接邀请仍由 network_room_invite_create 生成并可按群审批策略审批。移除会取消该成员在房间内的 pending/claimed 投递。transfer_owner_to 已移除，传入会返回 INVALID_ARGUMENT；转让请使用 network_room_owner_transfer_propose。遗留无主群不允许添加成员（返回 CONFLICT/reason=owner_missing），移除仍可用。',
    roomMembersUpdateSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return roomMembersUpdate(db, principal, input);
    },
  );

  register(
    server,
    'network_room_role_set',
    '群主任免管理员：role=admin 授予管理员，role=member 撤销管理员。只有 owner 可以调用；管理员不能任免其他管理员，也不能修改 owner。expected_role_revision 必须等于目标成员当前 role_revision，过期返回 VERSION_CONFLICT；并发撤销管理员与管理员操作按事务提交序裁决。群角色不会授予 Agent 管理权或设备凭据权限。',
    roomRoleSetSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return roomRoleSet(db, principal, input);
    },
  );

  register(
    server,
    'network_room_owner_transfer',
    '兼容旧工具名：发起群主转让提议，不再直接切换 owner。只有当前 owner 可以调用；目标必须是 active 非 owner 成员。目标用 network_room_owner_transfer_respond 接受后才在同一事务内改变 rooms.owner_id 与双方角色；接受前原 owner 继续负责。新调用请使用 network_room_owner_transfer_propose。',
    roomOwnerTransferSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      await roomOwnerTransferPropose(db, principal, input);
      return roomGet(db, principal, input.room_id);
    },
  );

  register(
    server,
    'network_room_owner_transfer_propose',
    '发起群主转让提议。只有当前 owner 可以调用；目标必须是 active 非 owner 成员。同一群只允许一条有效 pending 提议，默认 24 小时有效；目标接受前 rooms.owner_id 与双方角色不变，原 owner 继续负责且不能借提议离群。返回房间详情中的 owner_transfer（含 version、expires_at 与 can_*）。',
    roomOwnerTransferProposeSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      await roomOwnerTransferPropose(db, principal, input);
      return roomGet(db, principal, input.room_id);
    },
  );

  register(
    server,
    'network_room_owner_transfer_respond',
    '目标接受或拒绝群主转让提议。只有目标本人可以响应；accept 在同一事务内复核提议版本、有效期、原 owner 仍负责、目标仍 active 且 role_revision 未漂移，然后原子换 owner 并把原 owner 降为普通成员。重复接受同一 request_id 返回同一结果；提议已接受后不能用新 request_id 再接受。不改变个人 Agent 归属、任务负责人或外部资源权限。',
    roomOwnerTransferRespondSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      const result = await roomOwnerTransferRespond(db, principal, input);
      return roomGet(db, principal, result.room_id);
    },
  );

  register(
    server,
    'network_room_owner_transfer_cancel',
    '发起人取消待确认的群主转让提议。只有原 owner 可以取消；expected_version 必须等于提议当前 version。取消不改变 owner 或任何成员角色。目标离群/被移除、原 owner 失去 owner 或提议过期后不能接受，下一次发起会在同一事务内把失效提议收敛为 expired。',
    roomOwnerTransferCancelSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      const result = await roomOwnerTransferCancel(db, principal, input);
      return roomGet(db, principal, result.room_id);
    },
  );

  register(
    server,
    'network_room_policy_set',
    '群主设置普通成员策略：发言、邀请、历史、入群审批、资料编辑与 @所有人。值为 members（普通成员可用）或 owner_admin（仅 owner/管理员）；历史为 full（默认，全历史）或 from_join（群主收紧后仅当前加入后）。管理员始终可发言与邀请；@所有人默认仅 owner/admin。expected_policy_revision 必须匹配当前版本。返回 policy_impact：开启/收紧历史会说明受影响成员和材料失权，收紧后加入前消息与文件立即不可见；已复制内容无法回收。',
    roomPolicySetSchema,
    roomPolicySetResultSchema,
    async (input) => {
      requireActor(principal);
      return roomPolicySet(db, principal, input);
    },
  );

  register(
    server,
    'network_room_rename',
    '修改群名称，遵循群资料编辑策略。expected_title 必须匹配读取时的名称；不创建聊天消息、未读或投递。',
    roomRenameSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return roomRename(db, principal, input);
    },
  );

  register(
    server,
    'network_room_announcement_set',
    '群主或管理员维护群公告；空字符串表示清除。expected_announcement_revision 必须匹配当前版本。公告只作为房间信息返回，不创建消息、delivery 或未读，不唤醒 Agent。',
    roomAnnouncementSetSchema,
    roomDetailSchema,
    async (input) => {
      requireActor(principal);
      return roomAnnouncementSet(db, principal, input);
    },
  );

  register(
    server,
    'network_room_role_history',
    '分页读取群管理审计（角色任免、成员增删、转移、策略和公告变更）。只有 owner/管理员可读；普通成员用 network_room_notice_list 读取影响自身、公告和策略的摘要。审计只含定位与版本，不包含消息正文或凭据。',
    roomRoleHistoryQuerySchema,
    roomRoleHistoryResultSchema,
    async (input) => {
      requireActor(principal);
      return roomRoleHistory(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_notice_list',
    '分页读取当前身份可见的群管理事件摘要：影响自己的成员/角色/群主事件，以及群公告和群策略变更。所有 active 成员可用。只返回摘要，不含 request_id、内部 detail、版本或消息正文；需要详细管理记录时由 owner/管理员使用 network_room_role_history。',
    roomNoticeListSchema,
    roomNoticePageSchema,
    async (input) => {
      requireActor(principal);
      return roomNoticeList(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_leave_preview',
    '只读预览退出群聊的后果：列出你在该群的 pending/claimed 投递数、是否需要先转移群主，以及是否可解散。群主在任何未解散群（包括只剩自己一人）都返回 can_leave=false、owner_transfer_required=true；解散群返回 can_leave=true。不会撤销任何工作或成员资格；退群前先展示给用户确认。',
    roomLeavePreviewQuerySchema,
    roomLeavePreviewResultSchema,
    async (input) => {
      requireActor(principal);
      return roomLeavePreview(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_room_leave',
    '离开群聊。群主在任何未解散群都不能直接退群（即使只剩自己一人），必须先通过 network_room_owner_transfer_propose 完成转让或使用 network_room_dissolve 解散；否则返回 CONFLICT（details.reason=owner_transfer_required）。退出会立即撤销你在该群的发言/文件授权与 pending/claimed 投递，旧 claim 与文件下载立即失败。若存在待处理投递，先用 network_room_leave_preview 查看并确认，调用时传 confirm_in_flight: true；否则返回 CONFLICT 与 pending/claimed 计数，不静默丢失。退出已解散群会失去该群只读归档访问，且不能重新加入。已下载到本地的副本无法技术回收。',
    roomLeaveSchema,
    leaveResultSchema,
    async (input) => {
      requireActor(principal);
      return roomLeave(db, principal, input);
    },
  );

  register(
    server,
    'network_room_dissolve',
    '解散群聊（owner only）。同一事务冻结发言、邀请、文件写入与未来通话资格；取消 pending/claimed 投递、邀请/加入请求与邀请链接，并写入 room_dissolved 审计。解散不删除消息、成果或文件；解散时仍合法的成员保留截至 archived_head_seq 的只读归档，此前已退群/被移除者无归档资格。事件携带 media_revoke: true，供未来 M09 媒体层消费；当前版本尚未实现通话媒体终止。',
    roomDissolveSchema,
    roomDissolveResultSchema,
    async (input) => {
      requireActor(principal);
      const summary = await roomDissolve(db, principal, input);
      return { ...(await roomGet(db, principal, input.room_id)), dissolve: summary };
    },
  );
}
