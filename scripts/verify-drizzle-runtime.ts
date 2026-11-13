/**
 * 4C-1 Drizzle 只读查询运行时对比。
 *
 * 对 `src/storage/queries.ts` 中已迁移到 Drizzle 的读查询（core + 4C-6 memory），逐条执行：
 * 1. 手写 SQL（迁移前的原语句）与 Drizzle 构建结果逐行比较，包含字段顺序；
 * 2. 比较 `EXPLAIN QUERY PLAN`，确认索引选择与扫描顺序不变；
 * 3. 记录 raw / Drizzle 构建+执行的基准耗时。
 *
 * 只读内存库，不触碰真实 DATA_DIR；执行仍走生产同款 `createD1()` shim。
 *
 * 用法：`bun scripts/verify-drizzle-runtime.ts`
 */

import { Database } from 'bun:sqlite';
import { and, desc, eq, inArray, lt, ne, or } from 'drizzle-orm';
import { resolve } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { orm, schema } from '../src/storage/drizzle';
import {
  activeRoomCount,
  countActiveMemoryHostBindings,
  getActiveMemoryHostBindingBySession,
  getActiveMemorySourceByKey,
  getActiveMemorySpace,
  getActor,
  getActorBySession,
  getActorManagementByIds,
  getActorsByIds,
  getCredentialByHash,
  getCurrentCuratedRevision,
  getEventsMinSeq,
  getLatestActiveMemoryHostBinding,
  getLatestMemoryReceiptForManifest,
  getLatestMemorySource,
  getMember,
  getMemoryCatchupPlan,
  getMemoryCatchupPlanByRequestKey,
  getMemoryContext,
  getMemoryExperience,
  getMemoryExperienceByDedupe,
  getMemoryHostBinding,
  getMemoryInstance,
  getMemoryManifest,
  getMemoryManifestByInvocation,
  getMemoryRecallRequest,
  getMemoryRecallRequestByKey,
  getMemoryReceipt,
  getMemoryReceiptByIdempotencyKey,
  getMemoryReceiptByInvocation,
  getMemoryRepresentation,
  getMemoryRepresentationSourceId,
  getMemorySelection,
  getMemorySourceRevision,
  getMemorySpaceById,
  getRoom,
  hasMemoryGatewayProof,
  hasMemoryReceiptForManifest,
  isActiveMember,
  isMemoryTargetTombstoned,
  isMemoryTombstonedBySourceKey,
  listActiveMemoryHostBindingIds,
  listActiveRoomPeers,
  listCurrentCuratedMemories,
  listMemoryCatchupItems,
  listMemoryContextItems,
  listMemoryContextSummaries,
  listMemoryCoverageRanges,
  listMemoryManifestItems,
  listMemoryRecallCandidates,
  listMemoryRepresentationDependencies,
  listMemoryRepresentationDependencyLinks,
  memorySpaceExists,
} from '../src/storage/queries';
import { check, checkEqual, checksPassed } from './lib/harness';

const ROOT = resolve(import.meta.dir, '..');
const MIGRATIONS = resolve(ROOT, 'migrations');

