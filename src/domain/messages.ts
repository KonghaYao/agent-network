import { BusinessError } from '../contracts/errors';
import { MENTION_REMINDER_EVENT } from '../contracts/events';
import { decodeCursor, encodeCursor } from '../contracts/cursor';
import { clampPage, LIMITS } from '../contracts/limits';
import type {
  HistoryListInput,
  MessageReadInput,
  MessageSendInput,
  MessageSendStatusInput,
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
  mentionsFor,
  nullableString,
  summarizeDeliveryStates,
  type DeliveryStateRow,
  type MentionSource,
  type MentionView,
} from './message-view-helpers';
import {
  isMessageConflict,
  operationsStatement,
  runIdempotent,
} from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';
import { assertRoomWritable, capabilityGuardStatement, roomDissolvedGuardStatement } from './room-access';
import type { MessagePreviewView } from './rooms';
import {
  decodeHistoryCursor,
  historyBoundary,
  historyCursorScope,
  historySnapshot,
  visibleMessage,
  type HistoryBoundary,
  type HistorySnapshot,
} from './room-history';
import { timelineList, type TimelinePage } from './timeline';

export interface MessageView extends MessagePreviewView {
  room_id: string;
  reply_to: string | null;
  root_id: string | null;
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
    replyTo = replied.message_id;
    if (!parent) parent = replied;
  }
  if (parent && !visibleMessage(parent, boundary)) {
    throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
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

interface GroupTextResolution {
  /** 正文唯一精确匹配到的 active Agent（不含发送者）。 */
  agents: string[];
  /** 正文唯一精确匹配到的 active 人类成员（不含发送者）。 */
  humans: string[];
  /** 正文顶层出现 `@所有人`。 */
  mentionAll: boolean;
  /** 房间当前 active 人类成员；`@所有人` 的提醒范围。 */
  allHumans: string[];
}

/**
 * 只保留可以参与派活解析的正文。
 *
 * Markdown 围栏/行内代码、引用行（含粘贴的聊天记录）与附件 URL 都只是
 * 展示内容，不是新的指令；替换为空白后，服务端再按 active 成员名做精确、
 * 大小写敏感、最长优先的匹配。未闭合的围栏视为延伸到正文末尾。
 */
export function instructionText(body: string): string {
  const lines = body.split('\n');
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const match = line.match(/^\s{0,3}(`{3,}|~{3,})/u);
    if (fence) {
      if (match && match[1]!.startsWith(fence[0]!)) fence = null;
      kept.push('');
      continue;
    }
    if (match) {
      fence = match[1]!;
      kept.push('');
      continue;
    }
    if (/^\s{0,3}>/u.test(line)) {
      kept.push('');
      continue;
    }
    kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/(`+)([\s\S]*?)\1/gu, ' ')
    .replace(/https?:\/\/[^\s<>()]+/gu, ' ');
}

/**
 * 群聊省略 `invoke` 时的正文提及解析。
 *
 * 只在正文顶层（去掉代码、引用与 URL 后）按 active 成员名做精确、大小写
 * 敏感、最长优先匹配。同名成员必须由选择器或显式 `invoke`/`mentions`
 * 消歧；正文只做便利兜底，不能猜。`collectTargets=false` 时只检测
 * `@所有人` 控制符，用于显式 invoke 的消息仍允许群级提醒。
 */

/** `@` 前一个字符若是邮箱本地部分或单词字符，就不是独立提及。 */
const MENTION_PREV_BLOCKED = /[\p{L}\p{N}_.%+\-]/u;
/** 名字后紧跟字母、数字或下划线时仍属于同一个词，不是完整提及。 */
const MENTION_WORD_CHAR = /[\p{L}\p{N}_]/u;

function mentionStartsAt(text: string, at: number): boolean {
  return at === 0 || !MENTION_PREV_BLOCKED.test(text[at - 1]!);
}

function mentionEndsAt(text: string, end: number): boolean {
  return end >= text.length || !MENTION_WORD_CHAR.test(text[end]!);
}

async function resolveGroupTextMentions(
  db: D1Database,
  roomId: string,
  sender: string,
  body: string,
  collectTargets: boolean,
): Promise<GroupTextResolution> {
  const text = instructionText(body);
  if (!text.includes('@')) {
    return { agents: [], humans: [], mentionAll: false, allHumans: [] };
  }
  const rows = await db
    .prepare(
      `SELECT m.actor_id, a.kind, a.name
         FROM room_members m JOIN actors a ON a.actor_id = m.actor_id
        WHERE m.room_id = ? AND m.status = 'active'`,
    )
    .bind(roomId)
    .all<MentionMember>();

  const allHumans = rows.results
    .filter((row) => row.kind === 'human' && row.actor_id !== sender)
    .map((row) => row.actor_id);

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

  const agents = new Set<string>();
  const humans = new Set<string>();
  let mentionAll = false;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@') continue;
    // `foo@Bot.com` 之类的邮箱地址不是提及；`@` 必须是独立 token 的开头。
    if (!mentionStartsAt(text, index)) continue;
    const start = index + 1;
    // 优先识别更长的成员名（例如“所有人2”）；否则 `@所有人` 是保留控制符，
    // 不会因为存在名为“所有”的成员而被当成普通前缀匹配。
    const longerAllMember = names.some(
      (name) =>
        name.length > '所有人'.length &&
        name.startsWith('所有人') &&
        text.startsWith(name, start) &&
        mentionEndsAt(text, start + name.length),
    );
    if (
      !longerAllMember &&
      text.startsWith('所有人', start) &&
      mentionEndsAt(text, start + '所有人'.length)
    ) {
      mentionAll = true;
      index = start + '所有人'.length - 1;
      continue;
    }
    const matched = names.find(
      (name) => text.startsWith(name, start) && mentionEndsAt(text, start + name.length),
    );
    if (!matched) continue;
    const members = byName.get(matched) ?? [];
    if (collectTargets && members.length > 1) {
      throw new BusinessError(
        'INVALID_ARGUMENT',
        '群内有多个同名成员，无法按 @ 名字唯一确定目标；请从成员选择器选择或显式使用 invoke/mentions',
      );
    }
    if (collectTargets && members.length === 1) {
      const member = members[0]!;
      if (member.actor_id !== sender) {
        if (member.kind === 'agent') agents.add(member.actor_id);
        else humans.add(member.actor_id);
      }
    }
    index = start + matched.length - 1;
  }
  return { agents: [...agents], humans: [...humans], mentionAll, allHumans };
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

/** 显式 mentions 只接受人类成员；Agent 派活必须走 invoke。 */
function assertMentions(mentions: string[] | undefined, sender: string): string[] {
  const list = [...new Set(mentions ?? [])];
  if (list.length > LIMITS.invokeMax) {
    throw new BusinessError('INVALID_ARGUMENT', `单条消息最多指定 ${LIMITS.invokeMax} 个提醒对象`);
  }
  if (list.includes(sender)) {
    throw new BusinessError('INVALID_ARGUMENT', '不能把消息发送者自己加入 mentions');
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
  assertRoomWritable(room);
  const boundary = historyBoundary(room, member);

  const bodyBytes = utf8Bytes(input.body);
  if (bodyBytes > LIMITS.messageBodyBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', '消息正文超过 256 KiB，请拆分为关联消息', {
      body_bytes: bodyBytes,
    });
  }
  // 正文解析只在群聊、未显式给 invoke 且不是 claim 回复时参与派活。
  // 显式 invoke 仍识别 `@所有人` 控制符，但不从正文追加 Agent 目标。
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
    clientMessageId: input.client_message_id,
    body: input.body,
    preview: truncateUtf8(input.body, LIMITS.previewBytes),
    bodyBytes,
    replyTo: link.replyTo,
    rootId: link.rootId,
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

export interface MessageSendStatusItem {
  client_message_id: string;
  found: boolean;
  message_id: string | null;
  room_id: string | null;
  created_seq: string | null;
  delivery_ids: string[];
  body_bytes: number | null;
  created_at: string | null;
}

interface MessageSendStatusRow {
  message_id: string;
  room_id: string;
  client_message_id: string;
  created_seq: number;
  body_bytes: number;
  created_at: number;
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
      `SELECT message_id, room_id, client_message_id, created_seq, body_bytes, created_at
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
    mentionAll: false,
    mentions: [],
    reminders: [],
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
  // 本次请求只使用这一份授权快照：即使策略在查询期间变化，列表、游标与
  // 返回的 authorization 仍按同一代次/边界解释；下一次请求重新计算。
  const boundary = historyBoundary(room, member);
  const authorization = historySnapshot(boundary);

  if (input.view === 'timeline') {
    if (principal.actor?.kind !== 'human') {
      throw new BusinessError('INVALID_ARGUMENT', 'timeline 视图仅对人类身份开放');
    }
    return timelineList(db, room, input, boundary);
  }

  const scope = historyCursorScope('history', room.room_id, boundary.memberGeneration);
  const limit = clampPage(input.limit, LIMITS.historyPageDefault, LIMITS.historyPageMax);
  const cursor = input.cursor
    ? decodeHistoryCursor(input.cursor, scope, room.room_id)
    : null;
  const direction = input.direction ?? 'before';
  // 解散归档固定读取上界；after 追新也不能越过 archived_head_seq。
  const readHead =
    boundary.toSeq === null ? room.head_seq : Math.min(room.head_seq, boundary.toSeq);
  // 快照上界只用于向前翻旧页；after 是追新，必须允许超过首次查询时的 head。
  const snapshot =
    direction === 'after'
      ? readHead
      : Math.max(boundary.fromSeq, cursor?.snapshot ?? readHead);

  let rows: MessageRow[];
  if (direction === 'before') {
    const predicate = cursor ? 'AND created_seq < ?' : '';
    const binds: unknown[] = cursor
      ? [room.room_id, snapshot, boundary.fromSeq, cursor.seq, limit + 1]
      : [room.room_id, snapshot, boundary.fromSeq, limit + 1];
    const result = await db
      .prepare(
        `SELECT * FROM messages
          WHERE room_id = ? AND created_seq <= ? AND created_seq >= ? ${predicate}
          ORDER BY created_seq DESC LIMIT ?`,
      )
      .bind(...binds)
      .all<MessageRow>();
    rows = result.results;
  } else {
    const start = Math.max(boundary.fromSeq, cursor?.seq ?? snapshot);
    const result = await db
      .prepare(
        `SELECT * FROM messages
          WHERE room_id = ? AND created_seq <= ? AND created_seq > ? AND created_seq >= ?
          ORDER BY created_seq ASC LIMIT ?`,
      )
      .bind(room.room_id, snapshot, start, boundary.fromSeq, limit + 1)
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
  const mentions = await mentionsFor(
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
      mentions: mentions.get(row.message_id) ?? [],
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
    authorization,
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
  const room = await getRoom(db, message.room_id);
  if (!room) throw new BusinessError('NOT_FOUND', '消息不存在');
  if (!visibleMessage(message, historyBoundary(room, member))) {
    // 按 ID 直读与列表共用同一可见性；不区分“不存在”和“加入前”，避免探测。
    throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
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
  const current = await getMember(db, room.room_id, viewer);
  if (!current || current.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  // 加入前的内容不属于当前代次，阅读水位不能低于本次加入边界。
  const floor = historyBoundary(room, current).fromSeq;
  const clampThrough = Math.max(through, floor);

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
        clampThrough,
      ),
    db
      .prepare(
        `UPDATE room_members
            SET last_read_seq = MAX(last_read_seq, MIN(?, (SELECT head_seq FROM rooms WHERE room_id = ?)))
          WHERE room_id = ? AND actor_id = ? AND status = 'active'
            AND EXISTS (SELECT 1 FROM events WHERE event_key = ?)`,
      )
      .bind(clampThrough, room.room_id, room.room_id, viewer, eventKey),
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
