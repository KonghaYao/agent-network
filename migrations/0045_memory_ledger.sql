-- MF02/MF03：Agent Memory 空间归属、权威来源、治理日志与持久作业。
--
-- 物理表一次冻结，覆盖 DATA-FLOW §3 的长期对象：
-- instance/spaces/transitions、shared sources/curated、representations/dependencies、
-- governance commands、cursors、jobs/retain intents、receipts、experiences/coverage、
-- selections/manifests、recall requests/contexts、host bindings、projections、
-- catchup plans 与 permanent tombstones。
--
-- 三条不可交换的存储边界：
-- 1. Memory 账本独立于通用 operations/events TTL；operations 过期不能删除来源、
--    回执、经历或 tombstone。
-- 2. 只有合格 ExposureReceipt、准确 ExperienceEntry 与获准 retain 意图同事务写入；
--    派发、claim、预热、查询返回都不在该事务里产生个人经历。
-- 3. space/ownership/backend epoch 与 backend job ref 一起保存；换库不能让旧
--    JobRef 查新库，旧 owner 正文也不会随 binding_id 原地保留而转移。

-- 部署稳定 instance：首次启动写入后不再随机变化。
CREATE TABLE memory_instances (
  instance_id TEXT PRIMARY KEY,
  capture_default TEXT NOT NULL DEFAULT 'enabled'
    CHECK (capture_default IN ('enabled', 'disabled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 活动空间唯一；旧空间保留原权属与治理记录，但 active=0。
CREATE TABLE memory_spaces (
  space_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES memory_instances(instance_id),
  agent_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  owner_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  ownership_kind TEXT NOT NULL CHECK (ownership_kind IN ('managed', 'self_owned')),
  ownership_epoch INTEGER NOT NULL CHECK (ownership_epoch >= 1),
  backend_binding_epoch INTEGER NOT NULL DEFAULT 1 CHECK (backend_binding_epoch >= 1),
  management_binding_id TEXT,
  capture TEXT NOT NULL DEFAULT 'pending'
    CHECK (capture IN ('none', 'pending', 'extracted', 'excluded')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memory_spaces_active
  ON memory_spaces(agent_actor_id) WHERE active = 1;
CREATE INDEX idx_memory_spaces_owner ON memory_spaces(owner_actor_id, active);
CREATE INDEX idx_memory_spaces_instance ON memory_spaces(instance_id, active);

-- 归属变化记录；initial_claim/management_transfer 必须切 epoch 与 space。
CREATE TABLE memory_space_transitions (
  transition_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  previous_space_id TEXT,
  agent_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  kind TEXT NOT NULL CHECK (kind IN ('initial_enable', 'initial_claim', 'management_transfer')),
  previous_owner_actor_id TEXT,
  next_owner_actor_id TEXT NOT NULL,
  previous_ownership_epoch INTEGER NOT NULL,
  next_ownership_epoch INTEGER NOT NULL CHECK (next_ownership_epoch >= 1),
  closed_host_binding_ids TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memory_space_transitions_epoch
  ON memory_space_transitions(agent_actor_id, next_ownership_epoch);
CREATE INDEX idx_memory_space_transitions_space
  ON memory_space_transitions(space_id, created_at DESC);

-- 共享来源修订。source_key 是业务稳定身份；同一 key 的 active 版本唯一。
-- 内容正文只在策略允许时保存；业务权威仍由原 message/task/file 系统持有。
CREATE TABLE memory_sources (
  source_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'message', 'task_offer', 'task_detail', 'task_attachment', 'task_submission',
    'task_review', 'task_handoff', 'file', 'langfuse_observation', 'manual'
  )),
  business_ref_kind TEXT NOT NULL,
  business_ref_json TEXT NOT NULL,
  origin_room_id TEXT,
  origin_member_generation INTEGER NOT NULL DEFAULT 0 CHECK (origin_member_generation >= 0),
  origin_policy_revision INTEGER NOT NULL DEFAULT 0 CHECK (origin_policy_revision >= 0),
  origin_joined_seq INTEGER NOT NULL DEFAULT 0,
  origin_joined_at INTEGER NOT NULL DEFAULT 0,
  origin_archive_head_seq INTEGER,
  origin_seq INTEGER,
  origin_created_at INTEGER NOT NULL,
  author_actor_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'retracted')),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  content_text TEXT,
  content_sha256 TEXT,
  content_bytes INTEGER CHECK (content_bytes IS NULL OR content_bytes >= 0),
  superseded_by_source_id TEXT,
  superseded_by_revision INTEGER,
  retracted_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memory_sources_revision
  ON memory_sources(instance_id, source_key, revision);
CREATE UNIQUE INDEX idx_memory_sources_active
  ON memory_sources(instance_id, source_key) WHERE state = 'active';
CREATE INDEX idx_memory_sources_room
  ON memory_sources(origin_room_id, state, origin_created_at);
CREATE INDEX idx_memory_sources_author ON memory_sources(author_actor_id, state);

-- 人工明确保存的记忆；expected_revision 由 store 校验，current 唯一。
CREATE TABLE memory_curated (
  curated_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL CHECK (ownership_epoch >= 1),
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'imported_external_knowledge')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1 CHECK (current IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (curated_id, revision)
);
CREATE UNIQUE INDEX idx_memory_curated_current
  ON memory_curated(curated_id) WHERE current = 1;
CREATE INDEX idx_memory_curated_space ON memory_curated(space_id, current);

-- 准确表示与依赖。raw_* 才推进原文覆盖；summary/context/authored 各自保留来源。
CREATE TABLE memory_representations (
  representation_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'raw_full', 'raw_fragment', 'preview', 'summary', 'memory_context', 'authored'
  )),
  source_id TEXT,
  source_revision INTEGER,
  summary_id TEXT,
  summary_revision INTEGER,
  source_context_id TEXT,
  producer_kind TEXT CHECK (producer_kind IS NULL OR producer_kind IN (
    'agent_text', 'server_template', 'mixed'
  )),
  lineage TEXT CHECK (lineage IS NULL OR lineage IN ('run_bound', 'lineage_unknown')),
  partition_id TEXT,
  partition_generation INTEGER,
  partition_policy_revision INTEGER,
  range_start INTEGER,
  range_end INTEGER,
  text TEXT NOT NULL,
  text_bytes INTEGER NOT NULL CHECK (text_bytes >= 0),
  text_sha256 TEXT NOT NULL,
  verbatim INTEGER NOT NULL CHECK (verbatim IN (0, 1)),
  created_at INTEGER NOT NULL,
  CHECK (range_start IS NULL OR (range_start >= 0 AND range_end > range_start))
);
CREATE INDEX idx_memory_representations_source
  ON memory_representations(source_id, source_revision);
CREATE INDEX idx_memory_representations_summary
  ON memory_representations(summary_id, summary_revision);

CREATE TABLE memory_representation_dependencies (
  representation_id TEXT NOT NULL REFERENCES memory_representations(representation_id),
  dependency_index INTEGER NOT NULL CHECK (dependency_index >= 0),
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  depends_on_representation_id TEXT,
  range_start INTEGER,
  range_end INTEGER,
  PRIMARY KEY (representation_id, dependency_index)
);
CREATE INDEX idx_memory_representation_dependencies_source
  ON memory_representation_dependencies(source_id, source_revision);

-- space-scoped 治理命令流；连续确认前缀由 memory_cursors 记录。
CREATE TABLE memory_governance_commands (
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  command_seq INTEGER NOT NULL CHECK (command_seq >= 1),
  command_id TEXT NOT NULL UNIQUE,
  mutation_kind TEXT NOT NULL CHECK (mutation_kind IN (
    'source_register', 'source_retract', 'source_correct', 'curated_put',
    'curated_correct', 'forget', 'space_close'
  )),
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  target_revision INTEGER,
  payload_sha256 TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'unknown', 'failed')),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  applied_at INTEGER,
  PRIMARY KEY (space_id, command_seq)
);
CREATE UNIQUE INDEX idx_memory_governance_idempotency
  ON memory_governance_commands(space_id, idempotency_key);
