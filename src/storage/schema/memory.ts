import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { actors } from './core';

/**
 * Memory 只读 schema。
 *
 * 迁移 SQL 仍是唯一事实源；这里只覆盖由 `storage/queries` 只读查询使用的表，
 * 列顺序与 `0045_memory_ledger.sql` / `0046_memory_experience_catchup.sql`
 * 完全一致，保证 `SELECT *` 返回的字段顺序不变。
 *
 * 写路径、作业/租约、治理命令流与不可变触发器继续保留 raw：
 * - `memory_jobs`、`memory_retain_intents`、`memory_governance_commands`、
 *   `memory_cursors`、`memory_projections`、`memory_space_transitions`；
 * - `memory_contexts_body_immutable` 等触发器不进入 Drizzle schema。
 *
 * 只导出表对象；表清单由 `schema/index.ts` 汇总后交给 parity 脚本派生。
 */
export const memoryInstances = sqliteTable(
  'memory_instances',
  {
    instance_id: text('instance_id'),
    capture_default: text('capture_default', { enum: ['enabled', 'disabled'] })
      .notNull()
      .default('enabled'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.instance_id] }),
    check(
      'memory_instances_capture_default_check',
      sql`${table.capture_default} in ('enabled', 'disabled')`,
    ),
  ],
);

export const memorySpaces = sqliteTable(
  'memory_spaces',
  {
    space_id: text('space_id'),
    instance_id: text('instance_id')
      .notNull()
      .references(() => memoryInstances.instance_id),
    agent_actor_id: text('agent_actor_id')
      .notNull()
      .references(() => actors.actor_id),
    owner_actor_id: text('owner_actor_id')
      .notNull()
      .references(() => actors.actor_id),
    ownership_kind: text('ownership_kind', { enum: ['managed', 'self_owned'] }).notNull(),
    ownership_epoch: integer('ownership_epoch').notNull(),
    backend_binding_epoch: integer('backend_binding_epoch').notNull().default(1),
    management_binding_id: text('management_binding_id'),
    capture: text('capture', { enum: ['none', 'pending', 'extracted', 'excluded'] })
      .notNull()
      .default('pending'),
    active: integer('active').notNull().default(1),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.space_id] }),
    uniqueIndex('idx_memory_spaces_active')
      .on(table.agent_actor_id)
      .where(sql`${table.active} = 1`),
    index('idx_memory_spaces_owner').on(table.owner_actor_id, table.active),
    index('idx_memory_spaces_instance').on(table.instance_id, table.active),
    check(
      'memory_spaces_ownership_kind_check',
      sql`${table.ownership_kind} in ('managed', 'self_owned')`,
    ),
    check('memory_spaces_ownership_epoch_check', sql`${table.ownership_epoch} >= 1`),
    check('memory_spaces_backend_binding_epoch_check', sql`${table.backend_binding_epoch} >= 1`),
    check(
      'memory_spaces_capture_check',
      sql`${table.capture} in ('none', 'pending', 'extracted', 'excluded')`,
    ),
    check('memory_spaces_active_check', sql`${table.active} in (0, 1)`),
  ],
);

