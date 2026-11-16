/**
 * 持久表示行 → 适配器可消费的准确表示。
 *
 * 只做纯映射：不读环境、不调用后端；缺失字段抛错，让运行时显式失败而不是
 * 发送伪造的 range/hash。正文由调用方从同一行读取并再次校验 hash。
 */
import type { MemoryRepresentation } from './contracts';
import type { MemoryRepresentationRow } from './rows';

export function representationFromRow(row: MemoryRepresentationRow): MemoryRepresentation {
  const base = {
    representation_id: row.representation_id,
    text_bytes: row.text_bytes,
    text_sha256: row.text_sha256,
    verbatim: row.verbatim === 1,
  };
  switch (row.kind) {
    case 'raw_full':
    case 'raw_fragment':
    case 'preview': {
      if (
        row.source_id === null ||
        row.source_revision === null ||
        row.range_start === null ||
        row.range_end === null
      ) {
        throw new Error('raw representation missing source/range');
      }
      return {
        ...base,
        kind: row.kind,
        source_id: row.source_id,
        source_revision: row.source_revision,
        range: { start: row.range_start, end: row.range_end },
        depends_on: [],
      };
    }
    case 'summary':
      if (row.summary_id === null || row.summary_revision === null) {
        throw new Error('summary representation missing id/revision');
      }
      return {
        ...base,
        kind: 'summary',
        summary_id: row.summary_id,
        revision: row.summary_revision,
        depends_on: [],
        partition_proof:
          row.partition_id &&
          row.partition_generation !== null &&
          row.partition_policy_revision !== null
            ? {
                partition_id: row.partition_id,
                generation: row.partition_generation,
                policy_revision: row.partition_policy_revision,
                source_ids: [],
              }
            : null,
      };
    case 'memory_context':
      if (row.source_context_id === null) {
        throw new Error('context representation missing context id');
      }
      return {
        ...base,
        kind: 'memory_context',
        source_context_id: row.source_context_id,
        depends_on: [],
      };
    case 'authored':
      if (row.source_id === null || row.source_revision === null || row.producer_kind === null) {
        throw new Error('authored representation missing source/producer');
      }
      return {
        ...base,
        kind: 'authored',
        source_id: row.source_id,
        source_revision: row.source_revision,
        producer_kind: row.producer_kind,
        lineage: row.lineage ?? 'lineage_unknown',
        depends_on: [],
      };
  }
}
