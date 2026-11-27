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
