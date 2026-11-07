-- P0 条件闸门（0018）。每张表只在失败语句中写入，正常提交后始终为空。
-- 表名与 CONSTRAINT 名称同时作为 mapBatchError 的错误分类依据。

DROP TABLE IF EXISTS guard_permission_denied;
CREATE TABLE guard_permission_denied (x INTEGER NOT NULL, CONSTRAINT guard_permission_denied CHECK (x = 0));

DROP TABLE IF EXISTS guard_membership_stale;
CREATE TABLE guard_membership_stale (x INTEGER NOT NULL, CONSTRAINT guard_membership_stale CHECK (x = 0));

DROP TABLE IF EXISTS guard_version_conflict;
CREATE TABLE guard_version_conflict (x INTEGER NOT NULL, CONSTRAINT guard_version_conflict CHECK (x = 0));

DROP TABLE IF EXISTS guard_assignment_stale;
CREATE TABLE guard_assignment_stale (x INTEGER NOT NULL, CONSTRAINT guard_assignment_stale CHECK (x = 0));

DROP TABLE IF EXISTS guard_quota_exceeded;
CREATE TABLE guard_quota_exceeded (x INTEGER NOT NULL, CONSTRAINT guard_quota_exceeded CHECK (x = 0));

DROP TABLE IF EXISTS guard_request_expired;
CREATE TABLE guard_request_expired (x INTEGER NOT NULL, CONSTRAINT guard_request_expired CHECK (x = 0));

DROP TABLE IF EXISTS guard_invite_exhausted;
CREATE TABLE guard_invite_exhausted (x INTEGER NOT NULL, CONSTRAINT guard_invite_exhausted CHECK (x = 0));

DROP TABLE IF EXISTS guard_blocked;
CREATE TABLE guard_blocked (x INTEGER NOT NULL, CONSTRAINT guard_blocked CHECK (x = 0));

DROP TABLE IF EXISTS guard_actor_disabled;
CREATE TABLE guard_actor_disabled (x INTEGER NOT NULL, CONSTRAINT guard_actor_disabled CHECK (x = 0));

DROP TABLE IF EXISTS guard_pairing_invalid;
CREATE TABLE guard_pairing_invalid (x INTEGER NOT NULL, CONSTRAINT guard_pairing_invalid CHECK (x = 0));

DROP TABLE IF EXISTS guard_task_state;
CREATE TABLE guard_task_state (x INTEGER NOT NULL, CONSTRAINT guard_task_state CHECK (x = 0));

DROP TABLE IF EXISTS guard_friend_required;
CREATE TABLE guard_friend_required (x INTEGER NOT NULL, CONSTRAINT guard_friend_required CHECK (x = 0));
