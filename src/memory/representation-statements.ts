/**
 * Memory 准确表示的写入语句（MF03）。
 *
 * 单独拆出以保持 statements.ts 低于仓库 1000 行上限；调用方负责先核对
 * text_bytes/text_sha256 与插入事务。
 */
import type { D1Like } from '../storage/queries';
import type { MemoryExactRepresentation, MemorySourceDependency } from './contracts';

export function memoryRepresentationInsertStatements(
  db: D1Like,
  input: {
    instanceId: string;
    exact: MemoryExactRepresentation;
    dependencies: readonly MemorySourceDependency[];
    now: number;
  },
): D1PreparedStatement[] {
  const representation = input.exact.representation;
  const raw =
    representation.kind === 'raw_full' ||
    representation.kind === 'raw_fragment' ||
    representation.kind === 'preview';
  const summary = representation.kind === 'summary';
  const context = representation.kind === 'memory_context';
  const authored = representation.kind === 'authored';
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO memory_representations
           (representation_id, instance_id, kind, source_id, source_revision, summary_id,
            summary_revision, source_context_id, producer_kind, lineage, partition_id,
            partition_generation, partition_policy_revision, range_start, range_end,
            text, text_bytes, text_sha256, verbatim, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM memory_representations WHERE representation_id = ?
          )`,
      )
      .bind(
        representation.representation_id,
        input.instanceId,
        representation.kind,
        raw || authored ? representation.source_id : null,
        raw || authored ? representation.source_revision : null,
        summary ? representation.summary_id : null,
        summary ? representation.revision : null,
        context ? representation.source_context_id : null,
        authored ? representation.producer_kind : null,
        authored ? representation.lineage : null,
        summary ? representation.partition_proof?.partition_id ?? null : null,
        summary ? representation.partition_proof?.generation ?? null : null,
        summary ? representation.partition_proof?.policy_revision ?? null : null,
        raw ? representation.range.start : null,
        raw ? representation.range.end : null,
        input.exact.text,
        representation.text_bytes,
        representation.text_sha256,
        representation.verbatim ? 1 : 0,
        input.now,
        representation.representation_id,
      ),
  ];
  input.dependencies.forEach((dependency, index) => {
    statements.push(
      db
        .prepare(
          `INSERT INTO memory_representation_dependencies
             (representation_id, dependency_index, source_id, source_revision,
              depends_on_representation_id, range_start, range_end)
           SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE NOT EXISTS (
              SELECT 1 FROM memory_representation_dependencies
               WHERE representation_id = ? AND dependency_index = ?
            )`,
        )
        .bind(
          representation.representation_id,
          index,
          dependency.source_id,
          dependency.source_revision,
          dependency.representation_id,
          dependency.range?.start ?? null,
          dependency.range?.end ?? null,
          representation.representation_id,
          index,
        ),
    );
  });
  return statements;
}


