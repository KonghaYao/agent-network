export interface ActorRow {
  actor_id: string;
  kind: 'human' | 'agent';
  agent_session_id: string | null;
  name: string;
  metadata: string;
  inbox_head_seq: number;
  inbox_min_seq: number;
  pending_count: number;
  /** 管理列表软归档时间；NULL 表示未归档，不参与任何授权判断。 */
  archived_at: number | null;
  archived_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface CredentialRow {
  credential_id: string;
  actor_id: string;
  device_id: string;
  token_hash: string;
  revoked_at: number | null;
  created_at: number;
}

export interface ContactRow {
  owner_actor_id: string;
  target_actor_id: string;
  created_at: number;
}

export interface RoomRow {
  room_id: string;
  kind: 'direct' | 'group';
  owner_id: string | null;
  title: string;
  direct_pair_key: string | null;
  head_seq: number;
  events_min_seq: number;
  member_seq: number;
  last_message_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface RoomMemberRow {
  room_id: string;
  actor_id: string;
  role: 'owner' | 'member';
  status: 'active' | 'left' | 'removed';
  joined_seq: number;
  last_read_seq: number;
  joined_at: number;
}

export interface MessageRow {
  message_id: string;
  room_id: string;
  sender_id: string;
  client_message_id: string;
  created_seq: number;
  body: string;
  body_bytes: number;
  preview: string;
  reply_to: string | null;
  root_id: string | null;
  hop: number;
  root_invocations_used: number;
  created_at: number;
}

export interface DeliveryRow {
  delivery_id: string;
  recipient_id: string;
  message_id: string;
  room_id: string;
  state: 'pending' | 'claimed' | 'completed' | 'failed' | 'cancelled';
  attempt: number;
  claim_id: string | null;
  claimed_at: number | null;
  progress_at: number | null;
  result_message_id: string | null;
  error: string | null;
  created_seq: number;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  event_seq: number;
  scope_kind: 'room' | 'inbox' | 'actor';
  scope_id: string;
  event_type: string;
  ref_id: string | null;
  metadata: string;
  event_key: string;
  created_at: number;
}

export interface OutboxRow {
  outbox_id: string;
  topic: string;
  event_seq: number;
  status: 'pending' | 'processing' | 'completed';
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_until: number | null;
  completed_at: number | null;
  created_at: number;
}

export interface OperationRow {
  actor_id: string;
  request_id: string;
  payload_hash: string;
  write_nonce: string;
  result_json: string;
  created_at: number;
}

export interface RecoveryTicketRow {
  ticket_hash: string;
  actor_id: string;
  expires_at: number;
  consumed_at: number | null;
  redeemed_credential_id: string | null;
  redeem_request_id: string | null;
  created_at: number;
}

/** 已绑定到房间的 MCPP Files 记录；public_url 由 PUBLIC_ORIGIN 派生，不落库。 */
export interface RoomFileRow {
  room_file_id: string;
  room_id: string;
  file_id: string;
  uploader_id: string;
  name: string;
  mime_type: string;
  size: number;
  sha256: string;
  created_at: number;
  expires_at: number;
  deleted_at: number | null;
  deleted_by: string | null;
}

/** 每个 human 在每个房间私有的网页监控地址；无行表示未配置。 */
export interface ActorRoomMonitorRow {
  actor_id: string;
  room_id: string;
  url: string;
  created_at: number;
  updated_at: number;
}

/** MCP Events webhook 订阅；secret 以 AES-GCM 密文落库。 */
export interface EventSubscriptionRow {
  subscription_id: string;
  actor_id: string;
  event_name: string;
  arguments_json: string;
  callback_url: string;
  callback_url_key: string;
  credential_id: string;
  secret_ciphertext: string;
  secret_nonce: string;
  previous_secret_ciphertext: string | null;
  previous_secret_nonce: string | null;
  previous_secret_expires_at: number | null;
  refresh_before: number;
  scanned_seq: number;
  last_scan_at: number;
  last_delivery_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  active: number;
  verified_at: number;
  created_at: number;
  updated_at: number;
}

export type EventDeliveryStatus = 'pending' | 'processing' | 'delivered' | 'abandoned';

/** MCP Events 单事件投递；payload_json 是发送时的精确字节。 */
export interface EventDeliveryRow {
  delivery_id: string;
  subscription_id: string;
  event_seq: number;
  event_id: string;
  payload_json: string;
  status: EventDeliveryStatus;
  attempts: number;
  next_attempt_at: number;
  lease_token: string | null;
  lease_until: number | null;
  last_http_status: number | null;
  last_error: string | null;
  created_at: number;
  delivered_at: number | null;
}

export interface WebhookVerificationRow {
  actor_id: string;
  callback_url_key: string;
  verified_at: number;
  expires_at: number;
}
