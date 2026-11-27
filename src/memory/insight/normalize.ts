/**
 * Hindsight 响应的白名单归一化与裁剪。
 *
 * 这里不做授权，也不发请求；只把上游数据转成稳定 DTO，并保证：
 * - 记忆图不超过节点/边/字节预算；
 * - 自环、悬空边、重复边被过滤；
 * - 正文按字符/字节截断；
 * - 输出中不出现 document_id、chunk_id、原始 metadata 或 agentnet 内部 tags。
 */
import { LIMITS } from '../../contracts/limits';
import { truncateUtf8, utf8Bytes } from '../../storage/db';
import type { MemoryProvenance } from '../contracts-core';
import { PROVENANCE_METADATA_KEY, parseProvenanceMetadata } from '../provenance';
import type {
  InsightEntityDetail,
  InsightEntityGraph,
  InsightEntityItem,
  InsightFactType,
  InsightGraphEdge,
  InsightGraphNode,
  InsightGraphRow,
  InsightMemoryDetail,
  InsightMemoryItem,
  InsightStats,
  InsightTimelineItem,
} from './contracts';
import { INSIGHT_FACT_TYPES } from './contracts';

const INTERNAL_TAG_PREFIX = 'agentnet:';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 只从上游 metadata/document_metadata 解析白名单 provenance；原始 metadata
 * 对象本身绝不进入输出。
 */
function provenanceOf(entry: Record<string, unknown>): MemoryProvenance | null {
  const metadata = isRecord(entry.metadata)
    ? entry.metadata
    : isRecord(entry.document_metadata)
      ? entry.document_metadata
      : null;
  return metadata ? parseProvenanceMetadata(metadata[PROVENANCE_METADATA_KEY]) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function nonNegativeInt(value: unknown): number {
  const parsed = numberValue(value);
  return parsed !== null && parsed >= 0 ? Math.floor(parsed) : 0;
}

function positiveWeight(value: unknown): number {
  const parsed = numberValue(value);
  return parsed !== null && parsed > 0 ? parsed : 1;
}

function timestampValue(value: unknown): string | null {
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > 0 ? truncateChars(text, 64) : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/** 可解析的 ISO 时间戳；不可解析的原样字符串不参与排序与分组。 */
function parseableTimestamp(value: string | null): string | null {
  return value !== null && Number.isFinite(Date.parse(value)) ? value : null;
}

/**
 * 事件时间：优先可解析的 occurred_start，否则回退可解析的 mentioned_at。
 * 与 timeline 的分组回退保持一致；两者都不可解析时保留原值，最终归入 undated。
 */
function eventTimestamp(occurred: string | null, mentioned: string | null): string | null {
  return parseableTimestamp(occurred) ?? parseableTimestamp(mentioned) ?? occurred ?? mentioned;
}

export function truncateChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const chars = Array.from(text);
  return chars.length <= maxChars ? text : chars.slice(0, maxChars).join('');
}

function factType(value: unknown): InsightFactType | null {
  return typeof value === 'string' && (INSIGHT_FACT_TYPES as readonly string[]).includes(value)
    ? (value as InsightFactType)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function entityArray(value: unknown, max = 20, maxChars = 80): string[] {
  const raw =
    typeof value === 'string'
      ? value.split(',')
      : Array.isArray(value)
        ? stringArray(value)
        : [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    const name = truncateChars(entry.trim(), maxChars);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
    if (result.length >= max) break;
  }
  return result;
}

function publicTags(value: unknown): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of stringArray(value)) {
    const normalized = truncateChars(tag.trim(), 80);
    if (!normalized || normalized.startsWith(INTERNAL_TAG_PREFIX) || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= 20) break;
  }
  return result;
}

function unwrap(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  return isRecord(value.data) ? value.data : value;
}

