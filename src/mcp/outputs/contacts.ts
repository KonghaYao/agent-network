import { z } from 'zod';

export const contactSchema = z.object({
  actor_id: z.string(),
  kind: z.enum(['human', 'agent']),
  name: z.string(),
  agent_session_id: z.string().nullable(),
  /** 同源 `/f/<fileId>`；无头像为 null。 */
  avatar_url: z.string().nullable(),
  /** active 表示双方已建立好友关系；none 只是自己的历史收藏。 */
  relation: z.enum(['active', 'none']),
  created_at: z.string(),
});

export const contactActorSchema = z.object({
  actor_id: z.string(),
  kind: z.enum(['human', 'agent']),
  name: z.string(),
  agent_session_id: z.string().nullable(),
  /** 同源 `/f/<fileId>`；无头像为 null。 */
  avatar_url: z.string().nullable(),
});

export const contactSearchItemSchema = z.object({
  actor: contactActorSchema,
  relation: z.enum(['active', 'none']),
  pending_request: z
    .object({
      contact_request_id: z.string(),
      direction: z.enum(['incoming', 'outgoing']),
    })
    .nullable(),
});

export const contactSearchResultSchema = z.object({
  items: z.array(contactSearchItemSchema),
  truncated: z.boolean(),
});

export const contactRelationSchema = z.object({
  pair_key: z.string(),
  actor_ids: z.array(z.string()),
  status: z.enum(['active', 'ended']),
  source: z.enum(['request', 'auto_manager', 'invite_link']),
  created_at: z.string(),
  updated_at: z.string(),
  ended_at: z.string().nullable(),
});

export const contactRequestSchema = z.object({
  contact_request_id: z.string(),
  status: z.enum(['pending', 'accepted', 'rejected', 'cancelled', 'expired']),
  direction: z.enum(['incoming', 'outgoing']),
  message: z.string(),
  auto_accepted: z.boolean(),
  from_actor: contactActorSchema,
  to_actor: contactActorSchema,
  created_at: z.string(),
  updated_at: z.string(),
  expires_at: z.string(),
  responded_at: z.string().nullable(),
  responded_by: z.string().nullable(),
  can_respond: z.boolean(),
  can_cancel: z.boolean(),
});

export const contactRequestResultSchema = z.object({
  request: contactRequestSchema.nullable(),
  relation: contactRelationSchema.nullable(),
  status: z.enum(['pending', 'accepted', 'rejected', 'cancelled', 'expired']),
  already_friends: z.boolean(),
  auto_accepted: z.boolean(),
});

export const contactRequestPageSchema = z.object({
  items: z.array(contactRequestSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const contactPolicySchema = z.object({
  actor_id: z.string(),
  name: z.string(),
  kind: z.enum(['human', 'agent']),
  policy: z.enum(['self_approval', 'manager_approval', 'auto_accept']),
  configured: z.boolean(),
  approver_actor_id: z.string().nullable(),
  approver_name: z.string().nullable(),
});

export const contactBlockSchema = z.object({
  block_id: z.string(),
  blocker_actor_id: z.string(),
  blocked_actor: contactActorSchema,
  reason: z.string(),
  mute_mentions: z.boolean(),
  created_at: z.string(),
  active: z.boolean(),
  released_at: z.string().nullable(),
  released_by: z.string().nullable(),
});

export const contactBlockResultSchema = z.object({
  block: contactBlockSchema,
  already_blocked: z.boolean(),
});

export const contactUnblockResultSchema = z.object({
  block: contactBlockSchema.nullable(),
  released: z.boolean(),
});

export const contactBlockPageSchema = z.object({
  items: z.array(contactBlockSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

export const contactReportSchema = z.object({
  report_id: z.string(),
  reporter_actor_id: z.string(),
  target_actor: contactActorSchema,
  category: z.enum(['harassment', 'spam', 'fraud', 'other']),
  note: z.string(),
  room_id: z.string().nullable(),
  message_id: z.string().nullable(),
  status: z.enum(['received']),
  created_at: z.string(),
  updated_at: z.string(),
});

export const contactReportResultSchema = z.object({ report: contactReportSchema });

export const contactReportPageSchema = z.object({
  items: z.array(contactReportSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});

/**
 * 好友邀请链接视图：从不包含 token 或 token_hash。
 * `can_revoke` 只对仍 pending 且属于当前 actor 的链接为 true。
 */
export const contactLinkSchema = z.object({
  link_id: z.string(),
  status: z.enum(['pending', 'used', 'revoked', 'expired']),
  created_at: z.string(),
  expires_at: z.string(),
  used_by: contactActorSchema.nullable(),
  used_at: z.string().nullable(),
  revoked_at: z.string().nullable(),
  can_revoke: z.boolean(),
});

/** 明文分享 URL 只在首次 create 响应出现；重放返回 TOKEN_NOT_REPLAYABLE。 */
export const contactLinkCreateResultSchema = z.object({
  link: contactLinkSchema,
  share_url: z.string(),
});

export const contactLinkPreviewResultSchema = z.object({
  valid: z.boolean(),
  status: z.enum(['pending', 'used', 'revoked', 'expired', 'invalid']),
  owner: contactActorSchema.nullable(),
  expires_at: z.string().nullable(),
  reason: z.enum(['invalid', 'expired', 'used', 'revoked']).nullable(),
});

export const contactLinkRedeemResultSchema = z.object({
  link_id: z.string(),
  owner: contactActorSchema,
  relation: contactRelationSchema,
  already_friends: z.boolean(),
});

export const contactLinkRevokeResultSchema = z.object({
  link: contactLinkSchema,
  already_revoked: z.boolean(),
});

export const contactLinkListResultSchema = z.object({
  items: z.array(contactLinkSchema),
});

export const contactPageSchema = z.object({
  items: z.array(contactSchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
