/**
 * Phase C：delivery 记忆参考包（advisory pack）。
 *
 * 只读当前 Agent 的 active space：
 * - 不写 `memory_contexts`、`operations`、`events` 或 `outbox`；
 * - 不调用 Hindsight，也不伪造 lookup/bound 注入许可；
 * - 来源/经历必须同时属于当前 space/ownership_epoch/agent，且
 *   `origin_room_id` 硬等于请求房间，避免 direct room 的 agent_private
 *   目标把其它房间内容带进当前回复；
 * - 超时、无空间、无内容或查询失败都返回空包，不把记忆故障升级为投递错误。
 */
import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import { maskSecrets } from '../contracts/redaction';
import { getActiveManagement } from '../domain/agent-access';
import { loadRoomAccess } from '../domain/room-access';
import { historyBoundary, visibleMessage } from '../domain/room-history';
import { getActor, getMessage, getActiveMemorySpace, type D1Like } from '../storage/queries';
import { nowMs, sha256Hex, truncateUtf8, utf8Bytes } from '../storage/db';
import {
  assertAgentExecutionAllowed,
  resolveCurrentOwner,
  spaceMatchesOwner,
} from './access';

export type MemoryInjectionReason =
  | 'ready'
  | 'empty'
  | 'no_space'
  | 'excluded'
  | 'memory_disabled'
  | 'injection_disabled'
  | 'timeout'
  | 'unavailable'
  | 'target_invalid';

export interface MemoryInjectionItem {
  item_id: string;
  kind: 'experience' | 'source';
  text: string;
  text_bytes: number;
  origin_room_id: string;
  source_message_id: string | null;
  sender_id: string | null;
  evidence: string | null;
  source_kind: string | null;
}

export interface MemoryInjectionPack {
  pack_id: string;
  trigger: 'message';
  available: boolean;
  reason: MemoryInjectionReason;
  authority: 'reference_data';
  as_of: number;
  expires_at: number;
  room_id: string;
  message_id: string | null;
  items: MemoryInjectionItem[];
  item_count: number;
  items_bytes: number;
  truncated: boolean;
  omitted: number;
  stats: {
    sources: number;
    experiences: number;
    rooms: number;
  };
  semantic: {
    status: 'not_requested';
    context_ref: string | null;
  };
  injection: {
    eligible: false;
    admit_required: true;
    reason: 'advisory_only';
  };
}

export interface BuildInjectionPackOptions {
  db: D1Like;
  instanceId: string;
  agentId: string;
  roomId: string;
  messageId?: string | null;
  query?: string | null;
  limit?: number;
  now?: number;
  /** 服务端硬超时；超时返回空包而不是错误。 */
  timeoutMs?: number;
}

interface ExperienceCandidate {
  experience_id: string;
  origin_room_id: string;
  evidence: string | null;
  source_id: string | null;
  source_revision: number | null;
  created_at: number;
  text: string;
  text_sha256: string;
  sender_id: string | null;
  source_kind: string | null;
  source_message_id: string | null;
}

interface SourceCandidate {
  source_id: string;
  revision: number;
  origin_room_id: string;
  source_kind: string;
  sender_id: string | null;
  text: string;
  text_sha256: string;
  created_at: number;
  source_message_id: string | null;
}

const CONTROL_CHARS =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const HORIZONTAL_SPACE = /[ \t\f\v]+/gu;

/**
 * 基础清洗：去控制字符与 bidi 控制符（含 CR，避免 `\r\n` 与孤立 CR 改变
 * 渲染）、折叠水平空白、限制连续空行；保留换行语义。
 */
export function sanitizeMemoryText(value: string): string {
  return maskSecrets(
    value
      .replace(CONTROL_CHARS, '')
      .replace(HORIZONTAL_SPACE, ' ')
      .replace(/ *\n */gu, '\n')
      .replace(/\n{3,}/gu, '\n\n')
      .trim(),
  );
}