CREATE INDEX idx_memory_governance_status
  ON memory_governance_commands(space_id, status, command_seq);
CREATE INDEX idx_memory_governance_target
  ON memory_governance_commands(target_kind, target_id, command_seq);

-- 连续确认水位、扫描位置与对账水位；不取 MAX(completed) 代替前缀。
CREATE TABLE memory_cursors (
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('space', 'agent', 'room', 'recall')),
  scope_id TEXT NOT NULL,
  cursor_kind TEXT NOT NULL,
  value INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_kind, scope_id, cursor_kind)
);

-- 后端作业。source/remove 优先于 recall；operation_key 长期幂等，不受 operations TTL 影响。
CREATE TABLE memory_jobs (
  job_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL CHECK (ownership_epoch >= 1),
  agent_actor_id TEXT NOT NULL,
  operation_type TEXT NOT NULL CHECK (operation_type IN (
    'ensure_space', 'source_apply', 'retain', 'remove', 'recall', 'rebuild'
  )),
  operation_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  source_command_id TEXT,
  recall_id TEXT,
  retain_intent_id TEXT,
  target_json TEXT,
  result_json TEXT,
  backend_binding_epoch INTEGER NOT NULL CHECK (backend_binding_epoch >= 1),
  provider_job_id TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'leased', 'completed', 'failed', 'unknown', 'cancelled'
  )),
  stage TEXT NOT NULL CHECK (stage IN ('accepted', 'source_applied', 'derived_ready', 'unknown')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_id TEXT,
  lease_until INTEGER,
  next_attempt_at INTEGER NOT NULL,
  unknown_since INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE UNIQUE INDEX idx_memory_jobs_operation
  ON memory_jobs(space_id, operation_key);
CREATE INDEX idx_memory_jobs_due
  ON memory_jobs(status, next_attempt_at, operation_type);
CREATE INDEX idx_memory_jobs_lease ON memory_jobs(status, lease_until);
CREATE INDEX idx_memory_jobs_space
  ON memory_jobs(space_id, operation_type, status);
CREATE INDEX idx_memory_jobs_retain
  ON memory_jobs(retain_intent_id) WHERE retain_intent_id IS NOT NULL;

-- 获准个人 retain 意图；与 receipt/experience 同事务写入。
CREATE TABLE memory_retain_intents (
  retain_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL CHECK (ownership_epoch >= 1),
  agent_actor_id TEXT NOT NULL,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('experienced', 'authored', 'curated')),
  experience_id TEXT,
  representation_id TEXT NOT NULL REFERENCES memory_representations(representation_id),
  source_id TEXT,
  source_revision INTEGER,
  receipt_id TEXT,
  curated_id TEXT,
  curated_revision INTEGER,
  evidence TEXT CHECK (evidence IS NULL OR evidence IN (
    'host_reported_submitted', 'gateway_observed_submitted'
  )),
  policy_version INTEGER NOT NULL,
  operation_key TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'leased', 'retained', 'skipped', 'suppressed', 'unknown', 'failed'
  )),
  job_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memory_retain_operation
  ON memory_retain_intents(space_id, operation_key);
