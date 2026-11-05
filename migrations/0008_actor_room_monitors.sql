-- 每个 human 在每个房间私有的网页监控地址。
-- 只保存 URL，不保存 iframe 内容；服务端不访问该 URL。
-- 该配置不写 events/outbox，不改变 rooms.head_seq、last_read_seq 或 pending_count。
CREATE TABLE actor_room_monitors (
  actor_id TEXT NOT NULL REFERENCES actors(actor_id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK (url <> ''),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, room_id)
);
