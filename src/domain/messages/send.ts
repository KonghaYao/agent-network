/** messages.ts 拆分模块：send。纯移动，行为保持不变。 */

import { BusinessError } from '../../contracts/errors';
import { LIMITS } from '../../contracts/limits';
import { type MessageSendInput, type MessageSendStatusInput } from '../../contracts/schemas';
import { memoryMessageChangeStatements, type MemoryIntakeOptions } from '../../memory/intake';
import { newId, nowMs, sha256Hex, stableStringify, truncateUtf8, utf8Bytes } from '../../storage/db';
import { getMember, getMessage, getRoom } from '../../storage/queries';
import { type DeliveryRow, type MessageRow } from '../../storage/rows';
import { isMessageConflict, operationsStatement, runIdempotent } from '../../storage/transactions/runner';
import { filterMutedMentions } from '../contact-blocks';
import { type MentionSource } from '../message-view-helpers';
import { actorId, type Principal } from '../principal';
import { assertRoomWritable } from '../room-access';
import { historyBoundary } from '../room-history';
import { resolveGroupTextMentions, assertInvoke, assertMentions, agentAutoMentionPlan } from './mentions';
import { messageView, messageGuardStatements, messageCoreStatements, resolveRootLink, type MessageView, type DeliverySeed, type MentionSeed, type MentionReminderSeed, type MessageCore } from './view';

export interface SendResult {
  message: MessageView;
  delivery_ids: string[];
}