CREATE INDEX idx_memory_retain_status
  ON memory_retain_intents(space_id, status, created_at);
CREATE INDEX idx_memory_retain_receipt
  ON memory_retain_intents(receipt_id) WHERE receipt_id IS NOT NULL;

-- 宿主等级、binding 代次与租约；关闭后不能继续签发 Context。
CREATE TABLE memory_host_bindings (
  binding_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL CHECK (ownership_epoch >= 1),
  agent_actor_id TEXT NOT NULL,
  credential_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  session_incarnation TEXT NOT NULL,
  declared_capabilities_json TEXT NOT NULL DEFAULT '[]',
  trust_level TEXT NOT NULL CHECK (trust_level IN (
    'api_tool_only', 'adapted_host', 'controlled_gateway'
  )),
  state TEXT NOT NULL CHECK (state IN ('active', 'closed', 'expired', 'revoked')),
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE UNIQUE INDEX idx_memory_host_bindings_active
  ON memory_host_bindings(space_id, session_incarnation) WHERE state = 'active';
CREATE INDEX idx_memory_host_bindings_agent
  ON memory_host_bindings(agent_actor_id, state, updated_at DESC);

-- 可供输入的选择；没有消费字段，消费只能由 manifest + receipt 证明。
CREATE TABLE memory_selections (
  selection_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL,
  agent_actor_id TEXT NOT NULL,
  recall_id TEXT,
  representation_id TEXT NOT NULL REFERENCES memory_representations(representation_id),
  origin_scope_json TEXT NOT NULL,
  target_scope_json TEXT NOT NULL,
  versions_json TEXT NOT NULL,
  consumption TEXT NOT NULL DEFAULT 'not_consumed'
    CHECK (consumption = 'not_consumed'),
  state TEXT NOT NULL CHECK (state IN ('available', 'expired')),
  issued_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX idx_memory_selections_space
  ON memory_selections(space_id, state, issued_at);
CREATE INDEX idx_memory_selections_recall
  ON memory_selections(recall_id) WHERE recall_id IS NOT NULL;

-- 最终输入清单；同一 invocation 只能绑定一个 manifest。
CREATE TABLE memory_manifests (
  manifest_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL,
  agent_actor_id TEXT NOT NULL,
  host_binding_id TEXT,
  host_generation INTEGER,
  session_incarnation TEXT,
  run_id TEXT,
  input_id TEXT,
  input_revision INTEGER,
  invocation_id TEXT,
  manifest_sha256 TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  target_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memory_manifests_invocation
  ON memory_manifests(space_id, ownership_epoch, agent_actor_id, host_binding_id, invocation_id)
  WHERE host_binding_id IS NOT NULL AND invocation_id IS NOT NULL;

CREATE TABLE memory_manifest_items (
  manifest_id TEXT NOT NULL REFERENCES memory_manifests(manifest_id),
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  selection_id TEXT,
  representation_id TEXT NOT NULL,
  origin_scope_json TEXT NOT NULL,
  text_sha256 TEXT NOT NULL,
  PRIMARY KEY (manifest_id, item_index)
);

-- 召回请求；warmup_only=1 只代表预召回资格，没有注入许可。
CREATE TABLE memory_recall_requests (
  recall_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL,
  agent_actor_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  mode TEXT NOT NULL,
  dispatch TEXT NOT NULL CHECK (dispatch IN ('explicit', 'auto')),
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'ready', 'empty', 'unavailable', 'unsupported', 'disabled',
    'skipped_no_boundary'
  )),
  target_json TEXT,
  plan_json TEXT,
  budget_json TEXT,
  warmup_only INTEGER NOT NULL DEFAULT 1 CHECK (warmup_only IN (0, 1)),
  result_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE UNIQUE INDEX idx_memory_recall_request_key
  ON memory_recall_requests(space_id, request_key);
CREATE INDEX idx_memory_recall_status
  ON memory_recall_requests(space_id, status, created_at);

-- Context 正文 immutable 或被清除，不静默原地改写。
CREATE TABLE memory_contexts (
  context_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL,
  agent_actor_id TEXT NOT NULL,
  recall_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('lookup', 'bound')),
  body TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0),
  target_json TEXT,
  versions_json TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'invalidated', 'expired', 'purged')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_contexts_agent
  ON memory_contexts(space_id, agent_actor_id, status, created_at);