export const memorySources = sqliteTable(
  'memory_sources',
  {
    source_id: text('source_id'),
    instance_id: text('instance_id').notNull(),
    source_key: text('source_key').notNull(),
    source_kind: text('source_kind', {
      enum: [
        'message',
        'task_offer',
        'task_detail',
        'task_attachment',
        'task_submission',
        'task_review',
        'task_handoff',
        'file',
        'langfuse_observation',
        'manual',
      ],
    }).notNull(),
    business_ref_kind: text('business_ref_kind').notNull(),
    business_ref_json: text('business_ref_json').notNull(),
    origin_room_id: text('origin_room_id'),
    origin_member_generation: integer('origin_member_generation').notNull().default(0),
    origin_policy_revision: integer('origin_policy_revision').notNull().default(0),
    origin_joined_seq: integer('origin_joined_seq').notNull().default(0),
    origin_joined_at: integer('origin_joined_at').notNull().default(0),
    origin_archive_head_seq: integer('origin_archive_head_seq'),
    origin_seq: integer('origin_seq'),
    origin_created_at: integer('origin_created_at').notNull(),
    author_actor_id: text('author_actor_id'),
    state: text('state', { enum: ['active', 'superseded', 'retracted'] }).notNull(),
    revision: integer('revision').notNull(),
    content_text: text('content_text'),
    content_sha256: text('content_sha256'),
    content_bytes: integer('content_bytes'),
    superseded_by_source_id: text('superseded_by_source_id'),
    superseded_by_revision: integer('superseded_by_revision'),
    retracted_at: integer('retracted_at'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.source_id] }),
    uniqueIndex('idx_memory_sources_revision').on(
      table.instance_id,
      table.source_key,
      table.revision,
    ),
    uniqueIndex('idx_memory_sources_active')
      .on(table.instance_id, table.source_key)
      .where(sql`${table.state} = 'active'`),
    index('idx_memory_sources_room').on(
      table.origin_room_id,
      table.state,
      table.origin_created_at,
    ),
    index('idx_memory_sources_author').on(table.author_actor_id, table.state),
    check(
      'memory_sources_source_kind_check',
      sql`${table.source_kind} in ('message', 'task_offer', 'task_detail', 'task_attachment', 'task_submission', 'task_review', 'task_handoff', 'file', 'langfuse_observation', 'manual')`,
    ),
    check(
      'memory_sources_origin_member_generation_check',
      sql`${table.origin_member_generation} >= 0`,
    ),
    check(
      'memory_sources_origin_policy_revision_check',
      sql`${table.origin_policy_revision} >= 0`,
    ),
    check('memory_sources_state_check', sql`${table.state} in ('active', 'superseded', 'retracted')`),
    check('memory_sources_revision_check', sql`${table.revision} >= 1`),
    check(
      'memory_sources_content_bytes_check',
      sql`${table.content_bytes} is null or ${table.content_bytes} >= 0`,
    ),
  ],
);

export const memoryCurated = sqliteTable(
  'memory_curated',
  {
    curated_id: text('curated_id').notNull(),
    revision: integer('revision').notNull(),
    space_id: text('space_id')
      .notNull()
      .references(() => memorySpaces.space_id),
    ownership_epoch: integer('ownership_epoch').notNull(),
    origin: text('origin', { enum: ['manual', 'imported_external_knowledge'] }).notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    content_sha256: text('content_sha256').notNull(),
    current: integer('current').notNull().default(1),
    created_by: text('created_by').notNull(),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.curated_id, table.revision] }),
    uniqueIndex('idx_memory_curated_current')
      .on(table.curated_id)
      .where(sql`${table.current} = 1`),
    index('idx_memory_curated_space').on(table.space_id, table.current),
    check('memory_curated_revision_check', sql`${table.revision} >= 1`),
    check('memory_curated_ownership_epoch_check', sql`${table.ownership_epoch} >= 1`),
    check(
      'memory_curated_origin_check',
      sql`${table.origin} in ('manual', 'imported_external_knowledge')`,
    ),
    check('memory_curated_current_check', sql`${table.current} in (0, 1)`),
  ],
);

export const memoryRepresentations = sqliteTable(
  'memory_representations',
  {
    representation_id: text('representation_id'),
    instance_id: text('instance_id').notNull(),
    kind: text('kind', {
      enum: ['raw_full', 'raw_fragment', 'preview', 'summary', 'memory_context', 'authored'],
    }).notNull(),
    source_id: text('source_id'),
    source_revision: integer('source_revision'),
    summary_id: text('summary_id'),
    summary_revision: integer('summary_revision'),
    source_context_id: text('source_context_id'),
    producer_kind: text('producer_kind', { enum: ['agent_text', 'server_template', 'mixed'] }),
    lineage: text('lineage', { enum: ['run_bound', 'lineage_unknown'] }),
    partition_id: text('partition_id'),
    partition_generation: integer('partition_generation'),
    partition_policy_revision: integer('partition_policy_revision'),
    range_start: integer('range_start'),
    range_end: integer('range_end'),
    text: text('text').notNull(),
    text_bytes: integer('text_bytes').notNull(),
    text_sha256: text('text_sha256').notNull(),
    verbatim: integer('verbatim').notNull(),
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.representation_id] }),
    index('idx_memory_representations_source').on(table.source_id, table.source_revision),
    index('idx_memory_representations_summary').on(table.summary_id, table.summary_revision),
    check(
      'memory_representations_kind_check',
      sql`${table.kind} in ('raw_full', 'raw_fragment', 'preview', 'summary', 'memory_context', 'authored')`,
    ),
    check(
      'memory_representations_producer_kind_check',
      sql`${table.producer_kind} is null or ${table.producer_kind} in ('agent_text', 'server_template', 'mixed')`,
    ),
    check(
      'memory_representations_lineage_check',
      sql`${table.lineage} is null or ${table.lineage} in ('run_bound', 'lineage_unknown')`,
    ),
    check('memory_representations_text_bytes_check', sql`${table.text_bytes} >= 0`),
    check('memory_representations_verbatim_check', sql`${table.verbatim} in (0, 1)`),
    check(
      'memory_representations_range_check',
      sql`${table.range_start} is null or (${table.range_start} >= 0 and ${table.range_end} > ${table.range_start})`,
    ),
  ],
);

