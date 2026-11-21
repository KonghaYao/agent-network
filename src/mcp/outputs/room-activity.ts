import { z } from 'zod';

const roomActionSchema = z.enum([
  'member_added',
  'member_removed',
  'member_left',
  'admin_appointed',
  'admin_revoked',
  'owner_transferred',
  'owner_transfer_proposed',
  'owner_transfer_accepted',
  'owner_transfer_rejected',
  'owner_transfer_cancelled',
  'owner_transfer_expired',
  'policy_updated',
  'announcement_updated',
  'invite_created',
  'invite_revoked',
  'join_requested',
  'join_approved',
  'join_rejected',
  'room_dissolved',
  'message_recalled',
  'message_pinned',
  'message_unpinned',
]);

export const roomRoleAuditSchema = z.object({
  audit_id: z.string(),
  room_id: z.string(),
  action: roomActionSchema,
  target_actor_id: z.string().nullable(),
  target_name: z.string().nullable(),
  previous_role: z.enum(['owner', 'admin', 'member']).nullable(),
  new_role: z.enum(['owner', 'admin', 'member']).nullable(),
  previous_status: z.enum(['active', 'left', 'removed']).nullable(),
  new_status: z.enum(['active', 'left', 'removed']).nullable(),
  expected_revision: z.number().nullable(),
  resulting_revision: z.number(),
  changed_by: z.string(),
  changed_by_name: z.string().nullable(),
  request_id: z.string(),
  detail: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

export const roomRoleHistorySchema = z.object({
  items: z.array(roomRoleAuditSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

/** 置顶确认只表达本次请求生效，不是置顶集合快照；随后重读 room_get。 */
export const roomMessagePinResultSchema = z.object({
  room_id: z.string(),
  message_id: z.string(),
  pinned: z.boolean(),
});

/** 普通成员可见的管理事件摘要；不含 request_id、detail 或版本字段。 */
export const roomNoticeSchema = z.object({
  audit_id: z.string(),
  action: roomActionSchema,
  target_actor_id: z.string().nullable(),
  changed_by: z.string(),
  changed_by_name: z.string().nullable(),
  summary: z.string(),
  created_at: z.string(),
});

export const roomNoticePageSchema = z.object({
  items: z.array(roomNoticeSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const pinnedMessageSchema = z.object({
  message_id: z.string(),
  /** 当前消息预览；不复制 pin 时快照，也不包含文件元数据。 */
  preview: z.string(),
  sender: z.object({
    actor_id: z.string(),
    name: z.string().nullable(),
    kind: z.enum(['human', 'agent']).nullable(),
  }),
  created_seq: z.string(),
  pinned_at: z.string(),
});