function clampLimit(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return LIMITS.memoryInjectMessageMaxItems;
  }
  return Math.min(value, LIMITS.memoryInjectMessageMaxItems);
}

function prepareItemText(value: string): string {
  const cleaned = sanitizeMemoryText(value);
  const chars = Array.from(cleaned);
  const limited =
    chars.length > LIMITS.memoryInjectItemMaxChars
      ? chars.slice(0, LIMITS.memoryInjectItemMaxChars).join('')
      : cleaned;
  return truncateUtf8(limited, LIMITS.memoryInjectItemMaxBytes);
}

function itemBytes(items: readonly MemoryInjectionItem[]): number {
  return items.reduce((sum, item) => sum + item.text_bytes, 0);
}

function statsOf(items: readonly MemoryInjectionItem[]): MemoryInjectionPack['stats'] {
  let sources = 0;
  let experiences = 0;
  for (const item of items) {
    if (item.kind === 'source') sources += 1;
    else experiences += 1;
  }
  return { sources, experiences, rooms: items.length > 0 ? 1 : 0 };
}

async function packId(parts: Record<string, unknown>): Promise<string> {
  return `mpk_${(await sha256Hex(JSON.stringify(parts))).slice(0, 32)}`;
}

async function finalizePack(
  pack: Omit<MemoryInjectionPack, 'pack_id'>,
  context: { instanceId: string; agentId: string; spaceId: string | null; epoch: number },
): Promise<MemoryInjectionPack> {
  // 预留 pack_id/字段包装的字节余量，保证加入最终 id 后仍不超过预算。
  const maxBytes =
    Math.min(LIMITS.memoryInjectMessageMaxBytes, LIMITS.memoryInjectResponseBytes) - 128;
  let candidate: MemoryInjectionPack = {
    ...pack,
    pack_id: '',
  };
  // 先按总字节预算从尾部裁剪；不静默返回一个看似完整的包。
  while (candidate.items.length > 0 && utf8Bytes(JSON.stringify(candidate)) > maxBytes) {
    const removed = candidate.items.pop();
    if (!removed) break;
    candidate = {
      ...candidate,
      item_count: candidate.items.length,
      items_bytes: itemBytes(candidate.items),
      truncated: true,
      omitted: candidate.omitted + 1,
      stats: statsOf(candidate.items),
    };
  }
  candidate.pack_id = await packId({
    v: 1,
    instance: context.instanceId,
    agent: context.agentId,
    space: context.spaceId,
    epoch: context.epoch,
    trigger: candidate.trigger,
    room: candidate.room_id,
    message: candidate.message_id,
    query: pack.semantic.context_ref,
    reason: candidate.reason,
    available: candidate.available,
    omitted: candidate.omitted,
    items: candidate.items.map((item) => [item.item_id, item.text]),
  });
  return candidate;
}

async function emptyPack(
  reason: MemoryInjectionReason,
  options: {
    instanceId: string;
    agentId: string;
    roomId: string;
    messageId?: string | null;
    spaceId?: string | null;
    epoch?: number;
    now?: number;
  },
): Promise<MemoryInjectionPack> {
  const at = options.now ?? nowMs();
  return await finalizePack(
    {
      trigger: 'message',
      available: false,
      reason,
      authority: 'reference_data',
      as_of: at,
      expires_at: at + LIMITS.memoryInjectPackTtlMs,
      room_id: options.roomId,
      message_id: options.messageId ?? null,
      items: [],
      item_count: 0,
      items_bytes: 0,
      truncated: false,
      omitted: 0,
      stats: { sources: 0, experiences: 0, rooms: 0 },
      semantic: { status: 'not_requested', context_ref: null },
      injection: { eligible: false, admit_required: true, reason: 'advisory_only' },
    },
    {
      instanceId: options.instanceId,
      agentId: options.agentId,
      spaceId: options.spaceId ?? null,
      epoch: options.epoch ?? 0,
    },
  );
}