export const memoryRepresentationDependencies = sqliteTable(
  'memory_representation_dependencies',
  {
    representation_id: text('representation_id')
      .notNull()
      .references(() => memoryRepresentations.representation_id),
    dependency_index: integer('dependency_index').notNull(),
    source_id: text('source_id').notNull(),
    source_revision: integer('source_revision').notNull(),
    depends_on_representation_id: text('depends_on_representation_id'),
    range_start: integer('range_start'),
    range_end: integer('range_end'),
  },
  (table) => [
    primaryKey({ columns: [table.representation_id, table.dependency_index] }),
    index('idx_memory_representation_dependencies_source').on(
      table.source_id,
      table.source_revision,
    ),
    check(
      'memory_representation_dependencies_index_check',
      sql`${table.dependency_index} >= 0`,
    ),
  ],
);

export const memorySelections = sqliteTable(
  'memory_selections',
  {
    selection_id: text('selection_id'),
    space_id: text('space_id')
      .notNull()
      .references(() => memorySpaces.space_id),
    ownership_epoch: integer('ownership_epoch').notNull(),
    agent_actor_id: text('agent_actor_id').notNull(),
    recall_id: text('recall_id'),
    representation_id: text('representation_id')
      .notNull()
      .references(() => memoryRepresentations.representation_id),
    origin_scope_json: text('origin_scope_json').notNull(),
    target_scope_json: text('target_scope_json').notNull(),
    versions_json: text('versions_json').notNull(),
    consumption: text('consumption', { enum: ['not_consumed'] })
      .notNull()
      .default('not_consumed'),
    state: text('state', { enum: ['available', 'expired'] }).notNull(),
    issued_at: integer('issued_at').notNull(),
    expires_at: integer('expires_at'),
  },
  (table) => [
    primaryKey({ columns: [table.selection_id] }),
    index('idx_memory_selections_space').on(table.space_id, table.state, table.issued_at),
    index('idx_memory_selections_recall')
      .on(table.recall_id)
      .where(sql`${table.recall_id} is not null`),
    check(
      'memory_selections_consumption_check',
      sql`${table.consumption} = 'not_consumed'`,
    ),
    check('memory_selections_state_check', sql`${table.state} in ('available', 'expired')`),
  ],
);

export const memoryManifests = sqliteTable(
  'memory_manifests',
  {
    manifest_id: text('manifest_id'),
    space_id: text('space_id')
      .notNull()
      .references(() => memorySpaces.space_id),
    ownership_epoch: integer('ownership_epoch').notNull(),
    agent_actor_id: text('agent_actor_id').notNull(),
    host_binding_id: text('host_binding_id'),
    host_generation: integer('host_generation'),
    session_incarnation: text('session_incarnation'),
    run_id: text('run_id'),
    input_id: text('input_id'),
    input_revision: integer('input_revision'),
    invocation_id: text('invocation_id'),
    manifest_sha256: text('manifest_sha256').notNull(),
    payload_sha256: text('payload_sha256').notNull(),
    target_json: text('target_json').notNull(),
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.manifest_id] }),
    uniqueIndex('idx_memory_manifests_invocation')
      .on(
        table.space_id,
        table.ownership_epoch,
        table.agent_actor_id,
        table.host_binding_id,
        table.invocation_id,
      )
      .where(sql`${table.host_binding_id} is not null and ${table.invocation_id} is not null`),
  ],
);

