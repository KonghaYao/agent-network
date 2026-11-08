-- D06 · 成果提交的来源与外部证据。
--
-- 0017 已冻结 `task_submissions` 的版本、材料、证据与审核状态；本迁移只补充
-- 外链与实现提交 SHA 两个可空/默认字段，不重建表、不改变状态 CHECK：
-- - `links_json` 保存提交时的外链快照：url、title、version、digest 与提交者声明
--   的 availability。服务端不抓取外链；可访问不等于验收通过，URL 本身也不是
--   不可变字节证据。
-- - `commit_sha` 保存实现提交 SHA；非代码任务可以留空，但提交必须至少有一项
--   可核对成果（材料、链接、证据或提交 SHA）。
-- - 材料校验值仍冻结在 `materials_json`；文件字节保留由 `file_references`
--   （kind = task，ref_id = task_id）与 `retained` 共同保证。
-- - 旧行默认 `links_json = '[]'`、`commit_sha = NULL`，读取时保持兼容；不需要
--   回填，也不会把旧提交误认为有外链或 Git 证据。

ALTER TABLE task_submissions ADD COLUMN links_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE task_submissions ADD COLUMN commit_sha TEXT;