export function normalizeStats(body: unknown): InsightStats | null {
  if (!isRecord(body)) return null;
  const byType = isRecord(body.nodes_by_fact_type) ? body.nodes_by_fact_type : {};
  const linksByType: Record<string, number> = {};
  if (isRecord(body.links_by_link_type)) {
    for (const [key, value] of Object.entries(body.links_by_link_type)) {
      const count = numberValue(value);
      if (count !== null && count >= 0) linksByType[truncateChars(key, 64)] = Math.floor(count);
    }
  }
  return {
    total_nodes: nonNegativeInt(body.total_nodes),
    total_links: nonNegativeInt(body.total_links),
    total_documents: nonNegativeInt(body.total_documents),
    by_fact_type: {
      world: nonNegativeInt(byType.world),
      experience: nonNegativeInt(byType.experience),
      observation: nonNegativeInt(byType.observation),
    },
    links_by_type: linksByType,
    pending_operations: nonNegativeInt(body.pending_operations),
    failed_operations: nonNegativeInt(body.failed_operations),
    last_write_at: timestampValue(body.last_memory_write_at),
    last_consolidated_at: timestampValue(body.last_consolidated_at),
  };
}

export interface GraphNormalizeOptions {
  nodeLimit: number;
  edgeLimit: number;
  textChars: number;
  labelChars?: number;
  entityMode?: boolean;
}

export interface NormalizedGraph {
  nodes: InsightGraphNode[];
  edges: InsightGraphEdge[];
  total_units: number | null;
  total_edges: number;
  raw_node_count: number;
  raw_edge_count: number;
  truncated: boolean;
}

function tableFactTypes(body: Record<string, unknown>): Map<string, InsightFactType> {
  const result = new Map<string, InsightFactType>();
  if (!Array.isArray(body.table_rows)) return result;
  for (const row of body.table_rows) {
    if (!isRecord(row)) continue;
    const id = stringValue(row.id ?? row.memory_id ?? row.unit_id ?? row.memory_unit_id);
    if (!id) continue;
    const type = factType(row.fact_type ?? row.type);
    if (type) result.set(id, type);
  }
  return result;
}

export function normalizeMemoryGraph(
  body: unknown,
  options: GraphNormalizeOptions,
): NormalizedGraph | null {
  if (!isRecord(body)) return null;
  const rawNodes = Array.isArray(body.nodes) ? body.nodes : [];
  const rawEdges = Array.isArray(body.edges) ? body.edges : [];
  const factTypes = tableFactTypes(body);
  const nodes = new Map<string, InsightGraphNode>();

  for (const entry of rawNodes) {
    const node = unwrap(entry);
    if (!node) continue;
    const id = stringValue(node.id);
    if (!id || nodes.has(id)) continue;
    const label = truncateChars(
      stringValue(node.label) ?? stringValue(node.text) ?? id,
      options.labelChars ?? LIMITS.memoryPanelGraphLabelChars,
    );
    const normalized: InsightGraphNode = { id, label };
    const text = stringValue(node.text);
    if (!options.entityMode && text !== null) {
      normalized.text = truncateChars(text, options.textChars);
    }
    const type = factTypes.get(id) ?? factType(node.fact_type ?? node.type);
    if (!options.entityMode && type) normalized.fact_type = type;
    const date = timestampValue(node.date);
    if (date) normalized.date = date;
    if (options.entityMode) {
      normalized.mention_count = nonNegativeInt(node.mentionCount ?? node.mention_count);
    } else {
      const entities = entityArray(node.entities);
      if (entities.length > 0) normalized.entities = entities;
    }
    nodes.set(id, normalized);
    if (nodes.size >= options.nodeLimit) break;
  }

  const byKey = new Map<string, InsightGraphEdge>();
  for (const entry of rawEdges) {
    const edge = unwrap(entry);
    if (!edge) continue;
    const source = stringValue(edge.source);
    const target = stringValue(edge.target);
    if (!source || !target || source === target) continue;
    if (!nodes.has(source) || !nodes.has(target)) continue;
    const type = stringValue(edge.linkType ?? edge.type) ?? 'unknown';
    const key = `${source}\u0000${target}\u0000${type}`;
    const normalized: InsightGraphEdge = {
      id:
        stringValue(edge.id) ??
        truncateChars(`${source}->${target}:${type}`, 160),
      source,
      target,
      type: truncateChars(type, 40),
      weight: positiveWeight(edge.weight),
    };
    const entity = stringValue(edge.entityName ?? edge.entity);
    if (entity) normalized.entity = truncateChars(entity, 80);
    if (options.entityMode) {
      // 上游没有该字段时省略整个属性；存在但为 null 时如实返回 null。
      const hasLastCooccurred =
        Object.hasOwn(edge, 'lastCooccurred') || Object.hasOwn(edge, 'last_cooccurred');
      if (hasLastCooccurred) {
        normalized.last_cooccurred = timestampValue(edge.lastCooccurred ?? edge.last_cooccurred);
      }
    }
    const existing = byKey.get(key);
    if (!existing || normalized.weight > existing.weight) byKey.set(key, normalized);
  }

  const validEdges = [...byKey.values()];
  const trimmedEdges = trimEdges(validEdges, options.edgeLimit);
  const upstreamEdges = numberValue(body.total_edges);
  const upstreamUnits = numberValue(body.total_units ?? body.total_entities);
  return {
    nodes: [...nodes.values()],
    edges: trimmedEdges,
    total_units: upstreamUnits !== null ? Math.floor(upstreamUnits) : null,
    total_edges: upstreamEdges !== null ? Math.floor(upstreamEdges) : validEdges.length,
    raw_node_count: rawNodes.length,
    raw_edge_count: rawEdges.length,
    truncated:
      rawNodes.length > nodes.size ||
      rawEdges.length > trimmedEdges.length ||
      (upstreamUnits !== null && upstreamUnits > nodes.size) ||
      (upstreamEdges !== null && upstreamEdges > trimmedEdges.length),
  };
}