/**
 * 只读加载当前 space 并确认 owner/epoch；任何不一致都返回空，不建空间、不转让。
 */
async function loadInjectionSpace(
  db: D1Like,
  agentId: string,
  instanceId: string,
): Promise<
  | { ok: true; spaceId: string; epoch: number; capture: string }
  | { ok: false; reason: MemoryInjectionReason }
> {
  const agent = await getActor(db, agentId);
  if (!agent || agent.kind !== 'agent') return { ok: false, reason: 'target_invalid' };
  assertAgentExecutionAllowed(agent);
  const management = await getActiveManagement(db, agentId);
  const owner = resolveCurrentOwner(agentId, management);
  const space = await getActiveMemorySpace(db, agentId);
  if (!space) return { ok: false, reason: 'no_space' };
  if (space.instance_id !== instanceId) return { ok: false, reason: 'unavailable' };
  if (!spaceMatchesOwner(space, owner)) return { ok: false, reason: 'target_invalid' };
  if (space.capture === 'excluded') return { ok: false, reason: 'excluded' };
  return {
    ok: true,
    spaceId: space.space_id,
    epoch: space.ownership_epoch,
    capture: space.capture,
  };
}

async function collectExperiences(
  db: D1Like,
  input: {
    spaceId: string;
    epoch: number;
    agentId: string;
    roomId: string;
    messageId: string | null;
    query: string | null;
  },
): Promise<ExperienceCandidate[]> {
  const rows = await db
    .prepare(
      `SELECT e.experience_id,
              e.origin_room_id,
              e.evidence,
              e.source_id,
              e.source_revision,
              e.created_at,
              r.text AS text,
              r.text_sha256 AS text_sha256,
              s.author_actor_id AS sender_id,
              s.source_kind AS source_kind,
              json_extract(s.business_ref_json, '$.message_id') AS source_message_id
         FROM memory_experiences e
         JOIN memory_representations r ON r.representation_id = e.representation_id
         LEFT JOIN memory_sources s
                ON s.source_id = e.source_id AND s.revision = e.source_revision
        WHERE e.space_id = ?
          AND e.ownership_epoch = ?
          AND e.agent_actor_id = ?
          AND e.origin_room_id = ?
          AND e.available = 1
          AND e.evidence IS NOT NULL AND e.evidence <> ''
          AND r.text IS NOT NULL AND r.text <> ''
          AND (? IS NULL OR COALESCE(json_extract(s.business_ref_json, '$.message_id'), '') <> ?)
          AND (? IS NULL OR instr(lower(r.text), lower(?)) > 0)
        ORDER BY e.created_at DESC, e.experience_id DESC
        LIMIT ?`,
    )
    .bind(
      input.spaceId,
      input.epoch,
      input.agentId,
      input.roomId,
      input.messageId,
      input.messageId,
      input.query,
      input.query,
      LIMITS.memoryInjectScanCandidates,
    )
    .all<ExperienceCandidate>();
  return rows.results;
}

async function collectSources(
  db: D1Like,
  input: {
    spaceId: string;
    epoch: number;
    agentId: string;
    roomId: string;
    messageId: string | null;
    query: string | null;
  },
): Promise<SourceCandidate[]> {
  const rows = await db
    .prepare(
      `SELECT s.source_id,
              s.revision,
              s.origin_room_id,
              s.source_kind,
              s.author_actor_id AS sender_id,
              s.content_text AS text,
              s.content_sha256 AS text_sha256,
              s.created_at,
              json_extract(s.business_ref_json, '$.message_id') AS source_message_id
         FROM memory_sources s
        WHERE s.state = 'active'
          AND s.origin_room_id = ?
          AND s.content_text IS NOT NULL AND s.content_text <> ''
          AND EXISTS (
                SELECT 1
                  FROM memory_experiences e
                 WHERE e.source_id = s.source_id
                   AND e.source_revision = s.revision
                   AND e.space_id = ?
                   AND e.ownership_epoch = ?
                   AND e.agent_actor_id = ?
                   AND e.available = 1
                   AND e.origin_room_id = ?
              )
          AND (? IS NULL OR COALESCE(json_extract(s.business_ref_json, '$.message_id'), '') <> ?)
          AND (? IS NULL OR instr(lower(s.content_text), lower(?)) > 0)
        ORDER BY COALESCE(s.origin_created_at, s.created_at) DESC, s.source_id DESC
        LIMIT ?`,
    )
    .bind(
      input.roomId,
      input.spaceId,
      input.epoch,
      input.agentId,
      input.roomId,
      input.messageId,
      input.messageId,
      input.query,
      input.query,
      LIMITS.memoryInjectScanCandidates,
    )
    .all<SourceCandidate>();
  return rows.results;
}

