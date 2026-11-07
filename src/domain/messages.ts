import { BusinessError } from '../contracts/errors';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  HistoryListInput,
  MessageReadInput,
  MessageSendInput,
  RoomMarkReadInput,
} from '../contracts/schemas';
import {
  newId,
  nowMs,
  sha256Hex,
  sliceUtf8Chunk,
  stableStringify,
  truncateUtf8,
  utf8Bytes,
} from '../storage/db';
import {
  eventStatement,
  inboxHeadStatement,
  inboxHeadStatementIfEvent,
  inboxTopic,
  outboxStatement,
  roomHeadStatement,
  roomTopic,
} from '../storage/events';
import { guardSql } from '../storage/guards';
import { directMessageGuardStatement } from './contact-relations';
import {
  directBlockGuardStatement,
  filterMutedMentions,
} from './contact-blocks';
import {
  getActorsByIds,
  getClaimedDelivery,
  getDelivery,
  getMember,
  getMessage,
  getRoom,
} from '../storage/queries';
import type { DeliveryRow, MessageRow } from '../storage/rows';
import {
  deliveryStatesFor,
  nullableString,
  summarizeDeliveryStates,
  type DeliveryStateRow,
} from './message-view-helpers';
import {
  isMessageConflict,
  operationsStatement,
  runIdempotent,
} from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';
import { capabilityGuardStatement } from './room-access';
import type { MessagePreviewView } from './rooms';
import { timelineList, type TimelinePage } from './timeline';

export interface MessageView extends MessagePreviewView {
  room_id: string;
  reply_to: string | null;
  root_id: string | null;
  hop: number;
  delivery_states: Record<string, number>;
  /** 该消息当前 claimed 投递中最早的领取时间；无 claimed 时为 null。 */
  delivery_claimed_at: string | null;
  /** 该消息 claimed 投递最近一次 claim/report 的更新时间；无 claimed 时为 null。 */
  delivery_updated_at: string | null;
}

export interface MessagePage {
  items: HistoryMessageView[];
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  head_seq: string;
}

/**
 * 历史页的权威发送者类型，用于网页区分 AI Markdown 与人类纯文本。
 *
 * `null` 表示 actor 已不存在；网页回退到 members（可能也没有）后按纯文本渲染。
 * `network_message_send` / `delivery_complete` 的返回结构不包含该字段。
 */
export interface HistoryMessageView extends MessageView {
  sender_kind: 'human' | 'agent' | null;
}

export interface DeliverySeed {
  deliveryId: string;
  recipientId: string;
}

export interface MessageCore {
  messageId: string;
  roomId: string;
  senderId: string;
  clientMessageId: string;
  body: string;
  preview: string;
  bodyBytes: number;
  replyTo: string | null;
  rootId: string | null;
  /** 用于 root 预算统计的根消息 ID。 */
  rootKey: string;
  hop: number;
  invoke: string[];
  deliveries: DeliverySeed[];
  eventKey: string;
  at: number;
}

export async function messageView(
  db: D1Database,
  row: MessageRow,
): Promise<MessageView> {
  const states = await db
    .prepare(
      `SELECT state, COUNT(*) AS n,
              MAX(CASE WHEN state = 'claimed' THEN claimed_at END) AS max_claimed_at,
              MAX(CASE WHEN state = 'claimed' THEN updated_at END) AS max_updated_at
         FROM deliveries WHERE message_id = ? GROUP BY state`,
    )
    .bind(row.message_id)
    .all<DeliveryStateRow>();
  const summary = summarizeDeliveryStates(states.results);
  return {
    message_id: row.message_id,
    room_id: row.room_id,
    sender_id: row.sender_id,
    created_seq: String(row.created_seq),
    preview: row.preview,
    body_bytes: row.body_bytes,
    created_at: String(row.created_at),
    reply_to: row.reply_to,
    root_id: row.root_id,
    hop: row.hop,
    delivery_states: summary.states,
    delivery_claimed_at: nullableString(summary.claimedAt),
    delivery_updated_at: nullableString(summary.updatedAt),
  };
}

