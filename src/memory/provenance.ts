/**
 * Memory provenance：retain 快照、metadata 解析与本地 source 回退。
 *
 * 边界：
 * - 只读写稳定业务 ID、显示名快照与 epoch 毫秒；不返回 Hindsight 的
 *   document_id/chunk_id/raw tags/原始 metadata，也不写正文或 token。
 * - 解析失败一律返回 null，不能让召回或 insight 因坏 metadata 失败。
 * - provenance 只用于展示/引用，不参与授权、成员资格或证据等级判断；
 *   actor_id 才是身份，显示名只是快照。
 */
import { LIMITS } from '../contracts/limits';
import { maskSecrets } from '../contracts/redaction';
import { getActor, getMemorySourceRevision, type D1Like } from '../storage/queries';
import {
  MEMORY_SOURCE_KINDS,
  type MemoryProvenance,
  type MemorySourceKind,
  type MemorySourceRef,
} from './contracts';
import type { MemorySourceRow } from './rows';

/** Hindsight metadata 中唯一的 provenance 键；不新增 tag。 */
export const PROVENANCE_METADATA_KEY = 'agentnet_provenance';

/** provenance JSON 版本；未知版本按解析失败处理。 */
export const PROVENANCE_VERSION = 1;

const ID_MAX_CHARS = 160;

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const masked = maskSecrets(value).trim();
  if (masked.length === 0) return null;
  const chars = Array.from(masked);
  return chars.length > LIMITS.memoryProvenanceNameMaxChars
    ? chars.slice(0, LIMITS.memoryProvenanceNameMaxChars).join('')
    : masked;
}

function cleanId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > ID_MAX_CHARS) return null;
  return trimmed;
}

function cleanOccurredAt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const at = Math.trunc(value);
  return at > 0 ? at : null;
}

function isSourceKind(value: unknown): value is MemorySourceKind {
  return typeof value === 'string' && (MEMORY_SOURCE_KINDS as readonly string[]).includes(value);
}

function nameSource(value: unknown, hasName: boolean): MemoryProvenance['author_name_source'] {
  if (!hasName) return null;
  return value === 'read_current' || value === 'retain_snapshot' ? value : null;
}

/**
 * 逐字段校验并返回新的白名单对象；全部为空时返回 null。
 *
 * `source_message_id` 只在 `source_kind === 'message'` 时保留：快照、本地行、
 * 合并与序列化都经这里收口，避免坏 metadata 或旧数据把消息 id 挂到
 * task/file/manual 来源上。
 */
function normalizeProvenance(input: {
  author_actor_id: unknown;
  author_name: unknown;
  author_name_source: unknown;
  source_kind: unknown;
  origin_room_id: unknown;
  source_message_id: unknown;
  occurred_at: unknown;
}): MemoryProvenance | null {
  const authorName = cleanName(input.author_name);
  const sourceKind = isSourceKind(input.source_kind) ? input.source_kind : null;
  const provenance: MemoryProvenance = {
    author_actor_id: cleanId(input.author_actor_id),
    author_name: authorName,
    author_name_source: nameSource(input.author_name_source, authorName !== null),
    source_kind: sourceKind,
    origin_room_id: cleanId(input.origin_room_id),
    source_message_id: sourceKind === 'message' ? cleanId(input.source_message_id) : null,
    occurred_at: cleanOccurredAt(input.occurred_at),
  };
  if (
    provenance.author_actor_id === null &&
    provenance.author_name === null &&
    provenance.source_kind === null &&
    provenance.origin_room_id === null &&
    provenance.source_message_id === null &&
    provenance.occurred_at === null
  ) {
    return null;
  }
  return provenance;
}

/** 序列化为版本化 JSON；没有可用字段时返回 null，由调用方决定不写键。 */
export function serializeProvenance(value: MemoryProvenance | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeProvenance(value);
  if (!normalized) return null;
  const payload: Record<string, unknown> = { v: PROVENANCE_VERSION };
  if (normalized.author_actor_id !== null) payload.author_actor_id = normalized.author_actor_id;
  if (normalized.author_name !== null) payload.author_name = normalized.author_name;
  if (normalized.source_kind !== null) payload.source_kind = normalized.source_kind;
  if (normalized.origin_room_id !== null) payload.origin_room_id = normalized.origin_room_id;
  if (normalized.source_message_id !== null) {
    payload.source_message_id = normalized.source_message_id;
  }
  if (normalized.occurred_at !== null) payload.occurred_at = normalized.occurred_at;
  return JSON.stringify(payload);
}

