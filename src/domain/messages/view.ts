/** messages.ts 拆分模块：view。纯移动，行为保持不变。 */

import { BusinessError } from '../../contracts/errors';
import { MENTION_REMINDER_EVENT } from '../../contracts/events';
import { LIMITS } from '../../contracts/limits';
import { type MessageSendInput } from '../../contracts/schemas';
import { eventStatement, inboxHeadStatement, inboxTopic, outboxStatement, roomHeadStatement, roomTopic } from '../../storage/events';
import { guardSql } from '../../storage/guards';
import { getClaimedDelivery, getDelivery, getMessage } from '../../storage/queries';
import { type MessageRow } from '../../storage/rows';
import { directBlockGuardStatement } from '../contact-blocks';
import { directMessageGuardStatement } from '../contact-relations';
import { mentionsFor, nullableString, summarizeDeliveryStates, type DeliveryStateRow, type MentionSource, type MentionView } from '../message-view-helpers';
import { actorId } from '../principal';
import { capabilityGuardStatement, roomDissolvedGuardStatement } from '../room-access';
import { visibleMessage, type HistoryBoundary, type HistorySnapshot } from '../room-history';
import { type MessagePreviewView } from '../rooms';

export interface MessageView extends MessagePreviewView {
  room_id: string;
  reply_to: string | null;
  root_id: string | null;
  /** 消息式 Task 归属；普通消息为 null，起点为自身 message_id。 */
  task_root_id: string | null;
  hop: number;
  delivery_states: Record<string, number>;
  /** 该消息的提及集合；human 只产生个人提醒，agent 才可能有 delivery。 */
  mentions: MentionView[];
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
  /** 本次读取采用的授权快照；与房间、文件、任务读取使用同一计算入口。 */
  authorization: HistorySnapshot;
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

/** 持久化到 `message_mentions` 的提及；同一消息内按 actor 去重。 */
export interface MentionSeed {
  actorId: string;
  kind: 'human' | 'agent';
  source: MentionSource;
}

/** human 提及对应的 inbox 个人提醒；不创建 delivery、不增加 pending_count。 */
export interface MentionReminderSeed {
  actorId: string;
  source: MentionSource;
  mentionAll: boolean;
}

export interface MessageCore {
  messageId: string;
  roomId: string;
  senderId: string;
  /** 发送者展示身份；只进入 delivery_created 的 stream metadata，省略为 null。 */
  senderName?: string | null;
  senderKind?: 'human' | 'agent' | null;
  clientMessageId: string;
  body: string;
  preview: string;
  bodyBytes: number;
  replyTo: string | null;
  rootId: string | null;
  /** 消息式 Task 归属；省略时按普通消息写入 NULL。 */
  taskRootId?: string | null;
  /** 用于 root 预算统计的根消息 ID。 */
  rootKey: string;
  hop: number;
  invoke: string[];
  /** 正文包含 `@所有人`；受群策略能力约束，只发提醒，不创建批量投递。 */
  mentionAll: boolean;
  /** 全部提及（显式选择 + 正文解析 + @所有人）。 */
  mentions: MentionSeed[];
  /** human 的个人提醒；与 mentions 中的 human 一一对应。 */
  reminders: MentionReminderSeed[];
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
  const mentions = await mentionsFor(db, [row.message_id]);
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
    task_root_id: row.task_root_id,
    hop: row.hop,
    delivery_states: summary.states,
    mentions: mentions.get(row.message_id) ?? [],
    delivery_claimed_at: nullableString(summary.claimedAt),
    delivery_updated_at: nullableString(summary.updatedAt),
  };
}