CREATE TABLE memory_context_items (
  context_id TEXT NOT NULL REFERENCES memory_contexts(context_id),
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  experience_id TEXT,
  representation_id TEXT NOT NULL,
  source_dependencies_json TEXT NOT NULL,
  evidence TEXT,
  origin_scope_json TEXT NOT NULL,
  PRIMARY KEY (context_id, item_index)
);
CREATE INDEX idx_memory_context_items_representation
  ON memory_context_items(representation_id);

-- 分群经历：稀疏原文/片段/摘要/authored 分开；dedupe_key 含 space/ownership/room 代次/修订/表示/范围/hash。
CREATE TABLE memory_experiences (
  experience_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL CHECK (ownership_epoch >= 1),
  agent_actor_id TEXT NOT NULL,
  origin_room_id TEXT,
  origin_member_generation INTEGER NOT NULL DEFAULT 0,
  origin_kind TEXT NOT NULL CHECK (origin_kind IN ('experienced', 'authored', 'curated')),
  producer_kind TEXT CHECK (producer_kind IS NULL OR producer_kind IN (
    'agent_text', 'server_template', 'mixed'
  )),
  source_id TEXT,
  source_revision INTEGER,
  representation_id TEXT NOT NULL REFERENCES memory_representations(representation_id),
  representation_kind TEXT NOT NULL,
  range_start INTEGER,
  range_end INTEGER,
  text_sha256 TEXT NOT NULL,
  receipt_id TEXT,
  evidence TEXT,
  capture TEXT NOT NULL CHECK (capture IN ('none', 'pending', 'extracted', 'excluded')),
  available INTEGER NOT NULL DEFAULT 1 CHECK (available IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_experiences_lookup
  ON memory_experiences(space_id, ownership_epoch, agent_actor_id, origin_room_id,
                       origin_member_generation, created_at);
CREATE INDEX idx_memory_experiences_representation
  ON memory_experiences(representation_id);
CREATE INDEX idx_memory_experiences_source
  ON memory_experiences(source_id, source_revision);

-- 稀疏原文覆盖；按 member generation 隔离，退群重加不会复制旧游标。
CREATE TABLE memory_coverage_ranges (
  coverage_id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL,
  agent_actor_id TEXT NOT NULL,
  origin_room_id TEXT NOT NULL,
  origin_member_generation INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  range_start INTEGER NOT NULL CHECK (range_start >= 0),
  range_end INTEGER NOT NULL CHECK (range_end > range_start),
  text_sha256 TEXT NOT NULL,
  experience_id TEXT NOT NULL REFERENCES memory_experiences(experience_id),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_memory_coverage_scope
  ON memory_coverage_ranges(space_id, ownership_epoch, agent_actor_id, origin_room_id,
                            origin_member_generation, source_id, source_revision);

-- 回执；kind 分开交付与源输入消费；同 invocation 只绑定一个 manifest。
CREATE TABLE memory_receipts (
  receipt_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('input_exposure', 'context_delivery')),
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL,
  agent_actor_id TEXT NOT NULL,
  host_binding_id TEXT,
  host_generation INTEGER,
  session_incarnation TEXT,
  run_id TEXT,
  input_id TEXT,
  input_revision INTEGER,
  invocation_id TEXT,
  manifest_id TEXT,
  manifest_sha256 TEXT,
  payload_sha256 TEXT,
  context_id TEXT,
  context_sha256 TEXT,
  target_scope_json TEXT NOT NULL,
  origin_scopes_json TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL,
  proof_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('applied', 'history_only', 'rejected')),
  reason TEXT,
  recorded_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memory_receipts_idempotency
  ON memory_receipts(idempotency_key);
CREATE UNIQUE INDEX idx_memory_receipts_invocation
  ON memory_receipts(kind, space_id, ownership_epoch, agent_actor_id, host_binding_id, invocation_id)
  WHERE host_binding_id IS NOT NULL AND invocation_id IS NOT NULL;
CREATE UNIQUE INDEX idx_memory_receipts_proof ON memory_receipts(proof_id);
CREATE INDEX idx_memory_receipts_space
  ON memory_receipts(space_id, kind, recorded_at);

-- 可重建投影；BackendRef 永远绑定原 backend_binding_epoch。
CREATE TABLE memory_projections (
  projection_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL,
  backend_binding_epoch INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_ref TEXT NOT NULL,
  source_id TEXT,
  source_revision INTEGER,
  representation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'purged', 'unknown')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memory_projections_ref
  ON memory_projections(space_id, backend_binding_epoch, provider, provider_ref);

-- 补读计划；scan_cursor 只记录扫描，不代表已消费。
CREATE TABLE memory_catchup_plans (
  plan_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL REFERENCES memory_spaces(space_id),
  ownership_epoch INTEGER NOT NULL,
  agent_actor_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  member_generation INTEGER NOT NULL,
  upper_bound INTEGER NOT NULL,
  query TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ready', 'partial', 'missing_required', 'expired')),
  budget_json TEXT NOT NULL,
  scan_cursor_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX idx_memory_catchup_agent
  ON memory_catchup_plans(space_id, agent_actor_id, room_id, status);

CREATE TABLE memory_catchup_items (
  plan_id TEXT NOT NULL REFERENCES memory_catchup_plans(plan_id),
  item_index INTEGER NOT NULL CHECK (item_index >= 0),
  message_id TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  selection_state TEXT NOT NULL CHECK (selection_state IN (
    'selected', 'not_selected', 'missing'
  )),
  reason TEXT,
  PRIMARY KEY (plan_id, item_index)
);

-- 永久删除屏障；通用 TTL/清理不得删除。source_key 防止已知原文再次导入。
CREATE TABLE memory_tombstones (
  tombstone_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN (
    'source', 'source_key', 'representation', 'curated', 'space', 'partition', 'context'
  )),
  target_id TEXT NOT NULL,
  source_key TEXT,
  reason TEXT NOT NULL CHECK (reason IN (
    'recall', 'forget', 'permission', 'file_deleted', 'transfer', 'policy'
  )),
  command_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_memory_tombstones_target
  ON memory_tombstones(target_kind, target_id, reason);
CREATE INDEX idx_memory_tombstones_source_key
  ON memory_tombstones(source_key) WHERE source_key IS NOT NULL;

-- Context 正文允许清除为空，但不允许静默原地改写。
CREATE TRIGGER memory_contexts_body_immutable
BEFORE UPDATE OF body, body_sha256, body_bytes ON memory_contexts
WHEN NEW.body <> OLD.body AND NEW.body <> ''
BEGIN
  SELECT RAISE(ABORT, 'memory_context_body_immutable');
END;

-- 清单项是最终提交证据的一部分，不能被原地改写。
CREATE TRIGGER memory_manifest_items_immutable
BEFORE UPDATE ON memory_manifest_items
BEGIN
  SELECT RAISE(ABORT, 'memory_manifest_item_immutable');
END;

-- 删除屏障永久有效；显式治理只能追加，不能删除历史。
CREATE TRIGGER memory_tombstones_no_delete
BEFORE DELETE ON memory_tombstones
BEGIN
  SELECT RAISE(ABORT, 'memory_tombstone_permanent');
END;
