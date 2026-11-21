import { z } from 'zod';

export const roomInvitationSchema = z.object({
  invitation_id: z.string(),
  room_id: z.string(),
  room_title: z.string(),
  inviter_id: z.string(),
  inviter_name: z.string(),
  target_actor_id: z.string().nullable(),
  kind: z.enum(['direct', 'link']),
  status: z.enum(['pending', 'accepted', 'rejected', 'revoked', 'expired', 'exhausted']),
  expires_at: z.string(),
  created_at: z.string(),
  revision: z.number(),
  max_uses: z.number(),
  used_count: z.number(),
  /** 目标群当前 active 人数；只是群名片，不包含成员私密资料。 */
  member_count: z.number(),
  /** true 表示确认后先进入申请列表，而不是立即成为成员。 */
  requires_approval: z.boolean(),
  /** 服务端给出的下一步；页面只展示，不自行推断权限。 */
  next_step: z.enum([
    'join',
    'request',
    'pending_approval',
    'member',
    'removed',
    'blocked',
    'invalid',
    'share',
  ]),
  join_request_status: z
    .enum(['pending', 'approved', 'rejected', 'cancelled', 'expired'])
    .nullable(),
  can_respond: z.boolean(),
});

export const roomInvitationPageSchema = z.object({
  items: z.array(roomInvitationSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const roomInvitationRespondSchema = z.object({
  invitation_id: z.string(),
  room_id: z.string(),
  status: z.enum(['accepted', 'rejected', 'requested']),
  /** 进入审批时返回对应申请；直接加入或拒绝为 null。 */
  join_request_id: z.string().nullable().optional(),
});

/** 创建邀请：链接只在创建响应中出现一次明文 key 与分享 URL。 */
export const roomInviteCreateResultSchema = z.object({
  /** 链接邀请对象；指定 target_actor_id 时目标直接入群，这里为 null。 */
  invitation: roomInvitationSchema.nullable(),
  invite_key: z.string().nullable(),
  share_url: z.string().nullable(),
  /** 定向添加直接成为 active 成员时的目标摘要；链接邀请为 null。 */
  member: z
    .object({
      actor_id: z.string(),
      kind: z.enum(['human', 'agent']),
      name: z.string(),
      role: z.enum(['owner', 'admin', 'member']),
      status: z.literal('active'),
    })
    .nullable(),
});

/** 入群申请视图；只有 owner/admin 能读取。 */
export const roomJoinRequestSchema = z.object({
  join_request_id: z.string(),
  invitation_id: z.string(),
  room_id: z.string(),
  invitation_kind: z.enum(['direct', 'link']),
  applicant: z.object({
    actor_id: z.string(),
    kind: z.enum(['human', 'agent']),
    name: z.string(),
    agent_session_id: z.string().nullable(),
  }),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']),
  message: z.string(),
  revision: z.number(),
  created_at: z.string(),
  expires_at: z.string(),
  can_approve: z.boolean(),
  can_reject: z.boolean(),
});

export const roomJoinRequestPageSchema = z.object({
  items: z.array(roomJoinRequestSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const roomJoinRequestRespondResultSchema = z.object({
  join_request_id: z.string(),
  invitation_id: z.string(),
  room_id: z.string(),
  status: z.enum(['approved', 'rejected']),
});