/** 深度、root 派发预算、成员资格、目标有效性与队列上限的同一事务校验。 */
export function messageGuardStatements(
  db: D1Database,
  core: Pick<MessageCore, 'roomId' | 'senderId' | 'hop' | 'rootKey' | 'invoke' | 'at'>,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        guardSql(
          'notMember',
          "NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active')",
        ),
      )
      .bind(core.roomId, core.senderId),
    // 拉黑先于好友关系裁决，返回稳定的 BLOCKED 而不是 FRIEND_REQUIRED。
    directBlockGuardStatement(db, core.roomId),
    directMessageGuardStatement(db, core.roomId),
    // 群策略：owner_admin 时普通成员不能发言；管理员和 owner 始终可以。
    capabilityGuardStatement(db, core.roomId, core.senderId, 'send_message'),
  ];

  if (core.hop > LIMITS.cooperationDepthMax) {
    statements.push(
      db.prepare(guardSql('budgetExceeded', '? > ?')).bind(core.hop, LIMITS.cooperationDepthMax),
    );
  }

  for (const recipient of core.invoke) {
    statements.push(
      db
        .prepare(
          guardSql(
            'invalidTarget',
            `NOT EXISTS (
               SELECT 1 FROM room_members m JOIN actors a ON a.actor_id = m.actor_id
                WHERE m.room_id = ? AND m.actor_id = ? AND m.status = 'active' AND a.kind = 'agent'
             )`,
          ),
        )
        .bind(core.roomId, recipient),
      db
        .prepare(
          guardSql(
            'actorDisabled',
            "EXISTS (SELECT 1 FROM actors WHERE actor_id = ? AND disabled_at IS NOT NULL)",
          ),
        )
        .bind(recipient),
      db
        .prepare(
          guardSql(
            'queueFull',
            "(SELECT COUNT(*) FROM deliveries WHERE recipient_id = ? AND state = 'pending') + 1 > ?",
          ),
        )
        .bind(recipient, LIMITS.pendingPerActor),
      // 重复 @ 的定向投递窗口限额；普通广播消息不受影响。
      db
        .prepare(
          guardSql(
            'rateLimited',
            `(SELECT COUNT(*)
                FROM deliveries d JOIN messages m ON m.message_id = d.message_id
               WHERE d.recipient_id = ? AND m.sender_id = ? AND d.created_at > ?) >= ?`,
          ),
        )
        .bind(
          recipient,
          core.senderId,
          core.at - LIMITS.mentionDeliveryWindowMs,
          LIMITS.mentionDeliveryWindowMax,
        ),
    );
  }

  if (core.invoke.length > 0) {
    statements.push(
      db
        .prepare(
          guardSql(
            'budgetExceeded',
            `(SELECT COUNT(*)
                FROM deliveries d JOIN messages m ON m.message_id = d.message_id
               WHERE COALESCE(m.root_id, m.message_id) = ?) + ? > ?`,
          ),
        )
        .bind(core.rootKey, core.invoke.length, LIMITS.rootDeliveryMax),
    );
  }

  return statements;
}

/** 消息本体、房间 head、delivery 与对应 inbox 事件的原子写入。 */
export function messageCoreStatements(
  db: D1Database,
  core: MessageCore,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [
    eventStatement(
      db,
      {
        eventKey: core.eventKey,
        scopeKind: 'room',
        scopeId: core.roomId,
        eventType: 'message_created',
        refId: core.messageId,
        metadata: { sender_id: core.senderId, deliveries: core.deliveries.length },
      },
      core.at,
    ),
    db
      .prepare(
        `INSERT INTO messages
           (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes, preview,
            reply_to, root_id, hop, root_invocations_used, created_at)
         VALUES (?, ?, ?, ?, (SELECT event_seq FROM events WHERE event_key = ?), ?, ?, ?, ?, ?, ?,
           COALESCE((SELECT COUNT(*)
                       FROM deliveries d JOIN messages m ON m.message_id = d.message_id
                      WHERE COALESCE(m.root_id, m.message_id) = ?), 0) + ?,
           ?)`,
      )
      .bind(
        core.messageId,
        core.roomId,
        core.senderId,
        core.clientMessageId,
        core.eventKey,
        core.body,
        core.bodyBytes,
        core.preview,
        core.replyTo,
        core.rootId,
        core.hop,
        core.rootKey,
        core.invoke.length,
        core.at,
      ),
    ...core.deliveries.map((delivery) =>
      db
        .prepare(
          `INSERT INTO deliveries
             (delivery_id, recipient_id, message_id, room_id, state, attempt, claim_id, claimed_at,
              progress_at, result_message_id, error, created_seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL,
             (SELECT event_seq FROM events WHERE event_key = ?), ?, ?)`,
        )
        .bind(
          delivery.deliveryId,
          delivery.recipientId,
          core.messageId,
          core.roomId,
          core.eventKey,
          core.at,
          core.at,
        ),
    ),
    roomHeadStatement(db, core.roomId, core.eventKey, core.at, core.messageId),
    outboxStatement(db, { topic: roomTopic(core.roomId), eventKey: core.eventKey }, core.at),
  ];

  for (const delivery of core.deliveries) {
    const inboxKey = `inbox:${delivery.recipientId}:${core.messageId}`;
    statements.push(
      eventStatement(
        db,
        {
          eventKey: inboxKey,
          scopeKind: 'inbox',
          scopeId: delivery.recipientId,
          eventType: 'delivery_created',
          refId: delivery.deliveryId,
          metadata: {
            message_id: core.messageId,
            room_id: core.roomId,
            sender_id: core.senderId,
          },
        },
        core.at,
      ),
      outboxStatement(db, { topic: inboxTopic(delivery.recipientId), eventKey: inboxKey }, core.at),
      inboxHeadStatement(db, delivery.recipientId, inboxKey, core.at, 1),
    );
  }

  return statements;
}