export async function buildInjectionPack(
  options: BuildInjectionPackOptions,
): Promise<MemoryInjectionPack> {
  const at = options.now ?? nowMs();
  const base = {
    instanceId: options.instanceId,
    agentId: options.agentId,
    roomId: options.roomId,
    messageId: options.messageId ?? null,
    now: at,
  };
  const space = await loadInjectionSpace(options.db, options.agentId, options.instanceId).catch(
    (error) => {
      if (error instanceof BusinessError) return { ok: false as const, reason: 'target_invalid' as const };
      throw error;
    },
  );
  if (!space.ok) {
    return await emptyPack(space.reason, base);
  }

  const limit = clampLimit(options.limit);
  const query = options.query?.trim() ? options.query.trim() : null;
  const experiences = await collectExperiences(options.db, {
    spaceId: space.spaceId,
    epoch: space.epoch,
    agentId: options.agentId,
    roomId: options.roomId,
    messageId: options.messageId ?? null,
    query,
  });
  const sources = await collectSources(options.db, {
    spaceId: space.spaceId,
    epoch: space.epoch,
    agentId: options.agentId,
    roomId: options.roomId,
    messageId: options.messageId ?? null,
    query,
  });

  const seen = new Set<string>();
  const items: MemoryInjectionItem[] = [];
  const candidates: number = experiences.length + sources.length;

  const push = (item: MemoryInjectionItem, dedupe: string): void => {
    if (items.length >= limit) return;
    if (seen.has(dedupe)) return;
    seen.add(dedupe);
    items.push(item);
  };

  for (const row of experiences) {
    // 即使 SQL 已过滤，仍在出口逐条复核，防止未来查询改动放宽房间边界。
    if (row.origin_room_id !== options.roomId) continue;
    const text = prepareItemText(row.text);
    if (text.length === 0) continue;
    push(
      {
        item_id: `exp:${row.experience_id}`,
        kind: 'experience',
        text,
        text_bytes: utf8Bytes(text),
        origin_room_id: options.roomId,
        source_message_id: row.source_message_id,
        sender_id: row.sender_id,
        evidence: row.evidence,
        source_kind: row.source_kind,
      },
      row.text_sha256 || text,
    );
  }
  for (const row of sources) {
    if (row.origin_room_id !== options.roomId) continue;
    const text = prepareItemText(row.text);
    if (text.length === 0) continue;
    push(
      {
        item_id: `src:${row.source_id}:${row.revision}`,
        kind: 'source',
        text,
        text_bytes: utf8Bytes(text),
        origin_room_id: options.roomId,
        source_message_id: row.source_message_id,
        sender_id: row.sender_id,
        evidence: null,
        source_kind: row.source_kind,
      },
      row.text_sha256 || text,
    );
  }

  if (items.length === 0) {
    return await emptyPack('empty', {
      ...base,
      spaceId: space.spaceId,
      epoch: space.epoch,
    });
  }

  return await finalizePack(
    {
      trigger: 'message',
      available: true,
      reason: 'ready',
      authority: 'reference_data',
      as_of: at,
      expires_at: at + LIMITS.memoryInjectPackTtlMs,
      room_id: options.roomId,
      message_id: options.messageId ?? null,
      items,
      item_count: items.length,
      items_bytes: itemBytes(items),
      truncated: candidates > items.length,
      omitted: Math.max(0, candidates - items.length),
      stats: statsOf(items),
      semantic: { status: 'not_requested', context_ref: query },
      injection: { eligible: false, admit_required: true, reason: 'advisory_only' },
    },
    {
      instanceId: options.instanceId,
      agentId: options.agentId,
      spaceId: space.spaceId,
      epoch: space.epoch,
    },
  );
}