function seed(sqlite: Database): void {
  const actor = sqlite.prepare(
    `INSERT INTO actors
       (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
        pending_count, created_at, updated_at, archived_at, archived_by,
        disabled_at, disabled_by, disabled_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const actors: [string, string, string | null, string, number, number, number, number][] = [
    ['act_human_1', 'human', null, 'Alice', 11, 7, 0, 100],
    ['act_human_2', 'human', null, 'Bob', 0, 0, 0, 101],
    ['act_agent_1', 'agent', 'sess_atlas', 'Atlas', 0, 0, 2, 102],
    ['act_agent_2', 'agent', 'sess_bravo', 'Bravo', 0, 3, 0, 103],
    ['act_agent_3', 'agent', null, 'Charlie', 0, 0, 0, 104],
  ];
  for (const [id, kind, session, name, head, min, pending, created] of actors) {
    const archived = id === 'act_agent_2' ? 1_000 : null;
    const archivedBy = id === 'act_agent_2' ? 'act_human_1' : null;
    const disabled = id === 'act_agent_3' ? 2_000 : null;
    const disabledBy = id === 'act_agent_3' ? 'act_human_1' : null;
    const reason = id === 'act_agent_3' ? 'retired' : null;
    actor.run(
      id,
      kind,
      session,
      name,
      '{}',
      head,
      min,
      pending,
      created,
      created + 1,
      archived,
      archivedBy,
      disabled,
      disabledBy,
      reason,
    );
  }

  const credential = sqlite.prepare(
    `INSERT INTO credentials
       (credential_id, actor_id, device_id, token_hash, revoked_at, created_at,
        last_used_at, revoked_by, label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  credential.run('cred_h1', 'act_human_1', 'dev_1', 'hash_h1', null, 10, 12, null, 'laptop');
  credential.run(
    'cred_a1',
    'act_agent_1',
    'dev_2',
    'hash_a1',
    20,
    11,
    null,
    'act_human_1',
    null,
  );
  credential.run('cred_a2', 'act_agent_2', 'dev_3', 'hash_a2', null, 12, null, null, null);

  const room = sqlite.prepare(
    `INSERT INTO rooms
       (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
        member_seq, last_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  room.run('room_direct_1', 'direct', null, '', 'pair_h1_a1', 5, 3, 2, null, 200, 300);
  room.run('room_direct_2', 'direct', null, '', 'pair_h1_a2', 2, 1, 2, null, 201, 200);
  room.run('room_group_1', 'group', 'act_human_1', 'Team', null, 9, 4, 4, null, 202, 400);

  const member = sqlite.prepare(
    `INSERT INTO room_members
       (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
        role_revision, updated_at, member_generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  member.run('room_direct_1', 'act_human_1', 'owner', 'active', 1, 2, 210, 1, 210, 1);
  member.run('room_direct_1', 'act_agent_1', 'member', 'active', 1, 1, 211, 1, 211, 1);
  member.run('room_direct_2', 'act_human_1', 'owner', 'active', 1, 2, 212, 1, 212, 1);
  member.run('room_direct_2', 'act_agent_2', 'member', 'active', 1, 1, 213, 1, 213, 1);
  member.run('room_group_1', 'act_human_1', 'owner', 'active', 1, 9, 214, 2, 214, 1);
  member.run('room_group_1', 'act_agent_1', 'admin', 'active', 2, 9, 215, 1, 215, 2);
  member.run('room_group_1', 'act_human_2', 'member', 'left', 3, 3, 216, 1, 216, 1);
  member.run('room_group_1', 'act_agent_3', 'member', 'active', 4, 4, 217, 1, 217, 3);

  seedMemory(sqlite);
}

function seedMemory(sqlite: Database): void {
  sqlite
    .prepare(
      `INSERT INTO memory_instances (instance_id, capture_default, created_at, updated_at)
       VALUES ('mni_test', 'enabled', 1, 1)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_spaces
         (space_id, instance_id, agent_actor_id, owner_actor_id, ownership_kind,
          ownership_epoch, backend_binding_epoch, management_binding_id, capture, active,
          created_at, updated_at)
       VALUES ('msp_test', 'mni_test', 'act_agent_1', 'act_human_1', 'managed', 2, 1,
               'mg_test', 'pending', 1, 10, 11)`,
    )
    .run();
  const source = sqlite.prepare(
    `INSERT INTO memory_sources
       (source_id, instance_id, source_key, source_kind, business_ref_kind, business_ref_json,
        origin_room_id, origin_member_generation, origin_policy_revision, origin_joined_seq,
        origin_joined_at, origin_archive_head_seq, origin_seq, origin_created_at, author_actor_id,
        state, revision, content_text, content_sha256, content_bytes, superseded_by_source_id,
        superseded_by_revision, retracted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  source.run(
    'src_1', 'mni_test', 'message:msg_mem_1', 'message', 'message',
    '{"message_id":"msg_mem_1"}', 'room_group_1', 2, 2, 2, 215, null, 6, 500, 'act_agent_1',
    'superseded', 1, 'old', 'sha_src_old', 3, 'src_1b', 2, null, 20, 21,
  );
  source.run(
    'src_1b', 'mni_test', 'message:msg_mem_1', 'message', 'message',
    '{"message_id":"msg_mem_1"}', 'room_group_1', 2, 2, 2, 215, null, 6, 500, 'act_agent_1',
    'active', 2, 'hello', 'sha_src_1', 5, null, null, null, 22, 23,
  );
  source.run(
    'src_manual', 'mni_test', 'manual:note_1', 'manual', 'manual',
    '{"note":"note_1"}', null, 0, 0, 0, 0, null, null, 600, 'act_agent_1',
    'active', 1, 'note', 'sha_manual', 4, null, null, null, 24, 25,
  );
  const representation = sqlite.prepare(
    `INSERT INTO memory_representations
       (representation_id, instance_id, kind, source_id, source_revision, summary_id,
        summary_revision, source_context_id, producer_kind, lineage, partition_id,
        partition_generation, partition_policy_revision, range_start, range_end,
        text, text_bytes, text_sha256, verbatim, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  representation.run(
    'rep_raw', 'mni_test', 'raw_full', 'src_1b', 2, null, null, null, null, null, null,
    null, null, 0, 5, 'hello', 5, 'sha_text', 1, 30,
  );
  representation.run(
    'rep_summary', 'mni_test', 'summary', null, null, 'sum_1', 1, null, 'server_template',
    'run_bound', 'part_1', 1, 2, null, null, 'summary text', 12, 'sha_summary', 0, 31,
  );
  sqlite
    .prepare(
      `INSERT INTO memory_representation_dependencies
         (representation_id, dependency_index, source_id, source_revision,
          depends_on_representation_id, range_start, range_end)
       VALUES ('rep_summary', 0, 'src_1b', 2, 'rep_raw', 0, 5)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_experiences
         (experience_id, dedupe_key, space_id, ownership_epoch, agent_actor_id, origin_room_id,
          origin_member_generation, origin_kind, producer_kind, source_id, source_revision,
          representation_id, representation_kind, range_start, range_end, text_sha256,
          receipt_id, evidence, capture, available, created_at, updated_at)
       VALUES ('exp_1', 'dedupe_exp_1', 'msp_test', 2, 'act_agent_1', 'room_group_1', 2,
               'experienced', null, 'src_1b', 2, 'rep_raw', 'raw_full', 0, 5, 'sha_text',
               'rcp_1', 'host_reported_submitted', 'extracted', 1, 40, 41)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_experiences
         (experience_id, dedupe_key, space_id, ownership_epoch, agent_actor_id, origin_room_id,
          origin_member_generation, origin_kind, producer_kind, source_id, source_revision,
          representation_id, representation_kind, range_start, range_end, text_sha256,
          receipt_id, evidence, capture, available, created_at, updated_at)
       VALUES ('exp_2', 'dedupe_exp_2', 'msp_test', 2, 'act_agent_1', null, 0,
               'authored', 'agent_text', null, null, 'rep_summary', 'summary', null, null,
               'sha_summary', null, null, 'none', 1, 42, 43)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_coverage_ranges
         (coverage_id, dedupe_key, space_id, ownership_epoch, agent_actor_id, origin_room_id,
          origin_member_generation, source_id, source_revision, range_start, range_end,
          text_sha256, experience_id, created_at)
       VALUES ('cov_1', 'dedupe_cov_1', 'msp_test', 2, 'act_agent_1', 'room_group_1', 2,
               'src_1b', 2, 0, 5, 'sha_text', 'exp_1', 44)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_host_bindings
         (binding_id, space_id, ownership_epoch, agent_actor_id, credential_id, generation,
          session_incarnation, declared_capabilities_json, trust_level, state, lease_until,
          created_at, updated_at, closed_at)
       VALUES ('hb_1', 'msp_test', 2, 'act_agent_1', 'cred_a1', 1, 'sess_host_1',
               '["lookup"]', 'adapted_host', 'active', 99999, 50, 51, null)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_contexts
         (context_id, space_id, ownership_epoch, agent_actor_id, recall_id, kind, body,
          body_sha256, body_bytes, target_json, versions_json, policy_version, status,
          created_at, expires_at, updated_at)
       VALUES ('ctx_1', 'msp_test', 2, 'act_agent_1', 'rec_1', 'lookup', 'context body',
               'sha_ctx_1', 12, '{"audience":"agent"}', '{"v":1}', 1, 'ready', 60, 99999, 61)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_contexts
         (context_id, space_id, ownership_epoch, agent_actor_id, recall_id, kind, body,
          body_sha256, body_bytes, target_json, versions_json, policy_version, status,
          created_at, expires_at, updated_at)
       VALUES ('ctx_2', 'msp_test', 2, 'act_agent_1', null, 'bound', 'bound body',
               'sha_ctx_2', 10, '{"audience":"agent"}', '{"v":1}', 1, 'ready', 61, null, 62)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_context_items
         (context_id, item_index, experience_id, representation_id, source_dependencies_json,
          evidence, origin_scope_json)
       VALUES ('ctx_1', 0, 'exp_1', 'rep_raw', '[]', 'host_reported_submitted',
               '{"room_id":"room_group_1"}')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_manifests
         (manifest_id, space_id, ownership_epoch, agent_actor_id, host_binding_id,
          host_generation, session_incarnation, run_id, input_id, input_revision, invocation_id,
          manifest_sha256, payload_sha256, target_json, created_at)
       VALUES ('mnf_1', 'msp_test', 2, 'act_agent_1', 'hb_1', 1, 'sess_host_1', 'run_1',
               'input_1', 1, 'inv_1', 'sha_manifest', 'sha_payload', '{"audience":"agent"}', 70)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_manifest_items
         (manifest_id, item_index, selection_id, representation_id, origin_scope_json, text_sha256)
       VALUES ('mnf_1', 0, 'sel_1', 'rep_raw', '{"room_id":"room_group_1"}', 'sha_text')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_selections
         (selection_id, space_id, ownership_epoch, agent_actor_id, recall_id, representation_id,
          origin_scope_json, target_scope_json, versions_json, consumption, state, issued_at,
          expires_at)
       VALUES ('sel_1', 'msp_test', 2, 'act_agent_1', 'rec_1', 'rep_raw',
               '{"room_id":"room_group_1"}', '{"audience":"agent"}', '{"v":1}',
               'not_consumed', 'available', 80, 99999)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_receipts
         (receipt_id, kind, space_id, ownership_epoch, agent_actor_id, host_binding_id,
          host_generation, session_incarnation, run_id, input_id, input_revision, invocation_id,
          manifest_id, manifest_sha256, payload_sha256, context_id, context_sha256,
          target_scope_json, origin_scopes_json, evidence, proof_id, idempotency_key,
          disposition, reason, recorded_at, created_at)
       VALUES ('rcp_1', 'input_exposure', 'msp_test', 2, 'act_agent_1', 'hb_1', 1,
               'sess_host_1', 'run_1', 'input_1', 1, 'inv_1', 'mnf_1', 'sha_manifest',
               'sha_payload', null, null, '{"audience":"agent"}', '[]',
               'host_reported_submitted', 'proof_1', 'idem_rcp_1', 'applied', null, 90, 91)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_experience_proofs
         (experience_id, proof_id, receipt_id, evidence, invocation_id, manifest_id, created_at)
       VALUES ('exp_1', 'proof_1', 'rcp_1', 'gateway_observed_submitted', 'inv_1', 'mnf_1', 92)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_curated
         (curated_id, revision, space_id, ownership_epoch, origin, title, content,
          content_sha256, current, created_by, created_at, updated_at)
       VALUES ('cur_1', 1, 'msp_test', 2, 'manual', 'Title', 'Curated body', 'sha_cur_1', 0,
               'act_human_1', 100, 101)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_curated
         (curated_id, revision, space_id, ownership_epoch, origin, title, content,
          content_sha256, current, created_by, created_at, updated_at)
       VALUES ('cur_1', 2, 'msp_test', 2, 'manual', 'Title', 'Curated body v2', 'sha_cur_2', 1,
               'act_human_1', 102, 103)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_catchup_plans
         (plan_id, space_id, ownership_epoch, agent_actor_id, room_id, member_generation,
          upper_bound, query, status, budget_json, scan_cursor_json, created_at, updated_at,
          expires_at, request_key, request_sha256, policy_revision, member_seq, joined_seq,
          snapshot_sha256)
       VALUES ('plan_1', 'msp_test', 2, 'act_agent_1', 'room_group_1', 2, 9, 'query',
               'ready', '{}', null, 110, 111, null, 'req_catchup_1', 'sha_req', 2, 2, 2,
               'sha_snapshot')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_catchup_items
         (plan_id, item_index, message_id, created_seq, selection_state, reason)
       VALUES ('plan_1', 0, 'msg_mem_1', 6, 'selected', null),
              ('plan_1', 1, 'msg_mem_2', 7, 'missing', 'not_visible')`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_recall_requests
         (recall_id, space_id, ownership_epoch, agent_actor_id, request_key, mode, dispatch,
          status, target_json, plan_json, budget_json, warmup_only, result_json, created_at,
          updated_at, expires_at)
       VALUES ('rec_1', 'msp_test', 2, 'act_agent_1', 'req_recall_1', 'lookup', 'explicit',
               'pending', '{"audience":"agent"}', null, '{}', 0, null, 120, 121, null)`,
    )
    .run();
  sqlite
    .prepare(
      `INSERT INTO memory_tombstones
         (tombstone_id, instance_id, target_kind, target_id, source_key, reason, command_id,
          created_at)
       VALUES ('tomb_1', 'mni_test', 'source_key', 'src_old', 'tomb:key', 'forget', null, 130),
              ('tomb_2', 'mni_test', 'source', 'src_old', null, 'forget', null, 131)`,
    )
    .run();
}

function rawFirst<T>(sqlite: Database, sql: string, params: unknown[]): T | null {
  return (sqlite.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
}

function rawAll<T>(sqlite: Database, sql: string, params: unknown[]): T[] {
  return sqlite.prepare(sql).all(...(params as never[])) as T[];
}

function plan(sqlite: Database, sql: string, params: unknown[]): string[] {
  return (
    sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
      detail: string;
    }[]
  ).map((row) => row.detail.replace(/\s+/gu, ' ').trim());
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}

async function memoryRowParityChecks(sqlite: Database, db: D1Database): Promise<void> {
  checkEqual(
    'getMemoryInstance',
    JSON.stringify(await getMemoryInstance(db)),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT instance_id, capture_default FROM memory_instances LIMIT 1', []),
    ),
  );
  checkEqual(
    'getActiveMemorySpace',
    JSON.stringify(await getActiveMemorySpace(db, 'act_agent_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM memory_spaces WHERE agent_actor_id = ? AND active = 1', [
        'act_agent_1',
      ]),
    ),
  );
  checkEqual(
    'getActiveMemorySpace missing',
    await getActiveMemorySpace(db, 'act_agent_3'),
    null,
  );
  checkEqual(
    'getMemorySpaceById',
    JSON.stringify(await getMemorySpaceById(db, 'msp_test')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM memory_spaces WHERE space_id = ?', ['msp_test'])),
  );
  checkEqual('memorySpaceExists true', await memorySpaceExists(db, 'msp_test'), true);
  checkEqual('memorySpaceExists false', await memorySpaceExists(db, 'msp_missing'), false);

  checkEqual(
    'isMemoryTombstonedBySourceKey true',
    await isMemoryTombstonedBySourceKey(db, 'tomb:key'),
    true,
  );
  checkEqual(
    'isMemoryTombstonedBySourceKey false',
    await isMemoryTombstonedBySourceKey(db, 'missing'),
    false,
  );
  checkEqual(
    'isMemoryTargetTombstoned true',
    await isMemoryTargetTombstoned(db, 'source', 'src_old'),
    true,
  );
  checkEqual(
    'isMemoryTargetTombstoned false',
    await isMemoryTargetTombstoned(db, 'source', 'missing'),
    false,
  );

  checkEqual(
    'getMemorySourceRevision',
    JSON.stringify(await getMemorySourceRevision(db, 'src_1', 1)),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM memory_sources WHERE source_id = ? AND revision = ?', [
        'src_1',
        1,
      ]),
    ),
  );
  checkEqual(
    'getLatestMemorySource',
    JSON.stringify(await getLatestMemorySource(db, 'src_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM memory_sources WHERE source_id = ? ORDER BY revision DESC LIMIT 1', [
        'src_1',
      ]),
    ),
  );
  checkEqual(
    'getActiveMemorySourceByKey',
    JSON.stringify(await getActiveMemorySourceByKey(db, 'mni_test', 'message:msg_mem_1')),
    JSON.stringify(
      rawFirst(
        sqlite,
        "SELECT * FROM memory_sources WHERE instance_id = ? AND source_key = ? AND state = 'active' LIMIT 1",
        ['mni_test', 'message:msg_mem_1'],
      ),
    ),
  );

  checkEqual(
    'getMemoryRepresentation',
    JSON.stringify(await getMemoryRepresentation(db, 'rep_raw')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM memory_representations WHERE representation_id = ?', [
        'rep_raw',
      ]),
    ),
  );
  checkEqual(
    'getMemoryRepresentationSourceId',
    JSON.stringify(await getMemoryRepresentationSourceId(db, 'rep_raw')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT source_id FROM memory_representations WHERE representation_id = ?', [
        'rep_raw',
      ]),
    ),
  );
  checkEqual(
    'listMemoryRepresentationDependencyLinks',
    JSON.stringify(await listMemoryRepresentationDependencyLinks(db, 'rep_summary')),
    JSON.stringify(
      rawAll(
        sqlite,
        'SELECT source_id, depends_on_representation_id FROM memory_representation_dependencies WHERE representation_id = ?',
        ['rep_summary'],
      ),
    ),
  );
  checkEqual(
    'listMemoryRepresentationDependencies',
    JSON.stringify(await listMemoryRepresentationDependencies(db, 'rep_summary')),
    JSON.stringify(
      rawAll(
        sqlite,
        'SELECT * FROM memory_representation_dependencies WHERE representation_id = ? ORDER BY dependency_index',
        ['rep_summary'],
      ),
    ),
  );

  checkEqual(
    'getMemoryExperience',
    JSON.stringify(await getMemoryExperience(db, 'exp_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM memory_experiences WHERE experience_id = ?', [
      'exp_1',
    ])),
  );
  checkEqual(
    'getMemoryExperienceByDedupe',
    JSON.stringify(await getMemoryExperienceByDedupe(db, 'dedupe_exp_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT experience_id FROM memory_experiences WHERE dedupe_key = ?', [
        'dedupe_exp_1',
      ]),
    ),
  );

  checkEqual(
    'getMemoryContext',
    JSON.stringify(await getMemoryContext(db, 'ctx_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM memory_contexts WHERE context_id = ?', ['ctx_1'])),
  );
  checkEqual(
    'listMemoryContextItems',
    JSON.stringify(await listMemoryContextItems(db, 'ctx_1')),
    JSON.stringify(
      rawAll(
        sqlite,
        'SELECT representation_id, evidence, origin_scope_json FROM memory_context_items WHERE context_id = ? ORDER BY item_index',
        ['ctx_1'],
      ),
    ),
  );
  const contextSummaryRaw = (kind: string | null, cursor: { seq: number; key: string } | null): unknown[] => {
    const conditions = ['space_id = ?', 'ownership_epoch = ?', 'agent_actor_id = ?'];
    const params: unknown[] = ['msp_test', 2, 'act_agent_1'];
    if (kind) {
      conditions.push('kind = ?');
      params.push(kind);
    }
    if (cursor) {
      conditions.push('(created_at < ? OR (created_at = ? AND context_id < ?))');
      params.push(cursor.seq, cursor.seq, cursor.key);
    }
    return rawAll(
      sqlite,
      `SELECT context_id, recall_id, kind, body_sha256, body_bytes, status, created_at, expires_at
         FROM memory_contexts
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC, context_id DESC
        LIMIT ?`,
      [...params, 3],
    );
  };
  checkEqual(
    'listMemoryContextSummaries all',
    JSON.stringify(
      await listMemoryContextSummaries(db, {
        spaceId: 'msp_test',
        ownershipEpoch: 2,
        agentId: 'act_agent_1',
        limit: 3,
      }),
    ),
    JSON.stringify(contextSummaryRaw(null, null)),
  );
  checkEqual(
    'listMemoryContextSummaries kind',
    JSON.stringify(
      await listMemoryContextSummaries(db, {
        spaceId: 'msp_test',
        ownershipEpoch: 2,
        agentId: 'act_agent_1',
        kind: 'lookup',
        limit: 3,
      }),
    ),
    JSON.stringify(contextSummaryRaw('lookup', null)),
  );
  checkEqual(
    'listMemoryContextSummaries cursor',
    JSON.stringify(
      await listMemoryContextSummaries(db, {
        spaceId: 'msp_test',
        ownershipEpoch: 2,
        agentId: 'act_agent_1',
        cursor: { seq: 61, key: 'ctx_2' },
        limit: 3,
      }),
    ),
    JSON.stringify(contextSummaryRaw(null, { seq: 61, key: 'ctx_2' })),
  );

  checkEqual(
    'getMemoryManifest',
    JSON.stringify(await getMemoryManifest(db, 'mnf_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM memory_manifests WHERE manifest_id = ?', ['mnf_1'])),
  );
  checkEqual(
    'getMemoryManifestByInvocation',
    JSON.stringify(
      await getMemoryManifestByInvocation(db, {
        spaceId: 'msp_test',
        ownershipEpoch: 2,
        agentId: 'act_agent_1',
        hostBindingId: 'hb_1',
        invocationId: 'inv_1',
      }),
    ),
    JSON.stringify(
      rawFirst(
        sqlite,
        `SELECT * FROM memory_manifests
          WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
            AND host_binding_id = ? AND invocation_id = ?`,
        ['msp_test', 2, 'act_agent_1', 'hb_1', 'inv_1'],
      ),
    ),
  );
  checkEqual(
    'listMemoryManifestItems',
    JSON.stringify(await listMemoryManifestItems(db, 'mnf_1')),
    JSON.stringify(
      rawAll(sqlite, 'SELECT * FROM memory_manifest_items WHERE manifest_id = ? ORDER BY item_index', [
        'mnf_1',
      ]),
    ),
  );
  checkEqual(
    'getMemorySelection',
    JSON.stringify(await getMemorySelection(db, 'sel_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM memory_selections WHERE selection_id = ?', [
      'sel_1',
    ])),
  );

  checkEqual(
    'getMemoryReceiptByIdempotencyKey',
    JSON.stringify(await getMemoryReceiptByIdempotencyKey(db, 'idem_rcp_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM memory_receipts WHERE idempotency_key = ?', ['idem_rcp_1']),
    ),
  );
  checkEqual(
    'getMemoryReceipt',
    JSON.stringify(await getMemoryReceipt(db, 'rcp_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM memory_receipts WHERE receipt_id = ?', ['rcp_1'])),
  );
  checkEqual(
    'getMemoryReceiptByInvocation',
    JSON.stringify(
      await getMemoryReceiptByInvocation(db, {
        kind: 'input_exposure',
        spaceId: 'msp_test',
        ownershipEpoch: 2,
        agentId: 'act_agent_1',
        hostBindingId: 'hb_1',
        invocationId: 'inv_1',
      }),
    ),
    JSON.stringify(
      rawFirst(
        sqlite,
        `SELECT * FROM memory_receipts
          WHERE kind = 'input_exposure' AND space_id = ? AND ownership_epoch = ?
            AND agent_actor_id = ? AND host_binding_id = ? AND invocation_id = ?`,
        ['msp_test', 2, 'act_agent_1', 'hb_1', 'inv_1'],
      ),
    ),
  );
  checkEqual('hasMemoryReceiptForManifest', await hasMemoryReceiptForManifest(db, 'mnf_1'), true);
  checkEqual(
    'hasMemoryReceiptForManifest missing',
    await hasMemoryReceiptForManifest(db, 'mnf_missing'),
    false,
  );
  checkEqual(
    'getLatestMemoryReceiptForManifest',
    JSON.stringify(await getLatestMemoryReceiptForManifest(db, 'mnf_1')),
    JSON.stringify(
      rawFirst(
        sqlite,
        `SELECT * FROM memory_receipts
          WHERE kind = 'input_exposure' AND manifest_id = ?
          ORDER BY recorded_at DESC LIMIT 1`,
        ['mnf_1'],
      ),
    ),
  );
  checkEqual('hasMemoryGatewayProof', await hasMemoryGatewayProof(db, 'mnf_1'), true);
  checkEqual('hasMemoryGatewayProof missing', await hasMemoryGatewayProof(db, 'mnf_missing'), false);

  checkEqual(
    'getMemoryHostBinding',
    JSON.stringify(await getMemoryHostBinding(db, 'hb_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM memory_host_bindings WHERE binding_id = ?', ['hb_1']),
    ),
  );
  checkEqual(
    'getActiveMemoryHostBindingBySession',
    JSON.stringify(await getActiveMemoryHostBindingBySession(db, 'msp_test', 'sess_host_1')),
    JSON.stringify(
      rawFirst(
        sqlite,
        "SELECT * FROM memory_host_bindings WHERE space_id = ? AND session_incarnation = ? AND state = 'active'",
        ['msp_test', 'sess_host_1'],
      ),
    ),
  );
  checkEqual(
    'getLatestActiveMemoryHostBinding',
    JSON.stringify(await getLatestActiveMemoryHostBinding(db, 'msp_test', 'act_agent_1')),
    JSON.stringify(
      rawFirst(
        sqlite,
        `SELECT * FROM memory_host_bindings
          WHERE space_id = ? AND agent_actor_id = ? AND state = 'active'
          ORDER BY created_at DESC LIMIT 1`,
        ['msp_test', 'act_agent_1'],
      ),
    ),
  );
  checkEqual(
    'listActiveMemoryHostBindingIds',
    JSON.stringify(await listActiveMemoryHostBindingIds(db, 'act_agent_1')),
    JSON.stringify(
      rawAll(
        sqlite,
        "SELECT binding_id FROM memory_host_bindings WHERE agent_actor_id = ? AND state = 'active'",
        ['act_agent_1'],
      ),
    ),
  );
  checkEqual(
    'countActiveMemoryHostBindings',
    await countActiveMemoryHostBindings(db, 'msp_test'),
    rawFirst<{ n: number }>(
      sqlite,
      "SELECT COUNT(*) AS n FROM memory_host_bindings WHERE space_id = ? AND state = 'active'",
      ['msp_test'],
    )?.n ?? 0,
  );

  checkEqual(
    'getCurrentCuratedRevision',
    JSON.stringify(await getCurrentCuratedRevision(db, 'cur_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT revision FROM memory_curated WHERE curated_id = ? AND current = 1', [
        'cur_1',
      ]),
    ),
  );
  const curatedRaw = (limit: number | null): unknown[] => {
    const sql = `SELECT curated_id, revision, title, content, content_sha256, origin, created_at, updated_at
                   FROM memory_curated
                  WHERE space_id = ? AND ownership_epoch = ? AND current = 1
                  ORDER BY updated_at DESC${limit === null ? '' : ', curated_id'}
                  ${limit === null ? '' : 'LIMIT ?'}`;
    return rawAll(sqlite, sql, limit === null ? ['msp_test', 2] : ['msp_test', 2, limit]);
  };
  checkEqual(
    'listCurrentCuratedMemories',
    JSON.stringify(await listCurrentCuratedMemories(db, 'msp_test', 2)),
    JSON.stringify(curatedRaw(null)),
  );
  checkEqual(
    'listCurrentCuratedMemories limit',
    JSON.stringify(await listCurrentCuratedMemories(db, 'msp_test', 2, 1)),
    JSON.stringify(curatedRaw(1)),
  );

  checkEqual(
    'getMemoryCatchupPlan',
    JSON.stringify(await getMemoryCatchupPlan(db, 'plan_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM memory_catchup_plans WHERE plan_id = ?', ['plan_1']),
    ),
  );
  checkEqual(
    'getMemoryCatchupPlanByRequestKey',
    JSON.stringify(await getMemoryCatchupPlanByRequestKey(db, 'msp_test', 'act_agent_1', 'req_catchup_1')),
    JSON.stringify(
      rawFirst(
        sqlite,
        'SELECT * FROM memory_catchup_plans WHERE space_id = ? AND agent_actor_id = ? AND request_key = ?',
        ['msp_test', 'act_agent_1', 'req_catchup_1'],
      ),
    ),
  );
  checkEqual(
    'listMemoryCatchupItems',
    JSON.stringify(await listMemoryCatchupItems(db, 'plan_1')),
    JSON.stringify(
      rawAll(sqlite, 'SELECT * FROM memory_catchup_items WHERE plan_id = ? ORDER BY item_index', [
        'plan_1',
      ]),
    ),
  );

  checkEqual(
    'getMemoryRecallRequest',
    JSON.stringify(await getMemoryRecallRequest(db, 'rec_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM memory_recall_requests WHERE recall_id = ?', ['rec_1']),
    ),
  );
  checkEqual(
    'getMemoryRecallRequestByKey',
    JSON.stringify(await getMemoryRecallRequestByKey(db, 'msp_test', 'req_recall_1')),
    JSON.stringify(
      rawFirst(
        sqlite,
        'SELECT * FROM memory_recall_requests WHERE space_id = ? AND request_key = ?',
        ['msp_test', 'req_recall_1'],
      ),
    ),
  );
  checkEqual(
    'listMemoryRecallCandidates',
    JSON.stringify(
      await listMemoryRecallCandidates(db, {
        spaceId: 'msp_test',
        ownershipEpoch: 2,
        agentId: 'act_agent_1',
        limit: 10,
      }),
    ),
    JSON.stringify(
      rawAll(
        sqlite,
        `SELECT experience_id, origin_room_id, origin_member_generation, representation_id,
                evidence, created_at
           FROM memory_experiences
          WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
            AND available = 1 AND origin_kind = 'experienced'
          ORDER BY created_at DESC LIMIT ?`,
        ['msp_test', 2, 'act_agent_1', 10],
      ),
    ),
  );

  const coverageRaw = (sourceId: string | null): unknown[] => {
    const conditions = [
      'space_id = ?',
      'ownership_epoch = ?',
      'agent_actor_id = ?',
      'origin_room_id = ?',
      'origin_member_generation = ?',
    ];
    const params: unknown[] = ['msp_test', 2, 'act_agent_1', 'room_group_1', 2];
    if (sourceId) {
      conditions.push('source_id = ?');
      params.push(sourceId);
    }
    return rawAll(
      sqlite,
      `SELECT source_id, source_revision, range_start, range_end, text_sha256
         FROM memory_coverage_ranges
        WHERE ${conditions.join(' AND ')}
        ORDER BY source_id, source_revision, range_start, range_end`,
      params,
    );
  };
  checkEqual(
    'listMemoryCoverageRanges',
    JSON.stringify(
      await listMemoryCoverageRanges(db, {
        spaceId: 'msp_test',
        ownershipEpoch: 2,
        agentId: 'act_agent_1',
        roomId: 'room_group_1',
        memberGeneration: 2,
      }),
    ),
    JSON.stringify(coverageRaw(null)),
  );
  checkEqual(
    'listMemoryCoverageRanges source',
    JSON.stringify(
      await listMemoryCoverageRanges(db, {
        spaceId: 'msp_test',
        ownershipEpoch: 2,
        agentId: 'act_agent_1',
        roomId: 'room_group_1',
        memberGeneration: 2,
        sourceId: 'src_1b',
        sourceRevision: 2,
      }),
    ),
    JSON.stringify(coverageRaw('src_1b')),
  );
}


async function rowParityChecks(sqlite: Database, db: D1Database): Promise<void> {
  const actorIds = ['act_human_1', 'act_agent_2', 'act_agent_3'];
  checkEqual(
    'getActor human',
    JSON.stringify(await getActor(db, 'act_human_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_human_1'])),
  );
  checkEqual(
    'getActor agent',
    JSON.stringify(await getActor(db, 'act_agent_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_agent_1'])),
  );
  checkEqual(
    'getActor archived',
    JSON.stringify(await getActor(db, 'act_agent_2')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_agent_2'])),
  );
  checkEqual('getActor missing', await getActor(db, 'missing'), null);

  checkEqual(
    'getActorBySession',
    JSON.stringify(await getActorBySession(db, 'sess_atlas')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM actors WHERE agent_session_id = ?', ['sess_atlas']),
    ),
  );
  checkEqual('getActorBySession missing', await getActorBySession(db, 'sess_missing'), null);

  checkEqual('getActorsByIds empty', JSON.stringify(await getActorsByIds(db, [])), '[]');
  checkEqual(
    'getActorsByIds many',
    JSON.stringify(await getActorsByIds(db, actorIds)),
    JSON.stringify(
      rawAll(sqlite, `SELECT actor_id, kind FROM actors WHERE actor_id IN (${placeholders(actorIds)})`, actorIds),
    ),
  );
  checkEqual(
    'getActorsByIds duplicates collapsed',
    JSON.stringify(await getActorsByIds(db, ['act_agent_1', 'act_agent_1'])),
    JSON.stringify(
      rawAll(sqlite, 'SELECT actor_id, kind FROM actors WHERE actor_id IN (?, ?)', [
        'act_agent_1',
        'act_agent_1',
      ]),
    ),
  );
  checkEqual(
    'getActorsByIds missing ids',
    JSON.stringify(await getActorsByIds(db, ['act_human_1', 'missing'])),
    JSON.stringify(
      rawAll(sqlite, 'SELECT actor_id, kind FROM actors WHERE actor_id IN (?, ?)', [
        'act_human_1',
        'missing',
      ]),
    ),
  );

  const managementSql = `SELECT actor_id, kind, agent_session_id, name, archived_at, archived_by,
              disabled_at, disabled_by, disabled_reason
         FROM actors WHERE actor_id IN (${placeholders(actorIds)})`;
  checkEqual(
    'getActorManagementByIds',
    JSON.stringify(await getActorManagementByIds(db, actorIds)),
    JSON.stringify(rawAll(sqlite, managementSql, actorIds)),
  );
  checkEqual('getActorManagementByIds empty', JSON.stringify(await getActorManagementByIds(db, [])), '[]');

  checkEqual(
    'getRoom direct',
    JSON.stringify(await getRoom(db, 'room_direct_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM rooms WHERE room_id = ?', ['room_direct_1'])),
  );
  checkEqual(
    'getRoom group',
    JSON.stringify(await getRoom(db, 'room_group_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM rooms WHERE room_id = ?', ['room_group_1'])),
  );
  checkEqual('getRoom missing', await getRoom(db, 'room_missing'), null);

  checkEqual(
    'getMember active',
    JSON.stringify(await getMember(db, 'room_group_1', 'act_agent_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?', [
        'room_group_1',
        'act_agent_1',
      ]),
    ),
  );
  checkEqual(
    'getMember left',
    JSON.stringify(await getMember(db, 'room_group_1', 'act_human_2')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?', [
        'room_group_1',
        'act_human_2',
      ]),
    ),
  );
  checkEqual('getMember missing', await getMember(db, 'room_group_1', 'missing'), null);

  checkEqual('isActiveMember true', await isActiveMember(db, 'room_group_1', 'act_agent_1'), true);
  checkEqual('isActiveMember left', await isActiveMember(db, 'room_group_1', 'act_human_2'), false);
  checkEqual('isActiveMember missing', await isActiveMember(db, 'room_group_1', 'missing'), false);

  checkEqual(
    'activeRoomCount human',
    await activeRoomCount(db, 'act_human_1'),
    rawFirst<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'", [
      'act_human_1',
    ])?.n ?? 0,
  );
  checkEqual('activeRoomCount agent', await activeRoomCount(db, 'act_agent_1'), 2);
  checkEqual('activeRoomCount missing', await activeRoomCount(db, 'missing'), 0);

  checkEqual(
    'getCredentialByHash active',
    JSON.stringify(await getCredentialByHash(db, 'hash_h1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM credentials WHERE token_hash = ?', ['hash_h1'])),
  );
  checkEqual(
    'getCredentialByHash revoked',
    JSON.stringify(await getCredentialByHash(db, 'hash_a1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM credentials WHERE token_hash = ?', ['hash_a1'])),
  );
  checkEqual('getCredentialByHash missing', await getCredentialByHash(db, 'missing'), null);

  const peerSql = (roomIds: string[]): string =>
    `SELECT rm.room_id, a.actor_id, a.name, a.kind
       FROM room_members rm
       JOIN actors a ON a.actor_id = rm.actor_id
      WHERE rm.room_id IN (${placeholders(roomIds)})
        AND rm.status = 'active'
        AND rm.actor_id <> ?
      ORDER BY rm.room_id, a.actor_id`;
  checkEqual('listActiveRoomPeers empty', JSON.stringify(await listActiveRoomPeers(db, [], 'act_human_1')), '[]');
  const peerRooms = ['room_direct_1', 'room_direct_2', 'room_group_1'];
  checkEqual(
    'listActiveRoomPeers page',
    JSON.stringify(await listActiveRoomPeers(db, peerRooms, 'act_human_1')),
    JSON.stringify(rawAll(sqlite, peerSql(peerRooms), [...peerRooms, 'act_human_1'])),
  );
  checkEqual(
    'listActiveRoomPeers single',
    JSON.stringify(await listActiveRoomPeers(db, ['room_direct_1'], 'act_agent_1')),
    JSON.stringify(rawAll(sqlite, peerSql(['room_direct_1']), ['room_direct_1', 'act_agent_1'])),
  );

  checkEqual(
    'getEventsMinSeq room',
    await getEventsMinSeq(db, 'room', 'room_group_1'),
    rawFirst<{ events_min_seq: number }>(sqlite, 'SELECT events_min_seq FROM rooms WHERE room_id = ?', [
      'room_group_1',
    ])?.events_min_seq ?? 0,
  );
  checkEqual(
    'getEventsMinSeq inbox',
    await getEventsMinSeq(db, 'inbox', 'act_human_1'),
    rawFirst<{ inbox_min_seq: number }>(sqlite, 'SELECT inbox_min_seq FROM actors WHERE actor_id = ?', [
      'act_human_1',
    ])?.inbox_min_seq ?? 0,
  );
  checkEqual('getEventsMinSeq actor', await getEventsMinSeq(db, 'actor', 'act_human_1'), 0);
}

function explainChecks(sqlite: Database, db: D1Database): void {
  const cases: { label: string; raw: string; params: unknown[]; query: { toSQL(): { sql: string; params: unknown[] } } }[] = [
    {
      label: 'getActor',
      raw: 'SELECT * FROM actors WHERE actor_id = ?',
      params: ['act_agent_1'],
      query: orm(db).select().from(schema.actors).where(eq(schema.actors.actor_id, 'act_agent_1')),
    },
    {
      label: 'getActorBySession',
      raw: 'SELECT * FROM actors WHERE agent_session_id = ?',
      params: ['sess_atlas'],
      query: orm(db)
        .select()
        .from(schema.actors)
        .where(eq(schema.actors.agent_session_id, 'sess_atlas')),
    },
    {
      label: 'getRoom',
      raw: 'SELECT * FROM rooms WHERE room_id = ?',
      params: ['room_direct_1'],
      query: orm(db).select().from(schema.rooms).where(eq(schema.rooms.room_id, 'room_direct_1')),
    },
    {
      label: 'getMember',
      raw: 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?',
      params: ['room_group_1', 'act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.actor_id, 'act_agent_1'),
          ),
        ),
    },
    {
      label: 'isActiveMember',
      raw: "SELECT 1 AS ok FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'",
      params: ['room_group_1', 'act_agent_1'],
      query: orm(db)
        .select({ ok: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.actor_id, 'act_agent_1'),
            eq(schema.roomMembers.status, 'active'),
          ),
        )
        .limit(1),
    },
    {
      label: 'activeRoomCount',
      raw: "SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'",
      params: ['act_human_1'],
      query: orm(db)
        .select({ n: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.actor_id, 'act_human_1'),
            eq(schema.roomMembers.status, 'active'),
          ),
        ),
    },
    {
      label: 'getCredentialByHash',
      raw: 'SELECT * FROM credentials WHERE token_hash = ?',
      params: ['hash_h1'],
      query: orm(db)
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.token_hash, 'hash_h1')),
    },
    {
      label: 'listActiveRoomPeers',
      raw: `SELECT room_members.room_id, actors.actor_id, actors.name, actors.kind
              FROM room_members
              JOIN actors ON actors.actor_id = room_members.actor_id
             WHERE room_members.room_id IN (?, ?, ?)
               AND room_members.status = 'active'
               AND room_members.actor_id <> ?
             ORDER BY room_members.room_id, actors.actor_id`,
      params: ['room_direct_1', 'room_direct_2', 'room_group_1', 'act_human_1'],
      query: orm(db)
        .select({
          room_id: schema.roomMembers.room_id,
          actor_id: schema.actors.actor_id,
          name: schema.actors.name,
          kind: schema.actors.kind,
        })
        .from(schema.roomMembers)
        .innerJoin(schema.actors, eq(schema.actors.actor_id, schema.roomMembers.actor_id))
        .where(
          and(
            inArray(schema.roomMembers.room_id, [
              'room_direct_1',
              'room_direct_2',
              'room_group_1',
            ]),
            eq(schema.roomMembers.status, 'active'),
            ne(schema.roomMembers.actor_id, 'act_human_1'),
          ),
        )
        .orderBy(schema.roomMembers.room_id, schema.actors.actor_id),
    },
    {
      label: 'getMemoryInstance',
      raw: 'SELECT instance_id, capture_default FROM memory_instances LIMIT 1',
      params: [],
      query: orm(db)
        .select({
          instance_id: schema.memoryInstances.instance_id,
          capture_default: schema.memoryInstances.capture_default,
        })
        .from(schema.memoryInstances)
        .limit(1),
    },
    {
      label: 'getActiveMemorySpace',
      raw: 'SELECT * FROM memory_spaces WHERE agent_actor_id = ? AND active = 1',
      params: ['act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.memorySpaces)
        .where(
          and(
            eq(schema.memorySpaces.agent_actor_id, 'act_agent_1'),
            eq(schema.memorySpaces.active, 1),
          ),
        ),
    },
    {
      label: 'isMemoryTombstonedBySourceKey',
      raw: "SELECT tombstone_id FROM memory_tombstones WHERE source_key = ? AND target_kind IN ('source_key', 'source') LIMIT 1",
      params: ['tomb:key'],
      query: orm(db)
        .select({ tombstone_id: schema.memoryTombstones.tombstone_id })
        .from(schema.memoryTombstones)
        .where(
          and(
            eq(schema.memoryTombstones.source_key, 'tomb:key'),
            inArray(schema.memoryTombstones.target_kind, ['source_key', 'source']),
          ),
        )
        .limit(1),
    },
    {
      label: 'getMemorySourceRevision',
      raw: 'SELECT * FROM memory_sources WHERE source_id = ? AND revision = ?',
      params: ['src_1', 1],
      query: orm(db)
        .select()
        .from(schema.memorySources)
        .where(
          and(eq(schema.memorySources.source_id, 'src_1'), eq(schema.memorySources.revision, 1)),
        ),
    },
    {
      label: 'getLatestMemorySource',
      raw: 'SELECT * FROM memory_sources WHERE source_id = ? ORDER BY revision DESC LIMIT 1',
      params: ['src_1'],
      query: orm(db)
        .select()
        .from(schema.memorySources)
        .where(eq(schema.memorySources.source_id, 'src_1'))
        .orderBy(desc(schema.memorySources.revision))
        .limit(1),
    },
    {
      label: 'getMemoryRepresentation',
      raw: 'SELECT * FROM memory_representations WHERE representation_id = ?',
      params: ['rep_raw'],
      query: orm(db)
        .select()
        .from(schema.memoryRepresentations)
        .where(eq(schema.memoryRepresentations.representation_id, 'rep_raw')),
    },
    {
      label: 'listMemoryContextSummaries',
      raw: `SELECT context_id, recall_id, kind, body_sha256, body_bytes, status, created_at, expires_at
              FROM memory_contexts
             WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
               AND (created_at < ? OR (created_at = ? AND context_id < ?))
             ORDER BY created_at DESC, context_id DESC
             LIMIT ?`,
      params: ['msp_test', 2, 'act_agent_1', 61, 61, 'ctx_2', 3],
      query: orm(db)
        .select({
          context_id: schema.memoryContexts.context_id,
          recall_id: schema.memoryContexts.recall_id,
          kind: schema.memoryContexts.kind,
          body_sha256: schema.memoryContexts.body_sha256,
          body_bytes: schema.memoryContexts.body_bytes,
          status: schema.memoryContexts.status,
          created_at: schema.memoryContexts.created_at,
          expires_at: schema.memoryContexts.expires_at,
        })
        .from(schema.memoryContexts)
        .where(
          and(
            eq(schema.memoryContexts.space_id, 'msp_test'),
            eq(schema.memoryContexts.ownership_epoch, 2),
            eq(schema.memoryContexts.agent_actor_id, 'act_agent_1'),
            or(
              lt(schema.memoryContexts.created_at, 61),
              and(
                eq(schema.memoryContexts.created_at, 61),
                lt(schema.memoryContexts.context_id, 'ctx_2'),
              ),
            ),
          ),
        )
        .orderBy(desc(schema.memoryContexts.created_at), desc(schema.memoryContexts.context_id))
        .limit(3),
    },
    {
      label: 'getMemoryManifestByInvocation',
      raw: `SELECT * FROM memory_manifests
             WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
               AND host_binding_id = ? AND invocation_id = ?`,
      params: ['msp_test', 2, 'act_agent_1', 'hb_1', 'inv_1'],
      query: orm(db)
        .select()
        .from(schema.memoryManifests)
        .where(
          and(
            eq(schema.memoryManifests.space_id, 'msp_test'),
            eq(schema.memoryManifests.ownership_epoch, 2),
            eq(schema.memoryManifests.agent_actor_id, 'act_agent_1'),
            eq(schema.memoryManifests.host_binding_id, 'hb_1'),
            eq(schema.memoryManifests.invocation_id, 'inv_1'),
          ),
        ),
    },
    {
      label: 'getMemoryReceiptByInvocation',
      raw: `SELECT * FROM memory_receipts
             WHERE kind = 'input_exposure' AND space_id = ? AND ownership_epoch = ?
               AND agent_actor_id = ? AND host_binding_id = ? AND invocation_id = ?`,
      params: ['msp_test', 2, 'act_agent_1', 'hb_1', 'inv_1'],
      query: orm(db)
        .select()
        .from(schema.memoryReceipts)
        .where(
          and(
            eq(schema.memoryReceipts.kind, 'input_exposure'),
            eq(schema.memoryReceipts.space_id, 'msp_test'),
            eq(schema.memoryReceipts.ownership_epoch, 2),
            eq(schema.memoryReceipts.agent_actor_id, 'act_agent_1'),
            eq(schema.memoryReceipts.host_binding_id, 'hb_1'),
            eq(schema.memoryReceipts.invocation_id, 'inv_1'),
          ),
        ),
    },
    {
      label: 'getLatestActiveMemoryHostBinding',
      raw: `SELECT * FROM memory_host_bindings
             WHERE space_id = ? AND agent_actor_id = ? AND state = 'active'
             ORDER BY created_at DESC LIMIT 1`,
      params: ['msp_test', 'act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.memoryHostBindings)
        .where(
          and(
            eq(schema.memoryHostBindings.space_id, 'msp_test'),
            eq(schema.memoryHostBindings.agent_actor_id, 'act_agent_1'),
            eq(schema.memoryHostBindings.state, 'active'),
          ),
        )
        .orderBy(desc(schema.memoryHostBindings.created_at))
        .limit(1),
    },
    {
      label: 'listCurrentCuratedMemories',
      raw: `SELECT curated_id, revision, title, content, content_sha256, origin, created_at, updated_at
              FROM memory_curated
             WHERE space_id = ? AND ownership_epoch = ? AND current = 1
             ORDER BY updated_at DESC, curated_id
             LIMIT ?`,
      params: ['msp_test', 2, 1],
      query: orm(db)
        .select({
          curated_id: schema.memoryCurated.curated_id,
          revision: schema.memoryCurated.revision,
          title: schema.memoryCurated.title,
          content: schema.memoryCurated.content,
          content_sha256: schema.memoryCurated.content_sha256,
          origin: schema.memoryCurated.origin,
          created_at: schema.memoryCurated.created_at,
          updated_at: schema.memoryCurated.updated_at,
        })
        .from(schema.memoryCurated)
        .where(
          and(
            eq(schema.memoryCurated.space_id, 'msp_test'),
            eq(schema.memoryCurated.ownership_epoch, 2),
            eq(schema.memoryCurated.current, 1),
          ),
        )
        .orderBy(desc(schema.memoryCurated.updated_at), schema.memoryCurated.curated_id)
        .limit(1),
    },
    {
      label: 'getMemoryCatchupPlanByRequestKey',
      raw: `SELECT * FROM memory_catchup_plans
             WHERE space_id = ? AND agent_actor_id = ? AND request_key = ?`,
      params: ['msp_test', 'act_agent_1', 'req_catchup_1'],
      query: orm(db)
        .select()
        .from(schema.memoryCatchupPlans)
        .where(
          and(
            eq(schema.memoryCatchupPlans.space_id, 'msp_test'),
            eq(schema.memoryCatchupPlans.agent_actor_id, 'act_agent_1'),
            eq(schema.memoryCatchupPlans.request_key, 'req_catchup_1'),
          ),
        ),
    },
    {
      label: 'listMemoryRecallCandidates',
      raw: `SELECT experience_id, origin_room_id, origin_member_generation, representation_id,
                    evidence, created_at
               FROM memory_experiences
              WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
                AND available = 1 AND origin_kind = 'experienced'
              ORDER BY created_at DESC LIMIT ?`,
      params: ['msp_test', 2, 'act_agent_1', 10],
      query: orm(db)
        .select({
          experience_id: schema.memoryExperiences.experience_id,
          origin_room_id: schema.memoryExperiences.origin_room_id,
          origin_member_generation: schema.memoryExperiences.origin_member_generation,
          representation_id: schema.memoryExperiences.representation_id,
          evidence: schema.memoryExperiences.evidence,
          created_at: schema.memoryExperiences.created_at,
        })
        .from(schema.memoryExperiences)
        .where(
          and(
            eq(schema.memoryExperiences.space_id, 'msp_test'),
            eq(schema.memoryExperiences.ownership_epoch, 2),
            eq(schema.memoryExperiences.agent_actor_id, 'act_agent_1'),
            eq(schema.memoryExperiences.available, 1),
            eq(schema.memoryExperiences.origin_kind, 'experienced'),
          ),
        )
        .orderBy(desc(schema.memoryExperiences.created_at))
        .limit(10),
    },
    {
      label: 'listMemoryCoverageRanges',
      raw: `SELECT source_id, source_revision, range_start, range_end, text_sha256
               FROM memory_coverage_ranges
              WHERE space_id = ? AND ownership_epoch = ? AND agent_actor_id = ?
                AND origin_room_id = ? AND origin_member_generation = ?
                AND source_id = ? AND source_revision = ?
              ORDER BY source_id, source_revision, range_start, range_end`,
      params: ['msp_test', 2, 'act_agent_1', 'room_group_1', 2, 'src_1b', 2],
      query: orm(db)
        .select({
          source_id: schema.memoryCoverageRanges.source_id,
          source_revision: schema.memoryCoverageRanges.source_revision,
          range_start: schema.memoryCoverageRanges.range_start,
          range_end: schema.memoryCoverageRanges.range_end,
          text_sha256: schema.memoryCoverageRanges.text_sha256,
        })
        .from(schema.memoryCoverageRanges)
        .where(
          and(
            eq(schema.memoryCoverageRanges.space_id, 'msp_test'),
            eq(schema.memoryCoverageRanges.ownership_epoch, 2),
            eq(schema.memoryCoverageRanges.agent_actor_id, 'act_agent_1'),
            eq(schema.memoryCoverageRanges.origin_room_id, 'room_group_1'),
            eq(schema.memoryCoverageRanges.origin_member_generation, 2),
            eq(schema.memoryCoverageRanges.source_id, 'src_1b'),
            eq(schema.memoryCoverageRanges.source_revision, 2),
          ),
        )
        .orderBy(
          schema.memoryCoverageRanges.source_id,
          schema.memoryCoverageRanges.source_revision,
          schema.memoryCoverageRanges.range_start,
          schema.memoryCoverageRanges.range_end,
        ),
    },
  ];

  for (const item of cases) {
    const compiled = item.query.toSQL();
    checkEqual(
      `EXPLAIN ${item.label}`,
      JSON.stringify(plan(sqlite, compiled.sql, compiled.params)),
      JSON.stringify(plan(sqlite, item.raw, item.params)),
    );
  }
}

async function bench(label: string, fn: () => Promise<unknown>, iterations = 3_000): Promise<string> {
  for (let index = 0; index < 200; index += 1) await fn();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) await fn();
  const elapsed = performance.now() - started;
  return `${label}: ${elapsed.toFixed(1)}ms / ${iterations} (${(elapsed / iterations * 1000).toFixed(1)}µs/op)`;
}

async function benchmark(sqlite: Database, db: D1Database): Promise<void> {
  const rawActor = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_agent_1']);
  const ormActor = async (): Promise<unknown> => getActor(db, 'act_agent_1');
  const rawMember = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?', [
      'room_group_1',
      'act_agent_1',
    ]);
  const ormMember = async (): Promise<unknown> => getMember(db, 'room_group_1', 'act_agent_1');
  const rawCount = async (): Promise<unknown> =>
    rawFirst(sqlite, "SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'", [
      'act_human_1',
    ]);
  const ormCount = async (): Promise<unknown> => activeRoomCount(db, 'act_human_1');
  const rawIdentity = async (): Promise<unknown> => {
    const credential = rawFirst<{ actor_id: string }>(
      sqlite,
      'SELECT * FROM credentials WHERE token_hash = ?',
      ['hash_h1'],
    );
    if (!credential) return null;
    return rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', [credential.actor_id]);
  };
  const ormIdentity = async (): Promise<unknown> => {
    const credential = await getCredentialByHash(db, 'hash_h1');
    if (!credential) return null;
    return getActor(db, credential.actor_id);
  };

  console.log('\nread query benchmark (in-memory, includes drizzle build):');
  console.log(`  raw   ${await bench('actor', rawActor)}`);
  console.log(`  orm   ${await bench('actor', ormActor)}`);
  console.log(`  raw   ${await bench('member', rawMember)}`);
  console.log(`  orm   ${await bench('member', ormMember)}`);
  console.log(`  raw   ${await bench('count', rawCount)}`);
  console.log(`  orm   ${await bench('count', ormCount)}`);
  console.log(`  raw   ${await bench('identity', rawIdentity)}`);
  console.log(`  orm   ${await bench('identity', ormIdentity)}`);
}

async function main(): Promise<void> {
  const sqlite = new Database(':memory:');
  migrate(sqlite, MIGRATIONS);
  seed(sqlite);
  const db = createD1(sqlite);
  try {
    await rowParityChecks(sqlite, db);
    await memoryRowParityChecks(sqlite, db);
    explainChecks(sqlite, db);
    await benchmark(sqlite, db);
    console.log(`\ndrizzle runtime checks passed: ${checksPassed()}`);
  } finally {
    sqlite.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