interface RootLink {
  replyTo: string | null;
  rootId: string | null;
  rootKey: string;
  hop: number;
  parent: MessageRow | null;
}

async function resolveRootLink(
  db: D1Database,
  sender: string,
  roomId: string,
  input: MessageSendInput,
): Promise<RootLink> {
  let parent: MessageRow | null = null;

  if (input.claim) {
    const delivery = await getDelivery(db, input.claim.delivery_id);
    if (!delivery || delivery.recipient_id !== sender) {
      throw new BusinessError('STALE_ATTEMPT', 'claim 不属于当前身份', {
        delivery_id: input.claim.delivery_id,
      });
    }
    if (delivery.state !== 'claimed') {
      throw new BusinessError('CLAIM_CONFLICT', '该工作当前不是领取状态');
    }
    if (delivery.attempt !== input.claim.attempt || delivery.claim_id !== input.claim.claim_id) {
      throw new BusinessError('STALE_ATTEMPT', 'attempt 或 claim_id 已过期');
    }
    if (delivery.room_id !== roomId) {
      throw new BusinessError('INVALID_ARGUMENT', '回复必须发生在任务所在房间');
    }
    parent = await getMessage(db, delivery.message_id);
  } else {
    const claimed = await getClaimedDelivery(db, sender);
    if (claimed) parent = await getMessage(db, claimed.message_id);
  }

  let replyTo = input.reply_to ?? parent?.message_id ?? null;
  if (input.reply_to) {
    const replied = await getMessage(db, input.reply_to);
    if (!replied || replied.room_id !== roomId) {
      throw new BusinessError('INVALID_ARGUMENT', 'reply_to 不是当前房间的消息');
    }
    replyTo = replied.message_id;
    if (!parent) parent = replied;
  }

  if (!parent) {
    return { replyTo, rootId: null, rootKey: '', hop: 0, parent: null };
  }
  return {
    replyTo,
    rootId: parent.root_id ?? parent.message_id,
    rootKey: parent.root_id ?? parent.message_id,
    hop: parent.hop + 1,
    parent,
  };
}

interface MentionMember {
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
}

interface GroupMentionResolution {
  /** 正文 @ 解析出的唯一 active Agent 目标。 */
  invoke: string[];
  /** 正文是否命中任一 active 成员名，含 human 与发送者本人。 */
  hadMemberMention: boolean;
}

/**
 * 群聊省略 `invoke` 时按正文 `@名字` 解析投递目标。
 *
 * 只用房间当前 active 成员名做精确、大小写敏感、最长优先的原文匹配；
 * 不 trim、不做 Unicode 归一化、不识别 Markdown 或转义。非 Agent 成员与发送者
 * 参与最长匹配（避免被更短的 Agent 名字前缀误命中），但只有唯一的
 * active Agent 成员会进入结果。正文里的非成员名字只是普通文本。
 * `hadMemberMention` 用于阻止“回复上一条消息”的自动投递：只要命中任一成员名
 * （即使是 human 或发送者本人）就视为显式 @，不再自动补目标。
 */
