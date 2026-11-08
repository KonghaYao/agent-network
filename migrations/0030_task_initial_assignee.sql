-- D01 · 持久化任务创建时的初始负责人。
--
-- `convergeSourceTask` 比较的是“创建参数”，不能用后续 claim/offer 产生的
-- assignment 反推。公开任务创建时没有负责人，之后的首次 assignment 来自
-- 领取；若仍取最早 assignment，会把合法重放误判为参数不同。
--
-- 约束：
-- - 新任务在 `taskCreate` 的同一事务内写入创建参数里的
--   `assignee_actor_id`（可为 NULL，表示公开任务），此后重派/接受/拒绝都
--   不再修改该列。
-- - 旧行只在可证明为创建时指派时回填：v1 assignment、与任务同一时刻创建、
--   且由任务创建者发出。领取产生的 assignment 由领取者发出且晚于创建，
--   因此公开任务保持 NULL。
-- - 无法证明的旧行保持 NULL；读取侧只在 assignment 同样满足上述可证明条件
--   时才用作兼容回退，不猜测后续 assignment 的语义。

ALTER TABLE tasks ADD COLUMN initial_assignee_actor_id TEXT;

UPDATE tasks
   SET initial_assignee_actor_id = (
     SELECT a.owner_actor_id
       FROM task_assignments a
      WHERE a.task_id = tasks.task_id
        AND a.assignment_version = 1
        AND a.created_at = tasks.created_at
        AND a.offered_by = tasks.created_by
      LIMIT 1
   )
 WHERE EXISTS (
   SELECT 1
     FROM task_assignments a
    WHERE a.task_id = tasks.task_id
      AND a.assignment_version = 1
      AND a.created_at = tasks.created_at
      AND a.offered_by = tasks.created_by
 );
