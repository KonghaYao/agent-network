-- Task Focus 个人看板：秘书绑定、个人卡、证据、修订、作业、候选、扫描水位与领取流水。
--
-- 结构以 `docs/design/task-focus-data-model.md` 为准：个人卡主键与消息 ID 解耦，
-- 证据只存定位与用途，正文在读取时按当前权限重取。时间列不带默认值表达式，
-- 一律由调用方写入；缺省 0 只用于占位，不引入非确定性函数。
-- 旧的 `messages.task_*` 与两代 Task 表由后续迁移删除，本文件不触碰。

CREATE TABLE focus_bindings (
  owner_actor_id TEXT PRIMARY KEY REFERENCES actors(actor_id),
  secretary_actor_id TEXT NOT NULL UNIQUE REFERENCES actors(actor_id),
  -- 供远端 sessions.create 幂等；同一行重试不会产生第二个根会话。
  provisioning_key TEXT NOT NULL UNIQUE,
  session_id TEXT UNIQUE,
  root_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'paused', 'failed')),
  -- 暂停/重开时递增，旧代次的作业写入被拒。
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  -- 首开/重开的已提交事件水位。
  event_from_seq INTEGER NOT NULL DEFAULT 0,
  enabled_at INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE focus_items (
  item_id TEXT PRIMARY KEY,
  owner_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  secretary_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  title TEXT NOT NULL DEFAULT '',
  column_key TEXT NOT NULL CHECK (column_key IN ('needs_me', 'tracking', 'done')),
  next_step TEXT NOT NULL DEFAULT '',
  waiting_on TEXT,
  due_at INTEGER,
  due_text TEXT,
  summary TEXT NOT NULL DEFAULT '',
  -- 并发冲突与跨作业去重的版本；归档也递增。
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  archived_at INTEGER,
  archived_by TEXT REFERENCES actors(actor_id),
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  -- 归档是独立维度：时间与操作者必须同时存在。
  CHECK (
    (archived_at IS NULL AND archived_by IS NULL)
    OR (archived_at IS NOT NULL AND archived_by IS NOT NULL)
  )
);

CREATE INDEX idx_focus_items_owner
  ON focus_items(owner_actor_id, archived_at, column_key, updated_at DESC, item_id DESC);

CREATE TABLE focus_evidence (
  evidence_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES focus_items(item_id),
  owner_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('message', 'delivery')),
  -- 稳定来源身份（`message:<id>` / `delivery:<id>`）；SQLite 的 UNIQUE 视 NULL 为
  -- 互不相同，因此把可空的 room/message/delivery 列收敛到这一列做去重。
  source_key TEXT NOT NULL,
  room_id TEXT,
  message_id TEXT,
  delivery_id TEXT,
  source_revision INTEGER NOT NULL DEFAULT 0,
  purpose TEXT NOT NULL,
  occurred_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (item_id, source_key, purpose)
);

CREATE INDEX idx_focus_evidence_item
  ON focus_evidence(item_id, created_at, evidence_id);

CREATE TABLE focus_revisions (
  revision_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES focus_items(item_id),
  version INTEGER NOT NULL,
  -- 业务幂等键：同一 decision 可改多张卡，因此这里只建普通索引；
  -- 每个决定只有一份业务回执由 operations(actor, request_id) 保证。
  decision_id TEXT NOT NULL,
  changes_json TEXT NOT NULL DEFAULT '{}',
  reason TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (item_id, version)
);

CREATE INDEX idx_focus_revisions_item
  ON focus_revisions(item_id, version, revision_id);
CREATE INDEX idx_focus_revisions_decision
  ON focus_revisions(decision_id);

CREATE TABLE focus_jobs (
  job_id TEXT PRIMARY KEY,
  owner_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  secretary_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  -- 本次授权与提交幂等键；两者都由服务端签发。
  attempt_ref TEXT NOT NULL UNIQUE,
  submission_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'submitted', 'running', 'waiting', 'completed', 'failed', 'cancelled')
  ),
  generation INTEGER NOT NULL,
  event_from_seq INTEGER NOT NULL DEFAULT 0,
  event_to_seq INTEGER NOT NULL DEFAULT 0,
  turn_id TEXT,
  input_id TEXT,
  lease_until INTEGER,
  -- 重试计数：作业重新派发时递增，不用于幂等判断。
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);

-- 每人同时至多一个活跃作业。
CREATE UNIQUE INDEX idx_focus_jobs_one_active
  ON focus_jobs(owner_actor_id)
  WHERE status IN ('queued', 'submitted', 'running', 'waiting');

CREATE TABLE focus_candidates (
  candidate_id TEXT PRIMARY KEY,
  owner_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  -- 作业只读取分配给自己的候选；NULL 表示尚未分配。
  job_id TEXT,
  source_kind TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  room_id TEXT,
  message_id TEXT,
  delivery_id TEXT,
  source_key TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'assigned', 'consumed', 'skipped')),
  decision TEXT,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (owner_actor_id, event_seq, source_key)
);

CREATE INDEX idx_focus_candidates_pending
  ON focus_candidates(owner_actor_id, state, event_seq);
CREATE INDEX idx_focus_candidates_job
  ON focus_candidates(job_id, state);

-- 逻辑 Watch 中心共用一份已提交事件读取进度；单行，重启后从这里继续。
CREATE TABLE focus_scan_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  event_seq INTEGER NOT NULL DEFAULT 0,
  last_scan_at INTEGER NOT NULL DEFAULT 0
);

INSERT INTO focus_scan_state (id, event_seq, last_scan_at) VALUES (1, 0, 0);

-- 在既有 deliveryClaim() 同一批次追加的领取流水；无论是否开启秘书都留痕。
CREATE TABLE focus_delivery_claims (
  delivery_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  recipient_actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  claimed_by TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  event_seq INTEGER NOT NULL DEFAULT 0,
  claimed_at INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_focus_delivery_claims_recipient
  ON focus_delivery_claims(recipient_actor_id, event_seq);

-- 归档屏障：已归档仍更新时整批拒绝。
CREATE TABLE guard_focus_archive_conflict (
  x INTEGER NOT NULL,
  CONSTRAINT guard_focus_archive_conflict CHECK (x = 0)
);

-- 秘书写入：代次、租约或来源修订失效时整批拒绝。
CREATE TABLE guard_focus_stale_attempt (
  x INTEGER NOT NULL,
  CONSTRAINT guard_focus_stale_attempt CHECK (x = 0)
);