async function resolveGroupMentionInvoke(
  db: D1Database,
  roomId: string,
  sender: string,
  body: string,
): Promise<GroupMentionResolution> {
  if (!body.includes('@')) return { invoke: [], hadMemberMention: false };
  const rows = await db
    .prepare(
      `SELECT m.actor_id, a.kind, a.name
         FROM room_members m JOIN actors a ON a.actor_id = m.actor_id
        WHERE m.room_id = ? AND m.status = 'active'`,
    )
    .bind(roomId)
    .all<MentionMember>();

  const byName = new Map<string, MentionMember[]>();
  for (const row of rows.results) {
    const list = byName.get(row.name);
    if (list) list.push(row);
    else byName.set(row.name, [row]);
  }
  const names = [...byName.keys()].sort((a, b) => {
    if (a.length !== b.length) return b.length - a.length;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const targets = new Set<string>();
  let hadMemberMention = false;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '@') continue;
    const start = index + 1;
    const matched = names.find((name) => body.startsWith(name, start));
    if (!matched) continue;
    hadMemberMention = true;
    const members = byName.get(matched) ?? [];
    const agents = members.filter((member) => member.kind === 'agent');
    if (agents.length > 1) {
      throw new BusinessError(
        'INVALID_ARGUMENT',
        '群内有多个同名 Agent，无法按 @ 名字唯一投递；请改名或显式使用 invoke',
      );
    }
    if (agents.length === 1 && agents[0]!.actor_id !== sender) {
      targets.add(agents[0]!.actor_id);
    }
    index = start + matched.length - 1;
  }
  return { invoke: [...targets], hadMemberMention };
}

interface AdjacentSenderRow {
  sender_id: string;
  kind: 'human' | 'agent' | null;
  status: 'active' | 'left' | 'removed' | null;
}

/**
 * 群聊 human 回复的自动投递目标：紧邻上一条普通消息的发送者。
 *
 * 只读 `messages`（按 `created_seq` 倒序），不依赖 delivery/outbox 事件；
 * 上一条消息的发送者必须仍是当前 active 的 Agent 成员，且不能是发送者本人。
 * 查询发生在新消息插入之前，因此拿到的是“上一条”而不是自己。
 */
