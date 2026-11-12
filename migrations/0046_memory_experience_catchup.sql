-- MF11：补读快照授权、请求幂等与经历证据追加。
--
-- 0045 已建立 catchup/manifest/experience 主体；本迁移只补 MF11 需要的
-- 不可由现有列安全表达的约束，不重建表、不改 last_read_seq 语义：
-- 1. catchup 计划固定本轮 policy/member 快照，并以 request_key 保证同轮幂等；
-- 2. 经历证据可追加独立 proof，不靠改写原 receipt 或重复制造经历；
-- 3. 按 origin_kind 过滤的稀疏经历列表有稳定索引。

ALTER TABLE memory_catchup_plans ADD COLUMN request_key TEXT;
ALTER TABLE memory_catchup_plans ADD COLUMN request_sha256 TEXT;
ALTER TABLE memory_catchup_plans ADD COLUMN policy_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_catchup_plans ADD COLUMN member_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_catchup_plans ADD COLUMN joined_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memory_catchup_plans ADD COLUMN snapshot_sha256 TEXT;

CREATE UNIQUE INDEX idx_memory_catchup_request
  ON memory_catchup_plans(space_id, agent_actor_id, request_key)
  WHERE request_key IS NOT NULL;

CREATE INDEX idx_memory_catchup_snapshot
  ON memory_catchup_plans(space_id, agent_actor_id, room_id, member_generation, upper_bound);

-- 同一经历可以有多次提交证明；proof_id 独立，manifest/invocation 的唯一关系
-- 仍由 memory_manifests/memory_receipts 负责。证据升级只追加，不改原 receipt。
CREATE TABLE memory_experience_proofs (
  experience_id TEXT NOT NULL REFERENCES memory_experiences(experience_id),
  proof_id TEXT NOT NULL,
  receipt_id TEXT,
  evidence TEXT NOT NULL CHECK (evidence IN (
    'host_reported_submitted', 'gateway_observed_submitted'
  )),
  invocation_id TEXT NOT NULL,
  manifest_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (experience_id, proof_id)
);
CREATE INDEX idx_memory_experience_proofs_proof
  ON memory_experience_proofs(proof_id);
CREATE INDEX idx_memory_experience_proofs_evidence
  ON memory_experience_proofs(experience_id, evidence);

CREATE INDEX idx_memory_experiences_kind
  ON memory_experiences(space_id, ownership_epoch, agent_actor_id, origin_room_id,
                        origin_member_generation, origin_kind, created_at);

-- 最终清单条目是提交证据；除更新外，删除同样破坏历史对账。
CREATE TRIGGER memory_manifest_items_no_delete
BEFORE DELETE ON memory_manifest_items
BEGIN
  SELECT RAISE(ABORT, 'memory_manifest_item_immutable');
END;
