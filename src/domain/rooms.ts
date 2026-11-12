/**
 * rooms 领域 barrel。
 *
 * 纯移动拆分：`views`（列表与视图）、`create`（创建/单聊）、`detail`（详情）、
 * `membership`（成员增删）、`policy`（角色/策略/公告/审计）、`leave`（退出）。
 * 对外导出面与拆分前保持一致；内部模块可按需直接导入。
 */

export type { MessagePreviewView } from './views';

export type {
  MemberView,
  RoomCreateMemberResult,
  RoomCreateMemberStatus,
  RoomDetail,
  RoomPage,
  RoomPeerView,
  RoomPolicyImpact,
  RoomPolicySetResult,
  RoomRoleAuditView,
  RoomRoleHistoryPage,
  RoomView,
} from './rooms/views';
export type { RoomLeaveResult } from './rooms/leave';
export { roomsList } from './rooms/views';
export { roomCreate } from './rooms/create';
export { roomGet } from './rooms/detail';
export { roomMembersUpdate } from './rooms/membership';
export {
  roomAnnouncementSet,
  roomPolicySet,
  roomRoleHistory,
  roomRoleSet,
} from './rooms/policy';
export { roomLeave } from './rooms/leave';
