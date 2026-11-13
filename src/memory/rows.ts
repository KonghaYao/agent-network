/**
 * Memory 持久化行类型（MF02/MF03）。
 *
 * 只描述 `0045_memory_ledger.sql` + `0046_memory_experience_catchup.sql`
 * 的物理列，不包含业务判断。access/store/jobs
 * 共用这些形状，避免各模块自行解读 SQLite 返回值的 null/数值语义。
 */
import type {
  MemoryCaptureState,
  MemoryOriginKind,
  MemoryOwnershipKind,
  MemoryProducerKind,
  MemoryPurgeState,
  MemoryRepresentationKind,
  MemorySourceKind,
  MemorySourceState,
} from './contracts';

export interface MemoryInstanceRow {
  instance_id: string;
  capture_default: 'enabled' | 'disabled';
  created_at: number;
  updated_at: number;
}

export interface MemorySpaceRow {
  space_id: string;
  instance_id: string;
  agent_actor_id: string;
  owner_actor_id: string;
  ownership_kind: MemoryOwnershipKind;
  ownership_epoch: number;
  backend_binding_epoch: number;
  management_binding_id: string | null;
  capture: MemoryCaptureState;
  active: number;
  created_at: number;
  updated_at: number;
}

export interface MemorySourceRow {
  source_id: string;
  instance_id: string;
  source_key: string;
  source_kind: MemorySourceKind;
  business_ref_kind: string;
  business_ref_json: string;
  origin_room_id: string | null;
  origin_member_generation: number;
  origin_policy_revision: number;
  origin_joined_seq: number;
  origin_joined_at: number;
  origin_archive_head_seq: number | null;
  origin_seq: number | null;
  origin_created_at: number;
  author_actor_id: string | null;
  state: MemorySourceState;
  revision: number;
  content_text: string | null;
  content_sha256: string | null;
  content_bytes: number | null;
  superseded_by_source_id: string | null;
  superseded_by_revision: number | null;
  retracted_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryRepresentationRow {
  representation_id: string;
  instance_id: string;
  kind: MemoryRepresentationKind;
  source_id: string | null;
  source_revision: number | null;
  summary_id: string | null;
  summary_revision: number | null;
  source_context_id: string | null;
  producer_kind: MemoryProducerKind | null;
  lineage: 'run_bound' | 'lineage_unknown' | null;
  partition_id: string | null;
  partition_generation: number | null;
  partition_policy_revision: number | null;
  range_start: number | null;
  range_end: number | null;
  text: string;
  text_bytes: number;
  text_sha256: string;
  verbatim: number;
  created_at: number;
}

export interface MemoryRepresentationDependencyRow {
  representation_id: string;
  dependency_index: number;
  source_id: string;
  source_revision: number;
  depends_on_representation_id: string | null;
  range_start: number | null;
  range_end: number | null;
}

export interface MemoryGovernanceCommandRow {
  space_id: string;
  command_seq: number;
  command_id: string;
  mutation_kind: string;
  target_kind: string;
  target_id: string;
  target_revision: number | null;
  payload_sha256: string;
  idempotency_key: string;
  status: 'pending' | 'applied' | 'unknown' | 'failed';
  result_json: string | null;
  created_at: number;
  applied_at: number | null;
}

export interface MemoryJobRow {
  job_id: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  operation_type: 'ensure_space' | 'source_apply' | 'retain' | 'remove' | 'recall' | 'rebuild';
  operation_key: string;
  payload_sha256: string;
  source_command_id: string | null;
  recall_id: string | null;
  retain_intent_id: string | null;
  target_json: string | null;
  result_json: string | null;
  backend_binding_epoch: number;
  provider_job_id: string | null;
  status: 'pending' | 'leased' | 'completed' | 'failed' | 'unknown' | 'cancelled';
  stage: 'accepted' | 'source_applied' | 'derived_ready' | 'unknown';
  attempt: number;
  lease_id: string | null;
  lease_until: number | null;
  next_attempt_at: number;
  unknown_since: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface MemoryRetainIntentRow {
  retain_id: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  origin_kind: MemoryOriginKind;
  experience_id: string | null;
  representation_id: string;
  source_id: string | null;
  source_revision: number | null;
  receipt_id: string | null;
  curated_id: string | null;
  curated_revision: number | null;
  evidence: string | null;
  policy_version: number;
  operation_key: string;
  payload_sha256: string;
  status:
    | 'pending'
    | 'leased'
    | 'retained'
    | 'skipped'
    | 'suppressed'
    | 'unknown'
    | 'failed';
  job_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface MemoryReceiptRow {
  receipt_id: string;
  kind: 'input_exposure' | 'context_delivery';
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  host_binding_id: string | null;
  host_generation: number | null;
  session_incarnation: string | null;
  run_id: string | null;
  input_id: string | null;
  input_revision: number | null;
  invocation_id: string | null;
  manifest_id: string | null;
  manifest_sha256: string | null;
  payload_sha256: string | null;
  context_id: string | null;
  context_sha256: string | null;
  target_scope_json: string;
  origin_scopes_json: string;
  evidence: string;
  proof_id: string;
  idempotency_key: string;
  disposition: 'applied' | 'history_only' | 'rejected';
  reason: string | null;
  recorded_at: number;
  created_at: number;
}

export interface MemoryExperienceRow {
  experience_id: string;
  dedupe_key: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  origin_room_id: string | null;
  origin_member_generation: number;
  origin_kind: MemoryOriginKind;
  producer_kind: MemoryProducerKind | null;
  source_id: string | null;
  source_revision: number | null;
  representation_id: string;
  representation_kind: MemoryRepresentationKind;
  range_start: number | null;
  range_end: number | null;
  text_sha256: string;
  receipt_id: string | null;
  evidence: string | null;
  capture: MemoryCaptureState;
  available: number;
  created_at: number;
  updated_at: number;
}

export interface MemoryCoverageRow {
  coverage_id: string;
  dedupe_key: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  origin_room_id: string;
  origin_member_generation: number;
  source_id: string;
  source_revision: number;
  range_start: number;
  range_end: number;
  text_sha256: string;
  experience_id: string;
  created_at: number;
}

export interface MemoryManifestRow {
  manifest_id: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  host_binding_id: string | null;
  host_generation: number | null;
  session_incarnation: string | null;
  run_id: string | null;
  input_id: string | null;
  input_revision: number | null;
  invocation_id: string | null;
  manifest_sha256: string;
  payload_sha256: string;
  target_json: string;
  created_at: number;
}

export interface MemoryManifestItemRow {
  manifest_id: string;
  item_index: number;
  selection_id: string | null;
  representation_id: string;
  origin_scope_json: string;
  text_sha256: string;
}

export interface MemorySelectionRow {
  selection_id: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  recall_id: string | null;
  representation_id: string;
  origin_scope_json: string;
  target_scope_json: string;
  versions_json: string;
  consumption: 'not_consumed';
  state: 'available' | 'expired';
  issued_at: number;
  expires_at: number | null;
}

export interface MemoryCatchupPlanRow {
  plan_id: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  room_id: string;
  member_generation: number;
  upper_bound: number;
  query: string;
  status: 'ready' | 'partial' | 'missing_required' | 'expired';
  budget_json: string;
  scan_cursor_json: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  request_key: string | null;
  request_sha256: string | null;
  policy_revision: number;
  member_seq: number;
  joined_seq: number;
  snapshot_sha256: string | null;
}

export interface MemoryCatchupItemRow {
  plan_id: string;
  item_index: number;
  message_id: string;
  created_seq: number;
  selection_state: 'selected' | 'not_selected' | 'missing';
  reason: string | null;
}

export interface MemoryRecallRequestRow {
  recall_id: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  request_key: string;
  mode: string;
  dispatch: 'explicit' | 'auto';
  status:
    | 'pending'
    | 'ready'
    | 'empty'
    | 'unavailable'
    | 'unsupported'
    | 'disabled'
    | 'skipped_no_boundary';
  target_json: string | null;
  plan_json: string | null;
  budget_json: string | null;
  warmup_only: number;
  result_json: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

export interface MemoryContextRow {
  context_id: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  recall_id: string | null;
  kind: 'lookup' | 'bound';
  body: string;
  body_sha256: string;
  body_bytes: number;
  target_json: string | null;
  versions_json: string;
  policy_version: number;
  status: 'ready' | 'invalidated' | 'expired' | 'purged';
  created_at: number;
  expires_at: number | null;
  updated_at: number;
}

export interface MemoryHostBindingRow {
  binding_id: string;
  space_id: string;
  ownership_epoch: number;
  agent_actor_id: string;
  credential_id: string;
  generation: number;
  session_incarnation: string;
  declared_capabilities_json: string;
  trust_level: 'api_tool_only' | 'adapted_host' | 'controlled_gateway';
  state: 'active' | 'closed' | 'expired' | 'revoked';
  lease_until: number | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export interface MemoryTombstoneRow {
  tombstone_id: string;
  instance_id: string;
  target_kind:
    | 'source'
    | 'source_key'
    | 'representation'
    | 'curated'
    | 'space'
    | 'partition'
    | 'context';
  target_id: string;
  source_key: string | null;
  reason: 'recall' | 'forget' | 'permission' | 'file_deleted' | 'transfer' | 'policy';
  command_id: string | null;
  created_at: number;
}

/** 外部读取 Memory 对象时统一附加的当前状态；purge 状态不伪造已清除。 */
export interface MemoryObjectAvailability {
  available: boolean;
  purge_state: MemoryPurgeState;
  reason: string | null;
}
