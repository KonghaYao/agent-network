-- D07 · 验收结论、追加任务关系与验收版本闸门。
--
-- 目的：
-- - `task_reviews` 的 0017 结构只保存 accept/return、reason 与时间；D07 需要
--   记录验收人对 `acceptance_criteria` 的逐项核对结果，因此追加
--   `checklist_json`。它是验收结论的证据快照，不是第二份任务状态。
-- - accepted 是终态；追加工作必须创建关联新任务。`tasks` 追加可空的
--   `parent_task_id` / `related_task_id`，由创建参数写入，后续状态变化不改写。
-- - 验收版本冲突使用独立闸门 `guard_review_stale`，让旧 submission/version
--   映射为 `REVIEW_STALE`，不与编辑版本 `VERSION_CONFLICT` 混用。
--
-- 权威状态：
-- - `tasks.status`、`tasks.revision`、`task_submissions.status` 仍是唯一权威。
-- - `checklist_json` 只解释该条 review 的核对内容；旧 accept 行没有清单时为空
--   数组，读取侧不据此推断验收通过。
-- - `parent_task_id` / `related_task_id` 只表达任务关系，不复制父任务状态，
--   也不授予额外执行权。
--
-- 约束/索引：
-- - checklist_json 默认 '[]'，旧行自动获得空数组，不需要回填。
-- - 父/关联任务索引仅用于读取关联任务；同房间与父任务终态在写入事务前校验，
--   父任务 accepted/cancelled 都是终态，不会被后续状态变化绕过。
-- - 闸门表与 0002 相同，只接受 x = 0；正常提交后始终为空。
--
-- 旧数据映射：
-- - 现有任务 parent_task_id/related_task_id 为 NULL，表示没有登记关系。
-- - 现有 review 的 checklist_json 为 '[]'；旧 return 的 reason 保持不变。
--
-- 恢复方式：
-- - 回退应用版本时旧代码忽略新增列与新闸门表，数据库保持可用。
-- - 本迁移不删除、不重建任何已发布表，也不改写既有行。

ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
ALTER TABLE tasks ADD COLUMN related_task_id TEXT;
CREATE INDEX idx_tasks_parent_task ON tasks(parent_task_id);
CREATE INDEX idx_tasks_related_task ON tasks(related_task_id);

ALTER TABLE task_reviews ADD COLUMN checklist_json TEXT NOT NULL DEFAULT '[]';

CREATE TABLE guard_review_stale (
  x INTEGER NOT NULL,
  CONSTRAINT guard_review_stale CHECK (x = 0)
);