export const memoryManifestItems = sqliteTable(
  'memory_manifest_items',
  {
    manifest_id: text('manifest_id')
      .notNull()
      .references(() => memoryManifests.manifest_id),
    item_index: integer('item_index').notNull(),
    selection_id: text('selection_id'),
    representation_id: text('representation_id').notNull(),
    origin_scope_json: text('origin_scope_json').notNull(),
    text_sha256: text('text_sha256').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.manifest_id, table.item_index] }),
    check('memory_manifest_items_index_check', sql`${table.item_index} >= 0`),
  ],
);

export const memoryRecallRequests = sqliteTable(
  'memory_recall_requests',
  {
    recall_id: text('recall_id'),
    space_id: text('space_id')
      .notNull()
      .references(() => memorySpaces.space_id),
    ownership_epoch: integer('ownership_epoch').notNull(),
    agent_actor_id: text('agent_actor_id').notNull(),
    request_key: text('request_key').notNull(),
    mode: text('mode').notNull(),
    dispatch: text('dispatch', { enum: ['explicit', 'auto'] }).notNull(),
    status: text('status', {
      enum: [
        'pending',
        'ready',
        'empty',
        'unavailable',
        'unsupported',
        'disabled',
        'skipped_no_boundary',
      ],
    }).notNull(),
    target_json: text('target_json'),
    plan_json: text('plan_json'),
    budget_json: text('budget_json'),
    warmup_only: integer('warmup_only').notNull().default(1),
    result_json: text('result_json'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    expires_at: integer('expires_at'),
  },
  (table) => [
    primaryKey({ columns: [table.recall_id] }),
    uniqueIndex('idx_memory_recall_request_key').on(table.space_id, table.request_key),
    index('idx_memory_recall_status').on(table.space_id, table.status, table.created_at),
    check(
      'memory_recall_requests_dispatch_check',
      sql`${table.dispatch} in ('explicit', 'auto')`,
    ),
    check(
      'memory_recall_requests_status_check',
      sql`${table.status} in ('pending', 'ready', 'empty', 'unavailable', 'unsupported', 'disabled', 'skipped_no_boundary')`,
    ),
    check('memory_recall_requests_warmup_check', sql`${table.warmup_only} in (0, 1)`),
  ],
);

export const memoryContexts = sqliteTable(
  'memory_contexts',
  {
    context_id: text('context_id'),
    space_id: text('space_id')
      .notNull()
      .references(() => memorySpaces.space_id),
    ownership_epoch: integer('ownership_epoch').notNull(),
    agent_actor_id: text('agent_actor_id').notNull(),
    recall_id: text('recall_id'),
    kind: text('kind', { enum: ['lookup', 'bound'] }).notNull(),
    body: text('body').notNull(),
    body_sha256: text('body_sha256').notNull(),
    body_bytes: integer('body_bytes').notNull(),
    target_json: text('target_json'),
    versions_json: text('versions_json').notNull(),
    policy_version: integer('policy_version').notNull(),
    status: text('status', { enum: ['ready', 'invalidated', 'expired', 'purged'] }).notNull(),
    created_at: integer('created_at').notNull(),
    expires_at: integer('expires_at'),
    updated_at: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.context_id] }),
    index('idx_memory_contexts_agent').on(
      table.space_id,
      table.agent_actor_id,
      table.status,
      table.created_at,
    ),
    check('memory_contexts_kind_check', sql`${table.kind} in ('lookup', 'bound')`),
    check('memory_contexts_body_bytes_check', sql`${table.body_bytes} >= 0`),
    check(
      'memory_contexts_status_check',
      sql`${table.status} in ('ready', 'invalidated', 'expired', 'purged')`,
    ),
  ],
);

export const memoryContextItems = sqliteTable(
  'memory_context_items',
  {
    context_id: text('context_id')
      .notNull()
      .references(() => memoryContexts.context_id),
    item_index: integer('item_index').notNull(),
    experience_id: text('experience_id'),
    representation_id: text('representation_id').notNull(),
    source_dependencies_json: text('source_dependencies_json').notNull(),
    evidence: text('evidence'),
    origin_scope_json: text('origin_scope_json').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.context_id, table.item_index] }),
    index('idx_memory_context_items_representation').on(table.representation_id),
    check('memory_context_items_index_check', sql`${table.item_index} >= 0`),
  ],
);

