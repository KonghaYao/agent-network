-- D01 · 区分“创建时确认无负责人”与“旧行未知”。
--
-- `initial_assignee_actor_id` 为 NULL 同时表示两种语义：
-- - 新公开任务：创建参数没有负责人，NULL 是权威答案；
-- - 旧行：0030 之前没有持久化创建参数，无法确定创建时是否有负责人。
-- 0030 的读取回退（v1 + 同一 created_at + offered_by = created_by）无法区分
-- 创建者同毫秒自我领取，会把领取误当成创建时指派并导致重放 CONFLICT。
--
-- 本迁移新增 `initial_assignee_known`：
-- - 1：`initial_assignee_actor_id` 是权威答案（可以为 NULL）；
-- - 0：旧行未知，读取侧不再用后续 assignment 推断，收敛时跳过负责人比较。
--
-- 新任务由 `taskCreate` 在同一事务内写入 known = 1。
--
-- 旧行只有在能证明创建时语义时才回填：
-- 1. `task_created` 事件明确记录创建状态为 `offered`：创建事务写过 v1
--    assignment，其 owner 即创建时负责人；
-- 2. `task_created` 事件明确记录创建状态为 `unassigned`：公开任务，权威 NULL；
-- 3. 没有创建事件、但仍是未被动过的创建时 offer（revision = 1、status =
--    `offered`、owner 为空、current_assignment 为 v1、由创建者发出、与任务同一
--    created_at）。创建后同毫秒再 offer 会把 revision 推到 2，因此不会命中。
-- 其余旧行（包含 0017 从 `room_tasks` 生成的 `asg_legacy_*`、无事件且已流转的
-- 任务）保持 known = 0 + NULL。
--
-- 0030 可能已经把同毫秒自我领取回填成创建者，这里先清空再由可证明条件重建。

ALTER TABLE tasks ADD COLUMN initial_assignee_known INTEGER NOT NULL DEFAULT 0
  CHECK (initial_assignee_known IN (0, 1));

UPDATE tasks SET initial_assignee_actor_id = NULL;

-- 证明 1：创建事件记录为 offered。
UPDATE tasks
   SET initial_assignee_actor_id = (
         SELECT a.owner_actor_id
           FROM task_assignments a
          WHERE a.task_id = tasks.task_id
            AND a.assignment_version = 1
          LIMIT 1
       ),
       initial_assignee_known = 1
 WHERE EXISTS (
         SELECT 1
           FROM events e
          WHERE e.event_key = 'task:created:' || tasks.task_id
            AND e.event_type = 'task_created'
            AND json_extract(e.metadata, '$.status') = 'offered'
       )
   AND EXISTS (
         SELECT 1
           FROM task_assignments a
          WHERE a.task_id = tasks.task_id
            AND a.assignment_version = 1
       );

-- 证明 2：创建事件记录为 unassigned，公开任务的 NULL 是权威答案。
UPDATE tasks
   SET initial_assignee_actor_id = NULL,
       initial_assignee_known = 1
 WHERE EXISTS (
         SELECT 1
           FROM events e
          WHERE e.event_key = 'task:created:' || tasks.task_id
            AND e.event_type = 'task_created'
            AND json_extract(e.metadata, '$.status') = 'unassigned'
       );

-- 证明 3：无创建事件，但仍是未被动过的创建时 offer。
UPDATE tasks
   SET initial_assignee_actor_id = (
         SELECT a.owner_actor_id
           FROM task_assignments a
          WHERE a.task_id = tasks.task_id
            AND a.assignment_version = 1
          LIMIT 1
       ),
       initial_assignee_known = 1
 WHERE initial_assignee_known = 0
   AND status = 'offered'
   AND revision = 1
   AND owner_actor_id IS NULL
   AND current_assignment_id IS NOT NULL
   AND EXISTS (
         SELECT 1
           FROM task_assignments a
          WHERE a.task_id = tasks.task_id
            AND a.assignment_id = tasks.current_assignment_id
            AND a.assignment_version = 1
            AND a.status = 'offered'
            AND a.offered_by = tasks.created_by
            AND a.created_at = tasks.created_at
            AND a.assignment_id NOT LIKE 'asg_legacy_%'
       );
