-- G07 群历史边界、成员代次与全历史策略。
--
-- 权威模型：
-- - `room_members.member_generation` 从 1 开始，每次重新加入递增；旧游标、
--   旧缓存索引与旧管理凭据不能跨代次继续读取。
-- - `rooms.member_history_policy` 默认 `from_join`：新成员只能读取当前这次
--   加入之后的消息、文件与任务；群主显式改为 `full` 才允许读取加入前内容。
-- - 历史边界仍以 `joined_seq`（事件序号）和 `joined_at`（时间）表达；消息、
--   时间线与 sync 用序号，文件/任务用创建事件序号，旧行没有序号时回退到
--   `created_at`，避免升级后让既有成员突然失去旧内容。
-- - `room_files.created_seq` / `room_tasks.created_seq` 是新写入的权威边界；
--   旧行保持 NULL，仅作为升级兼容回退。
--
-- 本迁移不新增 guard：策略版本仍由 `guard_policy_revision` 裁决，成员代次
-- 只影响读取范围，不参与写事务的版本竞争。

ALTER TABLE room_members ADD COLUMN member_generation INTEGER NOT NULL DEFAULT 1;

ALTER TABLE rooms ADD COLUMN member_history_policy TEXT NOT NULL DEFAULT 'from_join'
  CHECK (member_history_policy IN ('from_join', 'full'));
-- 入群审批、资料编辑与 @所有人 权限；默认保持现有行为（直接邀请、群主/管理员
-- 管理资料、仅群主/管理员可 @所有人）。审批与资料编辑的强制执行分别由 G02/G04
-- 消费这些字段，G07 只负责持久化、返回与版本化。
ALTER TABLE rooms ADD COLUMN member_join_policy TEXT NOT NULL DEFAULT 'open'
  CHECK (member_join_policy IN ('open', 'approval'));
ALTER TABLE rooms ADD COLUMN member_profile_policy TEXT NOT NULL DEFAULT 'owner_admin'
  CHECK (member_profile_policy IN ('members', 'owner_admin'));
ALTER TABLE rooms ADD COLUMN member_mention_all_policy TEXT NOT NULL DEFAULT 'owner_admin'
  CHECK (member_mention_all_policy IN ('members', 'owner_admin'));

ALTER TABLE room_files ADD COLUMN created_seq INTEGER;
ALTER TABLE room_tasks ADD COLUMN created_seq INTEGER;

CREATE INDEX idx_room_files_room_seq ON room_files(room_id, created_seq, file_id);
CREATE INDEX idx_room_tasks_room_seq ON room_tasks(room_id, list_id, created_seq);

-- 加入前的内容不应成为新成员的未读；已有成员一旦有 joined_seq，就把阅读
-- 水位抬到加入边界。legacy 行的 joined_seq 为 0，保持不变。
UPDATE room_members SET last_read_seq = MAX(last_read_seq, joined_seq);