export const memoryExperiences = sqliteTable(
  'memory_experiences',
  {
    experience_id: text('experience_id'),
    dedupe_key: text('dedupe_key').notNull().unique(),
    space_id: text('space_id')
      .notNull()
      .references(() => memorySpaces.space_id),
    ownership_epoch: integer('ownership_epoch').notNull(),
    agent_actor_id: text('agent_actor_id').notNull(),
    origin_room_id: text('origin_room_id'),
    origin_member_generation: integer('origin_member_generation').notNull().default(0),
    origin_kind: text('origin_kind', { enum: ['experienced', 'authored', 'curated'] }).notNull(),
    producer_kind: text('producer_kind', { enum: ['agent_text', 'server_template', 'mixed'] }),
    source_id: text('source_id'),
    source_revision: integer('source_revision'),
    representation_id: text('representation_id')
      .notNull()
      .references(() => memoryRepresentations.representation_id),
    representation_kind: text('representation_kind', {
      enum: ['raw_full', 'raw_fragment', 'preview', 'summary', 'memory_context', 'authored'],
    }).notNull(),
    range_start: integer('range_start'),
    range_end: integer('range_end'),
    text_sha256: text('text_sha256').notNull(),
    receipt_id: text('receipt_id'),
    evidence: text('evidence'),
    capture: text('capture', { enum: ['none', 'pending', 'extracted', 'excluded'] }).notNull(),
    available: integer('available').notNull().default(1),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.experience_id] }),
    index('idx_memory_experiences_lookup').on(
      table.space_id,
      table.ownership_epoch,
      table.agent_actor_id,
      table.origin_room_id,
      table.origin_member_generation,
      table.created_at,
    ),
    index('idx_memory_experiences_representation').on(table.representation_id),
    index('idx_memory_experiences_source').on(table.source_id, table.source_revision),
    index('idx_memory_experiences_kind').on(
      table.space_id,
      table.ownership_epoch,
      table.agent_actor_id,
      table.origin_room_id,
      table.origin_member_generation,
      table.origin_kind,
      table.created_at,
    ),
    check('memory_experiences_ownership_epoch_check', sql`${table.ownership_epoch} >= 1`),
    check(
      'memory_experiences_origin_kind_check',
      sql`${table.origin_kind} in ('experienced', 'authored', 'curated')`,
    ),
    check(
      'memory_experiences_producer_kind_check',
      sql`${table.producer_kind} is null or ${table.producer_kind} in ('agent_text', 'server_template', 'mixed')`,
    ),
    check(
      'memory_experiences_capture_check',
      sql`${table.capture} in ('none', 'pending', 'extracted', 'excluded')`,
    ),
    check('memory_experiences_available_check', sql`${table.available} in (0, 1)`),
  ],
);

export const memoryCoverageRanges = sqliteTable(
  'memory_coverage_ranges',
  {
    coverage_id: text('coverage_id'),
    dedupe_key: text('dedupe_key').notNull().unique(),
    space_id: text('space_id')
      .notNull()
      .references(() => memorySpaces.space_id),
    ownership_epoch: integer('ownership_epoch').notNull(),
    agent_actor_id: text('agent_actor_id').notNull(),
    origin_room_id: text('origin_room_id').notNull(),
    origin_member_generation: integer('origin_member_generation').notNull(),
    source_id: text('source_id').notNull(),
    source_revision: integer('source_revision').notNull(),
    range_start: integer('range_start').notNull(),
    range_end: integer('range_end').notNull(),
    text_sha256: text('text_sha256').notNull(),
    experience_id: text('experience_id')
      .notNull()
      .references(() => memoryExperiences.experience_id),
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.coverage_id] }),
    index('idx_memory_coverage_scope').on(
      table.space_id,
      table.ownership_epoch,
      table.agent_actor_id,
      table.origin_room_id,
      table.origin_member_generation,
      table.source_id,
      table.source_revision,
    ),
    check('memory_coverage_ranges_start_check', sql`${table.range_start} >= 0`),
    check('memory_coverage_ranges_end_check', sql`${table.range_end} > ${table.range_start}`),
  ],
);