async function resolveAdjacentAgentSender(
  db: D1Database,
  roomId: string,
  sender: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT msg.sender_id, a.kind, m.status
         FROM messages msg
         LEFT JOIN actors a ON a.actor_id = msg.sender_id
         LEFT JOIN room_members m
           ON m.room_id = msg.room_id AND m.actor_id = msg.sender_id
        WHERE msg.room_id = ?
        ORDER BY msg.created_seq DESC
        LIMIT 1`,
    )
    .bind(roomId)
    .first<AdjacentSenderRow>();
  if (!row || row.sender_id === sender) return null;
  if (row.kind !== 'agent' || row.status !== 'active') return null;
  return row.sender_id;
}

function assertInvoke(invoke: string[] | undefined, sender: string): string[] {
  const list = [...new Set(invoke ?? [])];
  if (list.length > LIMITS.invokeMax) {
    throw new BusinessError('INVALID_ARGUMENT', `单条消息最多指定 ${LIMITS.invokeMax} 个执行目标`);
  }
  if (list.includes(sender)) {
    throw new BusinessError('INVALID_ARGUMENT', '不能把消息发送者自己加入 invoke');
  }
  return list;
}

export interface SendResult {
  message: MessageView;
  delivery_ids: string[];
}

export async function messageSend(
  db: D1Database,
  principal: Principal,
  input: MessageSendInput,
): Promise<SendResult> {
  const sender = actorId(principal);
  const room = await getRoom(db, input.room_id);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, room.room_id, sender);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }

  const bodyBytes = utf8Bytes(input.body);
  if (bodyBytes > LIMITS.messageBodyBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', '消息正文超过 256 KiB，请拆分为关联消息', {
      body_bytes: bodyBytes,
    });
  }
  const mentionResolution =
    input.invoke === undefined && !input.claim && room.kind === 'group'
      ? await resolveGroupMentionInvoke(db, room.room_id, sender, input.body)
      : null;
  let resolvedInvoke = input.invoke;
  if (mentionResolution) {
    resolvedInvoke = mentionResolution.invoke;
    // 群聊 human 回复紧邻上一条 Agent 消息时自动投递；显式 @ 任意 active 成员
    // 都视为明确目标，不再补上一条 Agent。Agent 发送不改行为。
    if (principal.actor?.kind === 'human' && !mentionResolution.hadMemberMention) {
      const adjacentAgent = await resolveAdjacentAgentSender(db, room.room_id, sender);
      if (adjacentAgent) resolvedInvoke = [adjacentAgent];
    }
  }
  // 拉黑只静默定向通知（delivery），不改变群消息本体、正文 @ 或成员资格。
  const invoke = await filterMutedMentions(
    db,
    room.kind,
    sender,
    assertInvoke(resolvedInvoke, sender),
  );
  const link = await resolveRootLink(db, sender, room.room_id, input);

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
    clientMessageId: input.client_message_id,
    body: input.body,
    preview: truncateUtf8(input.body, LIMITS.previewBytes),
    bodyBytes,
    replyTo: link.replyTo,
    rootId: link.rootId,
    rootKey: link.rootKey || messageId,
    hop: link.hop,
    invoke,
    deliveries,
    eventKey,
    at,
  };

  const payloadHash = await sha256Hex(stableStringify(input));

  await runIdempotent(db, {
    actorId: sender,
    requestId: input.request_id,
    payloadHash,
    result: { message_id: messageId },
    build: (resultJson) => [
      operationsStatement(db, sender, input.request_id, payloadHash, resultJson, at),
      ...messageGuardStatements(db, core),
      ...messageCoreStatements(db, core),
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
      if (existing.room_id !== room.room_id || existing.body !== input.body) {
        throw new BusinessError('IDEMPOTENCY_CONFLICT', 'client_message_id 已用于不同的消息内容', {
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
async function messageSendResult(db: D1Database, row: MessageRow): Promise<SendResult> {
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
    rootKey: parent.root_id ?? parent.message_id,
    hop: parent.hop + 1,
    invoke: [],
    deliveries: [],
    eventKey: `message:${messageId}`,
    at: nowMs(),
  };
}

export async function historyList(
  db: D1Database,
  principal: Principal,
  input: HistoryListInput,
): Promise<MessagePage | TimelinePage> {
  const viewer = actorId(principal);
  const room = await getRoom(db, input.room_id);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, room.room_id, viewer);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }

  if (input.view === 'timeline') {
    if (principal.actor?.kind !== 'human') {
      throw new BusinessError('INVALID_ARGUMENT', 'timeline 视图仅对人类身份开放');
    }
    return timelineList(db, room, input);
  }

  const scope = `room:${room.room_id}:history`;
  const limit = clampPage(input.limit, LIMITS.historyPageDefault, LIMITS.historyPageMax);
  const cursor = input.cursor ? decodeCursor(input.cursor, scope) : null;
  const direction = input.direction ?? 'before';
  // 快照上界只用于向前翻旧页；after 是追新，必须允许超过首次查询时的 head。
  const snapshot = direction === 'after' ? room.head_seq : (cursor?.snapshot ?? room.head_seq);

  let rows: MessageRow[];
  if (direction === 'before') {
    const predicate = cursor ? 'AND created_seq < ?' : '';
    const binds: unknown[] = cursor ? [room.room_id, snapshot, cursor.seq, limit + 1] : [room.room_id, snapshot, limit + 1];
    const result = await db
      .prepare(
        `SELECT * FROM messages
          WHERE room_id = ? AND created_seq <= ? ${predicate}
          ORDER BY created_seq DESC LIMIT ?`,
      )
      .bind(...binds)
      .all<MessageRow>();
    rows = result.results;
  } else {
    const start = cursor?.seq ?? snapshot;
    const result = await db
      .prepare(
        `SELECT * FROM messages
          WHERE room_id = ? AND created_seq <= ? AND created_seq > ?
          ORDER BY created_seq ASC LIMIT ?`,
      )
      .bind(room.room_id, snapshot, start, limit + 1)
      .all<MessageRow>();
    rows = result.results;
  }

  const page = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const last = page.at(-1);
  const states = await deliveryStatesFor(
    db,
    page.map((row) => row.message_id),
  );
  // 一次 IN 查询取权威 kind，避免网页依赖成员列表或在成员被移出后丢失 AI 属性。
  const senderIds = [...new Set(page.map((row) => row.sender_id))];
  const senders = await getActorsByIds(db, senderIds);
  const senderKinds = new Map(senders.map((actor) => [actor.actor_id, actor.kind]));

  const items = page.map((row) => {
    const summary = states.get(row.message_id);
    return {
      message_id: row.message_id,
      room_id: row.room_id,
      sender_id: row.sender_id,
      sender_kind: senderKinds.get(row.sender_id) ?? null,
      created_seq: String(row.created_seq),
      preview: row.preview,
      body_bytes: row.body_bytes,
      created_at: String(row.created_at),
      reply_to: row.reply_to,
      root_id: row.root_id,
      hop: row.hop,
      delivery_states: summary?.states ?? {},
      delivery_claimed_at: nullableString(summary?.claimedAt ?? null),
      delivery_updated_at: nullableString(summary?.updatedAt ?? null),
    };
  });

  return {
    items,
    next_cursor:
      hasMore && last
        ? encodeCursor({
            v: 1,
            scope,
            dir: direction,
            seq: last.created_seq,
            snapshot,
          })
        : direction === 'after'
          ? encodeCursor({
              v: 1,
              scope,
              dir: direction,
              seq: cursor?.seq ?? snapshot,
              snapshot,
            })
          : null,
    has_more: hasMore,
    snapshot: String(snapshot),
    head_seq: String(room.head_seq),
  };
}

export interface ReadChunk {
  message_id: string;
  room_id: string;
  chunk: string;
  chunk_cursor: string;
  next_cursor: string | null;
  eof: boolean;
  body_bytes: number;
  created_seq: string;
}

export async function messageRead(
  db: D1Database,
  principal: Principal,
  input: MessageReadInput,
): Promise<ReadChunk> {
  const viewer = actorId(principal);
  const message = await getMessage(db, input.message_id);
  if (!message) throw new BusinessError('NOT_FOUND', '消息不存在');
  const member = await getMember(db, message.room_id, viewer);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }

  let offset = 0;
  if (input.chunk_cursor) {
    if (!/^\d{1,12}$/u.test(input.chunk_cursor)) {
      throw new BusinessError('INVALID_ARGUMENT', 'chunk_cursor 必须是字节偏移');
    }
    offset = Number(input.chunk_cursor);
  }
  if (offset > message.body_bytes) {
    throw new BusinessError('INVALID_ARGUMENT', 'chunk_cursor 超出正文长度');
  }
  const chunk = sliceUtf8Chunk(message.body, offset, LIMITS.bodyChunkBytes);
  const eof = chunk.next >= chunk.total;
  return {
    message_id: message.message_id,
    room_id: message.room_id,
    chunk: chunk.text,
    chunk_cursor: String(offset),
    next_cursor: eof ? null : String(chunk.next),
    eof,
    body_bytes: message.body_bytes,
    created_seq: String(message.created_seq),
  };
}

export async function roomMarkRead(
  db: D1Database,
  principal: Principal,
  input: RoomMarkReadInput,
): Promise<{ room_id: string; last_read_seq: string }> {
  const viewer = actorId(principal);
  const through = Number(input.through_seq);
  if (!Number.isSafeInteger(through) || through < 0) {
    throw new BusinessError('INVALID_ARGUMENT', 'through_seq 必须是非负整数');
  }
  const room = await getRoom(db, input.room_id);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');

  const at = nowMs();
  const eventKey = newId('room_read');
  await db.batch([
    db
      .prepare(
        guardSql(
          'notMember',
          "NOT EXISTS (SELECT 1 FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active')",
        ),
      )
      .bind(room.room_id, viewer),
    db
      .prepare(
        `INSERT INTO events (scope_kind, scope_id, event_type, ref_id, metadata, event_key, created_at)
         SELECT 'inbox', ?, 'room_read', ?, ?, ?, ?
           FROM room_members m JOIN rooms r ON r.room_id = m.room_id
          WHERE m.room_id = ? AND m.actor_id = ? AND m.status = 'active'
            AND m.last_read_seq < MIN(?, r.head_seq)`,
      )
      .bind(
        viewer,
        room.room_id,
        JSON.stringify({ room_id: room.room_id }),
        eventKey,
        at,
        room.room_id,
        viewer,
        through,
      ),
    db
      .prepare(
        `UPDATE room_members
            SET last_read_seq = MIN(?, (SELECT head_seq FROM rooms WHERE room_id = ?))
          WHERE room_id = ? AND actor_id = ? AND status = 'active'
            AND EXISTS (SELECT 1 FROM events WHERE event_key = ?)`,
      )
      .bind(through, room.room_id, room.room_id, viewer, eventKey),
    db
      .prepare(
        `INSERT INTO outbox (outbox_id, topic, event_seq, status, attempts, next_attempt_at, created_at)
         SELECT ?, ?, event_seq, 'pending', 0, ?, ? FROM events WHERE event_key = ?`,
      )
      .bind(newId('obx'), inboxTopic(viewer), at, at, eventKey),
    inboxHeadStatementIfEvent(db, viewer, eventKey, at, 0),
  ]);

  const member = await getMember(db, room.room_id, viewer);
  return { room_id: room.room_id, last_read_seq: String(member?.last_read_seq ?? 0) };
}
