import { z } from 'zod';

const id = z.string().min(1).max(128);

/**
 * 群主设置或取消一条消息的置顶。
 *
 * `pinned` 是目标状态而不是 toggle：重试同一请求不会反转意图。成功结果
 * 只确认本次请求生效，不代表置顶集合的当前快照；随后读取 room_get。
 */
export const roomMessagePinSchema = z
  .object({
    request_id: id,
    room_id: id,
    message_id: id,
    pinned: z.boolean(),
  })
  .strict();
export type RoomMessagePinInput = z.infer<typeof roomMessagePinSchema>;

export interface RoomMessagePinResult {
  room_id: string;
  message_id: string;
  pinned: boolean;
}
