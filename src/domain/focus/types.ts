/** Task Focus 存储行与内部输入类型。 */

import type { FocusBindingStatus } from '../../contracts/focus';

export interface FocusBindingRow {
  owner_actor_id: string;
  secretary_actor_id: string;
  provisioning_key: string;
  session_id: string | null;
  root_session_id: string | null;
  /** 数据库状态；`disabled` 只表示没有绑定行。 */
  status: Exclude<FocusBindingStatus, 'disabled'>;
  generation: number;
  event_from_seq: number;
  enabled_at: number;
  paused_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface FocusItemRow {
  item_id: string;
  owner_actor_id: string;
  secretary_actor_id: string;
  title: string;
  column_key: 'needs_me' | 'tracking' | 'done';
  next_step: string;
  waiting_on: string | null;
  due_at: number | null;
  due_text: string | null;
  summary: string;
  version: number;
  archived_at: number | null;
  archived_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface FocusEvidenceRow {
  evidence_id: string;
  item_id: string;
  owner_actor_id: string;
  source_kind: 'message' | 'delivery';
  source_key: string;
  room_id: string | null;
  message_id: string | null;
  delivery_id: string | null;
  source_revision: number;
  purpose: string;
  occurred_at: number;
  created_at: number;
}

export interface FocusRevisionRow {
  revision_id: string;
  item_id: string;
  version: number;
  decision_id: string;
  changes_json: string;
  reason: string;
  evidence_json: string;
  created_at: number;
}

export interface FocusCountRow {
  needs_me: number;
  tracking: number;
  done: number;
  archived: number;
}

/** 秘书作业；同一 owner 至多一个活跃作业（部分唯一索引）。 */
export interface FocusJobRow {
  job_id: string;
  owner_actor_id: string;
  secretary_actor_id: string;
  attempt_ref: string;
  submission_key: string;
  status:
    | 'queued'
    | 'submitted'
    | 'running'
    | 'waiting'
    | 'completed'
    | 'failed'
    | 'cancelled';
  generation: number;
  event_from_seq: number;
  event_to_seq: number;
  turn_id: string | null;
  input_id: string | null;
  lease_until: number | null;
  attempt_count: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/** Watch 的持久候选索引；作业只能读取分配给自己的候选。 */
export interface FocusCandidateRow {
  candidate_id: string;
  owner_actor_id: string;
  job_id: string | null;
  source_kind: 'message' | 'delivery';
  event_seq: number;
  room_id: string | null;
  message_id: string | null;
  delivery_id: string | null;
  source_key: string;
  reason: string;
  state: 'pending' | 'assigned' | 'consumed' | 'skipped';
  decision: string | null;
  created_at: number;
  updated_at: number;
}
