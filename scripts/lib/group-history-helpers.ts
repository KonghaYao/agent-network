/**
 * G07 验收共享类型与工具调用。
 *
 * 只放跨 T01/T02/T03 复用的身份、房间、策略、历史与文件辅助，
 * 保持验收主体每个文件低于单文件行数上限。
 */

import { befriend, registerIdentity, type Identity } from './acceptance-helpers';
import {
  callTool,
  check,
  checkEqual,
  connectClient,
  newRequestId,
  newToken,
  uploadTestFile,
  type McpConnection,
} from './harness';

export const HISTORY_MARKER = 'G07 加入前消息';
export const FILE_MARKER = 'g07-before-join.txt';
export const POST_MARKER = 'G07 加入后可读消息';

export interface AuthorizationSnapshot {
  policy_revision: number;
  history_from_seq: string;
  member_generation: string;
}

export interface PolicyView {
  member_message: 'members' | 'owner_admin';
  member_invite: 'members' | 'owner_admin';
  member_history: 'from_join' | 'full';
  member_join: 'open' | 'approval';
  member_profile: 'members' | 'owner_admin';
  member_mention_all: 'members' | 'owner_admin';
}

export interface RoomSummaryView {
  room_id: string;
  kind: 'direct' | 'group';
  owner_id: string | null;
  head_seq: string;
  my_last_read_seq: string;
  my_member_generation: number;
  history_from_seq: string;
  authorization: AuthorizationSnapshot;
  policy_revision: number;
  policies: PolicyView;
  capabilities: Record<string, boolean>;
}

export interface MemberSummaryView {
  actor_id: string;
  role: 'owner' | 'admin' | 'member';
  member_generation: number;
  joined_seq: string;
}

export interface GroupDetailView {
  room: RoomSummaryView;
  members: MemberSummaryView[];
}

export interface PolicyImpactView {
  history_policy: 'from_join' | 'full';
  affected_members: number;
  hidden_files: number;
  material_loss: boolean;
  message: string;
}

export interface PolicySetView extends GroupDetailView {
  policy_impact?: PolicyImpactView;
}

/** `network_room_policy_set` 的输入字段；值与 RoomPolicies 同名但带 `_policy`。 */
export type PolicyPatch = Partial<{
  member_message_policy: PolicyView['member_message'];
  member_invite_policy: PolicyView['member_invite'];
  member_history_policy: PolicyView['member_history'];
  member_join_policy: PolicyView['member_join'];
  member_profile_policy: PolicyView['member_profile'];
  member_mention_all_policy: PolicyView['member_mention_all'];
}>;

export interface HistoryMessageView {
  message_id: string;
  created_seq: string;
  preview: string;
}

export interface HistoryPageView {
  items: HistoryMessageView[];
  next_cursor: string | null;
  has_more: boolean;
  authorization: AuthorizationSnapshot;
}

export interface TimelinePageView {
  timeline_resume_cursor: string;
  authorization: AuthorizationSnapshot;
}

export interface SendView {
  message: { message_id: string; created_seq: string };
  delivery_ids: string[];
}

export interface FileView {
  file_id: string;
  name: string;
  public_url: string;
  preview_url: string;
  download_url: string;
}

export interface FileResultView {
  file: FileView;
  authorization: AuthorizationSnapshot;
}

export interface FilePageView {
  items: FileView[];
  next_cursor: string | null;
  has_more: boolean;
  authorization: AuthorizationSnapshot;
}

export interface NoticeView {
  audit_id: string;
  action: string;
  target_actor_id: string | null;
  changed_by: string;
  changed_by_name: string | null;
  summary: string;
  created_at: string;
}