export async function messageSend(
  db: D1Database,
  principal: Principal,
  input: MessageSendInput,
  memory?: MemoryIntakeOptions | null,
): Promise<SendResult> {
  const sender = actorId(principal);
  const room = await getRoom(db, input.room_id);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, room.room_id, sender);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  assertRoomWritable(room);
  const boundary = historyBoundary(room, member);

  const originalBodyBytes = utf8Bytes(input.body);
  if (originalBodyBytes > LIMITS.messageBodyBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', '消息正文超过 256 KiB，请拆分为关联消息', {
      body_bytes: originalBodyBytes,
    });
  }
  // Agent 群消息：省略 invoke 且没有非空 mentions 时，自动 @ 前一个有效成员。
  // 自动 @ 只追加显示文本与提及记录；resolvedInvoke 仍只来自正文/显式目标。
  const autoMention = await agentAutoMentionPlan(
    db,
    room.kind,
    room.room_id,
    room.head_seq,
    boundary,
    sender,
    principal.actor?.kind ?? 'human',
    input,
  );
  const outgoingBody = autoMention?.body ?? input.body;
  const bodyBytes = utf8Bytes(outgoingBody);
  if (bodyBytes > LIMITS.messageBodyBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', '消息正文超过 256 KiB，请拆分为关联消息', {
      body_bytes: bodyBytes,
    });
  }
  // 正文解析只在群聊、未显式给 invoke 且不是 claim 回复时参与派活。
  // 显式 invoke 仍识别 `@所有人` 控制符，但不从正文追加 Agent 目标。
  // 自动 @ 只读取原始正文：追加部分不参与派活，避免改变原派活对象。
  const textResolution =
    room.kind === 'group' && !input.claim
      ? await resolveGroupTextMentions(
          db,
          room.room_id,
          sender,
          input.body,
          input.invoke === undefined,
        )
      : null;
  const resolvedInvoke =
    input.invoke === undefined ? (textResolution?.agents ?? []) : input.invoke;
  const explicitMentions = assertMentions(input.mentions, sender);
  // 拉黑只静默定向通知（delivery），不改变群消息本体、正文 @ 或成员资格。
  const requestedInvoke = assertInvoke(resolvedInvoke, sender);
  const invoke = await filterMutedMentions(db, room.kind, sender, requestedInvoke);

  const mentionAll = textResolution?.mentionAll ?? false;
  const mentionMap = new Map<string, MentionSeed>();
  const mentionRank: Record<MentionSource, number> = { all: 0, text: 1, explicit: 2 };
  const addMention = (actor: string, kind: 'human' | 'agent', source: MentionSource) => {
    const existing = mentionMap.get(actor);
    if (existing && mentionRank[existing.source] >= mentionRank[source]) return;
    mentionMap.set(actor, { actorId: actor, kind, source });
  };
  if (mentionAll && textResolution) {
    for (const actor of textResolution.allHumans) addMention(actor, 'human', 'all');
  }
  if (input.invoke === undefined) {
    for (const actor of textResolution?.agents ?? []) addMention(actor, 'agent', 'text');
    for (const actor of textResolution?.humans ?? []) addMention(actor, 'human', 'text');
  } else {
    // 记录全部显式选择；被拉黑静默的目标仍保留提及事实，只是没有 delivery。
    for (const actor of requestedInvoke) addMention(actor, 'agent', 'explicit');
  }
  for (const actor of explicitMentions) addMention(actor, 'human', 'explicit');
  // 自动 @ 沿用 text 来源，不新增迁移；Agent 目标不进入 invoke，因此没有 delivery。
  if (autoMention) {
    addMention(autoMention.target.actorId, autoMention.target.kind, 'text');
  }
  const mentions = [...mentionMap.values()];
  const reminders: MentionReminderSeed[] = mentions
    .filter((mention) => mention.kind === 'human' && mention.actorId !== sender)
    .map((mention) => ({
      actorId: mention.actorId,
      source: mention.source,
      mentionAll,
    }));
  const link = await resolveRootLink(db, sender, room.room_id, input, boundary);

  const at = nowMs();
  const messageId = newId('msg');
  const deliveries: DeliverySeed[] = invoke.map((recipientId) => ({
    deliveryId: newId('dlv'),
    recipientId,
  }));
  const eventKey = `message:${messageId}`;
  const core: MessageCore = {
    messageId,
    roomId: room.room_id,
    senderId: sender,
    senderName: principal.actor?.name ?? null,
    senderKind: principal.actor?.kind ?? null,
    clientMessageId: input.client_message_id,
    body: outgoingBody,
    preview: truncateUtf8(outgoingBody, LIMITS.previewBytes),
    bodyBytes,
    replyTo: link.replyTo,
    rootId: link.rootId,
    taskRootId: link.taskRootId,
    rootKey: link.rootKey || messageId,
    hop: link.hop,
    invoke,
    mentionAll,
    mentions,
    reminders,
    deliveries,
    eventKey,
    at,
  };

  const payloadHash = await sha256Hex(stableStringify(input));
  // Memory 启用时，共享来源与真实 delivery 的预热资格与消息同批提交；
  // 未启用时不生成任何额外语句，也不做摘要计算。
  const memoryStatements = memory?.capture
    ? memoryMessageChangeStatements(db, memory, {
        messageId,
        eventKey,
        senderId: sender,
        body: outgoingBody,
        bodyBytes,
        digest: outgoingBody.length > 0 ? await sha256Hex(outgoingBody) : null,
        createdAt: at,
        roomId: room.room_id,
        origin: {
          roomId: room.room_id,
          memberGeneration: member.member_generation,
          policyRevision: boundary.policyRevision,
          joinedSeq: member.joined_seq,
          joinedAt: member.joined_at,
          archiveHeadSeq: room.archive_head_seq,
        },
        deliveries,
        taskRootId: core.taskRootId ?? null,
        now: at,
      })
    : [];

  await runIdempotent(db, {
    actorId: sender,
    requestId: input.request_id,
    payloadHash,
    result: { message_id: messageId },
    build: (resultJson) => [
      operationsStatement(db, sender, input.request_id, payloadHash, resultJson, at),
      ...messageGuardStatements(db, core),
      ...messageCoreStatements(db, core),
      ...memoryStatements,
      db
        .prepare(
          `UPDATE operations
              SET result_json = json_object(
                    'message_id', ?,
                    'seq', (SELECT CAST(event_seq AS TEXT) FROM events WHERE event_key = ?),
                    'delivery_ids', COALESCE(
                      (SELECT json_group_array(delivery_id)
                         FROM (SELECT delivery_id FROM deliveries WHERE message_id = ? ORDER BY delivery_id)),
                      '[]'
                    )
                  )
            WHERE actor_id = ? AND request_id = ?`,
        )
        .bind(messageId, eventKey, messageId, sender, input.request_id),
    ],
    onUniqueConflict: async (error) => {
      if (!isMessageConflict(error)) return undefined;
      const existing = await db
        .prepare('SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?')
        .bind(sender, input.client_message_id)
        .first<MessageRow>();
      if (!existing) return undefined;
      // 重放时按原消息之前的同一段历史重算自动 @，避免把“已追加”误判为新正文。
      const replayed = await agentAutoMentionPlan(
        db,
        room.kind,
        room.room_id,
        room.head_seq,
        boundary,
        sender,
        principal.actor?.kind ?? 'human',
        input,
        existing.created_seq,
      );
      const replayedBody = replayed?.body ?? input.body;
      let bodyMatches = existing.body === replayedBody;
      if (!bodyMatches && existing.body === '' && existing.preview === '此消息已撤回') {
        const recall = await db.prepare("SELECT metadata FROM events WHERE event_type = 'message_recalled' AND ref_id = ? ORDER BY event_seq DESC LIMIT 1")
          .bind(existing.message_id).first<{ metadata: string }>();
        let originalHash: string | null = null;
        try { originalHash = (JSON.parse(recall?.metadata ?? '{}') as { body_sha256?: string }).body_sha256 ?? null; } catch { /* malformed legacy event: reject replay */ }
        bodyMatches = originalHash !== null && originalHash === await sha256Hex(replayedBody);
      }
      if (existing.room_id !== room.room_id || !bodyMatches) {
        throw new BusinessError('IDEMPOTENCY_CONFLICT', 'client_message_id 已用于不同的消息内容', {
          message_id: existing.message_id,
        });
      }
      // 重放不得静默改变 Task 归属；继承结果允许与显式值相同。
      if (input.task_root_id !== undefined && existing.task_root_id !== input.task_root_id) {
        throw new BusinessError('IDEMPOTENCY_CONFLICT', 'client_message_id 已用于不同的 Task 归属', {
          message_id: existing.message_id,
        });
      }
      return messageSendResult(db, existing);
    },
  });

  const stored =
    (await getMessage(db, messageId)) ??
    (await db
      .prepare('SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?')
      .bind(sender, input.client_message_id)
      .first<MessageRow>());
  if (!stored) throw new BusinessError('CONFLICT', '消息事务已提交但读不到消息');
  return messageSendResult(db, stored);
}
export async function messageSendResult(db: D1Database, row: MessageRow): Promise<SendResult> {
  const ids = await db
    .prepare('SELECT delivery_id FROM deliveries WHERE message_id = ? ORDER BY delivery_id')
    .bind(row.message_id)
    .all<{ delivery_id: string }>();
  return {
    message: await messageView(db, row),
    delivery_ids: ids.results.map((item) => item.delivery_id),
  };
}

