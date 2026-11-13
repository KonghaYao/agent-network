import type { MentionSelection, RoomMember } from './chat';

export interface MentionQuery {
  /** `@` 的绝对位置。 */
  start: number;
  /** 光标位置（不含空白查询的结束位置）。 */
  end: number;
  query: string;
}

const MENTION_QUERY = /@([^\s@]*)$/u;
export const MENTION_LIMIT = 20;

/**
 * 从光标前的正文解析 `@查询`。
 *
 * 只处理光标前最后一个 `@`；群聊之外是否启用由调用方决定。正文其余
 * 部分保持原样，插入后仍带一个尾随空格，交给 `buildSendPlan` 判断目标
 * 是否还在正文里。
 */
export function findMentionQuery(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, Math.max(0, caret));
  const match = MENTION_QUERY.exec(before);
  if (!match) return null;
  const query = match[1] ?? '';
  return {
    start: caret - query.length - 1,
    end: caret,
    query,
  };
}

/** 成员候选：排除自己，按名称包含过滤，保持房间成员顺序。 */
export function mentionCandidates(
  members: Map<string, RoomMember>,
  selfId: string,
  query: string,
  limit = MENTION_LIMIT,
): RoomMember[] {
  const lower = query.toLowerCase();
  const items: RoomMember[] = [];
  for (const member of members.values()) {
    if (member.actor_id === selfId) continue;
    if (lower && !member.name.toLowerCase().includes(lower)) continue;
    items.push(member);
    if (items.length >= limit) break;
  }
  return items;
}

export interface MentionInsertion {
  text: string;
  caret: number;
  selection: MentionSelection;
}

/** 用 `@name ` 替换触发查询，并返回新的选择映射。 */
export function insertMention(
  text: string,
  query: MentionQuery,
  member: RoomMember,
): MentionInsertion {
  const next = `${text.slice(0, query.start)}@${member.name} ${text.slice(query.end)}`;
  return {
    text: next,
    caret: query.start + member.name.length + 2,
    selection: { actor_id: member.actor_id, name: member.name, kind: member.kind },
  };
}

/** 同名选择以 actor_id 去重，后选的成员覆盖旧条目。 */
export function upsertSelection(
  selections: MentionSelection[],
  selection: MentionSelection,
): MentionSelection[] {
  const next = selections.filter((item) => item.actor_id !== selection.actor_id);
  next.push(selection);
  return next;
}

/** 正文变化后丢弃已经不存在的选择，避免把旧目标带进 invoke。 */
export function pruneSelections(
  selections: MentionSelection[],
  text: string,
  members: Map<string, RoomMember>,
): MentionSelection[] {
  return selections.filter((selection) => {
    const member = members.get(selection.actor_id);
    return Boolean(member && text.includes(`@${member.name}`));
  });
}
