/** messages.ts 拆分模块：mentions。纯移动，行为保持不变。 */

import { BusinessError } from '../../contracts/errors';
import { LIMITS } from '../../contracts/limits';
import { type MessageSendInput } from '../../contracts/schemas';
import { utf8Bytes } from '../../storage/db';
import { actorId } from '../principal';
import { type HistoryBoundary } from '../room-history';

export interface MentionMember {
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
}

export interface GroupTextResolution {
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
export const MENTION_PREV_BLOCKED = /[\p{L}\p{N}_.%+\-]/u;
/** 名字后紧跟字母、数字或下划线时仍属于同一个词，不是完整提及。 */
export const MENTION_WORD_CHAR = /[\p{L}\p{N}_]/u;

export function mentionStartsAt(text: string, at: number): boolean {
  return at === 0 || !MENTION_PREV_BLOCKED.test(text[at - 1]!);
}

export function mentionEndsAt(text: string, end: number): boolean {
  return end >= text.length || !MENTION_WORD_CHAR.test(text[end]!);
}

export async function resolveGroupTextMentions(
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

export function assertInvoke(invoke: string[] | undefined, sender: string): string[] {
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
export function assertMentions(mentions: string[] | undefined, sender: string): string[] {
  const list = [...new Set(mentions ?? [])];
  if (list.length > LIMITS.invokeMax) {
    throw new BusinessError('INVALID_ARGUMENT', `单条消息最多指定 ${LIMITS.invokeMax} 个提醒对象`);
  }
  if (list.includes(sender)) {
    throw new BusinessError('INVALID_ARGUMENT', '不能把消息发送者自己加入 mentions');
  }
  return list;
}

/** 自动 @ 向前扫描的最近消息条数；只为找到一条不同发送者的有效消息。 */
export const AUTO_MENTION_SCAN_MAX = 20;

export interface AutoMentionCandidateRow {
  message_id: string;
  sender_id: string;
  created_seq: number;
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
  member_status: 'active' | 'left' | 'removed' | null;
}

export interface AgentAutoMention {
  body: string;
  target: { actorId: string; kind: 'human' | 'agent' };
}

/** 正文是否已经包含独立的 `@名字`；邮箱或更长的名字不算。 */
export function containsMentionToken(text: string, name: string): boolean {
  const token = `@${name}`;
  let from = 0;
  while (from <= text.length - token.length) {
    const at = text.indexOf(token, from);
    if (at < 0) return false;
    if (mentionStartsAt(text, at) && mentionEndsAt(text, at + token.length)) return true;
    from = at + 1;
  }
  return false;
}

/**
 * Agent 群消息的自动 @ 计划。
 *
 * 只在发送者显式省略 `invoke`、没有非空 `mentions` 时触发；目标为当前消息
 * 之前最近一条不同 actor、仍 active 且按发送者历史边界可见的消息发送者。
 * 名字必须在当前 active 成员中唯一；重名、目标已退出或追加后超过正文上限
 * 都跳过。自动 @ 只用于显示与人类提醒，绝不进入 invoke。
 */
export async function agentAutoMentionPlan(
  db: D1Database,
  roomKind: 'direct' | 'group',
  roomId: string,
  headSeq: number,
  boundary: HistoryBoundary,
  senderId: string,
  senderKind: 'human' | 'agent',
  input: Pick<MessageSendInput, 'body' | 'invoke' | 'mentions'>,
  beforeSeq?: number,
): Promise<AgentAutoMention | null> {
  if (roomKind !== 'group' || senderKind !== 'agent') return null;
  if (input.invoke !== undefined) return null;
  if (input.mentions !== undefined && input.mentions.length > 0) return null;
  if (input.body.trim().length === 0) return null;
  // 新消息在 room.head_seq 之后插入；幂等冲突重算时只看原消息之前的历史。
  const upperExclusive =
    beforeSeq ??
    (boundary.toSeq === null ? headSeq + 1 : Math.min(headSeq, boundary.toSeq) + 1);
  const rows = await db
    .prepare(
      `SELECT m.message_id, m.sender_id, m.created_seq,
              a.name AS sender_name, a.kind AS sender_kind,
              rm.status AS member_status
         FROM messages m
         LEFT JOIN actors a ON a.actor_id = m.sender_id
         LEFT JOIN room_members rm
           ON rm.room_id = m.room_id AND rm.actor_id = m.sender_id
        WHERE m.room_id = ? AND m.created_seq >= ? AND m.created_seq < ?
        ORDER BY m.created_seq DESC
        LIMIT ?`,
    )
    .bind(roomId, boundary.fromSeq, upperExclusive, AUTO_MENTION_SCAN_MAX)
    .all<AutoMentionCandidateRow>();

  let candidate: AutoMentionCandidateRow | null = null;
  for (const row of rows.results) {
    if (row.sender_id === senderId) continue;
    if (!row.sender_name || !row.sender_kind) continue;
    if (row.member_status !== 'active') continue;
    candidate = row;
    break;
  }
  if (!candidate || !candidate.sender_name || !candidate.sender_kind) return null;

  const unique = await db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM room_members m JOIN actors a ON a.actor_id = m.actor_id
        WHERE m.room_id = ? AND m.status = 'active' AND a.name = ?`,
    )
    .bind(roomId, candidate.sender_name)
    .first<{ n: number }>();
  if (!unique || unique.n !== 1) return null;

  const token = `@${candidate.sender_name}`;
  if (containsMentionToken(input.body, candidate.sender_name)) {
    return {
      body: input.body,
      target: { actorId: candidate.sender_id, kind: candidate.sender_kind },
    };
  }
  const body = `${input.body}\n${token}`;
  if (utf8Bytes(body) > LIMITS.messageBodyBytes) return null;
  return {
    body,
    target: { actorId: candidate.sender_id, kind: candidate.sender_kind },
  };
}