/** 深度、root 派发预算、成员资格、目标有效性与队列上限的同一事务校验。 */
export function messageGuardStatements(
  db: D1Database,
  core: Pick<
    MessageCore,
    'roomId' | 'senderId' | 'hop' | 'rootKey' | 'invoke' | 'mentions' | 'mentionAll' | 'at'
  >,
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
    // 解散后归档只读；预检查之外的提交时复核，避免先读后写窗口。
    roomDissolvedGuardStatement(db, core.roomId),
  ];
  // @所有人 只发提醒，不批量创建 delivery；权限在事务内与发送同一闸门复核。
  if (core.mentionAll) {
    statements.push(capabilityGuardStatement(db, core.roomId, core.senderId, 'mention_all'));
  }

  // 显式 mentions 必须在发送事务内复核：Web 选择器可能持有过期成员列表。
  // 正文解析与 @所有人 的提醒范围来自同一事务前的 active 成员查询，属于提示性
  // 写入；成员并发移除时最多留下一条不会被读取的历史提醒，不阻断群消息。
  for (const mention of core.mentions) {
    if (mention.source !== 'explicit' || mention.kind !== 'human') continue;
    statements.push(
      db
        .prepare(
          guardSql(
            'invalidMention',
            `NOT EXISTS (
               SELECT 1 FROM room_members m JOIN actors a ON a.actor_id = m.actor_id
                WHERE m.room_id = ? AND m.actor_id = ? AND m.status = 'active' AND a.kind = 'human'
             )`,
          ),
        )
        .bind(core.roomId, mention.actorId),
    );
  }

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
        metadata: {
          sender_id: core.senderId,
          deliveries: core.deliveries.length,
          task_root_id: core.taskRootId ?? null,
        },
      },
      core.at,
    ),
    db
      .prepare(
        `INSERT INTO messages
           (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes, preview,
            reply_to, root_id, task_root_id, hop, root_invocations_used, created_at)
         VALUES (?, ?, ?, ?, (SELECT event_seq FROM events WHERE event_key = ?), ?, ?, ?, ?, ?, ?, ?,
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
        core.taskRootId ?? null,
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
    ...core.mentions.map((mention) =>
      db
        .prepare(
          `INSERT INTO message_mentions (message_id, actor_id, actor_kind, source, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(core.messageId, mention.actorId, mention.kind, mention.source, core.at),
    ),
    // human 提醒是 inbox 事件而非 delivery：不增加 pending_count、不推进房间
    // head，也不写入 room scope；@所有人 与普通 human 提及共用同一事件类型。
    ...core.reminders.flatMap((reminder) => {
      const inboxKey = `mention_reminder:${core.messageId}:${reminder.actorId}`;
      return [
        eventStatement(
          db,
          {
            eventKey: inboxKey,
            scopeKind: 'inbox',
            scopeId: reminder.actorId,
            eventType: MENTION_REMINDER_EVENT,
            refId: core.messageId,
            metadata: {
              message_id: core.messageId,
              room_id: core.roomId,
              sender_id: core.senderId,
              source: reminder.source,
              mention_all: reminder.mentionAll,
            },
          },
          core.at,
        ),
        outboxStatement(db, { topic: inboxTopic(reminder.actorId), eventKey: inboxKey }, core.at),
        inboxHeadStatement(db, reminder.actorId, inboxKey, core.at, 0),
      ];
    }),
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
            sender_name: core.senderName ?? null,
            sender_kind: core.senderKind ?? null,
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

export interface RootLink {
  replyTo: string | null;
  rootId: string | null;
  taskRootId: string | null;
  rootKey: string;
  hop: number;
  parent: MessageRow | null;
}

/** 读取当前可见、仍在标记中的任务起点；不可见与未标记按同一结果处理。 */
export async function visibleMarkedTaskRoot(
  db: D1Database,
  roomId: string,
  rootId: string,
  boundary: HistoryBoundary,
): Promise<MessageRow | null> {
  const root = await getMessage(db, rootId);
  if (
    !root ||
    root.room_id !== roomId ||
    root.task_root_id !== root.message_id ||
    !visibleMessage(root, boundary)
  ) {
    return null;
  }
  return root;
}

/** 父消息归属的继承：显式归属优先，其次沿用父消息的 Task，最后由线程根回退。 */
export async function inheritedTaskRoot(
  db: D1Database,
  roomId: string,
  parent: MessageRow,
  boundary: HistoryBoundary,
): Promise<string | null> {
  if (parent.task_root_id) return parent.task_root_id;
  if (!parent.root_id) return null;
  const root = await visibleMarkedTaskRoot(db, roomId, parent.root_id, boundary);
  return root?.message_id ?? null;
}

export async function resolveRootLink(
  db: D1Database,
  sender: string,
  roomId: string,
  input: MessageSendInput,
  boundary: HistoryBoundary,
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
    if (!replied || replied.room_id !== roomId || !visibleMessage(replied, boundary)) {
      // 不区分“不存在”和“在加入前/策略外”，避免按 ID 探测历史内容。
      throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
    }
    if (replied.body === '') throw new BusinessError('INVALID_ARGUMENT', '不能回复已撤回的消息');
    replyTo = replied.message_id;
    if (!parent) parent = replied;
  }
  if (parent && !visibleMessage(parent, boundary)) {
    throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
  }
  if (parent && parent.body === '') throw new BusinessError('INVALID_ARGUMENT', '不能回复已撤回的消息');

  let taskRootId: string | null = null;
  if (input.task_root_id !== undefined) {
    // 显式归属必须指向同房间、当前可见、未撤回且仍在标记中的起点；
    // 不区分“未标记”和“不存在”，避免按 ID 探测历史。
    const root = await visibleMarkedTaskRoot(db, roomId, input.task_root_id, boundary);
    if (!root || root.body_bytes === 0) {
      throw new BusinessError('NOT_FOUND', '任务起点不存在、未标记或当前不可见');
    }
    taskRootId = root.message_id;
  } else if (parent) {
    taskRootId = await inheritedTaskRoot(db, roomId, parent, boundary);
  }

  if (!parent) {
    return { replyTo, rootId: null, taskRootId, rootKey: '', hop: 0, parent: null };
  }
  return {
    replyTo,
    rootId: parent.root_id ?? parent.message_id,
    taskRootId,
    rootKey: parent.root_id ?? parent.message_id,
    hop: parent.hop + 1,
    parent,
  };
}

