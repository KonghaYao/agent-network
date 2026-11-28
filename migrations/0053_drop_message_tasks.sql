-- TF-08：删除消息式 Task 的数据面（破坏性，不备份、不做只读保留）。
--
-- Task Focus（0052 的 `focus_*`）是后续里程碑，本迁移不触碰。此文件只清理
-- 0041/0048 引入的消息式 Task：归属/标记/完成五列、`idx_messages_task_root`、
-- 两个标记闸门、任务事件与其投递、任务写操作结果，以及 Memory 里全部
-- `task_*` 派生来源。普通消息、引用链（`reply_to`/`root_id`/`hop`）、delivery、
-- 未读与历史边界全部保留。
--
-- 顺序固定：先清 outbox 再清 events，避免 outbox 指向已删事件；先删索引
-- 再删列（SQLite 不允许删除被索引引用的列）；`messages` 五列最后处理。
--
-- 重放：`DROP INDEX`/`DROP TABLE` 可重复执行；`ALTER TABLE ... DROP COLUMN`
-- 受 SQLite 语法限制不能在列已不存在时重放，由 `schema_migrations` 保证只
-- 应用一次。不使用 `PRAGMA foreign_keys=OFF`：迁移在事务内执行，该 PRAGMA
-- 在事务中无效；本文件只删子行与列，不重建父表。

-- 1. 任务归属索引。
DROP INDEX IF EXISTS idx_messages_task_root;

-- 2. 任务事件：先清 outbox，再清 events。
DELETE FROM outbox
 WHERE event_seq IN (
   SELECT event_seq FROM events
    WHERE event_type IN ('message_task_marked', 'message_task_unmarked', 'message_task_completed')
       OR event_type LIKE 'task\_%' ESCAPE '\'
       OR event_type LIKE 'room\_task\_%' ESCAPE '\'
 );

DELETE FROM events
 WHERE event_type IN ('message_task_marked', 'message_task_unmarked', 'message_task_completed')
    OR event_type LIKE 'task\_%' ESCAPE '\'
    OR event_type LIKE 'room\_task\_%' ESCAPE '\';

-- 3. 任务写操作结果：只删带任务特征的 operations，保留其它幂等记录。
DELETE FROM operations
 WHERE json_valid(result_json)
   AND (
     json_extract(result_json, '$.task_root_id') IS NOT NULL
     OR (
       json_extract(result_json, '$.root_message_id') IS NOT NULL
       AND json_extract(result_json, '$.status') = 'completed'
     )
   );

-- 4. 普通消息事件不再携带任务归属。
UPDATE events
   SET metadata = json_remove(metadata, '$.task_root_id')
 WHERE event_type = 'message_created'
   AND json_valid(metadata)
   AND json_extract(metadata, '$.task_root_id') IS NOT NULL;

-- 5. Memory：全部旧 Task 派生来源（task_offer / task_detail / task_attachment /
--    task_submission / task_review / task_handoff）与对应预热请求。
--    逐行核对依赖：没有 representation / experience / 依赖 / retain / projection /
--    context 引用时才物理删除；有引用的行保留并置 retracted，读取路径已不可见。
--    独立 `message` / `file` 来源不受影响。
DELETE FROM memory_sources
 WHERE (source_kind LIKE 'task\_%' ESCAPE '\' OR source_key LIKE 'task\_%' ESCAPE '\')
   AND NOT EXISTS (
     SELECT 1 FROM memory_representations r
      WHERE r.source_id = memory_sources.source_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM memory_representation_dependencies d
      WHERE d.source_id = memory_sources.source_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM memory_retain_intents i
      WHERE i.source_id = memory_sources.source_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM memory_experiences e
      WHERE e.source_id = memory_sources.source_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM memory_coverage_ranges c
      WHERE c.source_id = memory_sources.source_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM memory_projections p
      WHERE p.source_id = memory_sources.source_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM memory_context_items ci
      WHERE instr(ci.source_dependencies_json, memory_sources.source_id) > 0
   );

UPDATE memory_sources
   SET state = 'retracted',
       retracted_at = COALESCE(retracted_at, CAST(strftime('%s', 'now') AS INTEGER) * 1000),
       updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE (source_kind LIKE 'task\_%' ESCAPE '\' OR source_key LIKE 'task\_%' ESCAPE '\')
   AND state <> 'retracted';

DELETE FROM memory_recall_requests WHERE request_key LIKE 'auto:task\_%' ESCAPE '\';

--    `memory_tombstones` 有 `memory_tombstones_no_delete` 触发器（永久的撤回/遗忘
--    屏障），不能删除；保留 `task_*` tombstone 也无副作用，因为该来源已停止
--    写入。若强行删触发器会破坏“遗忘不可逆”的既有约束。

UPDATE memory_recall_requests
   SET target_json = json_remove(target_json, '$.task_root_id')
 WHERE json_valid(target_json)
   AND json_extract(target_json, '$.task_root_id') IS NOT NULL;

-- 6. messages 消息式 Task 五列。顺序与 0041/0048 相反，先删归属再删标记。
ALTER TABLE messages DROP COLUMN task_root_id;
ALTER TABLE messages DROP COLUMN task_marked_by;
ALTER TABLE messages DROP COLUMN task_marked_at;
ALTER TABLE messages DROP COLUMN task_completed_at;
ALTER TABLE messages DROP COLUMN task_completed_by;

-- 7. 标记闸门。
DROP TABLE IF EXISTS guard_task_mark_unavailable;
DROP TABLE IF EXISTS guard_task_mark_conflict;

-- 8. 早期任务表：0042 已删除；此处只对两个命名表做防御性清理，
--    避免半迁移副本残留。实际 sqlite_master 中不存在其它任务表。
DROP TABLE IF EXISTS room_tasks;
DROP TABLE IF EXISTS tasks;