/** 幂等读取已提交的发送结果，供 client_message_id 并发恢复使用。 */
export async function sendResultByClientId(
  db: D1Database,
  senderId: string,
  clientMessageId: string,
): Promise<SendResult | null> {
  const row = await db
    .prepare('SELECT * FROM messages WHERE sender_id = ? AND client_message_id = ?')
    .bind(senderId, clientMessageId)
    .first<MessageRow>();
  return row ? messageSendResult(db, row) : null;
}

export interface MessageSendStatusItem {
  client_message_id: string;
  found: boolean;
  message_id: string | null;
  room_id: string | null;
  created_seq: string | null;
  delivery_ids: string[];
  body_bytes: number | null;
  created_at: string | null;
  recalled?: boolean;
}

export interface MessageSendStatusRow {
  message_id: string;
  room_id: string;
  client_message_id: string;
  created_seq: number;
  body_bytes: number;
  created_at: number;
  preview: string;
}

/**
 * 按发送者自己的 client_message_id 对账发送结果。
 *
 * 只返回定位信息（消息、房间、顺序、delivery 数），不返回正文与 preview；
 * 也不要求当前仍是房间成员。撤权后发送者仍能确认“是否已提交”，从而不会
 * 因响应丢失而生成第二条消息；正文读取仍走各自入口的当前授权检查。
 */