export const memoryReceipts = sqliteTable(
  'memory_receipts',
  {
    receipt_id: text('receipt_id'),
    kind: text('kind', { enum: ['input_exposure', 'context_delivery'] }).notNull(),
    space_id: text('space_id')
      .notNull()
      .references(() => memorySpaces.space_id),
    ownership_epoch: integer('ownership_epoch').notNull(),
    agent_actor_id: text('agent_actor_id').notNull(),
    host_binding_id: text('host_binding_id'),
    host_generation: integer('host_generation'),
    session_incarnation: text('session_incarnation'),
    run_id: text('run_id'),
    input_id: text('input_id'),
    input_revision: integer('input_revision'),
    invocation_id: text('invocation_id'),
    manifest_id: text('manifest_id'),
    manifest_sha256: text('manifest_sha256'),
    payload_sha256: text('payload_sha256'),
    context_id: text('context_id'),
    context_sha256: text('context_sha256'),
    target_scope_json: text('target_scope_json').notNull(),
    origin_scopes_json: text('origin_scopes_json').notNull().default('[]'),
    evidence: text('evidence').notNull(),
    proof_id: text('proof_id').notNull(),
    idempotency_key: text('idempotency_key').notNull(),
    disposition: text('disposition', { enum: ['applied', 'history_only', 'rejected'] }).notNull(),
    reason: text('reason'),
    recorded_at: integer('recorded_at').notNull(),
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.receipt_id] }),
    uniqueIndex('idx_memory_receipts_idempotency').on(table.idempotency_key),
    uniqueIndex('idx_memory_receipts_invocation')
      .on(
        table.kind,
        table.space_id,
        table.ownership_epoch,
        table.agent_actor_id,
        table.host_binding_id,
        table.invocation_id,
      )
      .where(sql`${table.host_binding_id} is not null and ${table.invocation_id} is not null`),
    uniqueIndex('idx_memory_receipts_proof').on(table.proof_id),
    index('idx_memory_receipts_space').on(table.space_id, table.kind, table.recorded_at),
    check(
      'memory_receipts_kind_check',
      sql`${table.kind} in ('input_exposure', 'context_delivery')`,
    ),
    check(
      'memory_receipts_disposition_check',
      sql`${table.disposition} in ('applied', 'history_only', 'rejected')`,
    ),
  ],
);

