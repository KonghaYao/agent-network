import type { HistoryItem, MentionSelection, RoomMember } from '../../lib/chat';
import type { TaskListItemView } from './types';

/**
 * 「询问进度」的目标解析与草稿文案。
 *
 * 只使用 Task 列表项与已加载历史，不额外调用工具：
 * - 根消息在已加载历史里时复原它原有的 mention（含 human/agent，保持服务端顺序）；
 * - 根消息不在已加载窗口时忽略 mentions，回退到最近参与的 Agent；
 * - 根 mentions 没有 Agent 时追加回退 Agent，保证「询问进度」仍触达 Agent；
 * - 回退顺序：recent_messages 最近一条 Agent → 根消息发送者（Agent）→ participants。
 *
 * 复原不截断 mention；超过 `LIMITS.invokeMax` 时由 composer 现有发送校验报错。
 */

export const TASK_ASK_PROGRESS_TEXT = '这个 task 现在进度如何？';

export interface TaskAskMention {
  actor_id: string;
  name: string;
  kind: 'human' | 'agent';
}

export interface TaskAskPlan {
  /** 根消息原有 mention 中能按当前成员表解析出的目标，保持服务端顺序。 */
  mentions: TaskAskMention[];
  /** 根 mentions 没有 Agent 时追加、或完全无 mentions 时使用的回退 Agent。 */
  agent: TaskAskMention | null;
}

function trimmedName(value: string | null | undefined): string | null {
  const name = value?.trim();
  return name ? name : null;
}

function findRoot(items: HistoryItem[], rootId: string) {
  for (const item of items) {
    if (item.kind === 'presence') continue;
    if (item.message_id === rootId) return item;
  }
  return null;
}

function agentMention(
  actorId: string,
  name: string | null | undefined,
  selfId: string | null,
  members: Map<string, RoomMember>,
): TaskAskMention | null {
  if (selfId && actorId === selfId) return null;
  // 已离开房间的 Agent 无法作为可发送的 @ 目标；继续尝试次近的参与者。
  const member = members.get(actorId);
  if (!member || member.kind !== 'agent') return null;
  const resolved = trimmedName(member.name) ?? trimmedName(name);
  if (!resolved) return null;
  return { actor_id: actorId, name: resolved, kind: 'agent' };
}

/** 没有根 mention 时的回退目标：最近参与且仍是 active 成员的 Agent，排除自己。 */
export function resolveTaskAskAgent(
  item: TaskListItemView,
  selfId: string | null,
  members: Map<string, RoomMember>,
): TaskAskMention | null {
  for (let index = item.recent_messages.length - 1; index >= 0; index -= 1) {
    const message = item.recent_messages[index];
    if (!message || message.sender_kind !== 'agent') continue;
    const target = agentMention(
      message.sender_id,
      message.sender_name,
      selfId,
      members,
    );
    if (target) return target;
  }

  if (item.root_sender_kind === 'agent') {
    const target = agentMention(
      item.root_sender_id,
      item.root_sender_name,
      selfId,
      members,
    );
    if (target) return target;
  }

  for (const participant of item.participants) {
    if (participant.kind !== 'agent') continue;
    const target = agentMention(
      participant.actor_id,
      participant.name,
      selfId,
      members,
    );
    if (target) return target;
  }
  return null;
}

/**
 * 根消息原有的 mention，按服务端顺序去重；成员已不在房间时无法取得显示名，
 * 跳过该条，而不是伪造 actor_id 作为 @ 文案。
 */
export function resolveTaskAskMentions(input: {
  item: TaskListItemView;
  items: HistoryItem[];
  members: Map<string, RoomMember>;
}): TaskAskMention[] {
  const root = findRoot(input.items, input.item.root_message_id);
  if (!root) return [];
  const seen = new Set<string>();
  const mentions: TaskAskMention[] = [];
  for (const mention of root.mentions) {
    if (seen.has(mention.actor_id)) continue;
    const member = input.members.get(mention.actor_id);
    if (!member) continue;
    const name = trimmedName(member.name);
    if (!name) continue;
    seen.add(mention.actor_id);
    mentions.push({ actor_id: member.actor_id, name, kind: member.kind });
  }
  return mentions;
}

export function resolveTaskAskPlan(input: {
  item: TaskListItemView;
  items: HistoryItem[];
  members: Map<string, RoomMember>;
  selfId: string | null;
}): TaskAskPlan {
  return {
    mentions: resolveTaskAskMentions(input),
    agent: resolveTaskAskAgent(input.item, input.selfId, input.members),
  };
}

/**
 * 入口可见性：至少能触达一个 Agent。
 *
 * 根消息的 mention 全部复原（含人类）；若这些 mention 没有 Agent，再追加
 * 回退 Agent，避免“询问进度”只提醒人类。提到但已离开房间的 Agent 无法
 * 取得显示名，不计入；最终没有任何 Agent 目标时不渲染入口。
 */
export function taskAskTargets(plan: TaskAskPlan): TaskAskMention[] {
  const targets = plan.mentions.slice();
  const hasAgent = targets.some((mention) => mention.kind === 'agent');
  if (!hasAgent && plan.agent) {
    targets.push(plan.agent);
  }
  return targets.some((mention) => mention.kind === 'agent') ? targets : [];
}

export function canAskTaskProgress(plan: TaskAskPlan): boolean {
  return taskAskTargets(plan).length > 0;
}

/** `@A @B 这个 task 现在进度如何？`；目标顺序即 mention 顺序。 */
export function buildTaskAskDraft(targets: TaskAskMention[]): string {
  const tokens = targets.map((target) => `@${target.name}`).join(' ');
  return tokens ? `${tokens} ${TASK_ASK_PROGRESS_TEXT}` : TASK_ASK_PROGRESS_TEXT;
}

export function taskAskSelections(targets: TaskAskMention[]): MentionSelection[] {
  return targets.map((target) => ({
    actor_id: target.actor_id,
    name: target.name,
    kind: target.kind,
  }));
}