export async function messageSendStatus(
  db: D1Database,
  principal: Principal,
  input: MessageSendStatusInput,
): Promise<{ items: MessageSendStatusItem[] }> {
  const sender = actorId(principal);
  const ids = [...new Set(input.client_message_ids)];
  const placeholders = ids.map(() => '?').join(',');
  const rows = await db
    .prepare(
      `SELECT message_id, room_id, client_message_id, created_seq, body_bytes, created_at, preview
         FROM messages WHERE sender_id = ? AND client_message_id IN (${placeholders})`,
    )
    .bind(sender, ...ids)
    .all<MessageSendStatusRow>();
  const byClient = new Map(rows.results.map((row) => [row.client_message_id, row]));

  const messageIds = rows.results.map((row) => row.message_id);
  const deliveryRows =
    messageIds.length === 0
      ? []
      : (
          await db
            .prepare(
              `SELECT message_id, delivery_id FROM deliveries
                WHERE message_id IN (${messageIds.map(() => '?').join(',')})
                ORDER BY delivery_id`,
            )
            .bind(...messageIds)
            .all<{ message_id: string; delivery_id: string }>()
        ).results;
  const deliveriesByMessage = new Map<string, string[]>();
  for (const delivery of deliveryRows) {
    const list = deliveriesByMessage.get(delivery.message_id);
    if (list) list.push(delivery.delivery_id);
    else deliveriesByMessage.set(delivery.message_id, [delivery.delivery_id]);
  }

  return {
    items: ids.map((clientMessageId) => {
      const row = byClient.get(clientMessageId);
      if (!row) {
        return {
          client_message_id: clientMessageId,
          found: false,
          message_id: null,
          room_id: null,
          created_seq: null,
          delivery_ids: [],
          body_bytes: null,
          created_at: null,
          recalled: false,
        };
      }
      return {
        client_message_id: clientMessageId,
        found: true,
        message_id: row.message_id,
        room_id: row.room_id,
        created_seq: String(row.created_seq),
        delivery_ids: deliveriesByMessage.get(row.message_id) ?? [],
        body_bytes: row.body_bytes,
        created_at: String(row.created_at),
        recalled: row.body_bytes === 0 && row.preview === '此消息已撤回',
      };
    }),
  };
}

/** 完成 delivery 时附加的最终消息；不产生新的 invoke。 */
export async function finalMessagePlan(
  db: D1Database,
  sender: string,
  delivery: DeliveryRow,
  body: string,
  clientMessageId: string,
): Promise<MessageCore> {
  const parent = await getMessage(db, delivery.message_id);
  if (!parent) throw new BusinessError('NOT_FOUND', '任务消息不存在');
  // 完成回执也是该线程的回复：沿用父消息归属，或在顶层起点已标记时继承。
  let taskRootId = parent.task_root_id;
  if (!taskRootId && parent.root_id) {
    const root = await getMessage(db, parent.root_id);
    if (root && root.room_id === parent.room_id && root.task_root_id === root.message_id) {
      taskRootId = root.message_id;
    }
  }
  const bodyBytes = utf8Bytes(body);
  if (bodyBytes > LIMITS.messageBodyBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', '消息正文超过 256 KiB，请拆分为关联消息');
  }
  const messageId = newId('msg');
  return {
    messageId,
    roomId: delivery.room_id,
    senderId: sender,
    clientMessageId,
    body,
    preview: truncateUtf8(body, LIMITS.previewBytes),
    bodyBytes,
    replyTo: parent.message_id,
    rootId: parent.root_id ?? parent.message_id,
    taskRootId,
    rootKey: parent.root_id ?? parent.message_id,
    hop: parent.hop + 1,
    invoke: [],
    mentionAll: false,
    mentions: [],
    reminders: [],
    deliveries: [],
    eventKey: `message:${messageId}`,
    at: nowMs(),
  };
}

