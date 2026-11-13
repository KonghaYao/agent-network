/**
 * 4C-1/4C-4 Drizzle 只读查询运行时对比。
 *
 * 对 `src/storage/queries.ts` 中已迁移到 Drizzle 的核心读查询，逐条执行：
 * 1. 手写 SQL（迁移前的原语句）与 Drizzle 构建结果逐行比较，包含字段顺序；
 * 2. 用生产实际执行的 SQL 做 `EXPLAIN QUERY PLAN`，与手写 SQL 的计划比较
 *    （4C-4 的手写 SQL 使用 `d`/`m`/`a` 别名，只归一化 FROM/JOIN 表标识）；
 * 3. 记录 raw / Drizzle 构建+执行的基准耗时。
 *
 * 只读内存库，不触碰真实 DATA_DIR；执行仍走生产同款 `createD1()` shim。
 *
 * 用法：`bun scripts/verify-drizzle-runtime.ts`
 */

import { Database } from 'bun:sqlite';
import { and, asc, desc, eq, gt, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { resolve } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { orm, schema } from '../src/storage/drizzle';
import {
  activeRoomCount,
  countActiveCredentials,
  countActiveRoomMembers,
  countActiveRoomMembersWithJoinHistory,
  findActiveContactBlockBetween,
  getActiveAgentManagement,
  getActiveContactBlock,
  getActiveContactRelation,
  countPendingEventDeliveries,
  driveFileQuotaUsage,
  earliestPendingEventDeliverySeq,
  getActor,
  getActorBySession,
  getActorManagementByIds,
  getActorRowsByIds,
  getActorsByIds,
  getContact,
  getContactRelation,
  getContactRequestById,
  getClaimedDelivery,
  getClaimedDeliveryId,
  getCredentialByHash,
  getDelivery,
  getDeliveryForMessage,
  getDriveFile,
  getEventSubscription,
  getEventSubscriptionRefresh,
  getEventsMinSeq,
  getExpiredPendingContactRequestForPair,
  getLatestJoinRequestForApplicant,
  getMember,
  getOwnerTransferById,
  getPendingContactRequest,
  getMessage,
  getMessageContextAnchor,
  getMessageSenderSummary,
  getRoom,
  getRoomInvitationById,
  getRoomJoinRequestById,
  getRoomFile,
  isActiveMember,
  listActiveManagementBindings,
  listActiveRoomManagerIds,
  listActiveRoomPeers,
  listContactBlocks,
  listExpiredPendingContactRequests,
  listJoinRequestRows,
  listMutedMentionBlockers,
  listPendingContactRequests,
  listPendingDirectInvitationMembers,
  listRoomAuditRows,
  listDeliveryStates,
  listHistoryMessagesAfter,
  listHistoryMessagesBefore,
  listHistoryMessagesByIds,
  listInboxDeliveries,
  listMessageContextWindow,
  listMessageMentions,
  listEventSubscriptionsForScan,
  roomFileQuotaUsage,
} from '../src/storage/queries';
import { check, checkEqual, checksPassed } from './lib/harness';

const ROOT = resolve(import.meta.dir, '..');
const MIGRATIONS = resolve(ROOT, 'migrations');

function seed(sqlite: Database): void {
  const actor = sqlite.prepare(
    `INSERT INTO actors
       (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq, inbox_min_seq,
        pending_count, created_at, updated_at, archived_at, archived_by,
        disabled_at, disabled_by, disabled_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const actors: [string, string, string | null, string, number, number, number, number][] = [
    ['act_human_1', 'human', null, 'Alice', 11, 7, 0, 100],
    ['act_human_2', 'human', null, 'Bob', 0, 0, 0, 101],
    ['act_agent_1', 'agent', 'sess_atlas', 'Atlas', 0, 0, 2, 102],
    ['act_agent_2', 'agent', 'sess_bravo', 'Bravo', 0, 3, 0, 103],
    ['act_agent_3', 'agent', null, 'Charlie', 0, 0, 0, 104],
  ];
  for (const [id, kind, session, name, head, min, pending, created] of actors) {
    const archived = id === 'act_agent_2' ? 1_000 : null;
    const archivedBy = id === 'act_agent_2' ? 'act_human_1' : null;
    const disabled = id === 'act_agent_3' ? 2_000 : null;
    const disabledBy = id === 'act_agent_3' ? 'act_human_1' : null;
    const reason = id === 'act_agent_3' ? 'retired' : null;
    actor.run(
      id,
      kind,
      session,
      name,
      '{}',
      head,
      min,
      pending,
      created,
      created + 1,
      archived,
      archivedBy,
      disabled,
      disabledBy,
      reason,
    );
  }

  const credential = sqlite.prepare(
    `INSERT INTO credentials
       (credential_id, actor_id, device_id, token_hash, revoked_at, created_at,
        last_used_at, revoked_by, label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  credential.run('cred_h1', 'act_human_1', 'dev_1', 'hash_h1', null, 10, 12, null, 'laptop');
  credential.run(
    'cred_a1',
    'act_agent_1',
    'dev_2',
    'hash_a1',
    20,
    11,
    null,
    'act_human_1',
    null,
  );
  credential.run('cred_a2', 'act_agent_2', 'dev_3', 'hash_a2', null, 12, null, null, null);

  const room = sqlite.prepare(
    `INSERT INTO rooms
       (room_id, kind, owner_id, title, direct_pair_key, head_seq, events_min_seq,
        member_seq, last_message_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  room.run('room_direct_1', 'direct', null, '', 'pair_h1_a1', 5, 3, 2, null, 200, 300);
  room.run('room_direct_2', 'direct', null, '', 'pair_h1_a2', 2, 1, 2, null, 201, 200);
  room.run('room_group_1', 'group', 'act_human_1', 'Team', null, 9, 4, 4, null, 202, 400);

  const member = sqlite.prepare(
    `INSERT INTO room_members
       (room_id, actor_id, role, status, joined_seq, last_read_seq, joined_at,
        role_revision, updated_at, member_generation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  member.run('room_direct_1', 'act_human_1', 'owner', 'active', 1, 2, 210, 1, 210, 1);
  member.run('room_direct_1', 'act_agent_1', 'member', 'active', 1, 1, 211, 1, 211, 1);
  member.run('room_direct_2', 'act_human_1', 'owner', 'active', 1, 2, 212, 1, 212, 1);
  member.run('room_direct_2', 'act_agent_2', 'member', 'active', 1, 1, 213, 1, 213, 1);
  member.run('room_group_1', 'act_human_1', 'owner', 'active', 1, 9, 214, 2, 214, 1);
  member.run('room_group_1', 'act_agent_1', 'admin', 'active', 2, 9, 215, 1, 215, 2);
  member.run('room_group_1', 'act_human_2', 'member', 'left', 3, 3, 216, 1, 216, 1);
  member.run('room_group_1', 'act_agent_3', 'member', 'active', 4, 4, 217, 1, 217, 3);

  const contact = sqlite.prepare(
    'INSERT INTO contacts (owner_actor_id, target_actor_id, created_at) VALUES (?, ?, ?)',
  );
  contact.run('act_human_1', 'act_agent_1', 500);
  contact.run('act_human_1', 'act_human_2', 400);
  contact.run('act_human_1', 'act_agent_3', 300);
  contact.run('act_human_2', 'act_human_1', 350);

  const relation = sqlite.prepare(
    `INSERT INTO contact_relations
       (pair_key, actor_a, actor_b, status, source, request_id,
        created_at, updated_at, ended_at, ended_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  relation.run(
    'act_agent_1|act_human_1',
    'act_agent_1',
    'act_human_1',
    'active',
    'request',
    'req_1',
    500,
    510,
    null,
    null,
  );
  relation.run(
    'act_human_1|act_human_2',
    'act_human_1',
    'act_human_2',
    'ended',
    'auto_manager',
    null,
    300,
    320,
    330,
    'act_human_1',
  );

  const request = sqlite.prepare(
    `INSERT INTO contact_requests
       (contact_request_id, pair_key, from_actor_id, to_actor_id, message, status,
        auto_accepted, created_at, updated_at, expires_at, responded_at, responded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  request.run(
    'req_1',
    'act_agent_1|act_human_1',
    'act_human_1',
    'act_agent_1',
    'hello',
    'pending',
    0,
    600,
    601,
    900,
    null,
    null,
  );
  request.run(
    'req_2',
    'act_agent_2|act_human_1',
    'act_human_1',
    'act_agent_2',
    'hi',
    'pending',
    0,
    500,
    501,
    700,
    null,
    null,
  );
  request.run(
    'req_3',
    'act_human_1|act_human_2',
    'act_human_1',
    'act_human_2',
    'yo',
    'accepted',
    1,
    400,
    410,
    900,
    410,
    'act_human_1',
  );
  request.run(
    'req_4',
    'act_agent_3|act_human_1',
    'act_human_1',
    'act_agent_3',
    '',
    'pending',
    0,
    800,
    801,
    1200,
    null,
    null,
  );

  const block = sqlite.prepare(
    `INSERT INTO contact_blocks
       (block_id, blocker_actor_id, blocked_actor_id, reason, mute_mentions,
        created_at, released_at, released_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  block.run('blk_1', 'act_human_1', 'act_agent_3', 'spam', 1, 700, null, null);
  block.run('blk_2', 'act_human_2', 'act_human_1', '', 1, 650, 660, 'act_human_2');
  block.run('blk_3', 'act_human_1', 'act_agent_2', 'mute', 1, 720, null, null);

  const management = sqlite.prepare(
    `INSERT INTO agent_managements
       (binding_id, agent_id, manager_id, status, grant_source, scopes_json,
        permission_version, initiated_by, confirmed_by, created_at, confirmed_at,
        expires_at, revoked_at, revoked_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  management.run(
    'mg_1',
    'act_agent_1',
    'act_human_1',
    'active',
    'created',
    '["manage_agent"]',
    3,
    'act_human_1',
    'act_human_1',
    100,
    101,
    null,
    null,
    null,
    102,
  );
  management.run(
    'mg_2',
    'act_agent_3',
    'act_human_1',
    'revoked',
    'created',
    '[]',
    1,
    'act_human_1',
    null,
    110,
    111,
    null,
    120,
    'act_human_1',
    121,
  );
  management.run(
    'mg_3',
    'act_agent_2',
    'act_human_2',
    'active',
    'claim',
    '[]',
    1,
    'act_human_2',
    null,
    130,
    131,
    null,
    null,
    null,
    132,
  );
  const invitation = sqlite.prepare(
    `INSERT INTO room_invitations
       (invitation_id, room_id, inviter_id, target_actor_id, token_hash, kind, status,
        max_uses, used_count, expires_at, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  invitation.run('inv_direct_h2', 'room_group_1', 'act_human_1', 'act_human_2', null, 'direct', 'pending', 1, 0, 5_000, 1, 220, 220);
  invitation.run('inv_direct_archived', 'room_group_1', 'act_human_1', 'act_agent_2', null, 'direct', 'pending', 1, 0, 5_000, 1, 221, 221);
  invitation.run('inv_direct_expired', 'room_group_1', 'act_human_1', 'act_agent_3', null, 'direct', 'pending', 1, 0, 900, 1, 219, 219);
  invitation.run('inv_link_1', 'room_group_1', 'act_human_1', null, 'tok_hash_link_1', 'link', 'pending', 20, 3, 9_000, 1, 222, 222);

  const joinRequest = sqlite.prepare(
    `INSERT INTO room_join_requests
       (join_request_id, invitation_id, room_id, applicant_id, status, message, revision,
        created_at, updated_at, decided_at, decided_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  joinRequest.run('jrq_0', 'inv_link_1', 'room_group_1', 'act_agent_1', 'rejected', '', 2, 250, 250, 251, 'act_human_1');
  joinRequest.run('jrq_1', 'inv_link_1', 'room_group_1', 'act_human_2', 'pending', '', 1, 300, 300, null, null);
  joinRequest.run('jrq_2', 'inv_link_1', 'room_group_1', 'act_agent_3', 'approved', 'hi', 2, 299, 299, 299, 'act_human_1');
  joinRequest.run('jrq_3', 'inv_link_1', 'room_group_1', 'act_agent_1', 'pending', '', 1, 300, 300, null, null);

  sqlite
    .prepare(
      `INSERT INTO room_owner_transfers
         (transfer_id, room_id, from_owner_id, to_actor_id, status, version,
          target_role_revision, invalid_reason, created_at, updated_at, expires_at,
          responded_at, responded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('tr_1', 'room_group_1', 'act_human_1', 'act_agent_1', 'pending', 1, 1, null, 400, 400, 9_000, null, null);

  const audit = sqlite.prepare(
    `INSERT INTO room_management_audit
       (audit_id, room_id, action, target_actor_id, previous_role, new_role,
        previous_status, new_status, expected_revision, resulting_revision, changed_by,
        request_id, detail_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  audit.run('aud_3', 'room_group_1', 'member_added', 'act_agent_1', null, 'admin', null, 'active', null, 2, 'act_human_1', 'req_3', '{"note":"c"}', 500);
  audit.run('aud_2', 'room_group_1', 'admin_appointed', 'act_agent_1', 'member', 'admin', 'active', 'active', 1, 2, 'act_human_1', 'req_2', '{"note":"b"}', 500);
  audit.run('aud_1', 'room_group_1', 'policy_updated', null, null, null, null, null, null, 2, 'act_human_1', 'req_1', '{"note":"a"}', 499);
  const message = sqlite.prepare(
    `INSERT INTO messages
       (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes,
        preview, reply_to, root_id, hop, root_invocations_used, created_at,
        task_root_id, task_marked_by, task_marked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const messages: [
    string,
    string,
    string,
    number,
    string,
    string | null,
    string | null,
    number,
    string,
    string | null,
    string | null,
    number | null,
  ][] = [
    ['msg_d1_1', 'room_direct_1', 'act_human_1', 1, 'hello direct', null, null, 0, 'cm_d1_1', null, null, null],
    ['msg_d1_2', 'room_direct_1', 'act_agent_1', 2, 'agent reply', 'msg_d1_1', 'msg_d1_1', 1, 'cm_d1_2', null, null, null],
    ['msg_d1_5', 'room_direct_1', 'act_human_1', 5, 'later message', null, null, 0, 'cm_d1_5', null, null, null],
    ['msg_d2_1', 'room_direct_2', 'act_agent_2', 1, 'second room', null, null, 0, 'cm_d2_1', null, null, null],
    ['msg_d2_2', 'room_direct_2', 'act_human_1', 2, 'second reply', null, null, 0, 'cm_d2_2', null, null, null],
    ['msg_g1_3', 'room_group_1', 'act_human_1', 3, 'group start', null, null, 0, 'cm_g1_3', null, null, null],
    ['msg_g1_8', 'room_group_1', 'act_agent_1', 8, 'group task', null, null, 0, 'cm_g1_8', 'msg_g1_8', 'act_human_1', 1_300],
    ['msg_g1_9', 'room_group_1', 'act_agent_3', 9, 'group answer', 'msg_g1_8', 'msg_g1_8', 1, 'cm_g1_9', 'msg_g1_9', 'act_agent_1', 1_400],
    ['msg_ghost', 'room_group_1', 'act_missing', 7, 'ghost sender', null, null, 0, 'cm_ghost', null, null, null],
  ];
  for (const [
    id,
    roomId,
    senderId,
    seq,
    body,
    replyTo,
    rootId,
    hop,
    clientMessageId,
    taskRootId,
    taskMarkedBy,
    taskMarkedAt,
  ] of messages) {
    message.run(
      id,
      roomId,
      senderId,
      clientMessageId,
      seq,
      body,
      Buffer.byteLength(body, 'utf8'),
      body,
      replyTo,
      rootId,
      hop,
      hop,
      1_000 + seq,
      taskRootId,
      taskMarkedBy,
      taskMarkedAt,
    );
  }

  const delivery = sqlite.prepare(
    `INSERT INTO deliveries
       (delivery_id, recipient_id, message_id, room_id, state, attempt, claim_id, claimed_at,
        progress_at, result_message_id, error, created_seq, created_at, updated_at,
        last_reminded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const deliveries: [
    string,
    string,
    string,
    string,
    string,
    number,
    string | null,
    number | null,
    number | null,
    string | null,
    string | null,
    number,
    number,
    number,
    number | null,
  ][] = [
    ['del_pending_1', 'act_agent_1', 'msg_d1_2', 'room_direct_1', 'pending', 0, null, null, null, null, null, 1, 1_100, 1_100, null],
    ['del_claimed_1', 'act_agent_1', 'msg_g1_8', 'room_group_1', 'claimed', 1, 'claim_1', 1_200, 1_210, null, null, 2, 1_200, 1_220, 1_230],
    ['del_pending_2', 'act_agent_3', 'msg_g1_8', 'room_group_1', 'pending', 0, null, null, null, null, null, 3, 1_210, 1_210, null],
    ['del_completed_1', 'act_agent_1', 'msg_g1_9', 'room_group_1', 'completed', 2, null, null, null, null, null, 4, 1_300, 1_400, null],
    ['del_failed_1', 'act_agent_2', 'msg_g1_9', 'room_group_1', 'failed', 1, null, null, null, null, 'boom', 5, 1_301, 1_401, null],
    ['del_ghost', 'act_agent_2', 'msg_ghost', 'room_group_1', 'pending', 0, null, null, null, null, null, 6, 1_302, 1_302, null],
  ];
  for (const row of deliveries) delivery.run(...row);

  const mention = sqlite.prepare(
    `INSERT INTO message_mentions (message_id, actor_id, actor_kind, source, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  mention.run('msg_g1_8', 'act_human_1', 'human', 'explicit', 1_200);
  mention.run('msg_g1_8', 'act_agent_2', 'agent', 'text', 1_200);
  mention.run('msg_g1_9', 'act_agent_3', 'agent', 'all', 1_300);
  mention.run('msg_d1_2', 'act_agent_1', 'agent', 'explicit', 1_100);
  const sha = (char: string): string => char.repeat(64);
  const drive = sqlite.prepare(
    `INSERT INTO drive_files
       (file_id, owner_scope, uploader_id, name, mime_type, size, sha256, state,
        visibility, room_id, created_at, expires_at, retained, deleted_at,
        deleted_by, purged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  drive.run('df_draft', 'actor:act_human_1', 'act_human_1', 'draft.txt', 'text/plain', 10, sha('a'), 'draft', 'public', null, 1_000, 3_000, 0, null, null, null);
  drive.run('df_retained', 'actor:act_human_1', 'act_human_1', 'kept.bin', 'application/octet-stream', 20, sha('b'), 'draft', 'private', null, 1_000, null, 1, null, null, null);
  drive.run('df_retained_expired', 'actor:act_human_1', 'act_human_1', 'kept-old.bin', 'application/octet-stream', 30, sha('c'), 'draft', 'private', null, 900, 1_000, 1, null, null, null);
  drive.run('df_expired', 'actor:act_human_1', 'act_human_1', 'old.txt', 'text/plain', 40, sha('d'), 'draft', 'public', null, 900, 2_000, 0, null, null, null);
  drive.run('df_deleted', 'actor:act_human_1', 'act_human_1', 'gone.txt', 'text/plain', 50, sha('e'), 'deleted', 'public', null, 1_000, 3_000, 0, 1_600, 'act_human_1', null);
  drive.run('df_other', 'actor:act_human_2', 'act_human_2', 'bob.txt', 'text/plain', 60, sha('f'), 'draft', 'public', null, 1_000, 4_000, 0, null, null, null);

  const roomFile = sqlite.prepare(
    `INSERT INTO room_files
       (room_file_id, room_id, file_id, uploader_id, name, mime_type, size, sha256,
        created_at, expires_at, deleted_at, deleted_by, created_seq, retained)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  roomFile.run('rf_live', 'room_group_1', 'rf_file_live', 'act_human_1', 'live.txt', 'text/plain', 100, sha('1'), 1_000, 3_000, null, null, 5, 0);
  roomFile.run('rf_retained_expired', 'room_group_1', 'rf_file_retained', 'act_agent_1', 'kept.txt', 'text/plain', 200, sha('2'), 900, 950, null, null, 1, 1);
  roomFile.run('rf_expired', 'room_group_1', 'rf_file_expired', 'act_human_1', 'expired.txt', 'text/plain', 300, sha('3'), 900, 1_000, null, null, 2, 0);
  roomFile.run('rf_deleted', 'room_group_1', 'rf_file_deleted', 'act_human_1', 'deleted.txt', 'text/plain', 400, sha('4'), 1_000, 3_000, 1_500, 'act_human_1', 3, 0);
  roomFile.run('rf_other', 'room_direct_1', 'rf_file_other', 'act_human_1', 'other.txt', 'text/plain', 500, sha('5'), 1_000, 3_000, null, null, 4, 0);

  const subscription = sqlite.prepare(
    `INSERT INTO mcp_event_subscriptions
       (subscription_id, actor_id, event_name, arguments_json, callback_url,
        callback_url_key, credential_id, secret_ciphertext, secret_nonce,
        previous_secret_ciphertext, previous_secret_nonce, previous_secret_expires_at,
        refresh_before, scanned_seq, last_scan_at, last_delivery_at, last_error,
        consecutive_failures, active, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  subscription.run('sub_a', 'act_agent_1', 'message.created', '{"room_id":"room_group_1"}', 'https://a.test/hook', 'https://a.test/hook', 'cred_a1', 'ct_a', 'nonce_a', 'ct_prev_a', 'nonce_prev_a', 4_000, 5_000, 3, 10, 900, null, 0, 1, 100, 100, 200);
  subscription.run('sub_b', 'act_agent_1', 'message.created', '{"room_id":"room_direct_1"}', 'https://b.test/hook', 'https://b.test/hook', 'cred_a1', 'ct_b', 'nonce_b', null, null, null, 5_000, 0, 0, null, null, 0, 1, 100, 100, 200);
  subscription.run('sub_c', 'act_agent_1', 'message.created', '{}', 'https://c.test/hook', 'https://c.test/hook', 'cred_a1', 'ct_c', 'nonce_c', null, null, null, 5_000, 0, 0, null, null, 0, 0, 100, 100, 200);
  subscription.run('sub_d', 'act_agent_1', 'message.created', '{"room_id":"room_group_1","attention":"informational"}', 'https://d.test/hook', 'https://d.test/hook', 'cred_a1', 'ct_d', 'nonce_d', null, null, null, 1_000, 0, 0, null, null, 0, 1, 100, 100, 200);

  const delivery = sqlite.prepare(
    `INSERT INTO mcp_event_deliveries
       (delivery_id, subscription_id, event_seq, event_id, payload_json, status,
        attempts, next_attempt_at, lease_token, lease_until, last_http_status,
        last_error, created_at, delivered_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  delivery.run('evd_a1', 'sub_a', 1, 'evt_a1', '{"n":1}', 'pending', 0, 1_100, null, null, null, null, 100, null);
  delivery.run('evd_a2', 'sub_a', 2, 'evt_a2', '{"n":2}', 'processing', 1, 1_100, 'lease_a', 9_000, null, null, 100, null);
  delivery.run('evd_a3', 'sub_a', 3, 'evt_a3', '{"n":3}', 'delivered', 1, 1_100, null, null, 200, null, 100, 1_200);
  delivery.run('evd_b1', 'sub_b', 1, 'evt_b1', '{"n":1}', 'pending', 0, 1_100, null, null, null, null, 100, null);
  delivery.run('evd_c1', 'sub_c', 1, 'evt_c1', '{"n":1}', 'pending', 0, 1_100, null, null, null, null, 100, null);
}

function rawFirst<T>(sqlite: Database, sql: string, params: unknown[]): T | null {
  return (sqlite.prepare(sql).get(...(params as never[])) as T | undefined) ?? null;
}

function rawAll<T>(sqlite: Database, sql: string, params: unknown[]): T[] {
  return sqlite.prepare(sql).all(...(params as never[])) as T[];
}

function plan(sqlite: Database, sql: string, params: unknown[]): string[] {
  return (
    sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as never[])) as {
      detail: string;
    }[]
  ).map((row) => row.detail.replace(/\s+/gu, ' ').trim());
}

function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}

/** 历史页共享列；与生产 `historyMessageSelection` 的列和顺序一致。 */
const HISTORY_SELECT =
  'message_id, room_id, sender_id, created_seq, preview, body_bytes, created_at, reply_to, root_id, task_root_id, hop';

function rawHistoryBefore(
  sqlite: Database,
  roomId: string,
  snapshot: number,
  fromSeq: number,
  beforeSeq: number | null,
  limit: number,
): string {
  const predicate = beforeSeq === null ? '' : 'AND created_seq < ?';
  const params: unknown[] =
    beforeSeq === null
      ? [roomId, snapshot, fromSeq, limit]
      : [roomId, snapshot, fromSeq, beforeSeq, limit];
  return JSON.stringify(
    rawAll(
      sqlite,
      `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq >= ? ${predicate}
        ORDER BY created_seq DESC LIMIT ?`,
      params,
    ),
  );
}

function rawHistoryAfter(
  sqlite: Database,
  roomId: string,
  snapshot: number,
  fromSeq: number,
  afterSeq: number,
  limit: number,
): string {
  return JSON.stringify(
    rawAll(
      sqlite,
      `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq > ? AND created_seq >= ?
        ORDER BY created_seq ASC LIMIT ?`,
      [roomId, snapshot, afterSeq, fromSeq, limit],
    ),
  );
}

const CONTEXT_SELECT = `m.message_id, m.room_id, m.sender_id, a.name AS sender_name,
  a.kind AS sender_kind, m.body_bytes, m.preview, m.created_at, m.created_seq, m.reply_to`;

function rawContextBefore(
  sqlite: Database,
  roomId: string,
  pivotSeq: number,
  fromSeq: number | null,
  limit: number,
): string {
  const lower = fromSeq === null ? '' : 'AND m.created_seq >= ?';
  const params: unknown[] =
    fromSeq === null ? [roomId, pivotSeq, limit] : [roomId, pivotSeq, fromSeq, limit];
  return JSON.stringify(
    rawAll(
      sqlite,
      `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.room_id = ? AND m.created_seq < ? ${lower}
        ORDER BY m.created_seq DESC LIMIT ?`,
      params,
    ),
  );
}

function rawContextAfter(
  sqlite: Database,
  roomId: string,
  pivotSeq: number,
  fromSeq: number | null,
  toSeq: number | null,
  limit: number,
): string {
  const lower = fromSeq === null ? '' : 'AND m.created_seq >= ?';
  const upper = toSeq === null ? '' : 'AND m.created_seq <= ?';
  const params: unknown[] = [
    roomId,
    pivotSeq,
    ...(fromSeq === null ? [] : [fromSeq]),
    ...(toSeq === null ? [] : [toSeq]),
    limit,
  ];
  return JSON.stringify(
    rawAll(
      sqlite,
      `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.room_id = ? AND m.created_seq > ? ${lower} ${upper}
        ORDER BY m.created_seq ASC LIMIT ?`,
      params,
    ),
  );
}

function rawInbox(
  sqlite: Database,
  recipientId: string,
  states: string[] | null,
  afterSeq: number | null,
  limit: number,
): string {
  const stateFilter = states ? `AND d.state IN (${placeholders(states)})` : '';
  const cursor = afterSeq === null ? '' : 'AND d.created_seq > ?';
  const params: unknown[] = states ? [recipientId, ...states] : [recipientId];
  if (afterSeq !== null) params.push(afterSeq);
  params.push(limit);
  return JSON.stringify(
    rawAll(
      sqlite,
      `SELECT d.*, m.preview AS m_preview, m.body_bytes AS m_body_bytes,
              m.sender_id AS m_sender_id, m.created_at AS m_created_at,
              a.name AS m_sender_name, a.kind AS m_sender_kind
         FROM deliveries d
         JOIN messages m ON m.message_id = d.message_id
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE d.recipient_id = ? ${stateFilter} ${cursor}
        ORDER BY d.created_seq ASC
        LIMIT ?`,
      params,
    ),
  );
}

function deliveryStateRows(rows: {
  message_id: string;
  state: string;
  n: number;
  max_claimed_at: number | null;
  max_updated_at: number | null;
}[]): string {
  return JSON.stringify(
    rows
      .map((row) => [row.message_id, row.state, row.n, row.max_claimed_at, row.max_updated_at])
      .sort((left, right) => `${left[0]}:${left[1]}`.localeCompare(`${right[0]}:${right[1]}`)),
  );
}

async function rowParityChecks(sqlite: Database, db: D1Database): Promise<void> {
  const actorIds = ['act_human_1', 'act_agent_2', 'act_agent_3'];
  checkEqual(
    'getActor human',
    JSON.stringify(await getActor(db, 'act_human_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_human_1'])),
  );
  checkEqual(
    'getActor agent',
    JSON.stringify(await getActor(db, 'act_agent_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_agent_1'])),
  );
  checkEqual(
    'getActor archived',
    JSON.stringify(await getActor(db, 'act_agent_2')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_agent_2'])),
  );
  checkEqual('getActor missing', await getActor(db, 'missing'), null);

  checkEqual(
    'getActorBySession',
    JSON.stringify(await getActorBySession(db, 'sess_atlas')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM actors WHERE agent_session_id = ?', ['sess_atlas']),
    ),
  );
  checkEqual('getActorBySession missing', await getActorBySession(db, 'sess_missing'), null);

  checkEqual('getActorsByIds empty', JSON.stringify(await getActorsByIds(db, [])), '[]');
  checkEqual(
    'getActorsByIds many',
    JSON.stringify(await getActorsByIds(db, actorIds)),
    JSON.stringify(
      rawAll(sqlite, `SELECT actor_id, kind FROM actors WHERE actor_id IN (${placeholders(actorIds)})`, actorIds),
    ),
  );
  checkEqual(
    'getActorsByIds duplicates collapsed',
    JSON.stringify(await getActorsByIds(db, ['act_agent_1', 'act_agent_1'])),
    JSON.stringify(
      rawAll(sqlite, 'SELECT actor_id, kind FROM actors WHERE actor_id IN (?, ?)', [
        'act_agent_1',
        'act_agent_1',
      ]),
    ),
  );
  checkEqual(
    'getActorsByIds missing ids',
    JSON.stringify(await getActorsByIds(db, ['act_human_1', 'missing'])),
    JSON.stringify(
      rawAll(sqlite, 'SELECT actor_id, kind FROM actors WHERE actor_id IN (?, ?)', [
        'act_human_1',
        'missing',
      ]),
    ),
  );

  const managementSql = `SELECT actor_id, kind, agent_session_id, name, archived_at, archived_by,
              disabled_at, disabled_by, disabled_reason
         FROM actors WHERE actor_id IN (${placeholders(actorIds)})`;
  checkEqual(
    'getActorManagementByIds',
    JSON.stringify(await getActorManagementByIds(db, actorIds)),
    JSON.stringify(rawAll(sqlite, managementSql, actorIds)),
  );
  checkEqual('getActorManagementByIds empty', JSON.stringify(await getActorManagementByIds(db, [])), '[]');

  checkEqual(
    'getRoom direct',
    JSON.stringify(await getRoom(db, 'room_direct_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM rooms WHERE room_id = ?', ['room_direct_1'])),
  );
  checkEqual(
    'getRoom group',
    JSON.stringify(await getRoom(db, 'room_group_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM rooms WHERE room_id = ?', ['room_group_1'])),
  );
  checkEqual('getRoom missing', await getRoom(db, 'room_missing'), null);

  checkEqual(
    'getMember active',
    JSON.stringify(await getMember(db, 'room_group_1', 'act_agent_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?', [
        'room_group_1',
        'act_agent_1',
      ]),
    ),
  );
  checkEqual(
    'getMember left',
    JSON.stringify(await getMember(db, 'room_group_1', 'act_human_2')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?', [
        'room_group_1',
        'act_human_2',
      ]),
    ),
  );
  checkEqual('getMember missing', await getMember(db, 'room_group_1', 'missing'), null);

  checkEqual('isActiveMember true', await isActiveMember(db, 'room_group_1', 'act_agent_1'), true);
  checkEqual('isActiveMember left', await isActiveMember(db, 'room_group_1', 'act_human_2'), false);
  checkEqual('isActiveMember missing', await isActiveMember(db, 'room_group_1', 'missing'), false);

  checkEqual(
    'activeRoomCount human',
    await activeRoomCount(db, 'act_human_1'),
    rawFirst<{ n: number }>(sqlite, "SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'", [
      'act_human_1',
    ])?.n ?? 0,
  );
  checkEqual('activeRoomCount agent', await activeRoomCount(db, 'act_agent_1'), 2);
  checkEqual('activeRoomCount missing', await activeRoomCount(db, 'missing'), 0);

  checkEqual(
    'getCredentialByHash active',
    JSON.stringify(await getCredentialByHash(db, 'hash_h1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM credentials WHERE token_hash = ?', ['hash_h1'])),
  );
  checkEqual(
    'getCredentialByHash revoked',
    JSON.stringify(await getCredentialByHash(db, 'hash_a1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM credentials WHERE token_hash = ?', ['hash_a1'])),
  );
  checkEqual('getCredentialByHash missing', await getCredentialByHash(db, 'missing'), null);

  const peerSql = (roomIds: string[]): string =>
    `SELECT rm.room_id, a.actor_id, a.name, a.kind
       FROM room_members rm
       JOIN actors a ON a.actor_id = rm.actor_id
      WHERE rm.room_id IN (${placeholders(roomIds)})
        AND rm.status = 'active'
        AND rm.actor_id <> ?
      ORDER BY rm.room_id, a.actor_id`;
  checkEqual('listActiveRoomPeers empty', JSON.stringify(await listActiveRoomPeers(db, [], 'act_human_1')), '[]');
  const peerRooms = ['room_direct_1', 'room_direct_2', 'room_group_1'];
  checkEqual(
    'listActiveRoomPeers page',
    JSON.stringify(await listActiveRoomPeers(db, peerRooms, 'act_human_1')),
    JSON.stringify(rawAll(sqlite, peerSql(peerRooms), [...peerRooms, 'act_human_1'])),
  );
  checkEqual(
    'listActiveRoomPeers single',
    JSON.stringify(await listActiveRoomPeers(db, ['room_direct_1'], 'act_agent_1')),
    JSON.stringify(rawAll(sqlite, peerSql(['room_direct_1']), ['room_direct_1', 'act_agent_1'])),
  );

  checkEqual(
    'getEventsMinSeq room',
    await getEventsMinSeq(db, 'room', 'room_group_1'),
    rawFirst<{ events_min_seq: number }>(sqlite, 'SELECT events_min_seq FROM rooms WHERE room_id = ?', [
      'room_group_1',
    ])?.events_min_seq ?? 0,
  );
  checkEqual(
    'getEventsMinSeq inbox',
    await getEventsMinSeq(db, 'inbox', 'act_human_1'),
    rawFirst<{ inbox_min_seq: number }>(sqlite, 'SELECT inbox_min_seq FROM actors WHERE actor_id = ?', [
      'act_human_1',
    ])?.inbox_min_seq ?? 0,
  );
  checkEqual('getEventsMinSeq actor', await getEventsMinSeq(db, 'actor', 'act_human_1'), 0);

  checkEqual(
    'getDriveFile draft',
    JSON.stringify(await getDriveFile(db, 'df_draft')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM drive_files WHERE file_id = ?', ['df_draft'])),
  );
  checkEqual(
    'getDriveFile deleted',
    JSON.stringify(await getDriveFile(db, 'df_deleted')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM drive_files WHERE file_id = ?', ['df_deleted'])),
  );
  checkEqual('getDriveFile missing', await getDriveFile(db, 'df_missing'), null);

  checkEqual(
    'getRoomFile live',
    JSON.stringify(await getRoomFile(db, 'rf_file_live')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM room_files WHERE file_id = ?', ['rf_file_live'])),
  );
  checkEqual(
    'getRoomFile tombstone',
    JSON.stringify(await getRoomFile(db, 'rf_file_deleted')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM room_files WHERE file_id = ?', ['rf_file_deleted']),
    ),
  );
  checkEqual('getRoomFile missing', await getRoomFile(db, 'rf_file_missing'), null);

  const driveQuotaSql = (ownerScope: string, at: number): { sql: string; params: unknown[] } => ({
    sql: `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes,
                 COALESCE(SUM(CASE WHEN retained = 1 THEN size ELSE 0 END), 0) AS retained
            FROM drive_files
           WHERE owner_scope = ? AND state = 'draft'
             AND (retained = 1 OR expires_at IS NULL OR expires_at > ?)`,
    params: [ownerScope, at],
  });
  const quotaAt = 2_500;
  checkEqual(
    'driveFileQuotaUsage owner',
    JSON.stringify(await driveFileQuotaUsage(db, 'actor:act_human_1', quotaAt)),
    JSON.stringify(
      rawFirst<{ files: number; bytes: number; retained: number }>(
        sqlite,
        driveQuotaSql('actor:act_human_1', quotaAt).sql,
        driveQuotaSql('actor:act_human_1', quotaAt).params,
      ),
    ),
  );
  checkEqual(
    'driveFileQuotaUsage other',
    JSON.stringify(await driveFileQuotaUsage(db, 'actor:act_human_2', quotaAt)),
    JSON.stringify(
      rawFirst<{ files: number; bytes: number; retained: number }>(
        sqlite,
        driveQuotaSql('actor:act_human_2', quotaAt).sql,
        driveQuotaSql('actor:act_human_2', quotaAt).params,
      ),
    ),
  );
  checkEqual(
    'driveFileQuotaUsage none',
    JSON.stringify(await driveFileQuotaUsage(db, 'actor:missing', quotaAt)),
    JSON.stringify(rawFirst(sqlite, driveQuotaSql('actor:missing', quotaAt).sql, driveQuotaSql('actor:missing', quotaAt).params)),
  );

  const roomQuotaSql = (roomId: string, at: number): { sql: string; params: unknown[] } => ({
    sql: `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes,
                 COALESCE(SUM(CASE WHEN retained = 1 THEN size ELSE 0 END), 0) AS retained
            FROM room_files
           WHERE room_id = ? AND deleted_at IS NULL AND (retained = 1 OR expires_at > ?)`,
    params: [roomId, at],
  });
  checkEqual(
    'roomFileQuotaUsage group',
    JSON.stringify(await roomFileQuotaUsage(db, 'room_group_1', quotaAt)),
    JSON.stringify(
      rawFirst<{ files: number; bytes: number; retained: number }>(
        sqlite,
        roomQuotaSql('room_group_1', quotaAt).sql,
        roomQuotaSql('room_group_1', quotaAt).params,
      ),
    ),
  );
  checkEqual(
    'roomFileQuotaUsage direct',
    JSON.stringify(await roomFileQuotaUsage(db, 'room_direct_1', quotaAt)),
    JSON.stringify(
      rawFirst<{ files: number; bytes: number; retained: number }>(
        sqlite,
        roomQuotaSql('room_direct_1', quotaAt).sql,
        roomQuotaSql('room_direct_1', quotaAt).params,
      ),
    ),
  );
  checkEqual(
    'roomFileQuotaUsage none',
    JSON.stringify(await roomFileQuotaUsage(db, 'room_missing', quotaAt)),
    JSON.stringify(rawFirst(sqlite, roomQuotaSql('room_missing', quotaAt).sql, roomQuotaSql('room_missing', quotaAt).params)),
  );

  checkEqual(
    'getEventSubscription active',
    JSON.stringify(await getEventSubscription(db, 'sub_a')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM mcp_event_subscriptions WHERE subscription_id = ?', ['sub_a']),
    ),
  );
  checkEqual(
    'getEventSubscription inactive',
    JSON.stringify(await getEventSubscription(db, 'sub_c')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM mcp_event_subscriptions WHERE subscription_id = ?', ['sub_c']),
    ),
  );
  checkEqual('getEventSubscription missing', await getEventSubscription(db, 'sub_missing'), null);

  const refreshSql = `SELECT active, refresh_before, credential_id, secret_ciphertext, secret_nonce,
              previous_secret_ciphertext, previous_secret_nonce, previous_secret_expires_at
         FROM mcp_event_subscriptions WHERE subscription_id = ?`;
  checkEqual(
    'getEventSubscriptionRefresh rotated',
    JSON.stringify(await getEventSubscriptionRefresh(db, 'sub_a')),
    JSON.stringify(rawFirst(sqlite, refreshSql, ['sub_a'])),
  );
  checkEqual(
    'getEventSubscriptionRefresh plain',
    JSON.stringify(await getEventSubscriptionRefresh(db, 'sub_b')),
    JSON.stringify(rawFirst(sqlite, refreshSql, ['sub_b'])),
  );
  checkEqual('getEventSubscriptionRefresh missing', await getEventSubscriptionRefresh(db, 'sub_missing'), null);

  const scanSql = `SELECT * FROM mcp_event_subscriptions
        WHERE active = 1 AND refresh_before > ? AND subscription_id > ?
        ORDER BY subscription_id ASC
        LIMIT ?`;
  checkEqual(
    'listEventSubscriptionsForScan all',
    JSON.stringify(await listEventSubscriptionsForScan(db, 2_000, '', 10)),
    JSON.stringify(rawAll(sqlite, scanSql, [2_000, '', 10])),
  );
  checkEqual(
    'listEventSubscriptionsForScan after id',
    JSON.stringify(await listEventSubscriptionsForScan(db, 2_000, 'sub_a', 10)),
    JSON.stringify(rawAll(sqlite, scanSql, [2_000, 'sub_a', 10])),
  );
  checkEqual(
    'listEventSubscriptionsForScan limit',
    JSON.stringify(await listEventSubscriptionsForScan(db, 2_000, '', 1)),
    JSON.stringify(rawAll(sqlite, scanSql, [2_000, '', 1])),
  );
  checkEqual(
    'listEventSubscriptionsForScan expired refresh',
    JSON.stringify(await listEventSubscriptionsForScan(db, 6_000, '', 10)),
    JSON.stringify(rawAll(sqlite, scanSql, [6_000, '', 10])),
  );

  const pendingCountSql = `SELECT COUNT(*) AS n FROM mcp_event_deliveries
        WHERE subscription_id = ? AND status IN ('pending', 'processing')`;
  for (const [subscriptionId, expected] of [
    ['sub_a', 2],
    ['sub_b', 1],
    ['sub_c', 1],
    ['sub_missing', 0],
  ] as const) {
    checkEqual(
      `countPendingEventDeliveries ${subscriptionId}`,
      await countPendingEventDeliveries(db, subscriptionId),
      rawFirst<{ n: number }>(sqlite, pendingCountSql, [subscriptionId])?.n ?? 0,
    );
    checkEqual(`countPendingEventDeliveries expected ${subscriptionId}`, expected, await countPendingEventDeliveries(db, subscriptionId));
  }

  const earliestSql = `SELECT MIN(event_seq) AS seq FROM mcp_event_deliveries
        WHERE subscription_id = ? AND status IN ('pending', 'processing')`;
  for (const subscriptionId of ['sub_a', 'sub_b', 'sub_c', 'sub_missing']) {
    checkEqual(
      `earliestPendingEventDeliverySeq ${subscriptionId}`,
      await earliestPendingEventDeliverySeq(db, subscriptionId),
      rawFirst<{ seq: number | null }>(sqlite, earliestSql, [subscriptionId])?.seq ?? null,
    );
  }
  checkEqual('earliestPendingEventDeliverySeq value', await earliestPendingEventDeliverySeq(db, 'sub_a'), 1);
}

function explainChecks(sqlite: Database, db: D1Database): void {
  const cases: { label: string; raw: string; params: unknown[]; query: { toSQL(): { sql: string; params: unknown[] } } }[] = [
    {
      label: 'getActor',
      raw: 'SELECT * FROM actors WHERE actor_id = ?',
      params: ['act_agent_1'],
      query: orm(db).select().from(schema.actors).where(eq(schema.actors.actor_id, 'act_agent_1')),
    },
    {
      label: 'getActorBySession',
      raw: 'SELECT * FROM actors WHERE agent_session_id = ?',
      params: ['sess_atlas'],
      query: orm(db)
        .select()
        .from(schema.actors)
        .where(eq(schema.actors.agent_session_id, 'sess_atlas')),
    },
    {
      label: 'getRoom',
      raw: 'SELECT * FROM rooms WHERE room_id = ?',
      params: ['room_direct_1'],
      query: orm(db).select().from(schema.rooms).where(eq(schema.rooms.room_id, 'room_direct_1')),
    },
    {
      label: 'getMember',
      raw: 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?',
      params: ['room_group_1', 'act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.actor_id, 'act_agent_1'),
          ),
        ),
    },
    {
      label: 'isActiveMember',
      raw: "SELECT 1 AS ok FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'",
      params: ['room_group_1', 'act_agent_1'],
      query: orm(db)
        .select({ ok: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.actor_id, 'act_agent_1'),
            eq(schema.roomMembers.status, 'active'),
          ),
        )
        .limit(1),
    },
    {
      label: 'activeRoomCount',
      raw: "SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'",
      params: ['act_human_1'],
      query: orm(db)
        .select({ n: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.actor_id, 'act_human_1'),
            eq(schema.roomMembers.status, 'active'),
          ),
        ),
    },
    {
      label: 'getCredentialByHash',
      raw: 'SELECT * FROM credentials WHERE token_hash = ?',
      params: ['hash_h1'],
      query: orm(db)
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.token_hash, 'hash_h1')),
    },
    {
      label: 'listActiveRoomPeers',
      raw: `SELECT room_members.room_id, actors.actor_id, actors.name, actors.kind
              FROM room_members
              JOIN actors ON actors.actor_id = room_members.actor_id
             WHERE room_members.room_id IN (?, ?, ?)
               AND room_members.status = 'active'
               AND room_members.actor_id <> ?
             ORDER BY room_members.room_id, actors.actor_id`,
      params: ['room_direct_1', 'room_direct_2', 'room_group_1', 'act_human_1'],
      query: orm(db)
        .select({
          room_id: schema.roomMembers.room_id,
          actor_id: schema.actors.actor_id,
          name: schema.actors.name,
          kind: schema.actors.kind,
        })
        .from(schema.roomMembers)
        .innerJoin(schema.actors, eq(schema.actors.actor_id, schema.roomMembers.actor_id))
        .where(
          and(
            inArray(schema.roomMembers.room_id, [
              'room_direct_1',
              'room_direct_2',
              'room_group_1',
            ]),
            eq(schema.roomMembers.status, 'active'),
            ne(schema.roomMembers.actor_id, 'act_human_1'),
          ),
        )
        .orderBy(schema.roomMembers.room_id, schema.actors.actor_id),
    },
    {
      label: 'getDriveFile',
      raw: 'SELECT * FROM drive_files WHERE file_id = ?',
      params: ['df_draft'],
      query: orm(db)
        .select()
        .from(schema.driveFiles)
        .where(eq(schema.driveFiles.file_id, 'df_draft')),
    },
    {
      label: 'getRoomFile',
      raw: 'SELECT * FROM room_files WHERE file_id = ?',
      params: ['rf_file_live'],
      query: orm(db)
        .select()
        .from(schema.roomFiles)
        .where(eq(schema.roomFiles.file_id, 'rf_file_live')),
    },
    {
      label: 'driveFileQuotaUsage',
      raw: `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes,
                   COALESCE(SUM(CASE WHEN retained = 1 THEN size ELSE 0 END), 0) AS retained
              FROM drive_files
             WHERE owner_scope = ? AND state = 'draft'
               AND (retained = 1 OR expires_at IS NULL OR expires_at > ?)`,
      params: ['actor:act_human_1', 2_500],
      query: orm(db)
        .select({
          files: sql<number>`count(*)`.as('files'),
          bytes: sql<number>`coalesce(sum(${schema.driveFiles.size}), 0)`.as('bytes'),
          retained: sql<number>`coalesce(sum(case when ${schema.driveFiles.retained} = 1 then ${schema.driveFiles.size} else 0 end), 0)`.as(
            'retained',
          ),
        })
        .from(schema.driveFiles)
        .where(
          and(
            eq(schema.driveFiles.owner_scope, 'actor:act_human_1'),
            eq(schema.driveFiles.state, 'draft'),
            or(
              eq(schema.driveFiles.retained, 1),
              isNull(schema.driveFiles.expires_at),
              gt(schema.driveFiles.expires_at, 2_500),
            ),
          ),
        ),
    },
    {
      label: 'roomFileQuotaUsage',
      raw: `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes,
                   COALESCE(SUM(CASE WHEN retained = 1 THEN size ELSE 0 END), 0) AS retained
              FROM room_files
             WHERE room_id = ? AND deleted_at IS NULL AND (retained = 1 OR expires_at > ?)`,
      params: ['room_group_1', 2_500],
      query: orm(db)
        .select({
          files: sql<number>`count(*)`.as('files'),
          bytes: sql<number>`coalesce(sum(${schema.roomFiles.size}), 0)`.as('bytes'),
          retained: sql<number>`coalesce(sum(case when ${schema.roomFiles.retained} = 1 then ${schema.roomFiles.size} else 0 end), 0)`.as(
            'retained',
          ),
        })
        .from(schema.roomFiles)
        .where(
          and(
            eq(schema.roomFiles.room_id, 'room_group_1'),
            isNull(schema.roomFiles.deleted_at),
            or(eq(schema.roomFiles.retained, 1), gt(schema.roomFiles.expires_at, 2_500)),
          ),
        ),
    },
    {
      label: 'getEventSubscription',
      raw: 'SELECT * FROM mcp_event_subscriptions WHERE subscription_id = ?',
      params: ['sub_a'],
      query: orm(db)
        .select()
        .from(schema.mcpEventSubscriptions)
        .where(eq(schema.mcpEventSubscriptions.subscription_id, 'sub_a')),
    },
    {
      label: 'listEventSubscriptionsForScan',
      raw: `SELECT * FROM mcp_event_subscriptions
              WHERE active = 1 AND refresh_before > ? AND subscription_id > ?
              ORDER BY subscription_id ASC
              LIMIT ?`,
      params: [2_000, '', 10],
      query: orm(db)
        .select()
        .from(schema.mcpEventSubscriptions)
        .where(
          and(
            eq(schema.mcpEventSubscriptions.active, 1),
            gt(schema.mcpEventSubscriptions.refresh_before, 2_000),
            gt(schema.mcpEventSubscriptions.subscription_id, ''),
          ),
        )
        .orderBy(asc(schema.mcpEventSubscriptions.subscription_id))
        .limit(10),
    },
    {
      label: 'getEventSubscriptionRefresh',
      raw: `SELECT active, refresh_before, credential_id, secret_ciphertext, secret_nonce,
                    previous_secret_ciphertext, previous_secret_nonce, previous_secret_expires_at
               FROM mcp_event_subscriptions WHERE subscription_id = ?`,
      params: ['sub_a'],
      query: orm(db)
        .select({
          active: schema.mcpEventSubscriptions.active,
          refresh_before: schema.mcpEventSubscriptions.refresh_before,
          credential_id: schema.mcpEventSubscriptions.credential_id,
          secret_ciphertext: schema.mcpEventSubscriptions.secret_ciphertext,
          secret_nonce: schema.mcpEventSubscriptions.secret_nonce,
          previous_secret_ciphertext: schema.mcpEventSubscriptions.previous_secret_ciphertext,
          previous_secret_nonce: schema.mcpEventSubscriptions.previous_secret_nonce,
          previous_secret_expires_at: schema.mcpEventSubscriptions.previous_secret_expires_at,
        })
        .from(schema.mcpEventSubscriptions)
        .where(eq(schema.mcpEventSubscriptions.subscription_id, 'sub_a')),
    },
    {
      label: 'countPendingEventDeliveries',
      raw: `SELECT COUNT(*) AS n FROM mcp_event_deliveries
              WHERE subscription_id = ? AND status IN ('pending', 'processing')`,
      params: ['sub_a'],
      query: orm(db)
        .select({ n: sql<number>`count(*)`.as('n') })
        .from(schema.mcpEventDeliveries)
        .where(
          and(
            eq(schema.mcpEventDeliveries.subscription_id, 'sub_a'),
            inArray(schema.mcpEventDeliveries.status, ['pending', 'processing']),
          ),
        ),
    },
    {
      label: 'earliestPendingEventDeliverySeq',
      raw: `SELECT MIN(event_seq) AS seq FROM mcp_event_deliveries
              WHERE subscription_id = ? AND status IN ('pending', 'processing')`,
      params: ['sub_a'],
      query: orm(db)
        .select({
          seq: sql<number | null>`min(${schema.mcpEventDeliveries.event_seq})`.as('seq'),
        })
        .from(schema.mcpEventDeliveries)
        .where(
          and(
            eq(schema.mcpEventDeliveries.subscription_id, 'sub_a'),
            inArray(schema.mcpEventDeliveries.status, ['pending', 'processing']),
          ),
        ),
    },
  ];

  checkEqual(
    'getContact existing',
    JSON.stringify(await getContact(db, 'act_human_1', 'act_agent_1')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM contacts WHERE owner_actor_id = ? AND target_actor_id = ?', [
        'act_human_1',
        'act_agent_1',
      ]),
    ),
  );
  checkEqual('getContact missing', await getContact(db, 'act_human_1', 'act_agent_2'), null);

  checkEqual(
    'getActiveContactRelation',
    JSON.stringify(await getActiveContactRelation(db, 'act_agent_1|act_human_1')),
    JSON.stringify(
      rawFirst(
        sqlite,
        "SELECT * FROM contact_relations WHERE pair_key = ? AND status = 'active'",
        ['act_agent_1|act_human_1'],
      ),
    ),
  );
  checkEqual(
    'getActiveContactRelation ended',
    await getActiveContactRelation(db, 'act_human_1|act_human_2'),
    null,
  );
  checkEqual(
    'getContactRelation ended',
    JSON.stringify(await getContactRelation(db, 'act_human_1|act_human_2')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM contact_relations WHERE pair_key = ?', [
        'act_human_1|act_human_2',
      ]),
    ),
  );
  checkEqual('getContactRelation missing', await getContactRelation(db, 'missing|pair'), null);

  checkEqual(
    'getPendingContactRequest',
    JSON.stringify(await getPendingContactRequest(db, 'act_agent_1|act_human_1')),
    JSON.stringify(
      rawFirst(sqlite, "SELECT * FROM contact_requests WHERE pair_key = ? AND status = 'pending'", [
        'act_agent_1|act_human_1',
      ]),
    ),
  );
  checkEqual(
    'getPendingContactRequest ended pair',
    await getPendingContactRequest(db, 'act_human_1|act_human_2'),
    null,
  );
  checkEqual(
    'getContactRequestById',
    JSON.stringify(await getContactRequestById(db, 'req_3')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM contact_requests WHERE contact_request_id = ?', ['req_3'])),
  );
  checkEqual('getContactRequestById missing', await getContactRequestById(db, 'req_missing'), null);

  const expiredSql = `SELECT * FROM contact_requests
        WHERE status = 'pending' AND expires_at <= ?
        ORDER BY expires_at ASC, contact_request_id ASC
        LIMIT ?`;
  checkEqual(
    'listExpiredPendingContactRequests',
    JSON.stringify(await listExpiredPendingContactRequests(db, 1_000, 10)),
    JSON.stringify(rawAll(sqlite, expiredSql, [1_000, 10])),
  );
  checkEqual(
    'listExpiredPendingContactRequests limit',
    JSON.stringify(await listExpiredPendingContactRequests(db, 1_000, 1)),
    JSON.stringify(rawAll(sqlite, expiredSql, [1_000, 1])),
  );

  checkEqual(
    'getExpiredPendingContactRequestForPair',
    JSON.stringify(await getExpiredPendingContactRequestForPair(db, 'act_agent_1|act_human_1', 1_000)),
    JSON.stringify(
      rawFirst(
        sqlite,
        `SELECT * FROM contact_requests
          WHERE pair_key = ? AND status = 'pending' AND expires_at <= ?`,
        ['act_agent_1|act_human_1', 1_000],
  // 4C-3 rooms 域只读查询：逐行与迁移前手写 SQL 对比。
  checkEqual('getActorRowsByIds empty', JSON.stringify(await getActorRowsByIds(db, [])), '[]');
  checkEqual(
    'getActorRowsByIds many',
    JSON.stringify(await getActorRowsByIds(db, actorIds)),
    JSON.stringify(
      rawAll(sqlite, `SELECT * FROM actors WHERE actor_id IN (${placeholders(actorIds)})`, actorIds),
    ),
  );

  checkEqual(
    'countActiveRoomMembers group',
    await countActiveRoomMembers(db, 'room_group_1'),
    rawFirst<{ n: number }>(
      sqlite,
      "SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND status = 'active'",
      ['room_group_1'],
    )?.n ?? 0,
  );
  checkEqual('countActiveRoomMembers missing', await countActiveRoomMembers(db, 'room_missing'), 0);
  checkEqual(
    'countActiveRoomMembersWithJoinHistory group',
    await countActiveRoomMembersWithJoinHistory(db, 'room_group_1'),
    rawFirst<{ n: number }>(
      sqlite,
      "SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND status = 'active' AND joined_seq > 0",
      ['room_group_1'],
    )?.n ?? 0,
  );
  checkEqual(
    'countActiveRoomMembersWithJoinHistory missing',
    await countActiveRoomMembersWithJoinHistory(db, 'room_missing'),
    0,
  );

  const managerSql = "SELECT actor_id FROM room_members WHERE room_id = ? AND status = 'active' AND role IN ('owner', 'admin')";
  checkEqual(
    'listActiveRoomManagerIds group',
    JSON.stringify([...(await listActiveRoomManagerIds(db, 'room_group_1'))].sort()),
    JSON.stringify(
      (rawAll<{ actor_id: string }>(sqlite, managerSql, ['room_group_1']) as { actor_id: string }[])
        .map((row) => row.actor_id)
        .sort(),
    ),
  );
  checkEqual('listActiveRoomManagerIds missing', JSON.stringify(await listActiveRoomManagerIds(db, 'room_missing')), '[]');

  const invitedSql = `SELECT i.invitation_id, i.target_actor_id AS actor_id, a.kind, a.name,
              i.inviter_id AS invited_by, i.created_at, i.expires_at
         FROM room_invitations i
         JOIN actors a ON a.actor_id = i.target_actor_id
        WHERE i.room_id = ? AND i.kind = 'direct' AND i.status = 'pending'
          AND i.expires_at > ? AND (a.kind <> 'agent' OR a.archived_at IS NULL)
        ORDER BY i.created_at ASC, i.invitation_id ASC`;
  checkEqual(
    'listPendingDirectInvitationMembers group',
    JSON.stringify(await listPendingDirectInvitationMembers(db, 'room_group_1', 1_000)),
    JSON.stringify(rawAll(sqlite, invitedSql, ['room_group_1', 1_000])),
  );
  checkEqual(
    'listPendingDirectInvitationMembers hides archived agent',
    JSON.stringify(await listPendingDirectInvitationMembers(db, 'room_group_1', 1_000)),
    JSON.stringify(
      rawAll(sqlite, invitedSql, ['room_group_1', 1_000]).filter(
        (row) => (row as { actor_id: string }).actor_id !== 'act_agent_2',
      ),
    ),
  );
  checkEqual(
    'getExpiredPendingContactRequestForPair not due',
    await getExpiredPendingContactRequestForPair(db, 'act_agent_3|act_human_1', 1_000),
    null,
  );

  checkEqual(
    'listPendingContactRequests',
    JSON.stringify(await listPendingContactRequests(db, 'act_agent_1|act_human_1')),
    JSON.stringify(
      rawAll(sqlite, "SELECT * FROM contact_requests WHERE pair_key = ? AND status = 'pending'", [
        'act_agent_1|act_human_1',
      ]),
    ),
  );

  checkEqual(
    'getActiveContactBlock',
    JSON.stringify(await getActiveContactBlock(db, 'act_human_1', 'act_agent_3')),
    JSON.stringify(
      rawFirst(
        sqlite,
        `SELECT * FROM contact_blocks
          WHERE blocker_actor_id = ? AND blocked_actor_id = ? AND released_at IS NULL`,
        ['act_human_1', 'act_agent_3'],
  // -------- 4C-4 messages --------
  checkEqual(
    'getMessage',
    JSON.stringify(await getMessage(db, 'msg_d1_2')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM messages WHERE message_id = ?', ['msg_d1_2'])),
  );
  checkEqual(
    'getMessage task root',
    JSON.stringify(await getMessage(db, 'msg_g1_9')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM messages WHERE message_id = ?', ['msg_g1_9'])),
  );
  checkEqual('getMessage missing', await getMessage(db, 'msg_missing'), null);

  checkEqual(
    'listHistoryMessagesBefore first page',
    JSON.stringify(
      await listHistoryMessagesBefore(db, {
        roomId: 'room_direct_1',
        snapshot: 5,
        fromSeq: 0,
        beforeSeq: null,
        limit: 3,
      }),
    ),
    rawHistoryBefore(sqlite, 'room_direct_1', 5, 0, null, 3),
  );
  checkEqual(
    'listHistoryMessagesBefore cursor',
    JSON.stringify(
      await listHistoryMessagesBefore(db, {
        roomId: 'room_direct_1',
        snapshot: 5,
        fromSeq: 0,
        beforeSeq: 5,
        limit: 3,
      }),
    ),
    rawHistoryBefore(sqlite, 'room_direct_1', 5, 0, 5, 3),
  );
  checkEqual(
    'listHistoryMessagesBefore from_join boundary',
    JSON.stringify(
      await listHistoryMessagesBefore(db, {
        roomId: 'room_group_1',
        snapshot: 9,
        fromSeq: 4,
        beforeSeq: null,
        limit: 20,
      }),
    ),
    rawHistoryBefore(sqlite, 'room_group_1', 9, 4, null, 20),
  );
  checkEqual(
    'listHistoryMessagesBefore empty room',
    JSON.stringify(
      await listHistoryMessagesBefore(db, {
        roomId: 'room_missing',
        snapshot: 9,
        fromSeq: 0,
        beforeSeq: null,
        limit: 20,
      }),
    ),
    rawHistoryBefore(sqlite, 'room_missing', 9, 0, null, 20),
  );
  checkEqual(
    'listHistoryMessagesAfter',
    JSON.stringify(
      await listHistoryMessagesAfter(db, {
        roomId: 'room_direct_1',
        snapshot: 5,
        fromSeq: 0,
        afterSeq: 2,
        limit: 5,
      }),
    ),
    rawHistoryAfter(sqlite, 'room_direct_1', 5, 0, 2, 5),
  );
  checkEqual(
    'listHistoryMessagesAfter fromSeq floor',
    JSON.stringify(
      await listHistoryMessagesAfter(db, {
        roomId: 'room_group_1',
        snapshot: 9,
        fromSeq: 4,
        afterSeq: 4,
        limit: 20,
      }),
    ),
    rawHistoryAfter(sqlite, 'room_group_1', 9, 4, 4, 20),
  );
  checkEqual(
    'listHistoryMessagesAfter snapshot upper bound',
    JSON.stringify(
      await listHistoryMessagesAfter(db, {
        roomId: 'room_group_1',
        snapshot: 8,
        fromSeq: 0,
        afterSeq: 3,
        limit: 20,
      }),
    ),
    rawHistoryAfter(sqlite, 'room_group_1', 8, 0, 3, 20),
  );

  const messageIds = ['msg_g1_9', 'msg_d1_1', 'msg_missing'];
  checkEqual(
    'listHistoryMessagesByIds',
    JSON.stringify(await listHistoryMessagesByIds(db, messageIds)),
    JSON.stringify(
      rawAll(
        sqlite,
        `SELECT ${HISTORY_SELECT} FROM messages WHERE message_id IN (${placeholders(messageIds)})`,
        messageIds,
      ),
    ),
  );
  checkEqual('listHistoryMessagesByIds empty', JSON.stringify(await listHistoryMessagesByIds(db, [])), '[]');

  // -------- 4C-4 message context --------
  checkEqual(
    'getMessageContextAnchor',
    JSON.stringify(await getMessageContextAnchor(db, 'room_group_1', 'msg_g1_8')),
    JSON.stringify(
      rawFirst(
        sqlite,
        `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
          WHERE m.room_id = ? AND m.message_id = ?`,
        ['room_group_1', 'msg_g1_8'],
      ),
    ),
  );
  checkEqual(
    'getActiveContactBlock released',
    await getActiveContactBlock(db, 'act_human_2', 'act_human_1'),
    null,
  );

  const betweenSql = `SELECT * FROM contact_blocks
        WHERE released_at IS NULL
          AND ((blocker_actor_id = ? AND blocked_actor_id = ?)
            OR (blocker_actor_id = ? AND blocked_actor_id = ?))
        LIMIT 1`;
  checkEqual(
    'findActiveContactBlockBetween',
    JSON.stringify(await findActiveContactBlockBetween(db, 'act_human_1', 'act_agent_3')),
    JSON.stringify(rawFirst(sqlite, betweenSql, ['act_human_1', 'act_agent_3', 'act_agent_3', 'act_human_1'])),
  );
  checkEqual(
    'findActiveContactBlockBetween reverse',
    JSON.stringify(await findActiveContactBlockBetween(db, 'act_agent_3', 'act_human_1')),
    JSON.stringify(rawFirst(sqlite, betweenSql, ['act_agent_3', 'act_human_1', 'act_human_1', 'act_agent_3'])),
  );
  checkEqual(
    'findActiveContactBlockBetween none',
    await findActiveContactBlockBetween(db, 'act_human_1', 'act_human_2'),
    'listPendingDirectInvitationMembers later cutoff',
    JSON.stringify(await listPendingDirectInvitationMembers(db, 'room_group_1', 5_000)),
    JSON.stringify(rawAll(sqlite, invitedSql, ['room_group_1', 5_000])),
  );

  checkEqual(
    'getRoomInvitationById direct',
    JSON.stringify(await getRoomInvitationById(db, 'inv_direct_h2')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM room_invitations WHERE invitation_id = ?', ['inv_direct_h2'])),
  );
  checkEqual(
    'getRoomInvitationById link',
    JSON.stringify(await getRoomInvitationById(db, 'inv_link_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM room_invitations WHERE invitation_id = ?', ['inv_link_1'])),
  );
  checkEqual('getRoomInvitationById missing', await getRoomInvitationById(db, 'missing'), null);

  checkEqual(
    'getRoomJoinRequestById',
    JSON.stringify(await getRoomJoinRequestById(db, 'jrq_2')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM room_join_requests WHERE join_request_id = ?', ['jrq_2'])),
  );
  checkEqual('getRoomJoinRequestById missing', await getRoomJoinRequestById(db, 'missing'), null);

  const latestSql = `SELECT * FROM room_join_requests
        WHERE invitation_id = ? AND applicant_id = ?
        ORDER BY created_at DESC, join_request_id DESC LIMIT 1`;
  checkEqual(
    'getLatestJoinRequestForApplicant',
    JSON.stringify(await getLatestJoinRequestForApplicant(db, 'inv_link_1', 'act_agent_1')),
    JSON.stringify(rawFirst(sqlite, latestSql, ['inv_link_1', 'act_agent_1'])),
  );
  checkEqual(
    'getLatestJoinRequestForApplicant missing',
    await getLatestJoinRequestForApplicant(db, 'inv_link_1', 'act_human_1'),
    null,
  );

  checkEqual(
    'listMutedMentionBlockers',
    JSON.stringify(
      (await listMutedMentionBlockers(db, 'act_agent_3', ['act_human_1', 'act_human_2'])).sort(),
    ),
    JSON.stringify(
      rawAll<{ blocker_actor_id: string }>(
        sqlite,
        `SELECT blocker_actor_id FROM contact_blocks
          WHERE released_at IS NULL
            AND mute_mentions = 1
            AND blocked_actor_id = ?
            AND blocker_actor_id IN (?, ?)`,
        ['act_agent_3', 'act_human_1', 'act_human_2'],
      )
        .map((row) => row.blocker_actor_id)
        .sort(),
    ),
  );
  checkEqual('listMutedMentionBlockers empty', JSON.stringify(await listMutedMentionBlockers(db, 'x', [])), '[]');

  const blockListSql = `SELECT b.*,
              a.kind AS blocked_kind, a.name AS blocked_name,
              a.agent_session_id AS blocked_session
         FROM contact_blocks b
         JOIN actors a ON a.actor_id = b.blocked_actor_id
        WHERE b.blocker_actor_id = ?
        ORDER BY b.created_at DESC, b.block_id ASC
        LIMIT ?`;
  checkEqual(
    'listContactBlocks',
    JSON.stringify(await listContactBlocks(db, 'act_human_1', 2, null)),
    JSON.stringify(rawAll(sqlite, blockListSql, ['act_human_1', 2])),
  );
  const blockCursorSql = `SELECT b.*,
              a.kind AS blocked_kind, a.name AS blocked_name,
              a.agent_session_id AS blocked_session
         FROM contact_blocks b
         JOIN actors a ON a.actor_id = b.blocked_actor_id
        WHERE b.blocker_actor_id = ?
          AND (b.created_at < ? OR (b.created_at = ? AND b.block_id > ?))
        ORDER BY b.created_at DESC, b.block_id ASC
        LIMIT ?`;
  checkEqual(
    'listContactBlocks cursor',
    JSON.stringify(await listContactBlocks(db, 'act_human_1', 2, { createdAt: 700, blockId: 'blk_1' })),
    JSON.stringify(rawAll(sqlite, blockCursorSql, ['act_human_1', 700, 700, 'blk_1', 2])),
  );

  checkEqual(
    'getActiveAgentManagement',
    JSON.stringify(await getActiveAgentManagement(db, 'act_agent_1')),
    JSON.stringify(
      rawFirst(sqlite, "SELECT * FROM agent_managements WHERE agent_id = ? AND status = 'active'", [
        'act_agent_1',
      ]),
    ),
  );
  checkEqual(
    'getActiveAgentManagement revoked',
    await getActiveAgentManagement(db, 'act_agent_3'),
    null,
  );

  const managementIds = ['act_agent_1', 'act_agent_2', 'act_agent_3'];
  checkEqual(
    'listActiveManagementBindings',
    JSON.stringify(await listActiveManagementBindings(db, managementIds)),
    JSON.stringify(
      rawAll(
        sqlite,
        `SELECT agent_id, manager_id FROM agent_managements
          WHERE status = 'active' AND agent_id IN (${placeholders(managementIds)})`,
        managementIds,
      ),
    ),
  );
  checkEqual(
    'listActiveManagementBindings empty',
    JSON.stringify(await listActiveManagementBindings(db, [])),
    '[]',
  );

  checkEqual(
    'countActiveCredentials',
    await countActiveCredentials(db, 'act_human_1'),
    rawFirst<{ n: number }>(
      sqlite,
      'SELECT COUNT(*) AS n FROM credentials WHERE actor_id = ? AND revoked_at IS NULL',
      ['act_human_1'],
    )?.n ?? 0,
  );
  checkEqual(
    'countActiveCredentials none',
    await countActiveCredentials(db, 'act_agent_1'),
    0,
    'getOwnerTransferById',
    JSON.stringify(await getOwnerTransferById(db, 'tr_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM room_owner_transfers WHERE transfer_id = ?', ['tr_1'])),
  );
  checkEqual('getOwnerTransferById missing', await getOwnerTransferById(db, 'missing'), null);

  const joinRequestListSql = `SELECT jr.*, i.kind AS invitation_kind, i.status AS invitation_status,
              i.expires_at AS invitation_expires_at,
              i.max_uses AS invitation_max_uses,
              i.used_count AS invitation_used_count,
              a.kind AS applicant_kind, a.name AS applicant_name,
              a.agent_session_id AS applicant_session_id
         FROM room_join_requests jr
         JOIN room_invitations i ON i.invitation_id = jr.invitation_id
         JOIN actors a ON a.actor_id = jr.applicant_id
        WHERE jr.room_id = ? AND jr.status = ?
        ORDER BY jr.created_at DESC, jr.join_request_id DESC
        LIMIT ?`;
  checkEqual(
    'listJoinRequestRows pending',
    JSON.stringify(await listJoinRequestRows(db, 'room_group_1', 'pending', null, 10)),
    JSON.stringify(rawAll(sqlite, joinRequestListSql, ['room_group_1', 'pending', 10])),
  );
  checkEqual(
    'listJoinRequestRows page limit',
    JSON.stringify(await listJoinRequestRows(db, 'room_group_1', 'pending', null, 2)),
    JSON.stringify(rawAll(sqlite, joinRequestListSql, ['room_group_1', 'pending', 2])),
  );
  const joinRequestCursorSql = `SELECT jr.*, i.kind AS invitation_kind, i.status AS invitation_status,
              i.expires_at AS invitation_expires_at,
              i.max_uses AS invitation_max_uses,
              i.used_count AS invitation_used_count,
              a.kind AS applicant_kind, a.name AS applicant_name,
              a.agent_session_id AS applicant_session_id
         FROM room_join_requests jr
         JOIN room_invitations i ON i.invitation_id = jr.invitation_id
         JOIN actors a ON a.actor_id = jr.applicant_id
        WHERE jr.room_id = ? AND jr.status = ?
          AND (jr.created_at < ? OR (jr.created_at = ? AND jr.join_request_id < ?))
        ORDER BY jr.created_at DESC, jr.join_request_id DESC
        LIMIT ?`;
  checkEqual(
    'listJoinRequestRows cursor tie-break',
    JSON.stringify(
      await listJoinRequestRows(db, 'room_group_1', 'pending', { seq: 300, key: 'jrq_3' }, 10),
    ),
    JSON.stringify(rawAll(sqlite, joinRequestCursorSql, ['room_group_1', 'pending', 300, 300, 'jrq_3', 10])),
  );
  checkEqual(
    'listJoinRequestRows approved',
    JSON.stringify(await listJoinRequestRows(db, 'room_group_1', 'approved', null, 10)),
    JSON.stringify(rawAll(sqlite, joinRequestListSql, ['room_group_1', 'approved', 10])),
  );

  const auditListSql = `SELECT a.*, target.name AS target_name, changer.name AS changed_by_name
         FROM room_management_audit a
         LEFT JOIN actors target ON target.actor_id = a.target_actor_id
         LEFT JOIN actors changer ON changer.actor_id = a.changed_by
        WHERE a.room_id = ?
        ORDER BY a.created_at DESC, a.audit_id DESC
        LIMIT ?`;
  checkEqual(
    'listRoomAuditRows page',
    JSON.stringify(await listRoomAuditRows(db, 'room_group_1', null, 10)),
    JSON.stringify(rawAll(sqlite, auditListSql, ['room_group_1', 10])),
  );
  checkEqual(
    'listRoomAuditRows limit',
    JSON.stringify(await listRoomAuditRows(db, 'room_group_1', null, 2)),
    JSON.stringify(rawAll(sqlite, auditListSql, ['room_group_1', 2])),
  );
  const auditCursorSql = `SELECT a.*, target.name AS target_name, changer.name AS changed_by_name
         FROM room_management_audit a
         LEFT JOIN actors target ON target.actor_id = a.target_actor_id
         LEFT JOIN actors changer ON changer.actor_id = a.changed_by
        WHERE a.room_id = ?
          AND (a.created_at < ? OR (a.created_at = ? AND a.audit_id < ?))
        ORDER BY a.created_at DESC, a.audit_id DESC
        LIMIT ?`;
  checkEqual(
    'listRoomAuditRows cursor tie-break',
    JSON.stringify(await listRoomAuditRows(db, 'room_group_1', { seq: 500, key: 'aud_2' }, 10)),
    JSON.stringify(rawAll(sqlite, auditCursorSql, ['room_group_1', 500, 500, 'aud_2', 10])),
  );
  checkEqual(
    'listRoomAuditRows empty',
    JSON.stringify(await listRoomAuditRows(db, 'room_missing', null, 10)),
    '[]',
    'getMessageContextAnchor missing',
    await getMessageContextAnchor(db, 'room_group_1', 'msg_missing'),
    null,
  );
  checkEqual(
    'listMessageContextWindow before full',
    JSON.stringify(
      await listMessageContextWindow(db, {
        roomId: 'room_group_1',
        pivotSeq: 8,
        direction: 'before',
        fromSeq: null,
        toSeq: null,
        limit: 2,
      }),
    ),
    rawContextBefore(sqlite, 'room_group_1', 8, null, 2),
  );
  checkEqual(
    'listMessageContextWindow before from_join',
    JSON.stringify(
      await listMessageContextWindow(db, {
        roomId: 'room_group_1',
        pivotSeq: 8,
        direction: 'before',
        fromSeq: 4,
        toSeq: 8,
        limit: 20,
      }),
    ),
    rawContextBefore(sqlite, 'room_group_1', 8, 4, 20),
  );
  checkEqual(
    'listMessageContextWindow after full',
    JSON.stringify(
      await listMessageContextWindow(db, {
        roomId: 'room_group_1',
        pivotSeq: 8,
        direction: 'after',
        fromSeq: null,
        toSeq: null,
        limit: 20,
      }),
    ),
    rawContextAfter(sqlite, 'room_group_1', 8, null, null, 20),
  );
  checkEqual(
    'listMessageContextWindow after archived',
    JSON.stringify(
      await listMessageContextWindow(db, {
        roomId: 'room_group_1',
        pivotSeq: 3,
        direction: 'after',
        fromSeq: 3,
        toSeq: 8,
        limit: 20,
      }),
    ),
    rawContextAfter(sqlite, 'room_group_1', 3, 3, 8, 20),
  );

  // -------- 4C-4 messages / deliveries joins --------
  const senderSql = `SELECT m.message_id, m.sender_id, m.created_seq, m.preview, m.body_bytes,
              m.created_at, a.name AS sender_name, a.kind AS sender_kind
         FROM messages m LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.message_id = ?`;
  checkEqual(
    'getMessageSenderSummary',
    JSON.stringify(await getMessageSenderSummary(db, 'msg_g1_8')),
    JSON.stringify(rawFirst(sqlite, senderSql, ['msg_g1_8'])),
  );
  checkEqual(
    'getMessageSenderSummary ghost sender',
    JSON.stringify(await getMessageSenderSummary(db, 'msg_ghost')),
    JSON.stringify(rawFirst(sqlite, senderSql, ['msg_ghost'])),
  );
  checkEqual('getMessageSenderSummary missing', await getMessageSenderSummary(db, 'msg_missing'), null);

  const stateIds = ['msg_d1_2', 'msg_g1_8', 'msg_g1_9', 'msg_missing'];
  checkEqual(
    'listDeliveryStates',
    deliveryStateRows(await listDeliveryStates(db, stateIds)),
    deliveryStateRows(
      rawAll(
        sqlite,
        `SELECT message_id, state, COUNT(*) AS n,
                MAX(CASE WHEN state = 'claimed' THEN claimed_at END) AS max_claimed_at,
                MAX(CASE WHEN state = 'claimed' THEN updated_at END) AS max_updated_at
           FROM deliveries WHERE message_id IN (${placeholders(stateIds)})
          GROUP BY message_id, state`,
        stateIds,
      ),
    ),
  );
  checkEqual('listDeliveryStates empty', JSON.stringify(await listDeliveryStates(db, [])), '[]');

  const mentionIds = ['msg_g1_8', 'msg_g1_9', 'msg_missing'];
  checkEqual(
    'listMessageMentions',
    JSON.stringify(await listMessageMentions(db, mentionIds)),
    JSON.stringify(
      rawAll(
        sqlite,
        `SELECT message_id, actor_id, actor_kind, source FROM message_mentions
          WHERE message_id IN (${placeholders(mentionIds)})
          ORDER BY message_id, actor_id`,
        mentionIds,
      ),
    ),
  );
  checkEqual('listMessageMentions empty', JSON.stringify(await listMessageMentions(db, [])), '[]');

  // -------- 4C-4 deliveries --------
  checkEqual(
    'getDelivery',
    JSON.stringify(await getDelivery(db, 'del_claimed_1')),
    JSON.stringify(rawFirst(sqlite, 'SELECT * FROM deliveries WHERE delivery_id = ?', ['del_claimed_1'])),
  );
  checkEqual('getDelivery missing', await getDelivery(db, 'del_missing'), null);
  checkEqual(
    'getDeliveryForMessage',
    JSON.stringify(await getDeliveryForMessage(db, 'act_agent_1', 'msg_g1_8')),
    JSON.stringify(
      rawFirst(sqlite, 'SELECT * FROM deliveries WHERE recipient_id = ? AND message_id = ?', [
        'act_agent_1',
        'msg_g1_8',
      ]),
    ),
  );
  checkEqual('getDeliveryForMessage missing', await getDeliveryForMessage(db, 'act_agent_3', 'msg_d1_1'), null);
  checkEqual(
    'getClaimedDelivery',
    JSON.stringify(await getClaimedDelivery(db, 'act_agent_1')),
    JSON.stringify(
      rawFirst(sqlite, "SELECT * FROM deliveries WHERE recipient_id = ? AND state = 'claimed' LIMIT 1", [
        'act_agent_1',
      ]),
    ),
  );
  checkEqual('getClaimedDelivery none', await getClaimedDelivery(db, 'act_agent_2'), null);
  checkEqual('getClaimedDeliveryId', await getClaimedDeliveryId(db, 'act_agent_1'), 'del_claimed_1');
  checkEqual('getClaimedDeliveryId none', await getClaimedDeliveryId(db, 'act_human_1'), null);

  checkEqual(
    'listInboxDeliveries active',
    JSON.stringify(
      await listInboxDeliveries(db, {
        recipientId: 'act_agent_1',
        states: ['pending', 'claimed'],
        afterSeq: null,
        limit: 3,
      }),
    ),
    rawInbox(sqlite, 'act_agent_1', ['pending', 'claimed'], null, 3),
  );
  checkEqual(
    'listInboxDeliveries cursor',
    JSON.stringify(
      await listInboxDeliveries(db, {
        recipientId: 'act_agent_1',
        states: ['pending', 'claimed'],
        afterSeq: 1,
        limit: 3,
      }),
    ),
    rawInbox(sqlite, 'act_agent_1', ['pending', 'claimed'], 1, 3),
  );
  checkEqual(
    'listInboxDeliveries all states',
    JSON.stringify(
      await listInboxDeliveries(db, {
        recipientId: 'act_agent_1',
        states: null,
        afterSeq: null,
        limit: 10,
      }),
    ),
    rawInbox(sqlite, 'act_agent_1', null, null, 10),
  );
  checkEqual(
    'listInboxDeliveries single state',
    JSON.stringify(
      await listInboxDeliveries(db, {
        recipientId: 'act_agent_2',
        states: ['pending'],
        afterSeq: null,
        limit: 10,
      }),
    ),
    rawInbox(sqlite, 'act_agent_2', ['pending'], null, 10),
  );
  checkEqual(
    'listInboxDeliveries empty',
    JSON.stringify(
      await listInboxDeliveries(db, {
        recipientId: 'act_human_1',
        states: ['pending'],
        afterSeq: null,
        limit: 10,
      }),
    ),
    rawInbox(sqlite, 'act_human_1', ['pending'], null, 10),
  );
}

function explainChecks(sqlite: Database, db: D1Database): void {
  const auditTarget = alias(schema.actors, 'target');
  const auditChanger = alias(schema.actors, 'changer');
  const cases: { label: string; raw: string; params: unknown[]; query: { toSQL(): { sql: string; params: unknown[] } } }[] = [
    {
      label: 'getActor',
      raw: 'SELECT * FROM actors WHERE actor_id = ?',
      params: ['act_agent_1'],
      query: orm(db).select().from(schema.actors).where(eq(schema.actors.actor_id, 'act_agent_1')),
    },
    {
      label: 'getActorBySession',
      raw: 'SELECT * FROM actors WHERE agent_session_id = ?',
      params: ['sess_atlas'],
      query: orm(db)
        .select()
        .from(schema.actors)
        .where(eq(schema.actors.agent_session_id, 'sess_atlas')),
    },
    {
      label: 'getRoom',
      raw: 'SELECT * FROM rooms WHERE room_id = ?',
      params: ['room_direct_1'],
      query: orm(db).select().from(schema.rooms).where(eq(schema.rooms.room_id, 'room_direct_1')),
    },
    {
      label: 'getMember',
      raw: 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?',
      params: ['room_group_1', 'act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.actor_id, 'act_agent_1'),
          ),
        ),
    },
    {
      label: 'isActiveMember',
      raw: "SELECT 1 AS ok FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'",
      params: ['room_group_1', 'act_agent_1'],
      query: orm(db)
        .select({ ok: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.actor_id, 'act_agent_1'),
            eq(schema.roomMembers.status, 'active'),
          ),
        )
        .limit(1),
    },
    {
      label: 'activeRoomCount',
      raw: "SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'",
      params: ['act_human_1'],
      query: orm(db)
        .select({ n: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.actor_id, 'act_human_1'),
            eq(schema.roomMembers.status, 'active'),
          ),
        ),
    },
    {
      label: 'getCredentialByHash',
      raw: 'SELECT * FROM credentials WHERE token_hash = ?',
      params: ['hash_h1'],
      query: orm(db)
        .select()
        .from(schema.credentials)
        .where(eq(schema.credentials.token_hash, 'hash_h1')),
    },
    {
      label: 'listActiveRoomPeers',
      raw: `SELECT room_members.room_id, actors.actor_id, actors.name, actors.kind
              FROM room_members
              JOIN actors ON actors.actor_id = room_members.actor_id
             WHERE room_members.room_id IN (?, ?, ?)
               AND room_members.status = 'active'
               AND room_members.actor_id <> ?
             ORDER BY room_members.room_id, actors.actor_id`,
      params: ['room_direct_1', 'room_direct_2', 'room_group_1', 'act_human_1'],
      query: orm(db)
        .select({
          room_id: schema.roomMembers.room_id,
          actor_id: schema.actors.actor_id,
          name: schema.actors.name,
          kind: schema.actors.kind,
        })
        .from(schema.roomMembers)
        .innerJoin(schema.actors, eq(schema.actors.actor_id, schema.roomMembers.actor_id))
        .where(
          and(
            inArray(schema.roomMembers.room_id, [
              'room_direct_1',
              'room_direct_2',
              'room_group_1',
            ]),
            eq(schema.roomMembers.status, 'active'),
            ne(schema.roomMembers.actor_id, 'act_human_1'),
          ),
        )
        .orderBy(schema.roomMembers.room_id, schema.actors.actor_id),
    },
    {
      label: 'getContact',
      raw: 'SELECT * FROM contacts WHERE owner_actor_id = ? AND target_actor_id = ?',
      params: ['act_human_1', 'act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.owner_actor_id, 'act_human_1'),
            eq(schema.contacts.target_actor_id, 'act_agent_1'),
          ),
        ),
    },
    {
      label: 'getActiveContactRelation',
      raw: "SELECT * FROM contact_relations WHERE pair_key = ? AND status = 'active'",
      params: ['act_agent_1|act_human_1'],
      query: orm(db)
        .select()
        .from(schema.contactRelations)
        .where(
          and(
            eq(schema.contactRelations.pair_key, 'act_agent_1|act_human_1'),
            eq(schema.contactRelations.status, 'active'),
          ),
        ),
    },
    {
      label: 'getPendingContactRequest',
      raw: "SELECT * FROM contact_requests WHERE pair_key = ? AND status = 'pending'",
      params: ['act_agent_1|act_human_1'],
      query: orm(db)
        .select()
        .from(schema.contactRequests)
        .where(
          and(
            eq(schema.contactRequests.pair_key, 'act_agent_1|act_human_1'),
            eq(schema.contactRequests.status, 'pending'),
          ),
        ),
    },
    {
      label: 'listExpiredPendingContactRequests',
      raw: `SELECT * FROM contact_requests
        WHERE status = 'pending' AND expires_at <= ?
        ORDER BY expires_at ASC, contact_request_id ASC
        LIMIT ?`,
      params: [1_000, 10],
      query: orm(db)
        .select()
        .from(schema.contactRequests)
        .where(
          and(
            eq(schema.contactRequests.status, 'pending'),
            lte(schema.contactRequests.expires_at, 1_000),
          ),
        )
        .orderBy(
          asc(schema.contactRequests.expires_at),
          asc(schema.contactRequests.contact_request_id),
        )
        .limit(10),
    },
    {
      label: 'getActiveContactBlock',
      raw: `SELECT * FROM contact_blocks
        WHERE blocker_actor_id = ? AND blocked_actor_id = ? AND released_at IS NULL`,
      params: ['act_human_1', 'act_agent_3'],
      query: orm(db)
        .select()
        .from(schema.contactBlocks)
        .where(
          and(
            eq(schema.contactBlocks.blocker_actor_id, 'act_human_1'),
            eq(schema.contactBlocks.blocked_actor_id, 'act_agent_3'),
            isNull(schema.contactBlocks.released_at),
          ),
        ),
    },
    {
      label: 'findActiveContactBlockBetween',
      raw: `SELECT * FROM contact_blocks
        WHERE released_at IS NULL
          AND ((blocker_actor_id = ? AND blocked_actor_id = ?)
            OR (blocker_actor_id = ? AND blocked_actor_id = ?))
        LIMIT 1`,
      params: ['act_human_1', 'act_agent_3', 'act_agent_3', 'act_human_1'],
      query: orm(db)
        .select()
        .from(schema.contactBlocks)
        .where(
          and(
            isNull(schema.contactBlocks.released_at),
            or(
              and(
                eq(schema.contactBlocks.blocker_actor_id, 'act_human_1'),
                eq(schema.contactBlocks.blocked_actor_id, 'act_agent_3'),
              ),
              and(
                eq(schema.contactBlocks.blocker_actor_id, 'act_agent_3'),
                eq(schema.contactBlocks.blocked_actor_id, 'act_human_1'),
              ),
            ),
          ),
        )
        .limit(1),
    },
    {
      label: 'listContactBlocks',
      raw: `SELECT contact_blocks.*,
              actors.kind AS blocked_kind, actors.name AS blocked_name,
              actors.agent_session_id AS blocked_session
         FROM contact_blocks
         JOIN actors ON actors.actor_id = contact_blocks.blocked_actor_id
        WHERE contact_blocks.blocker_actor_id = ?
        ORDER BY contact_blocks.created_at DESC, contact_blocks.block_id ASC
        LIMIT ?`,
      params: ['act_human_1', 2],
      query: orm(db)
        .select({
          block_id: schema.contactBlocks.block_id,
          blocker_actor_id: schema.contactBlocks.blocker_actor_id,
          blocked_actor_id: schema.contactBlocks.blocked_actor_id,
          reason: schema.contactBlocks.reason,
          mute_mentions: schema.contactBlocks.mute_mentions,
          created_at: schema.contactBlocks.created_at,
          released_at: schema.contactBlocks.released_at,
          released_by: schema.contactBlocks.released_by,
          blocked_kind: sql<'human' | 'agent'>`${schema.actors.kind}`.as('blocked_kind'),
          blocked_name: sql<string>`${schema.actors.name}`.as('blocked_name'),
          blocked_session: sql<string | null>`${schema.actors.agent_session_id}`.as(
            'blocked_session',
          ),
        })
        .from(schema.contactBlocks)
        .innerJoin(
          schema.actors,
          eq(schema.actors.actor_id, schema.contactBlocks.blocked_actor_id),
        )
        .where(eq(schema.contactBlocks.blocker_actor_id, 'act_human_1'))
        .orderBy(desc(schema.contactBlocks.created_at), asc(schema.contactBlocks.block_id))
        .limit(2),
    },
    {
      label: 'getActiveAgentManagement',
      raw: "SELECT * FROM agent_managements WHERE agent_id = ? AND status = 'active'",
      params: ['act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.agentManagements)
        .where(
          and(
            eq(schema.agentManagements.agent_id, 'act_agent_1'),
            eq(schema.agentManagements.status, 'active'),
          ),
        ),
    },
    {
      label: 'listActiveManagementBindings',
      raw: `SELECT agent_id, manager_id FROM agent_managements
          WHERE status = 'active' AND agent_id IN (?, ?, ?)`,
      params: ['act_agent_1', 'act_agent_2', 'act_agent_3'],
      query: orm(db)
        .select({
          agent_id: schema.agentManagements.agent_id,
          manager_id: schema.agentManagements.manager_id,
        })
        .from(schema.agentManagements)
        .where(
          and(
            eq(schema.agentManagements.status, 'active'),
            inArray(schema.agentManagements.agent_id, [
              'act_agent_1',
              'act_agent_2',
              'act_agent_3',
            ]),
          ),
        ),
    },
    {
      label: 'countActiveCredentials',
      raw: 'SELECT COUNT(*) AS n FROM credentials WHERE actor_id = ? AND revoked_at IS NULL',
      params: ['act_human_1'],
      query: orm(db)
        .select({ n: sql<number>`count(*)`.as('n') })
        .from(schema.credentials)
        .where(
          and(
            eq(schema.credentials.actor_id, 'act_human_1'),
            isNull(schema.credentials.revoked_at),
          ),
        ),
      label: 'getActorRowsByIds',
      raw: 'SELECT * FROM actors WHERE actor_id IN (?, ?, ?)',
      params: ['act_human_1', 'act_agent_2', 'act_agent_3'],
      query: orm(db)
        .select()
        .from(schema.actors)
        .where(inArray(schema.actors.actor_id, ['act_human_1', 'act_agent_2', 'act_agent_3'])),
    },
    {
      label: 'countActiveRoomMembers',
      raw: "SELECT count(*) AS n FROM room_members WHERE room_id = ? AND status = 'active'",
      params: ['room_group_1'],
      query: orm(db)
        .select({ n: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.status, 'active'),
          ),
        ),
    },
    {
      label: 'countActiveRoomMembersWithJoinHistory',
      raw: "SELECT count(*) AS n FROM room_members WHERE room_id = ? AND status = 'active' AND joined_seq > 0",
      params: ['room_group_1'],
      query: orm(db)
        .select({ n: schema.roomMembers.status })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.status, 'active'),
            gt(schema.roomMembers.joined_seq, 0),
          ),
        ),
    },
    {
      label: 'listActiveRoomManagerIds',
      raw: "SELECT actor_id FROM room_members WHERE room_id = ? AND status = 'active' AND role IN ('owner', 'admin')",
      params: ['room_group_1'],
      query: orm(db)
        .select({ actor_id: schema.roomMembers.actor_id })
        .from(schema.roomMembers)
        .where(
          and(
            eq(schema.roomMembers.room_id, 'room_group_1'),
            eq(schema.roomMembers.status, 'active'),
            inArray(schema.roomMembers.role, ['owner', 'admin']),
          ),
        ),
    },
    {
      label: 'listPendingDirectInvitationMembers',
      raw: `SELECT room_invitations.invitation_id, room_invitations.target_actor_id AS actor_id,
              actors.kind, actors.name,
              room_invitations.inviter_id AS invited_by,
              room_invitations.created_at, room_invitations.expires_at
         FROM room_invitations
         JOIN actors ON actors.actor_id = room_invitations.target_actor_id
        WHERE room_invitations.room_id = ? AND room_invitations.kind = 'direct'
          AND room_invitations.status = 'pending'
          AND room_invitations.expires_at > ?
          AND (actors.kind <> 'agent' OR actors.archived_at IS NULL)
        ORDER BY room_invitations.created_at ASC, room_invitations.invitation_id ASC`,
      params: ['room_group_1', 1_000],
      query: orm(db)
        .select({
          invitation_id: schema.roomInvitations.invitation_id,
          actor_id: schema.roomInvitations.target_actor_id,
          kind: schema.actors.kind,
          name: schema.actors.name,
          invited_by: schema.roomInvitations.inviter_id,
          created_at: schema.roomInvitations.created_at,
          expires_at: schema.roomInvitations.expires_at,
        })
        .from(schema.roomInvitations)
        .innerJoin(
          schema.actors,
          eq(schema.actors.actor_id, schema.roomInvitations.target_actor_id),
        )
        .where(
          and(
            eq(schema.roomInvitations.room_id, 'room_group_1'),
            eq(schema.roomInvitations.kind, 'direct'),
            eq(schema.roomInvitations.status, 'pending'),
            gt(schema.roomInvitations.expires_at, 1_000),
            or(ne(schema.actors.kind, 'agent'), isNull(schema.actors.archived_at)),
          ),
        )
        .orderBy(asc(schema.roomInvitations.created_at), asc(schema.roomInvitations.invitation_id)),
    },
    {
      label: 'getRoomInvitationById',
      raw: 'SELECT * FROM room_invitations WHERE invitation_id = ?',
      params: ['inv_link_1'],
      query: orm(db)
        .select()
        .from(schema.roomInvitations)
        .where(eq(schema.roomInvitations.invitation_id, 'inv_link_1')),
    },
    {
      label: 'getRoomJoinRequestById',
      raw: 'SELECT * FROM room_join_requests WHERE join_request_id = ?',
      params: ['jrq_2'],
      query: orm(db)
        .select()
        .from(schema.roomJoinRequests)
        .where(eq(schema.roomJoinRequests.join_request_id, 'jrq_2')),
    },
    {
      label: 'getLatestJoinRequestForApplicant',
      raw: `SELECT * FROM room_join_requests
        WHERE invitation_id = ? AND applicant_id = ?
        ORDER BY created_at DESC, join_request_id DESC LIMIT 1`,
      params: ['inv_link_1', 'act_agent_1'],
      query: orm(db)
        .select()
        .from(schema.roomJoinRequests)
        .where(
          and(
            eq(schema.roomJoinRequests.invitation_id, 'inv_link_1'),
            eq(schema.roomJoinRequests.applicant_id, 'act_agent_1'),
          ),
        )
        .orderBy(
          desc(schema.roomJoinRequests.created_at),
          desc(schema.roomJoinRequests.join_request_id),
        )
        .limit(1),
    },
    {
      label: 'getOwnerTransferById',
      raw: 'SELECT * FROM room_owner_transfers WHERE transfer_id = ?',
      params: ['tr_1'],
      query: orm(db)
        .select()
        .from(schema.roomOwnerTransfers)
        .where(eq(schema.roomOwnerTransfers.transfer_id, 'tr_1')),
    },
    {
      label: 'listJoinRequestRows',
      raw: `SELECT room_join_requests.*,
              room_invitations.kind AS invitation_kind,
              room_invitations.status AS invitation_status,
              room_invitations.expires_at AS invitation_expires_at,
              room_invitations.max_uses AS invitation_max_uses,
              room_invitations.used_count AS invitation_used_count,
              actors.kind AS applicant_kind, actors.name AS applicant_name,
              actors.agent_session_id AS applicant_session_id
         FROM room_join_requests
         JOIN room_invitations
           ON room_invitations.invitation_id = room_join_requests.invitation_id
         JOIN actors ON actors.actor_id = room_join_requests.applicant_id
        WHERE room_join_requests.room_id = ? AND room_join_requests.status = ?
        ORDER BY room_join_requests.created_at DESC, room_join_requests.join_request_id DESC
        LIMIT ?`,
      params: ['room_group_1', 'pending', 10],
      query: orm(db)
        .select({
          join_request_id: schema.roomJoinRequests.join_request_id,
          invitation_kind: schema.roomInvitations.kind,
          applicant_name: schema.actors.name,
        })
        .from(schema.roomJoinRequests)
        .innerJoin(
          schema.roomInvitations,
          eq(schema.roomInvitations.invitation_id, schema.roomJoinRequests.invitation_id),
        )
        .innerJoin(
          schema.actors,
          eq(schema.actors.actor_id, schema.roomJoinRequests.applicant_id),
        )
        .where(
          and(
            eq(schema.roomJoinRequests.room_id, 'room_group_1'),
            eq(schema.roomJoinRequests.status, 'pending'),
          ),
        )
        .orderBy(
          desc(schema.roomJoinRequests.created_at),
          desc(schema.roomJoinRequests.join_request_id),
        )
        .limit(10),
    },
    {
      label: 'listJoinRequestRows cursor',
      raw: `SELECT room_join_requests.*,
              room_invitations.kind AS invitation_kind,
              room_invitations.status AS invitation_status,
              room_invitations.expires_at AS invitation_expires_at,
              room_invitations.max_uses AS invitation_max_uses,
              room_invitations.used_count AS invitation_used_count,
              actors.kind AS applicant_kind, actors.name AS applicant_name,
              actors.agent_session_id AS applicant_session_id
         FROM room_join_requests
         JOIN room_invitations
           ON room_invitations.invitation_id = room_join_requests.invitation_id
         JOIN actors ON actors.actor_id = room_join_requests.applicant_id
        WHERE room_join_requests.room_id = ? AND room_join_requests.status = ?
          AND (room_join_requests.created_at < ?
               OR (room_join_requests.created_at = ?
                   AND room_join_requests.join_request_id < ?))
        ORDER BY room_join_requests.created_at DESC, room_join_requests.join_request_id DESC
        LIMIT ?`,
      params: ['room_group_1', 'pending', 300, 300, 'jrq_3', 10],
      query: orm(db)
        .select({
          join_request_id: schema.roomJoinRequests.join_request_id,
          invitation_kind: schema.roomInvitations.kind,
          applicant_name: schema.actors.name,
        })
        .from(schema.roomJoinRequests)
        .innerJoin(
          schema.roomInvitations,
          eq(schema.roomInvitations.invitation_id, schema.roomJoinRequests.invitation_id),
        )
        .innerJoin(
          schema.actors,
          eq(schema.actors.actor_id, schema.roomJoinRequests.applicant_id),
        )
        .where(
          and(
            eq(schema.roomJoinRequests.room_id, 'room_group_1'),
            eq(schema.roomJoinRequests.status, 'pending'),
            or(
              lt(schema.roomJoinRequests.created_at, 300),
              and(
                eq(schema.roomJoinRequests.created_at, 300),
                lt(schema.roomJoinRequests.join_request_id, 'jrq_3'),
              ),
            )!,
          ),
        )
        .orderBy(
          desc(schema.roomJoinRequests.created_at),
          desc(schema.roomJoinRequests.join_request_id),
        )
        .limit(10),
    },
    {
      label: 'listRoomAuditRows',
      raw: `SELECT room_management_audit.*, target.name AS target_name,
              changer.name AS changed_by_name
         FROM room_management_audit
         LEFT JOIN actors target
           ON target.actor_id = room_management_audit.target_actor_id
         LEFT JOIN actors changer
           ON changer.actor_id = room_management_audit.changed_by
        WHERE room_management_audit.room_id = ?
        ORDER BY room_management_audit.created_at DESC, room_management_audit.audit_id DESC
        LIMIT ?`,
      params: ['room_group_1', 10],
      query: orm(db)
        .select({
          audit_id: schema.roomManagementAudit.audit_id,
          target_name: auditTarget.name,
          changed_by_name: auditChanger.name,
        })
        .from(schema.roomManagementAudit)
        .leftJoin(
          auditTarget,
          eq(auditTarget.actor_id, schema.roomManagementAudit.target_actor_id),
        )
        .leftJoin(
          auditChanger,
          eq(auditChanger.actor_id, schema.roomManagementAudit.changed_by),
        )
        .where(eq(schema.roomManagementAudit.room_id, 'room_group_1'))
        .orderBy(
          desc(schema.roomManagementAudit.created_at),
          desc(schema.roomManagementAudit.audit_id),
        )
        .limit(10),
    },
  ];

  for (const item of cases) {
    const compiled = item.query.toSQL();
    checkEqual(
      `EXPLAIN ${item.label}`,
      JSON.stringify(plan(sqlite, compiled.sql, compiled.params)),
      JSON.stringify(plan(sqlite, item.raw, item.params)),
    );
  }
}

interface ExecutedQuery {
  sql: string;
  params: unknown[];
}

/** 记录 D1 实际执行的 SQL，用于对生产语句本身做 EXPLAIN，而不是在测试里重写 builder。 */
function capture(inner: D1Database): { db: D1Database; executed: ExecutedQuery[] } {
  const executed: ExecutedQuery[] = [];
  const wrap = (
    statement: D1PreparedStatement,
    sql: string,
    values: unknown[],
  ): D1PreparedStatement => ({
    bind: (...next) => wrap(statement.bind(...next), sql, next),
    first: async <T = unknown>(colName?: string) => {
      executed.push({ sql, params: values });
      return statement.first<T>(colName);
    },
    all: async <T = unknown>() => {
      executed.push({ sql, params: values });
      return statement.all<T>();
    },
    run: async <T = unknown>() => {
      executed.push({ sql, params: values });
      return statement.run<T>();
    },
    raw: async <T = unknown>() => {
      executed.push({ sql, params: values });
      return statement.raw<T>();
    },
  });
  const db: D1Database = {
    prepare: (sql) => wrap(inner.prepare(sql), sql, []),
    batch: (statements) => inner.batch(statements),
    exec: (query) => inner.exec(query),
  };
  return { db, executed };
}

const EXPLAIN_ALIASES: Record<string, string> = {
  d: 'deliveries',
  m: 'messages',
  a: 'actors',
};

/** 手写 SQL 使用 `d`/`m`/`a` 别名，Drizzle 使用表名；只归一化 FROM/JOIN 的表标识。 */
function normalizePlan(lines: string[]): string[] {
  return lines.map((line) =>
    line.replace(/\b(SCAN|SEARCH) (d|m|a)\b/gu, (_match, op: string, alias: string) => {
      return `${op} ${EXPLAIN_ALIASES[alias] ?? alias}`;
    }),
  );
}

interface ExplainCase {
  label: string;
  /** 从捕获到的语句中挑选目标 SQL；未命中即失败。 */
  pattern: RegExp;
  run: (db: D1Database) => Promise<unknown>;
  raw: string;
  params: unknown[];
}

async function messageExplainChecks(sqlite: Database, db: D1Database): Promise<void> {
  const cases: ExplainCase[] = [
    {
      label: 'getMessage',
      pattern: /^select .* from "messages" where "messages"\."message_id" = \?$/u,
      run: (target) => getMessage(target, 'msg_d1_2'),
      raw: 'SELECT * FROM messages WHERE message_id = ?',
      params: ['msg_d1_2'],
    },
    {
      label: 'listHistoryMessagesBefore first page',
      pattern: /from "messages" where .*order by "messages"\."created_seq" desc limit \?$/u,
      run: (target) =>
        listHistoryMessagesBefore(target, {
          roomId: 'room_group_1',
          snapshot: 9,
          fromSeq: 4,
          beforeSeq: null,
          limit: 20,
        }),
      raw: `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq >= ?
        ORDER BY created_seq DESC LIMIT ?`,
      params: ['room_group_1', 9, 4, 20],
    },
    {
      label: 'listHistoryMessagesBefore cursor',
      pattern: /from "messages" where .*order by "messages"\."created_seq" desc limit \?$/u,
      run: (target) =>
        listHistoryMessagesBefore(target, {
          roomId: 'room_group_1',
          snapshot: 9,
          fromSeq: 4,
          beforeSeq: 9,
          limit: 20,
        }),
      raw: `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq >= ? AND created_seq < ?
        ORDER BY created_seq DESC LIMIT ?`,
      params: ['room_group_1', 9, 4, 9, 20],
    },
    {
      label: 'listHistoryMessagesAfter',
      pattern: /from "messages" where .*order by "messages"\."created_seq" asc limit \?$/u,
      run: (target) =>
        listHistoryMessagesAfter(target, {
          roomId: 'room_group_1',
          snapshot: 9,
          fromSeq: 4,
          afterSeq: 4,
          limit: 20,
        }),
      raw: `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq > ? AND created_seq >= ?
        ORDER BY created_seq ASC LIMIT ?`,
      params: ['room_group_1', 9, 4, 4, 20],
    },
    {
      label: 'listHistoryMessagesByIds',
      pattern: /from "messages" where "messages"\."message_id" in \(\?, \?\)$/u,
      run: (target) => listHistoryMessagesByIds(target, ['msg_g1_8', 'msg_g1_9']),
      raw: `SELECT ${HISTORY_SELECT} FROM messages WHERE message_id IN (?, ?)`,
      params: ['msg_g1_8', 'msg_g1_9'],
    },
    {
      label: 'getMessageContextAnchor',
      pattern: /inner join "actors" .*where .*"messages"\."message_id" = \?\)$/u,
      run: (target) => getMessageContextAnchor(target, 'room_group_1', 'msg_g1_8'),
      raw: `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.room_id = ? AND m.message_id = ?`,
      params: ['room_group_1', 'msg_g1_8'],
    },
    {
      label: 'listMessageContextWindow before',
      pattern: /inner join "actors" .*order by "messages"\."created_seq" desc limit \?$/u,
      run: (target) =>
        listMessageContextWindow(target, {
          roomId: 'room_group_1',
          pivotSeq: 8,
          direction: 'before',
          fromSeq: 4,
          toSeq: 8,
          limit: 20,
        }),
      raw: `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.room_id = ? AND m.created_seq < ? AND m.created_seq >= ?
        ORDER BY m.created_seq DESC LIMIT ?`,
      params: ['room_group_1', 8, 4, 20],
    },
    {
      label: 'listMessageContextWindow after',
      pattern: /inner join "actors" .*order by "messages"\."created_seq" asc limit \?$/u,
      run: (target) =>
        listMessageContextWindow(target, {
          roomId: 'room_group_1',
          pivotSeq: 3,
          direction: 'after',
          fromSeq: 3,
          toSeq: 8,
          limit: 20,
        }),
      raw: `SELECT ${CONTEXT_SELECT} FROM messages m JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.room_id = ? AND m.created_seq > ? AND m.created_seq >= ? AND m.created_seq <= ?
        ORDER BY m.created_seq ASC LIMIT ?`,
      params: ['room_group_1', 3, 3, 8, 20],
    },
    {
      label: 'getMessageSenderSummary',
      pattern: /left join "actors" .*where "messages"\."message_id" = \?$/u,
      run: (target) => getMessageSenderSummary(target, 'msg_g1_8'),
      raw: `SELECT m.message_id, m.sender_id, m.created_seq, m.preview, m.body_bytes,
              m.created_at, a.name AS sender_name, a.kind AS sender_kind
         FROM messages m LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE m.message_id = ?`,
      params: ['msg_g1_8'],
    },
    {
      label: 'listDeliveryStates',
      pattern: /from "deliveries" where .*group by "deliveries"\."message_id", "deliveries"\."state"$/u,
      run: (target) => listDeliveryStates(target, ['msg_g1_8', 'msg_g1_9']),
      raw: `SELECT message_id, state, COUNT(*) AS n,
              MAX(CASE WHEN state = 'claimed' THEN claimed_at END) AS max_claimed_at,
              MAX(CASE WHEN state = 'claimed' THEN updated_at END) AS max_updated_at
         FROM deliveries WHERE message_id IN (?, ?) GROUP BY message_id, state`,
      params: ['msg_g1_8', 'msg_g1_9'],
    },
    {
      label: 'listMessageMentions',
      pattern: /from "message_mentions" where .*order by "message_mentions"\."message_id", "message_mentions"\."actor_id"$/u,
      run: (target) => listMessageMentions(target, ['msg_g1_8', 'msg_g1_9']),
      raw: `SELECT message_id, actor_id, actor_kind, source FROM message_mentions
        WHERE message_id IN (?, ?) ORDER BY message_id, actor_id`,
      params: ['msg_g1_8', 'msg_g1_9'],
    },
    {
      label: 'listInboxDeliveries active',
      pattern: /from "deliveries" inner join "messages".*order by "deliveries"\."created_seq" asc limit \?$/u,
      run: (target) =>
        listInboxDeliveries(target, {
          recipientId: 'act_agent_1',
          states: ['pending', 'claimed'],
          afterSeq: null,
          limit: 3,
        }),
      raw: `SELECT d.*, m.preview AS m_preview, m.body_bytes AS m_body_bytes,
              m.sender_id AS m_sender_id, m.created_at AS m_created_at,
              a.name AS m_sender_name, a.kind AS m_sender_kind
         FROM deliveries d
         JOIN messages m ON m.message_id = d.message_id
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE d.recipient_id = ? AND d.state IN (?, ?)
        ORDER BY d.created_seq ASC
        LIMIT ?`,
      params: ['act_agent_1', 'pending', 'claimed', 3],
    },
    {
      label: 'listInboxDeliveries cursor',
      pattern: /from "deliveries" inner join "messages".*order by "deliveries"\."created_seq" asc limit \?$/u,
      run: (target) =>
        listInboxDeliveries(target, {
          recipientId: 'act_agent_1',
          states: ['pending', 'claimed'],
          afterSeq: 1,
          limit: 3,
        }),
      raw: `SELECT d.*, m.preview AS m_preview, m.body_bytes AS m_body_bytes,
              m.sender_id AS m_sender_id, m.created_at AS m_created_at,
              a.name AS m_sender_name, a.kind AS m_sender_kind
         FROM deliveries d
         JOIN messages m ON m.message_id = d.message_id
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE d.recipient_id = ? AND d.state IN (?, ?) AND d.created_seq > ?
        ORDER BY d.created_seq ASC
        LIMIT ?`,
      params: ['act_agent_1', 'pending', 'claimed', 1, 3],
    },
  ];

  console.log('\nmessage/delivery query plans (EXPLAIN QUERY PLAN):');
  for (const item of cases) {
    const captured = capture(db);
    await item.run(captured.db);
    const query = captured.executed.find((entry) => item.pattern.test(entry.sql));
    check(`捕获 ${item.label} 的 SQL`, query !== undefined);
    if (!query) continue;
    const actual = normalizePlan(plan(sqlite, query.sql, query.params));
    const expected = normalizePlan(plan(sqlite, item.raw, item.params));
    checkEqual(`EXPLAIN ${item.label}`, JSON.stringify(actual), JSON.stringify(expected));
    console.log(`  ${item.label}: ${actual.join(' | ')}`);
  }
}

async function bench(label: string, fn: () => Promise<unknown>, iterations = 3_000): Promise<string> {
  for (let index = 0; index < 200; index += 1) await fn();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) await fn();
  const elapsed = performance.now() - started;
  return `${label}: ${elapsed.toFixed(1)}ms / ${iterations} (${(elapsed / iterations * 1000).toFixed(1)}µs/op)`;
}

async function benchmark(sqlite: Database, db: D1Database): Promise<void> {
  const rawActor = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', ['act_agent_1']);
  const ormActor = async (): Promise<unknown> => getActor(db, 'act_agent_1');
  const rawMember = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM room_members WHERE room_id = ? AND actor_id = ?', [
      'room_group_1',
      'act_agent_1',
    ]);
  const ormMember = async (): Promise<unknown> => getMember(db, 'room_group_1', 'act_agent_1');
  const rawCount = async (): Promise<unknown> =>
    rawFirst(sqlite, "SELECT COUNT(*) AS n FROM room_members WHERE actor_id = ? AND status = 'active'", [
      'act_human_1',
    ]);
  const ormCount = async (): Promise<unknown> => activeRoomCount(db, 'act_human_1');
  const rawIdentity = async (): Promise<unknown> => {
    const credential = rawFirst<{ actor_id: string }>(
      sqlite,
      'SELECT * FROM credentials WHERE token_hash = ?',
      ['hash_h1'],
    );
    if (!credential) return null;
    return rawFirst(sqlite, 'SELECT * FROM actors WHERE actor_id = ?', [credential.actor_id]);
  };
  const ormIdentity = async (): Promise<unknown> => {
    const credential = await getCredentialByHash(db, 'hash_h1');
    if (!credential) return null;
    return getActor(db, credential.actor_id);
  };
  const rawContact = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM contacts WHERE owner_actor_id = ? AND target_actor_id = ?', [
      'act_human_1',
      'act_agent_1',
    ]);
  const ormContact = async (): Promise<unknown> => getContact(db, 'act_human_1', 'act_agent_1');
  const rawRelation = async (): Promise<unknown> =>
    rawFirst(sqlite, "SELECT * FROM contact_relations WHERE pair_key = ? AND status = 'active'", [
      'act_agent_1|act_human_1',
    ]);
  const ormRelation = async (): Promise<unknown> =>
    getActiveContactRelation(db, 'act_agent_1|act_human_1');
  const rawBlock = async (): Promise<unknown> =>
    rawFirst(
      sqlite,
      `SELECT * FROM contact_blocks
        WHERE blocker_actor_id = ? AND blocked_actor_id = ? AND released_at IS NULL`,
      ['act_human_1', 'act_agent_3'],
    );
  const ormBlock = async (): Promise<unknown> =>
    getActiveContactBlock(db, 'act_human_1', 'act_agent_3');
  const rawManagement = async (): Promise<unknown> =>
    rawFirst(sqlite, "SELECT * FROM agent_managements WHERE agent_id = ? AND status = 'active'", [
      'act_agent_1',
    ]);
  const ormManagement = async (): Promise<unknown> =>
    getActiveAgentManagement(db, 'act_agent_1');
  const rawInvitation = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM room_invitations WHERE invitation_id = ?', ['inv_link_1']);
  const ormInvitation = async (): Promise<unknown> => getRoomInvitationById(db, 'inv_link_1');
  const rawMemberCount = async (): Promise<unknown> =>
    rawFirst(sqlite, "SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND status = 'active'", [
      'room_group_1',
    ]);
  const ormMemberCount = async (): Promise<unknown> =>
    countActiveRoomMembers(db, 'room_group_1');

  const rawMessage = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM messages WHERE message_id = ?', ['msg_g1_8']);
  const ormMessage = async (): Promise<unknown> => getMessage(db, 'msg_g1_8');
  const rawHistory = async (): Promise<unknown> =>
    rawAll(
      sqlite,
      `SELECT ${HISTORY_SELECT} FROM messages
        WHERE room_id = ? AND created_seq <= ? AND created_seq >= ?
        ORDER BY created_seq DESC LIMIT ?`,
      ['room_group_1', 9, 4, 21],
    );
  const ormHistory = async (): Promise<unknown> =>
    listHistoryMessagesBefore(db, {
      roomId: 'room_group_1',
      snapshot: 9,
      fromSeq: 4,
      beforeSeq: null,
      limit: 21,
    });
  const rawStates = async (): Promise<unknown> =>
    rawAll(
      sqlite,
      `SELECT message_id, state, COUNT(*) AS n,
              MAX(CASE WHEN state = 'claimed' THEN claimed_at END) AS max_claimed_at,
              MAX(CASE WHEN state = 'claimed' THEN updated_at END) AS max_updated_at
         FROM deliveries WHERE message_id IN (?, ?) GROUP BY message_id, state`,
      ['msg_g1_8', 'msg_g1_9'],
    );
  const ormStates = async (): Promise<unknown> =>
    listDeliveryStates(db, ['msg_g1_8', 'msg_g1_9']);
  const rawInboxBench = async (): Promise<unknown> =>
    rawAll(
      sqlite,
      `SELECT d.*, m.preview AS m_preview, m.body_bytes AS m_body_bytes,
              m.sender_id AS m_sender_id, m.created_at AS m_created_at,
              a.name AS m_sender_name, a.kind AS m_sender_kind
         FROM deliveries d
         JOIN messages m ON m.message_id = d.message_id
         LEFT JOIN actors a ON a.actor_id = m.sender_id
        WHERE d.recipient_id = ? AND d.state IN (?, ?)
        ORDER BY d.created_seq ASC LIMIT ?`,
      ['act_agent_1', 'pending', 'claimed', 21],
    );
  const ormInboxBench = async (): Promise<unknown> =>
    listInboxDeliveries(db, {
      recipientId: 'act_agent_1',
      states: ['pending', 'claimed'],
      afterSeq: null,
      limit: 21,
    });
  const rawMentionsBench = async (): Promise<unknown> =>
    rawAll(
      sqlite,
      `SELECT message_id, actor_id, actor_kind, source FROM message_mentions
        WHERE message_id IN (?, ?) ORDER BY message_id, actor_id`,
      ['msg_g1_8', 'msg_g1_9'],
    );
  const ormMentionsBench = async (): Promise<unknown> =>
    listMessageMentions(db, ['msg_g1_8', 'msg_g1_9']);
  const rawRoomFile = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM room_files WHERE file_id = ?', ['rf_file_live']);
  const ormRoomFile = async (): Promise<unknown> => getRoomFile(db, 'rf_file_live');
  const rawSubscription = async (): Promise<unknown> =>
    rawFirst(sqlite, 'SELECT * FROM mcp_event_subscriptions WHERE subscription_id = ?', [
      'sub_a',
    ]);
  const ormSubscription = async (): Promise<unknown> => getEventSubscription(db, 'sub_a');
  const rawPendingCount = async (): Promise<unknown> =>
    rawFirst(
      sqlite,
      `SELECT COUNT(*) AS n FROM mcp_event_deliveries
        WHERE subscription_id = ? AND status IN ('pending', 'processing')`,
      ['sub_a'],
    );
  const ormPendingCount = async (): Promise<unknown> =>
    countPendingEventDeliveries(db, 'sub_a');

  console.log('\nread query benchmark (in-memory, includes drizzle build):');
  console.log(`  raw   ${await bench('actor', rawActor)}`);
  console.log(`  orm   ${await bench('actor', ormActor)}`);
  console.log(`  raw   ${await bench('member', rawMember)}`);
  console.log(`  orm   ${await bench('member', ormMember)}`);
  console.log(`  raw   ${await bench('count', rawCount)}`);
  console.log(`  orm   ${await bench('count', ormCount)}`);
  console.log(`  raw   ${await bench('identity', rawIdentity)}`);
  console.log(`  orm   ${await bench('identity', ormIdentity)}`);
  console.log(`  raw   ${await bench('contact', rawContact)}`);
  console.log(`  orm   ${await bench('contact', ormContact)}`);
  console.log(`  raw   ${await bench('relation', rawRelation)}`);
  console.log(`  orm   ${await bench('relation', ormRelation)}`);
  console.log(`  raw   ${await bench('block', rawBlock)}`);
  console.log(`  orm   ${await bench('block', ormBlock)}`);
  console.log(`  raw   ${await bench('management', rawManagement)}`);
  console.log(`  orm   ${await bench('management', ormManagement)}`);
  console.log(`  raw   ${await bench('invitation', rawInvitation)}`);
  console.log(`  orm   ${await bench('invitation', ormInvitation)}`);
  console.log(`  raw   ${await bench('room_member_count', rawMemberCount)}`);
  console.log(`  orm   ${await bench('room_member_count', ormMemberCount)}`);
  console.log(`  raw   ${await bench('message', rawMessage, 2_000)}`);
  console.log(`  orm   ${await bench('message', ormMessage, 2_000)}`);
  console.log(`  raw   ${await bench('history', rawHistory, 2_000)}`);
  console.log(`  orm   ${await bench('history', ormHistory, 2_000)}`);
  console.log(`  raw   ${await bench('states', rawStates, 2_000)}`);
  console.log(`  orm   ${await bench('states', ormStates, 2_000)}`);
  console.log(`  raw   ${await bench('inbox', rawInboxBench, 2_000)}`);
  console.log(`  orm   ${await bench('inbox', ormInboxBench, 2_000)}`);
  console.log(`  raw   ${await bench('mentions', rawMentionsBench, 2_000)}`);
  console.log(`  orm   ${await bench('mentions', ormMentionsBench, 2_000)}`);
  console.log(`  raw   ${await bench('room-file', rawRoomFile)}`);
  console.log(`  orm   ${await bench('room-file', ormRoomFile)}`);
  console.log(`  raw   ${await bench('subscription', rawSubscription)}`);
  console.log(`  orm   ${await bench('subscription', ormSubscription)}`);
  console.log(`  raw   ${await bench('pending-count', rawPendingCount)}`);
  console.log(`  orm   ${await bench('pending-count', ormPendingCount)}`);
}

async function main(): Promise<void> {
  const sqlite = new Database(':memory:');
  migrate(sqlite, MIGRATIONS);
  seed(sqlite);
  const db = createD1(sqlite);
  try {
    await rowParityChecks(sqlite, db);
    explainChecks(sqlite, db);
    await messageExplainChecks(sqlite, db);
    await benchmark(sqlite, db);
    console.log(`\ndrizzle runtime checks passed: ${checksPassed()}`);
  } finally {
    sqlite.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
