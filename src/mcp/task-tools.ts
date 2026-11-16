/**
 * 消息式 Task 工具的注册切片。
 *
 * 注册顺序与原有 5 个工具保持一致；新增 list / complete 追加在尾部。
 * 这里只做工具契约与 handler 装配，领域规则仍在 domain 层。
 */

import type { MemoryIntakeOptions } from '../memory/intake';
import { messageTaskSearch } from '../domain/message-task-search';
import {
  messageTaskMark,
  messageTaskSummaries,
  messageTaskTrace,
  messageTaskUnmark,
} from '../domain/message-tasks';
import { messageTaskComplete } from '../domain/message-task-completion';
import { messageTaskList } from '../domain/message-task-list';
import {
  messageTaskCompleteSchema,
  messageTaskListSchema,
  messageTaskMarkSchema,
  messageTaskSearchSchema,
  messageTaskSummariesSchema,
  messageTaskTraceSchema,
  messageTaskUnmarkSchema,
} from '../contracts/schemas';
import {
  taskCompleteResultSchema,
  taskListResultSchema,
  taskMarkResultSchema,
  taskSearchResultSchema,
  taskSummariesResultSchema,
  taskTraceResultSchema,
  taskUnmarkResultSchema,
} from './outputs';
import { requireActor } from './auth';
import type { Principal } from '../domain/principal';
import type { RegistrationServer } from './registration';
import type { register } from './tools';

type RegisterFn = typeof register;

export interface TaskToolDeps {
  db: D1Database;
  principal: Principal;
  memory: MemoryIntakeOptions | null;
  /** FTS 索引缺失或回滚时关闭；与 network_message_search 使用同一开关。 */
  ftsEnabled: boolean;
}

export function registerTaskTools(
  server: RegistrationServer,
  deps: TaskToolDeps,
  registerTool: RegisterFn,
): void {
  const { db, principal, memory, ftsEnabled } = deps;
  const register = registerTool;

  register(
    server,
    'network_task_mark',
    '把房间内任意当前可见、未撤回的消息标记为消息式 Task 起点；人类消息和 Agent 消息规则相同，可标记他人发送的消息。起点 ID 就是 message_id，不创建独立任务实体或表单。已是本起点时按幂等成功返回；消息已归属另一个仍标记中的 Task 时返回 CONFLICT。已完成的起点重新标记不会清除完成元数据，也不会隐式 reopen。只写房间事件提示，不写 inbox、不增加 pending_count、不推进 head_seq、不唤醒 Agent。所有写操作带唯一 request_id。',
    messageTaskMarkSchema,
    taskMarkResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskMark(db, principal, input, memory);
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  );

  register(
    server,
    'network_task_unmark',
    '取消消息式 Task 起点的聚合入口：只清空起点标记，原消息、处理消息、引用关系与完成元数据全部保留，重新标记后集合恢复。任何可发言成员都可以取消，不要求是原标记者。重复取消按幂等成功返回；只写房间事件提示，不写 inbox、不增加 pending_count、不推进 head_seq。',
    messageTaskUnmarkSchema,
    taskUnmarkResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskUnmark(db, principal, input, memory);
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  );

  register(
    server,
    'network_task_summaries',
    '批量读取消息式 Task 摘要：一次最多 20 个起点，返回短预览、起点发送者、参与 Agent 头像组去重顺序、可见消息计数、open/completed 完成态与 can_unmark / can_complete。已完成的 Task 仍然保留摘要与 Trace，不会被隐藏。未标记、已撤回或当前不可见的根直接省略，不泄露正文或数量。只读：不写 events/outbox/operations，不推进已读、pending_count 或 head_seq。',
    messageTaskSummariesSchema,
    taskSummariesResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskSummaries(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_trace',
    '按原消息顺序分页展开消息式 Task 集合：返回起点、处理消息与一层引用来源，按 message_id 去重，引用项标为 reference；next_cursor / prev_cursor 双向翻页，has_more_before / has_more_after 表示两侧是否还有内容。传 focus_message_id 可从搜索命中处开始定位；正文用 network_message_read 读取。根级返回 open/completed 完成态与完成人/时间，完成不关闭 Trace。只读：不写 events/outbox/operations，不推进已读、pending_count 或 head_seq。',
    messageTaskTraceSchema,
    taskTraceResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskTrace(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_search',
    '按起点聚合搜索消息式 Task：命中起点、处理消息或被引用的来源时只返回一个 Task 摘要，matches 最多 3 条命中并可直接作为 trace 的 focus_message_id；同一来源被多个 Task 引用时各自返回，不合并集合。默认搜索全部 Task（含已完成），task.status 表示完成态。普通 network_message_search 契约保持不变。只读：不写 events/outbox/operations，不推进已读、pending_count 或 head_seq；扫描达到上限时返回 truncated 并停止分页。',
    messageTaskSearchSchema,
    taskSearchResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskSearch(db, principal, input, { ftsEnabled });
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_list',
    '分页读取房间常驻 Task 列表。status 取 open | completed | all，默认 open。按起点创建顺序 created_seq DESC、message_id DESC 做 keyset 分页，不使用 OFFSET；cursor 绑定房间、筛选、成员代次、历史策略与 Task 集合 revision，mark/unmark/complete/recall 后旧 cursor 返回 CURSOR_EXPIRED。返回 total_count、snapshot、authorization，以及每个起点的受限预览、完成态、参与 Agent、消息数、最近活动与最近 3 条处理消息预览；撤回起点仍以 tombstone 显示。聚合按本页根批量执行，不逐 Task 读取摘要或 Trace。只读：不写 events/outbox/operations，不推进已读、pending_count 或 head_seq。',
    messageTaskListSchema,
    taskListResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskList(db, principal, input);
    },
    { readOnlyHint: true },
  );

  register(
    server,
    'network_task_complete',
    '把仍标记中的 Task 起点标记为 completed。任何具备 send_message 的 active 成员（人类或 Agent）可调用；只读/禁言/归档成员不可完成。完成只记录首次完成人与时间，不清除 Task 标记、不删除处理消息、不取消或完成任何 delivery，也不改变 pending_count、已读、head_seq 或房间排序。重复完成与并发完成返回同一个首次完成事实。写 room scope message_task_completed 事件与 room:<id> outbox，映射为 task.updated / change=completed；不写 inbox。所有写操作带唯一 request_id。',
    messageTaskCompleteSchema,
    taskCompleteResultSchema,
    async (input) => {
      requireActor(principal);
      return messageTaskComplete(db, principal, input);
    },
    { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  );
}