/**
 * 带硬超时的只读入口。构建失败/超时都返回空包：
 * 记忆是参考数据，不能阻塞 delivery、claim 或消息落库。
 */
export async function buildInjectionPackWithTimeout(
  options: BuildInjectionPackOptions,
): Promise<MemoryInjectionPack> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? LIMITS.memoryInjectMessageTimeoutMs);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const result = await Promise.race([buildInjectionPack(options), timeout]);
    if (result === null) {
      return await emptyPack('timeout', {
        instanceId: options.instanceId,
        agentId: options.agentId,
        roomId: options.roomId,
        messageId: options.messageId ?? null,
        now: options.now,
      });
    }
    return result;
  } catch {
    return await emptyPack('unavailable', {
      instanceId: options.instanceId,
      agentId: options.agentId,
      roomId: options.roomId,
      messageId: options.messageId ?? null,
      now: options.now,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 服务端 `MEMORY_INJECT` 关闭时的稳定空包；仍返回 200，旧 monitor 不需要
 * 识别新错误码即可把该投递当作“无记忆”继续处理。
 */
export async function injectionDisabledPack(options: {
  instanceId: string;
  agentId: string;
  roomId: string;
  messageId?: string | null;
  now?: number;
}): Promise<MemoryInjectionPack> {
  return await emptyPack('injection_disabled', options);
}

/** 已认证 Agent 调用的前置校验；人类、撤销凭据与停用 Agent 一律拒绝。 */
export async function assertPackCaller(options: {
  db: D1Like;
  principal: {
    actor: { actor_id: string; kind: 'human' | 'agent'; disabled_at: number | null } | null;
    credential: { revoked_at: number | null } | null;
  };
}): Promise<{ agentId: string }> {
  const actor = options.principal.actor;
  if (!actor || actor.kind !== 'agent') {
    throw new BusinessError('PERMISSION_DENIED', 'Memory 参考包只接受 Agent 自身凭据', {
      reason: 'agent_credential_required',
    });
  }
  if (!options.principal.credential || options.principal.credential.revoked_at !== null) {
    throw new BusinessError('PERMISSION_DENIED', '凭据已撤销，不能读取 Memory 参考包', {
      reason: 'credential_revoked',
    });
  }
  const stored = await getActor(options.db, actor.actor_id);
  if (!stored || stored.kind !== 'agent') {
    throw new BusinessError('PERMISSION_DENIED', 'Agent 身份不存在', {
      reason: 'agent_credential_required',
    });
  }
  assertAgentExecutionAllowed(stored);
  return { agentId: stored.actor_id };
}

/**
 * 校验 room 成员资格与可选 message 可见性。
 *
 * 跨房间 message 返回 NOT_FOUND，不区分“不存在”和“不可见”，避免探测。
 */
export async function assertPackTarget(
  db: D1Like,
  agentId: string,
  input: { roomId: string; messageId?: string | null },
): Promise<void> {
  const { room, member } = await loadRoomAccess(db, input.roomId, agentId);
  if (!input.messageId) return;
  const message = await getMessage(db, input.messageId);
  if (!message || message.room_id !== input.roomId) {
    throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
  }
  if (!visibleMessage(message, historyBoundary(room, member))) {
    throw new BusinessError('NOT_FOUND', '消息不存在或当前不可见');
  }
}
