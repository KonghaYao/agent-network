/**
 * Task dock / Trace 的 Web 视图类型。
 *
 * 只镜像 `network_task_list`、`network_task_trace` 的输出字段，不引用
 * domain 类型；服务端仍是全部字段的唯一权威。
 */

export type TaskStatus = 'open' | 'completed';

export interface TaskParticipantView {
  actor_id: string;
  name: string;
  kind: 'agent';
  first_seq: string;
}

export interface TaskRecentMessageView {
  message_id: string;
  sender_id: string;
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
  created_seq: string;
  created_at: string;
  preview: string;
  recalled: boolean;
}

export interface TaskListItemView {
  root_message_id: string;
  room_id: string;
  preview: string;
  root_sender_id: string;
  root_sender_name: string | null;
  root_sender_kind: 'human' | 'agent' | null;
  root_created_seq: string;
  root_created_at: string;
  participants: TaskParticipantView[];
  participant_count: number;
  message_count: number;
  status: TaskStatus;
  completed_at: string | null;
  completed_by: string | null;
  can_unmark: boolean;
  can_complete: boolean;
  latest_activity_seq: string;
  latest_activity_at: string;
  latest_message_id: string;
  recent_messages: TaskRecentMessageView[];
}

export interface TaskAuthorizationView {
  policy_revision: number;
  history_from_seq: string;
  member_generation: string;
}

export interface TaskListPageView {
  items: TaskListItemView[];
  total_count: number;
  next_cursor: string | null;
  has_more: boolean;
  snapshot: string;
  authorization: TaskAuthorizationView;
}

export interface TaskTraceItemView {
  message_id: string;
  sender_id: string;
  sender_name: string | null;
  sender_kind: 'human' | 'agent' | null;
  created_seq: string;
  created_at: string;
  preview: string;
  body_bytes: number;
  recalled: boolean;
  role: 'root' | 'member' | 'reference';
  reply_to: string | null;
  referenced_by: string | null;
  has_unavailable_reference: boolean;
}

export interface TaskTracePageView {
  root_message_id: string;
  items: TaskTraceItemView[];
  next_cursor: string | null;
  prev_cursor: string | null;
  has_more_before: boolean;
  has_more_after: boolean;
  message_count: number;
  focus_message_id: string | null;
  status: TaskStatus;
  completed_at: string | null;
  completed_by: string | null;
  authorization: TaskAuthorizationView;
}

/** Trace 抽屉顶部使用的摘要；与 TaskSummaryBar 的字段保持一致。 */
export interface TaskTraceSummaryView {
  root_message_id: string;
  room_id: string;
  preview: string;
  root_sender_id: string;
  root_sender_name: string | null;
  root_sender_kind: 'human' | 'agent' | null;
  root_created_at: string;
  root_created_seq: string;
  participants: TaskParticipantView[];
  participant_count: number;
  message_count: number;
  status: TaskStatus;
  completed_at: string | null;
  completed_by: string | null;
  can_unmark: boolean;
  can_complete: boolean;
}

export interface TaskSummariesPageView {
  items: TaskTraceSummaryView[];
}