export const memoryHostBindings = sqliteTable(
  'memory_host_bindings',
  {
    binding_id: text('binding_id'),
    space_id: text('space_id')
      .notNull()
      .references(() => memorySpaces.space_id),
    ownership_epoch: integer('ownership_epoch').notNull(),
    agent_actor_id: text('agent_actor_id').notNull(),
    credential_id: text('credential_id').notNull(),
    generation: integer('generation').notNull(),
    session_incarnation: text('session_incarnation').notNull(),
    declared_capabilities_json: text('declared_capabilities_json').notNull().default('[]'),
    trust_level: text('trust_level', {
      enum: ['api_tool_only', 'adapted_host', 'controlled_gateway'],
    }).notNull(),
    state: text('state', { enum: ['active', 'closed', 'expired', 'revoked'] }).notNull(),
    lease_until: integer('lease_until'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    closed_at: integer('closed_at'),
  },
  (table) => [
    primaryKey({ columns: [table.binding_id] }),
    uniqueIndex('idx_memory_host_bindings_active')
      .on(table.space_id, table.session_incarnation)
      .where(sql`${table.state} = 'active'`),
    index('idx_memory_host_bindings_agent').on(
      table.agent_actor_id,
      table.state,
      sql`${table.updated_at} desc`,
    ),
    check('memory_host_bindings_ownership_epoch_check', sql`${table.ownership_epoch} >= 1`),
    check('memory_host_bindings_generation_check', sql`${table.generation} >= 1`),
    check(
      'memory_host_bindings_trust_level_check',
      sql`${table.trust_level} in ('api_tool_only', 'adapted_host', 'controlled_gateway')`,
    ),
    check(
      'memory_host_bindings_state_check',
      sql`${table.state} in ('active', 'closed', 'expired', 'revoked')`,
    ),
  ],
);

export const memoryCatchupPlans = sqliteTable(
  'memory_catchup_plans',
  {
    plan_id: text('plan_id'),
    space_id: text('space_id')
      .notNull()
      .references(() => memorySpaces.space_id),
    ownership_epoch: integer('ownership_epoch').notNull(),
    agent_actor_id: text('agent_actor_id').notNull(),
    room_id: text('room_id').notNull(),
    member_generation: integer('member_generation').notNull(),
    upper_bound: integer('upper_bound').notNull(),
    query: text('query').notNull(),
    status: text('status', {
      enum: ['ready', 'partial', 'missing_required', 'expired'],
    }).notNull(),
    budget_json: text('budget_json').notNull(),
    scan_cursor_json: text('scan_cursor_json'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    expires_at: integer('expires_at'),
    request_key: text('request_key'),
    request_sha256: text('request_sha256'),
    policy_revision: integer('policy_revision').notNull().default(0),
    member_seq: integer('member_seq').notNull().default(0),
    joined_seq: integer('joined_seq').notNull().default(0),
    snapshot_sha256: text('snapshot_sha256'),
  },
  (table) => [
    primaryKey({ columns: [table.plan_id] }),
    index('idx_memory_catchup_agent').on(
      table.space_id,
      table.agent_actor_id,
      table.room_id,
      table.status,
    ),
    uniqueIndex('idx_memory_catchup_request')
      .on(table.space_id, table.agent_actor_id, table.request_key)
      .where(sql`${table.request_key} is not null`),
    index('idx_memory_catchup_snapshot').on(
      table.space_id,
      table.agent_actor_id,
      table.room_id,
      table.member_generation,
      table.upper_bound,
    ),
    check(
      'memory_catchup_plans_status_check',
      sql`${table.status} in ('ready', 'partial', 'missing_required', 'expired')`,
    ),
  ],
);

export const memoryCatchupItems = sqliteTable(
  'memory_catchup_items',
  {
    plan_id: text('plan_id')
      .notNull()
      .references(() => memoryCatchupPlans.plan_id),
    item_index: integer('item_index').notNull(),
    message_id: text('message_id').notNull(),
    created_seq: integer('created_seq').notNull(),
    selection_state: text('selection_state', {
      enum: ['selected', 'not_selected', 'missing'],
    }).notNull(),
    reason: text('reason'),
  },
  (table) => [
    primaryKey({ columns: [table.plan_id, table.item_index] }),
    check('memory_catchup_items_index_check', sql`${table.item_index} >= 0`),
    check(
      'memory_catchup_items_selection_state_check',
      sql`${table.selection_state} in ('selected', 'not_selected', 'missing')`,
    ),
  ],
);

export const memoryExperienceProofs = sqliteTable(
  'memory_experience_proofs',
  {
    experience_id: text('experience_id')
      .notNull()
      .references(() => memoryExperiences.experience_id),
    proof_id: text('proof_id').notNull(),
    receipt_id: text('receipt_id'),
    evidence: text('evidence', {
      enum: ['host_reported_submitted', 'gateway_observed_submitted'],
    }).notNull(),
    invocation_id: text('invocation_id').notNull(),
    manifest_id: text('manifest_id'),
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.experience_id, table.proof_id] }),
    index('idx_memory_experience_proofs_proof').on(table.proof_id),
    index('idx_memory_experience_proofs_evidence').on(table.experience_id, table.evidence),
    check(
      'memory_experience_proofs_evidence_check',
      sql`${table.evidence} in ('host_reported_submitted', 'gateway_observed_submitted')`,
    ),
  ],
);

export const memoryTombstones = sqliteTable(
  'memory_tombstones',
  {
    tombstone_id: text('tombstone_id'),
    instance_id: text('instance_id').notNull(),
    target_kind: text('target_kind', {
      enum: ['source', 'source_key', 'representation', 'curated', 'space', 'partition', 'context'],
    }).notNull(),
    target_id: text('target_id').notNull(),
    source_key: text('source_key'),
    reason: text('reason', {
      enum: ['recall', 'forget', 'permission', 'file_deleted', 'transfer', 'policy'],
    }).notNull(),
    command_id: text('command_id'),
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tombstone_id] }),
    uniqueIndex('idx_memory_tombstones_target').on(
      table.target_kind,
      table.target_id,
      table.reason,
    ),
    index('idx_memory_tombstones_source_key')
      .on(table.source_key)
      .where(sql`${table.source_key} is not null`),
    check(
      'memory_tombstones_target_kind_check',
      sql`${table.target_kind} in ('source', 'source_key', 'representation', 'curated', 'space', 'partition', 'context')`,
    ),
    check(
      'memory_tombstones_reason_check',
      sql`${table.reason} in ('recall', 'forget', 'permission', 'file_deleted', 'transfer', 'policy')`,
    ),
  ],
);

/** 只导出 4C-6 覆盖的表；未列出的 memory 表仍由迁移 SQL 独占。 */