export interface NoticePageView {
  items: NoticeView[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface RoleHistoryView {
  items: Record<string, unknown>[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface RoomListView {
  items: {
    room_id: string;
    last_message: { message_id: string; preview: string } | null;
  }[];
}

export interface SyncView {
  items: { type: string; ref_id: string | null; metadata: Record<string, unknown> }[];
  reset_required: boolean;
}

export interface ActorPair {
  connection: McpConnection;
  actor: Identity;
}

export async function createActor(
  name: string,
  kind: 'human' | 'agent',
): Promise<ActorPair> {
  const connection = await connectClient(newToken());
  const actor = await registerIdentity(connection, {
    kind,
    name,
    ...(kind === 'agent'
      ? { sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}` }
      : {}),
  });
  return { connection, actor };
}

export async function makeFriends(left: ActorPair, right: ActorPair): Promise<void> {
  await befriend(left.connection, left.actor.actor_id, right.connection, right.actor.actor_id);
}

export async function createRoom(
  owner: McpConnection,
  members: string[],
  title: string,
): Promise<string> {
  const created = await callTool<GroupDetailView>(owner.client, 'network_room_create', {
    request_id: newRequestId('g07_room'),
    kind: 'group',
    members,
    title,
  });
  return created.room.room_id;
}

export async function roomDetail(
  connection: McpConnection,
  roomId: string,
): Promise<GroupDetailView> {
  return callTool<GroupDetailView>(connection.client, 'network_room_get', { room_id: roomId });
}

export async function sendMessage(
  connection: McpConnection,
  roomId: string,
  body: string,
  options: { replyTo?: string } = {},
): Promise<SendView> {
  return callTool<SendView>(connection.client, 'network_message_send', {
    request_id: newRequestId('g07_send'),
    client_message_id: `cm_${crypto.randomUUID()}`,
    room_id: roomId,
    body,
    ...(options.replyTo ? { reply_to: options.replyTo } : {}),
  });
}

export async function history(
  connection: McpConnection,
  roomId: string,
  options: { cursor?: string; limit?: number; direction?: 'before' | 'after' } = {},
): Promise<HistoryPageView> {
  return callTool<HistoryPageView>(connection.client, 'network_history_list', {
    room_id: roomId,
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.direction ? { direction: options.direction } : {}),
  });
}

export async function timeline(
  connection: McpConnection,
  roomId: string,
): Promise<TimelinePageView> {
  return callTool<TimelinePageView>(connection.client, 'network_history_list', {
    room_id: roomId,
    view: 'timeline',
    limit: 20,
  });
}

export async function setPolicy(
  owner: McpConnection,
  roomId: string,
  expectedRevision: number,
  patch: PolicyPatch,
): Promise<PolicySetView> {
  return callTool<PolicySetView>(owner.client, 'network_room_policy_set', {
    request_id: newRequestId('g07_policy'),
    room_id: roomId,
    expected_policy_revision: expectedRevision,
    ...patch,
  });
}

export async function bindFile(
  owner: ActorPair,
  roomId: string,
  name: string,
  body: string,
  options: { private?: boolean } = {},
): Promise<FileResultView> {
  const uploaded = await uploadTestFile(owner.connection.token, {
    name,
    mimeType: 'text/plain',
    body,
  });
  const bound = await callTool<FileResultView>(owner.connection.client, 'network_room_file_bind', {
    request_id: newRequestId('g07_bind'),
    room_id: roomId,
    file_id: uploaded.fileId,
  });
  // 历史边界/撤权用例需要私有文件；默认公开会按链接放行。
  if (options.private) {
    await callTool(owner.connection.client, 'network_file_publish', {
      request_id: newRequestId('g07_unpublish'),
      file_id: uploaded.fileId,
      public: false,
    });
  }
  return bound;
}

export async function listFiles(
  connection: McpConnection,
  roomId: string,
  limit = 100,
): Promise<FilePageView> {
  return callTool<FilePageView>(connection.client, 'network_room_file_list', {
    room_id: roomId,
    limit,
  });
}

export function assertAuthorization(
  label: string,
  actual: AuthorizationSnapshot,
  expected: AuthorizationSnapshot,
): void {
  checkEqual(`${label} policy_revision`, actual.policy_revision, expected.policy_revision);
  checkEqual(`${label} history_from_seq`, actual.history_from_seq, expected.history_from_seq);
  checkEqual(`${label} member_generation`, actual.member_generation, expected.member_generation);
}

export function detailAuthorization(detail: GroupDetailView): AuthorizationSnapshot {
  return detail.room.authorization;
}

export function checkHistoryInsideBoundary(label: string, page: HistoryPageView): void {
  const floor = Number(page.authorization.history_from_seq);
  check(
    `${label} 每条消息都在授权边界内`,
    page.items.every((item) => Number(item.created_seq) >= floor),
    { floor, seqs: page.items.map((item) => item.created_seq) },
  );
}

export async function expectFileUrlGone(label: string, url: string): Promise<void> {
  const response = await fetch(url);
  checkEqual(label, response.status, 404);
}
