/**
 * 契约不兼容期间的统一写入闸门。
 *
 * 状态本身由 `update-store` 维护；这里只保存一个同步布尔值，供最小 MCP
 * 客户端在发请求前判断，避免把 React 状态机带进网络层。即使某个按钮漏了
 * `disabled`，写工具也不会真正发出。
 */

export const UPDATE_WRITE_BLOCKED_MESSAGE =
  '当前页面与服务器版本不兼容，请先更新后再操作。';

/**
 * 会改变服务端业务数据的工具。
 *
 * 读状态（`network_message_read`、`network_room_mark_read`）、版本探测、
 * 设备配对与注册登录不在其中：它们不产生聊天/文件/任务内容，且在页面
 * 不兼容时仍可能是恢复身份或完成更新的必要步骤。
 */
const UPDATE_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  'network_message_send',
  'network_message_recall',
  'network_room_message_pin',
  'network_room_file_bind',
  'network_room_file_delete',
  'network_room_create',
  'network_room_rename',
  'network_room_members_update',
  'network_room_role_set',
  'network_room_policy_set',
  'network_room_dissolve',
  'network_room_leave',
  'network_room_join_request_respond',
  'network_room_invite_create',
  'network_room_invite_respond',
  'network_room_invite_revoke',
  'network_room_announcement_set',
  'network_room_monitor_set',
  'network_room_owner_transfer_propose',
  'network_room_owner_transfer_respond',
  'network_room_owner_transfer_cancel',
  'network_contact_request',
  'network_contact_request_respond',
  'network_contact_request_cancel',
  'network_contact_remove',
  'network_contact_block',
  'network_contact_unblock',
  'network_contact_report',
  'network_contact_policy_set',
  'network_contact_link_create',
  'network_contact_link_revoke',
  'network_contact_link_redeem',
  'network_agent_create',
  'network_agent_rename',
  'network_agent_enable',
  'network_agent_disable',
  'network_agent_archive',
  'network_agent_unarchive',
  'network_agent_transfer_propose',
  'network_agent_transfer_respond',
  'network_agent_transfer_cancel',
  'network_agent_reissue_token',
  'network_me_rename',
  'network_task_mark',
  'network_task_unmark',
  'network_task_complete',
  'network_memory_forget',
  'network_focus_enable',
  'network_focus_disable',
  'network_focus_archive',
]);

let writeBlocked = false;

/** 由 `update-store` 在契约不兼容状态变化时同步；其他代码只读。 */
export function setUpdateWriteBlocked(next: boolean): void {
  writeBlocked = next;
}

export function isUpdateWriteBlocked(): boolean {
  return writeBlocked;
}

/** 仅用于单元验收；生产路径由状态机写入。 */
export function resetUpdateWriteBlockForTests(): void {
  writeBlocked = false;
}

/** 返回拦截原因；`null` 表示这次工具调用可以发出。 */
export function updateWriteBlockReason(toolName: string): string | null {
  return writeBlocked && UPDATE_BLOCKED_TOOLS.has(toolName)
    ? UPDATE_WRITE_BLOCKED_MESSAGE
    : null;
}
