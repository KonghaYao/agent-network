-- Agent 上下线时间线：持久化系统消息，不进入 messages、不推进房间 head。
-- agent_presence_state 每个 Agent 一行，revision 用于持久化 CAS，防止旧 close 覆盖新上线。
-- room_presence_events 是时间线唯一载体；timeline_seq 记录同事务通知事件的 event_seq。
-- presence_pending_rooms 保存最后连接断开时符合条件的 direct 房间，grace 内重连时删除。

CREATE TABLE agent_presence_state (
  actor_id TEXT PRIMARY KEY REFERENCES actors(actor_id),
  revision INTEGER NOT NULL DEFAULT 0,
  generation_id TEXT,
  phase TEXT NOT NULL CHECK (phase IN ('offline', 'online', 'pending_offline')),
  online_at INTEGER,
  disconnect_observed_at INTEGER,
  offline_due_at INTEGER,
  time_basis TEXT NOT NULL DEFAULT 'observed' CHECK (time_basis IN ('observed', 'inferred')),
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_agent_presence_due ON agent_presence_state(phase, offline_due_at);

CREATE TABLE room_presence_events (
  presence_event_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  generation_id TEXT NOT NULL,
  transition TEXT NOT NULL CHECK (transition IN ('online', 'offline')),
  occurred_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  timeline_seq INTEGER NOT NULL,
  time_basis TEXT NOT NULL CHECK (time_basis IN ('observed', 'inferred')),
  UNIQUE (room_id, generation_id, transition)
);
CREATE INDEX idx_room_presence_timeline
  ON room_presence_events(room_id, occurred_at DESC, timeline_seq DESC);
CREATE INDEX idx_room_presence_seq ON room_presence_events(room_id, timeline_seq);
CREATE INDEX idx_room_presence_agent ON room_presence_events(agent_id, occurred_at);

CREATE TABLE presence_pending_rooms (
  generation_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  PRIMARY KEY (generation_id, room_id)
);

DROP TABLE IF EXISTS guard_presence_stale;
CREATE TABLE guard_presence_stale (x INTEGER NOT NULL, CONSTRAINT guard_presence_stale CHECK (x = 0));
