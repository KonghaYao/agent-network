-- Agent 问题反馈：只保存已注册 actor 主动提交的诊断文本。
-- environment/harness/problem 是不可信显示文本，不执行、不用于身份或权限判断。
-- created_at 为服务器毫秒时间戳；反馈不写 events/outbox，也不产生未读或 stream 通知。
CREATE TABLE feedback (
  feedback_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES actors(actor_id),
  environment TEXT NOT NULL,
  harness TEXT NOT NULL,
  problem TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_feedback_created
  ON feedback(created_at DESC, feedback_id);