function trimEdges(edges: InsightGraphEdge[], maxEdges: number): InsightGraphEdge[] {
  if (edges.length <= maxEdges) return edges;
  const sorted = [...edges].sort((left, right) => {
    if (right.weight !== left.weight) return right.weight - left.weight;
    if (left.type !== right.type) return left.type < right.type ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  const selected: InsightGraphEdge[] = [];
  const selectedIds = new Set<string>();
  const covered = new Set<string>();
  const keyOf = (edge: InsightGraphEdge): string =>
    `${edge.id}\u0000${edge.source}\u0000${edge.target}`;

  // 先保证每个节点至少有一条最强边，再按权重填充剩余额度。
  for (const edge of sorted) {
    if (selected.length >= maxEdges) break;
    if (covered.has(edge.source) && covered.has(edge.target)) continue;
    selected.push(edge);
    selectedIds.add(keyOf(edge));
    covered.add(edge.source);
    covered.add(edge.target);
  }
  for (const edge of sorted) {
    if (selected.length >= maxEdges) break;
    if (selectedIds.has(keyOf(edge))) continue;
    selected.push(edge);
    selectedIds.add(keyOf(edge));
  }
  return selected;
}

export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

/**
 * 按 code point 减半正文，并保证 UTF-16 长度严格递减。
 *
 * `truncateChars` 按 code point 截断，而 `text.length` 是 UTF-16 长度；纯 astral
 * 文本（emoji）用 UTF-16 长度计算减半目标时会得到不小于实际 code point 数的值，
 * 截断后原样返回，压缩循环永不结束。这里直接按 code point 取半，并用长度检查
 * 兜底，确保每轮至少减少一个字符。
 */
function halveText(text: string): string {
  const chars = Array.from(text);
  const half = chars.slice(0, Math.floor(chars.length / 2)).join('');
  return half.length < text.length ? half : chars.slice(0, chars.length - 1).join('');
}

/**
 * 把图压到字节预算内。裁剪顺序保证星座视图优先保住边：
 * 1. 节点正文先截到 memoryPanelGraphTextFloorChars；长中文记忆的字节主要在这里；
 * 2. 仍超预算时按权重/覆盖度裁剪边，但不低于 min(现有边数, memoryPanelGraphEdgesMin)；
 * 3. 仍超预算时继续减半节点正文，正文压空后才允许跌破边下限；
 * 4. 最后才删节点，并同步清理悬空边。
 * 返回是否发生额外裁剪。
 */
export function fitGraphBytes<T extends { nodes: InsightGraphNode[]; edges: InsightGraphEdge[] }>(
  graph: T,
  maxBytes: number = LIMITS.memoryPanelGraphCoreBytes,
): boolean {
  if (jsonBytes(graph) <= maxBytes) return false;
  let truncated = false;

  for (const node of graph.nodes) {
    const text = node.text ?? '';
    if (text.length > LIMITS.memoryPanelGraphTextFloorChars) {
      node.text = truncateChars(text, LIMITS.memoryPanelGraphTextFloorChars);
      truncated = true;
    }
  }

  const edgeFloor = Math.min(graph.edges.length, LIMITS.memoryPanelGraphEdgesMin);
  while (graph.edges.length > edgeFloor && jsonBytes(graph) > maxBytes) {
    const nextEdges = trimEdges(
      graph.edges,
      Math.max(edgeFloor, Math.floor(graph.edges.length * 0.75)),
    );
    // 原地替换：调用方可能传入与结果共享 nodes/edges 的包装对象；重新赋值只会
    // 更新包装对象，外部持有的 result.edges 仍指向旧数组，删节点后形成悬空边。
    graph.edges.splice(0, graph.edges.length, ...nextEdges);
    truncated = true;
  }

  // 正文仍可继续压缩时优先牺牲正文，不跌破边下限。
  while (jsonBytes(graph) > maxBytes) {
    let shrunk = false;
    for (const node of graph.nodes) {
      const text = node.text ?? '';
      if (text.length === 0) continue;
      node.text = halveText(text);
      shrunk = true;
    }
    if (!shrunk) break;
    truncated = true;
  }

  // 正文已压空仍超预算，才允许跌破边下限。
  while (graph.edges.length > 0 && jsonBytes(graph) > maxBytes) {
    const nextEdges = trimEdges(graph.edges, Math.floor(graph.edges.length * 0.75));
    graph.edges.splice(0, graph.edges.length, ...nextEdges);
    truncated = true;
  }

  while (jsonBytes(graph) > maxBytes && graph.nodes.length > 0) {
    graph.nodes.pop();
    const ids = new Set(graph.nodes.map((node) => node.id));
    for (let index = graph.edges.length - 1; index >= 0; index -= 1) {
      const edge = graph.edges[index]!;
      if (!ids.has(edge.source) || !ids.has(edge.target)) graph.edges.splice(index, 1);
    }
    truncated = true;
  }
  return truncated;
}

export function normalizeMemoryList(
  body: unknown,
  options: { textChars?: number } = {},
): {
  items: InsightMemoryItem[];
  total: number | null;
  raw_count: number;
} | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const textChars = options.textChars ?? LIMITS.memoryPanelFactsTextChars;
  const items: InsightMemoryItem[] = [];
  for (const entry of body.items) {
    const item = normalizeMemoryItem(entry, textChars);
    if (item) items.push(item);
  }
  const total = numberValue(body.total);
  return {
    items,
    total: total !== null ? Math.floor(total) : null,
    raw_count: body.items.length,
  };
}

function normalizeMemoryItem(entry: unknown, textChars: number): InsightMemoryItem | null {
  if (!isRecord(entry)) return null;
  const id = stringValue(entry.id);
  if (!id) return null;
  const rawText = stringValue(entry.text) ?? '';
  const stateValue = stringValue(entry.state);
  const invalidated =
    stateValue === 'invalidated' || stateValue === 'invalid' || entry.invalidated_at != null;
  const provenance = provenanceOf(entry);
  return {
    id,
    text: truncateChars(rawText, textChars),
    fact_type: factType(entry.fact_type ?? entry.type),
    state: invalidated ? 'invalidated' : 'valid',
    mentioned_at: timestampValue(entry.mentioned_at ?? entry.date),
    occurred_start: timestampValue(entry.occurred_start),
    occurred_end: timestampValue(entry.occurred_end),
    entities: entityArray(entry.entities),
    proof_count: nonNegativeInt(entry.proof_count),
    tags: publicTags(entry.tags),
    ...(provenance ? { provenance } : {}),
  };
}

/** 时间线只保留渲染所需的 compact 字段；不返回 tags/document/chunk/metadata。 */
export function normalizeTimelineItem(entry: unknown): InsightTimelineItem | null {
  if (!isRecord(entry)) return null;
  const id = stringValue(entry.id);
  if (!id) return null;
  const stateValue = stringValue(entry.state);
  const occurredStart = timestampValue(entry.occurred_start ?? entry.occurred_at);
  const mentionedAt = timestampValue(entry.mentioned_at ?? entry.date);
  return {
    id,
    text: truncateChars(stringValue(entry.text) ?? '', LIMITS.memoryPanelTimelineTextChars),
    fact_type: factType(entry.fact_type ?? entry.type),
    state:
      stateValue === 'invalidated' || stateValue === 'invalid' || entry.invalidated_at != null
        ? 'invalidated'
        : 'valid',
    occurred_at: eventTimestamp(occurredStart, mentionedAt),
    mentioned_at: mentionedAt,
    entities: entityArray(
      entry.entities,
      LIMITS.memoryPanelTimelineEntitiesMax,
      LIMITS.memoryPanelTimelineEntityChars,
    ),
  };
}

function graphRowState(entry: Record<string, unknown>): 'valid' | 'invalidated' | undefined {
  if (entry.invalidated_at != null) return 'invalidated';
  const state = stringValue(entry.state);
  if (state === 'invalidated' || state === 'invalid') return 'invalidated';
  if (state === 'valid') return 'valid';
  // 只有上游显式给出 invalidated_at（即使为 null）才据此判断 valid。
  if (Object.hasOwn(entry, 'invalidated_at')) return 'valid';
  return undefined;
}

export function normalizeGraphRow(entry: unknown, textChars: number): InsightGraphRow | null {
  if (!isRecord(entry)) return null;
  const id = stringValue(entry.id);
  if (!id) return null;
  const occurredStart = timestampValue(entry.occurred_start);
  const mentionedAt = timestampValue(entry.mentioned_at ?? entry.date);
  const provenance = provenanceOf(entry);
  const row: InsightGraphRow = {
    id,
    text: truncateChars(stringValue(entry.text) ?? '', textChars),
    fact_type: factType(entry.fact_type ?? entry.type),
    occurred_at: eventTimestamp(occurredStart, mentionedAt),
    mentioned_at: mentionedAt,
    occurred_start: occurredStart,
    occurred_end: timestampValue(entry.occurred_end),
    entities: entityArray(entry.entities),
    proof_count: nonNegativeInt(entry.proof_count),
    tags: publicTags(entry.tags),
    ...(provenance ? { provenance } : {}),
  };
  const state = graphRowState(entry);
  if (state) row.state = state;
  return row;
}

export function graphRowTimeMs(row: InsightGraphRow): number | null {
  if (!row.occurred_at) return null;
  const parsed = Date.parse(row.occurred_at);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 图表行：复用记忆项的白名单（不含 document_id/chunk_id/metadata/内部 tags），
 * 按 occurred_at 倒序、无日期排最后，并截断到 rows_limit。
 */
export function normalizeGraphRows(
  body: unknown,
  options: { limit: number; textChars: number },
): { rows: InsightGraphRow[]; raw_count: number; truncated: boolean } | null {
  if (!isRecord(body)) return null;
  const rawRows = Array.isArray(body.table_rows) ? body.table_rows : [];
  const seen = new Set<string>();
  const rows: InsightGraphRow[] = [];
  for (const entry of rawRows) {
    const row = normalizeGraphRow(entry, options.textChars);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  rows.sort((left, right) => {
    const leftTime = graphRowTimeMs(left);
    const rightTime = graphRowTimeMs(right);
    if (leftTime !== rightTime) {
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      return rightTime - leftTime;
    }
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
  return {
    rows: rows.slice(0, options.limit),
    raw_count: rawRows.length,
    truncated: rows.length > options.limit,
  };
}

function normalizeContext(value: unknown): string | null {
  const context = stringValue(value);
  if (!context) return null;
  if (/^agentnet\s+message\b/u.test(context)) return '来自会话消息';
  return truncateChars(context, 200);
}

export function normalizeMemoryDetail(
  body: unknown,
  requestedId: string,
): InsightMemoryDetail | null {
  if (!isRecord(body)) return null;
  const id = stringValue(body.id) ?? requestedId;
  const rawText = stringValue(body.text) ?? '';
  const bytes = utf8Bytes(rawText);
  const text = truncateUtf8(rawText, LIMITS.memoryPanelDetailTextBytes);
  const history = Array.isArray(body.history) ? body.history.length : 0;
  const sourceMemories: InsightMemoryDetail['source_memories'] = [];
  if (Array.isArray(body.source_memories)) {
    for (const entry of body.source_memories.slice(0, 10)) {
      if (!isRecord(entry)) continue;
      const sourceId = stringValue(entry.id);
      if (!sourceId) continue;
      sourceMemories.push({
        id: sourceId,
        text: truncateChars(stringValue(entry.text) ?? '', 500),
        type: factType(entry.type ?? entry.fact_type),
        mentioned_at: timestampValue(entry.mentioned_at),
      });
    }
  }
  const stateValue = stringValue(body.state);
  const provenance = provenanceOf(body);
  return {
    id,
    text,
    fact_type: factType(body.fact_type ?? body.type),
    state:
      stateValue === 'invalidated' || stateValue === 'invalid' || body.invalidated_at != null
        ? 'invalidated'
        : 'valid',
    mentioned_at: timestampValue(body.mentioned_at ?? body.date),
    occurred_start: timestampValue(body.occurred_start),
    occurred_end: timestampValue(body.occurred_end),
    entities: entityArray(body.entities),
    proof_count: nonNegativeInt(body.proof_count),
    tags: publicTags(body.tags),
    ...(provenance ? { provenance } : {}),
    context: normalizeContext(body.context),
    source_memories: sourceMemories,
    history_count: history,
    text_truncated: bytes > LIMITS.memoryPanelDetailTextBytes,
  };
}

export function normalizeEntityList(body: unknown): {
  items: InsightEntityItem[];
  total: number | null;
  raw_count: number;
} | null {
  if (!isRecord(body) || !Array.isArray(body.items)) return null;
  const items: InsightEntityItem[] = [];
  for (const entry of body.items) {
    if (!isRecord(entry)) continue;
    const id = stringValue(entry.id);
    if (!id) continue;
    items.push({
      id,
      name: truncateChars(stringValue(entry.canonical_name ?? entry.name) ?? id, 120),
      mention_count: nonNegativeInt(entry.mention_count ?? entry.mentionCount),
      first_seen: timestampValue(entry.first_seen),
      last_seen: timestampValue(entry.last_seen),
    });
  }
  const total = numberValue(body.total);
  return { items, total: total !== null ? Math.floor(total) : null, raw_count: body.items.length };
}

export function normalizeEntityDetail(
  body: unknown,
  requestedId: string,
): InsightEntityDetail | null {
  if (!isRecord(body)) return null;
  const id = stringValue(body.id) ?? requestedId;
  const observations: InsightEntityDetail['observations'] = [];
  if (Array.isArray(body.observations)) {
    for (const entry of body.observations.slice(0, 50)) {
      if (!isRecord(entry)) continue;
      const observationId = stringValue(entry.id);
      if (!observationId) continue;
      observations.push({
        id: observationId,
        text: truncateChars(stringValue(entry.text) ?? '', 500),
        proof_count: nonNegativeInt(entry.proof_count),
      });
    }
  }
  return {
    id,
    name: truncateChars(stringValue(body.canonical_name ?? body.name) ?? id, 120),
    mention_count: nonNegativeInt(body.mention_count ?? body.mentionCount),
    first_seen: timestampValue(body.first_seen),
    last_seen: timestampValue(body.last_seen),
    observations,
    memories: [],
  };
}

export function normalizeEntityGraph(
  body: unknown,
  options: { edgeLimit: number; nodeLimit: number; bytes: number },
): InsightEntityGraph | null {
  const graph = normalizeMemoryGraph(body, {
    nodeLimit: options.nodeLimit,
    edgeLimit: options.edgeLimit,
    textChars: 0,
    entityMode: true,
  });
  if (!graph) return null;
  // Hindsight 的 total_entities/total_edges 是本次返回子图的计数，不是全库总数；
  // 返回数达到请求边上限或服务端节点上限时无法证明图完整，必须标记 truncated。
  const capReached =
    graph.nodes.length >= options.nodeLimit || graph.edges.length >= options.edgeLimit;
  const result: InsightEntityGraph = {
    nodes: graph.nodes,
    edges: graph.edges,
    total_entities: graph.total_units,
    total_edges: graph.total_edges,
    raw_node_count: graph.raw_node_count,
    raw_edge_count: graph.raw_edge_count,
    limit: options.edgeLimit,
    truncated: graph.truncated || capReached,
  };
  const extraTrimmed = fitGraphBytes(result, options.bytes);
  if (extraTrimmed) result.truncated = true;
  return result;
}

/** 从尾部移除条目直到 JSON 不超过预算；返回移除数量。 */
export function fitItemsToBytes<T extends { items: unknown[] }>(
  value: T,
  maxBytes: number = LIMITS.toolResponseBytes - 8 * 1024,
): number {
  let dropped = 0;
  while (jsonBytes(value) > maxBytes && value.items.length > 0) {
    value.items.pop();
    dropped += 1;
  }
  return dropped;
}
