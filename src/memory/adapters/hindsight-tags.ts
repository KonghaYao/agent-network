/**
 * Hindsight 适配器的稳定身份/标签工具。
 *
 * 所有可被后端枚举的标签都使用固定前缀 + SHA-256 截断，不把原始 source id
 * 或 bank 路由直接写进 Hindsight 标签。document_id/operation_id 均可由服务端
 * 输入稳定重算，因此重试幂等且不依赖后端返回的内部 ID。
 */
import { sha256Hex } from '../../storage/db';
import type {
  MemorySourceDependency,
  MemorySourceRef,
  MemorySpaceRef,
} from '../contracts';
import {
  RAW_REPRESENTATION_KINDS,
  nonEmptyString,
} from './validation';

export {
  isEvidenceKind,
  isHex64,
  isOriginKind,
  isProducerKind,
  isRecord,
  isRepresentationKind,
  nonEmptyString,
  validEpoch,
  validSourceRef,
  validSpaceRef,
} from './validation';

export const ORIGIN_TAG = 'agentnet:o:';
export const SOURCE_TAG = 'agentnet:s:';
export const SOURCE_REVISION_TAG = 'agentnet:v:';
export const DEPENDENCY_TAG = 'agentnet:d:';
export const DEPENDENCY_REVISION_TAG = 'agentnet:dv:';
export const ANCHOR_TAG = 'agentnet:p:';
export const CURATED_TAG = 'agentnet:c:';
export const CURATED_REVISION_TAG = 'agentnet:cr:';
export const PARTITION_TAG = 'agentnet:g:';

export const RAW_KINDS = RAW_REPRESENTATION_KINDS;

export function metadataValue(metadata: Record<string, unknown> | null, key: string): string | null {
  if (!metadata) return null;
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** 只解析本适配器写入的 [source_id, revision] 数组；其它形状忽略。 */
export function parseDependencies(value: string | null): MemorySourceDependency[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const dependencies: MemorySourceDependency[] = [];
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const [sourceId, sourceRevision] = item as [unknown, unknown];
    if (!nonEmptyString(sourceId) || typeof sourceRevision !== 'number') continue;
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) continue;
    dependencies.push({
      source_id: sourceId,
      source_revision: sourceRevision,
      representation_id: null,
      range: null,
    });
  }
  return dependencies;
}

async function shortTag(prefix: string, value: string): Promise<string> {
  const digest = await sha256Hex(`agentnet:hindsight:tag:${value}`);
  return `${prefix}${digest.slice(0, 24)}`;
}

export async function sourceTag(sourceId: string): Promise<string> {
  return shortTag(SOURCE_TAG, `source:${sourceId}`);
}

export async function sourceRevisionTag(sourceId: string, revision: number): Promise<string> {
  return shortTag(SOURCE_REVISION_TAG, `source-revision:${sourceId}:${revision}`);
}

export async function dependencyTag(sourceId: string): Promise<string> {
  return shortTag(DEPENDENCY_TAG, `source:${sourceId}`);
}

export async function dependencyRevisionTag(sourceId: string, revision: number): Promise<string> {
  return shortTag(DEPENDENCY_REVISION_TAG, `source-revision:${sourceId}:${revision}`);
}

export async function anchorTag(representationId: string): Promise<string> {
  return shortTag(ANCHOR_TAG, `representation:${representationId}`);
}

export async function curatedTag(curatedId: string): Promise<string> {
  return shortTag(CURATED_TAG, `curated:${curatedId}`);
}

export async function curatedRevisionTag(curatedId: string, revision: number): Promise<string> {
  return shortTag(CURATED_REVISION_TAG, `curated-revision:${curatedId}:${revision}`);
}

export async function partitionTag(partitionId: string, generation: number): Promise<string> {
  return shortTag(PARTITION_TAG, `partition:${partitionId}:${generation}`);
}

export async function dependencyTags(
  dependencies: readonly MemorySourceDependency[],
): Promise<string[]> {
  const tags = new Set<string>();
  for (const dependency of dependencies) {
    tags.add(await dependencyTag(dependency.source_id));
    tags.add(await dependencyRevisionTag(dependency.source_id, dependency.source_revision));
  }
  return [...tags];
}

/** space + ownership + backend epoch -> 不可猜测的 bank 路由。 */
export async function bankIdFor(bankPrefix: string, space: MemorySpaceRef): Promise<string> {
  const digest = await sha256Hex(
    `agentnet:hindsight:bank:${space.space_id}:${space.ownership_epoch}:${space.backend_binding_epoch}`,
  );
  return `${bankPrefix}-${digest.slice(0, 40)}`;
}

export async function documentIdFor(space: MemorySpaceRef, key: string): Promise<string> {
  const digest = await sha256Hex(
    `agentnet:hindsight:document:${space.space_id}:${space.backend_binding_epoch}:${key}`,
  );
  return `an-${digest.slice(0, 40)}`;
}

/**
 * 稳定 UUID：同一 operation_key/space 的重试得到同一 operation_id；
 * 同 key 不同正文由后端 409 拒绝，而不是静默创建第二个作业。
 */
export async function operationIdFor(
  space: MemorySpaceRef,
  operationKey: string,
): Promise<string> {
  const hex = await sha256Hex(
    `agentnet:hindsight:operation:${space.space_id}:${space.backend_binding_epoch}:${operationKey}`,
  );
  const variant = (Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant.toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
