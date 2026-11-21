import { z } from 'zod';

export const messagePreviewSchema = z.object({
  message_id: z.string(),
  sender_id: z.string(),
  created_seq: z.string(),
  preview: z.string(),
  body_bytes: z.number(),
  created_at: z.string(),
});

/** 投递消息额外带发送者展示身份；actor 不存在或名称为空时为 null。 */
export const deliveryMessageSchema = messagePreviewSchema.extend({
  sender_name: z.string().nullable(),
  sender_kind: z.enum(['human', 'agent']).nullable(),
});

export const mentionSchema = z.object({
  actor_id: z.string(),
  kind: z.enum(['human', 'agent']),
  /** explicit 显式选择、text 正文唯一精确匹配、all @所有人。 */
  source: z.enum(['explicit', 'text', 'all']),
});

export const messageSchema = messagePreviewSchema.extend({
  room_id: z.string(),
  reply_to: z.string().nullable(),
  root_id: z.string().nullable(),
  /** 消息式 Task 归属；null 表示普通消息，起点自身等于 message_id。 */
  task_root_id: z.string().nullable(),
  hop: z.number(),
  delivery_states: z.record(z.string(), z.number()),
  /** 该消息的提及集合；human 只产生个人提醒，agent 才可能有 delivery。 */
  mentions: z.array(mentionSchema),
  /** claimed 投递的领取时间与最近更新时间；用于网页“处理中未更新”提示。 */
  delivery_claimed_at: z.string().nullable(),
  delivery_updated_at: z.string().nullable(),
});

/** 历史页额外返回权威 sender_kind；send/complete 的消息结构保持不变。 */
export const historyMessageSchema = messageSchema.extend({
  sender_kind: z.enum(['human', 'agent']).nullable(),
  /** 发送者头像；未知 actor 或无头像为 null。 */
  sender_avatar_url: z.string().nullable(),
});

export const deliverySchema = z.object({
  delivery_id: z.string(),
  recipient_id: z.string(),
  message_id: z.string(),
  room_id: z.string(),
  state: z.enum(['pending', 'claimed', 'completed', 'failed', 'cancelled']),
  attempt: z.number(),
  claim_id: z.string().nullable(),
  claimed_at: z.string().nullable(),
  progress_at: z.string().nullable(),
  result_message_id: z.string().nullable(),
  error: z.string().nullable(),
  created_seq: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  message: deliveryMessageSchema.nullable(),
});

export const eventRefSchema = z.object({
  event_id: z.string(),
  seq: z.string(),
  scope: z.string(),
  type: z.string(),
  ref_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
});

export const inboxPageSchema = z.object({
  items: z.array(deliverySchema),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  pending_count: z.number(),
  claimed_delivery_id: z.string().nullable(),
});

export const syncPageSchema = z.object({
  scope: z.string(),
  items: z.array(eventRefSchema),
  next_cursor: z.string(),
  head_cursor: z.string(),
  has_more: z.boolean(),
  head_seq: z.string(),
  min_seq: z.string(),
  reset_required: z.boolean(),
});

/** 首次分块附带的引用上下文；不可见、已撤回或发送者缺失时为 null。 */
export const messageQuoteSchema = z.object({
  message_id: z.string(),
  sender_id: z.string(),
  sender_name: z.string(),
  sender_kind: z.enum(['human', 'agent']),
  preview: z.string(),
  created_at: z.string(),
});

export const readChunkSchema = z.object({
  message_id: z.string(),
  room_id: z.string(),
  chunk: z.string(),
  chunk_cursor: z.string(),
  next_cursor: z.string().nullable(),
  eof: z.boolean(),
  body_bytes: z.number(),
  created_seq: z.string(),
  /** 只在首次分块返回；后续分块省略。 */
  reply_to: z.string().nullable().optional(),
  quote: messageQuoteSchema.nullable().optional(),
});

export const sendResultSchema = z.object({
  message: messageSchema,
  delivery_ids: z.array(z.string()),
});

/** 发送对账只返回定位信息，不返回正文、preview 或成员资格。 */
export const messageSendStatusItemSchema = z.object({
  client_message_id: z.string(),
  found: z.boolean(),
  message_id: z.string().nullable(),
  room_id: z.string().nullable(),
  created_seq: z.string().nullable(),
  delivery_ids: z.array(z.string()),
  body_bytes: z.number().nullable(),
  created_at: z.string().nullable(),
  recalled: z.boolean().optional(),
});

export const messageSendStatusPageSchema = z.object({
  items: z.array(messageSendStatusItemSchema),
});

export const completeResultSchema = z.object({
  delivery: deliverySchema,
  message: messageSchema.nullable(),
});

export const progressResultSchema = z.object({
  delivery_id: z.string(),
  attempt: z.number(),
  progress_at: z.string(),
});