/**
 * 解析 retain 快照。接受 JSON 字符串或对象；任何类型/版本/JSON 错误返回
 * null，不抛错、不返回原始 metadata。
 */
export function parseProvenanceMetadata(value: unknown): MemoryProvenance | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.v !== PROVENANCE_VERSION) return null;
  return normalizeProvenance({
    author_actor_id: record.author_actor_id,
    author_name: record.author_name,
    author_name_source: 'retain_snapshot',
    source_kind: record.source_kind,
    origin_room_id: record.origin_room_id,
    source_message_id: record.source_message_id,
    occurred_at: record.occurred_at,
  });
}

/** 只从 message 类型的 business_ref 提取稳定 message_id；其他 source_kind 为 null。 */
export function parseSourceMessageId(businessRefJson: string): string | null {
  try {
    const parsed = JSON.parse(businessRefJson) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return cleanId((parsed as Record<string, unknown>).message_id);
  } catch {
    return null;
  }
}

/**
 * 用已加载的本地 source row 构造 provenance；显示名取当前 actor 名称。
 * 本地行是权威回退，不按 source_id 回抓未交付原文。
 */
export async function provenanceFromSourceRow(
  db: D1Like,
  row: MemorySourceRow,
): Promise<MemoryProvenance | null> {
  const actor = row.author_actor_id ? await getActor(db, row.author_actor_id) : null;
  const authorName = cleanName(actor?.name ?? null);
  return normalizeProvenance({
    author_actor_id: row.author_actor_id,
    author_name: authorName,
    author_name_source: authorName ? 'read_current' : null,
    source_kind: row.source_kind,
    origin_room_id: row.origin_room_id,
    source_message_id: row.source_kind === 'message' ? parseSourceMessageId(row.business_ref_json) : null,
    occurred_at: row.origin_created_at,
  });
}

/** 按 source ref 读取本地权威 provenance；source row 不存在时返回 null。 */
export async function loadSourceProvenance(
  db: D1Like,
  source: MemorySourceRef,
): Promise<MemoryProvenance | null> {
  const row = await getMemorySourceRevision(db, source.source_id, source.source_revision);
  return row ? await provenanceFromSourceRow(db, row) : null;
}

/** 只信任 message 来源携带的消息 id；其他 kind 即使有值也不参与合并。 */
function messageIdOf(value: MemoryProvenance): string | null {
  return value.source_kind === 'message' ? value.source_message_id : null;
}

/**
 * 本地 source 优先、metadata 快照兜底；字段级合并只为补空，不覆盖本地值。
 * 单侧输入也经 `normalizeProvenance` 收口，避免非 message 来源夹带消息 id。
 * `author_name_source` 跟随实际提供显示名的一方。
 */
export function mergeProvenance(
  local: MemoryProvenance | null | undefined,
  remote: MemoryProvenance | null | undefined,
): MemoryProvenance | null {
  const left = local ?? null;
  const right = remote ?? null;
  if (!left) return right ? normalizeProvenance(right) : null;
  if (!right) return left ? normalizeProvenance(left) : null;
  const authorName = left.author_name ?? right.author_name;
  return normalizeProvenance({
    author_actor_id: left.author_actor_id ?? right.author_actor_id,
    author_name: authorName,
    author_name_source: left.author_name
      ? left.author_name_source ?? 'read_current'
      : right.author_name_source ?? (authorName ? 'retain_snapshot' : null),
    source_kind: left.source_kind ?? right.source_kind,
    origin_room_id: left.origin_room_id ?? right.origin_room_id,
    source_message_id: messageIdOf(left) ?? messageIdOf(right),
    occurred_at: left.occurred_at ?? right.occurred_at,
  });
}
