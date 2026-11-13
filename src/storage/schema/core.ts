import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

/**
 * 4C-0 的 Drizzle core schema 骨架。
 *
 * 只覆盖最稳定的 8 张核心表；迁移 SQL 仍是唯一事实源。guard、FTS5、trigger、
 * 复杂权限 SQL 与其余业务表继续保留 raw，等 4C-1 起按域补齐。
 *
 * 为与迁移保持 PRAGMA 一致：
 * - 主键统一用表级 `primaryKey()`，避免 Drizzle 给单列主键额外加 `NOT NULL`；
 * - 枚举/范围约束用命名 `check()`，名称只用于 Drizzle 生成，不参与运行时语义。
 */
export const actors = sqliteTable(
  'actors',
  {
    actor_id: text('actor_id'),
    kind: text('kind').notNull(),
    agent_session_id: text('agent_session_id').unique(),
    name: text('name').notNull(),
    metadata: text('metadata').notNull().default('{}'),
    inbox_head_seq: integer('inbox_head_seq').notNull().default(0),
    inbox_min_seq: integer('inbox_min_seq').notNull().default(0),
    pending_count: integer('pending_count').notNull().default(0),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    archived_at: integer('archived_at'),
    archived_by: text('archived_by'),
    disabled_at: integer('disabled_at'),
    disabled_by: text('disabled_by'),
    disabled_reason: text('disabled_reason'),
  },
  (table) => [
    primaryKey({ columns: [table.actor_id] }),
    check('actors_kind_check', sql`${table.kind} in ('human', 'agent')`),
    check('actors_pending_count_check', sql`${table.pending_count} >= 0`),
  ],
);

export const credentials = sqliteTable(
  'credentials',
  {
    credential_id: text('credential_id'),
    actor_id: text('actor_id')
      .notNull()
      .references(() => actors.actor_id),
    device_id: text('device_id').notNull(),
    token_hash: text('token_hash').notNull().unique(),
    revoked_at: integer('revoked_at'),
    created_at: integer('created_at').notNull(),
    last_used_at: integer('last_used_at'),
    revoked_by: text('revoked_by'),
    label: text('label'),
  },
  (table) => [
    primaryKey({ columns: [table.credential_id] }),
    index('idx_credentials_actor').on(table.actor_id),
    index('idx_credentials_device').on(table.actor_id, table.device_id, table.revoked_at),
  ],
);

export const rooms = sqliteTable(
  'rooms',
  {
    room_id: text('room_id'),
    kind: text('kind').notNull(),
    owner_id: text('owner_id'),
    title: text('title').notNull().default(''),
    direct_pair_key: text('direct_pair_key').unique(),
    head_seq: integer('head_seq').notNull().default(0),
    events_min_seq: integer('events_min_seq').notNull().default(0),
    member_seq: integer('member_seq').notNull().default(0),
    last_message_id: text('last_message_id'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    policy_revision: integer('policy_revision').notNull().default(1),
    member_message_policy: text('member_message_policy').notNull().default('members'),
    member_invite_policy: text('member_invite_policy').notNull().default('owner_admin'),
    announcement: text('announcement').notNull().default(''),
    announcement_revision: integer('announcement_revision').notNull().default(1),
    announcement_updated_at: integer('announcement_updated_at'),
    announcement_updated_by: text('announcement_updated_by'),
    member_history_policy: text('member_history_policy').notNull().default('from_join'),
    member_join_policy: text('member_join_policy').notNull().default('open'),
    member_profile_policy: text('member_profile_policy').notNull().default('owner_admin'),
    member_mention_all_policy: text('member_mention_all_policy')
      .notNull()
      .default('owner_admin'),
    dissolved_at: integer('dissolved_at'),
    dissolved_by: text('dissolved_by').references(() => actors.actor_id),
    dissolve_reason: text('dissolve_reason'),
    archive_head_seq: integer('archive_head_seq'),
    archive_member_seq: integer('archive_member_seq'),
  },
  (table) => [
    primaryKey({ columns: [table.room_id] }),
    index('idx_rooms_updated').on(sql`${table.updated_at} desc`, table.room_id),
    check('rooms_kind_check', sql`${table.kind} in ('direct', 'group')`),
    check(
      'rooms_member_message_policy_check',
      sql`${table.member_message_policy} in ('members', 'owner_admin')`,
    ),
    check(
      'rooms_member_invite_policy_check',
      sql`${table.member_invite_policy} in ('members', 'owner_admin')`,
    ),
    check(
      'rooms_member_history_policy_check',
      sql`${table.member_history_policy} in ('from_join', 'full')`,
    ),
    check(
      'rooms_member_join_policy_check',
      sql`${table.member_join_policy} in ('open', 'approval')`,
    ),
    check(
      'rooms_member_profile_policy_check',
      sql`${table.member_profile_policy} in ('members', 'owner_admin')`,
    ),
    check(
      'rooms_member_mention_all_policy_check',
      sql`${table.member_mention_all_policy} in ('members', 'owner_admin')`,
    ),
  ],
);

export const roomMembers = sqliteTable(
  'room_members',
  {
    room_id: text('room_id').notNull(),
    actor_id: text('actor_id').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull(),
    joined_seq: integer('joined_seq').notNull().default(0),
    last_read_seq: integer('last_read_seq').notNull().default(0),
    joined_at: integer('joined_at').notNull(),
    role_revision: integer('role_revision').notNull().default(1),
    updated_at: integer('updated_at').notNull().default(0),
    member_generation: integer('member_generation').notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.room_id, table.actor_id] }),
    index('idx_room_members_actor').on(table.actor_id, table.status, table.room_id),
    index('idx_room_members_room_role').on(table.room_id, table.role, table.status),
    uniqueIndex('idx_room_members_one_owner')
      .on(table.room_id)
      .where(sql`${table.role} = 'owner' and ${table.status} = 'active'`),
    check('room_members_role_check', sql`${table.role} in ('owner', 'admin', 'member')`),
    check('room_members_status_check', sql`${table.status} in ('active', 'left', 'removed')`),
  ],
);

export const messages = sqliteTable(
  'messages',
  {
    message_id: text('message_id'),
    room_id: text('room_id').notNull(),
    sender_id: text('sender_id').notNull(),
    client_message_id: text('client_message_id').notNull(),
    created_seq: integer('created_seq').notNull(),
    body: text('body').notNull(),
    body_bytes: integer('body_bytes').notNull(),
    preview: text('preview').notNull(),
    reply_to: text('reply_to'),
    root_id: text('root_id'),
    hop: integer('hop').notNull().default(0),
    root_invocations_used: integer('root_invocations_used').notNull().default(0),
    created_at: integer('created_at').notNull(),
    task_root_id: text('task_root_id'),
    task_marked_by: text('task_marked_by'),
    task_marked_at: integer('task_marked_at'),
  },
  (table) => [
    primaryKey({ columns: [table.message_id] }),
    index('idx_messages_room_seq').on(table.room_id, sql`${table.created_seq} desc`),
    index('idx_messages_root').on(table.root_id, table.created_seq),
    index('idx_messages_room_reply_to')
      .on(table.room_id, table.reply_to, table.created_seq)
      .where(sql`${table.reply_to} is not null`),
    index('idx_messages_task_root')
      .on(table.room_id, table.task_root_id, table.created_seq)
      .where(sql`${table.task_root_id} is not null`),
    unique('messages_sender_client_unique').on(table.sender_id, table.client_message_id),
  ],
);

export const deliveries = sqliteTable(
  'deliveries',
  {
    delivery_id: text('delivery_id'),
    recipient_id: text('recipient_id').notNull(),
    message_id: text('message_id').notNull(),
    room_id: text('room_id').notNull(),
    state: text('state').notNull(),
    attempt: integer('attempt').notNull().default(0),
    claim_id: text('claim_id'),
    claimed_at: integer('claimed_at'),
    progress_at: integer('progress_at'),
    result_message_id: text('result_message_id'),
    error: text('error'),
    created_seq: integer('created_seq').notNull(),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    last_reminded_at: integer('last_reminded_at'),
  },
  (table) => [
    primaryKey({ columns: [table.delivery_id] }),
    index('idx_deliveries_recipient_state').on(
      table.recipient_id,
      table.state,
      table.created_seq,
    ),
    index('idx_deliveries_message').on(table.message_id),
    index('idx_deliveries_message_state').on(
      table.message_id,
      table.state,
      table.claimed_at,
      table.updated_at,
    ),
    uniqueIndex('idx_deliveries_one_claimed')
      .on(table.recipient_id)
      .where(sql`${table.state} = 'claimed'`),
    index('idx_deliveries_claimed_progress')
      .on(table.progress_at, table.last_reminded_at)
      .where(sql`${table.state} = 'claimed'`),
    unique('deliveries_recipient_message_unique').on(table.recipient_id, table.message_id),
    check(
      'deliveries_state_check',
      sql`${table.state} in ('pending', 'claimed', 'completed', 'failed', 'cancelled')`,
    ),
  ],
);

export const operations = sqliteTable(
  'operations',
  {
    actor_id: text('actor_id').notNull(),
    request_id: text('request_id').notNull(),
    payload_hash: text('payload_hash').notNull(),
    write_nonce: text('write_nonce').notNull(),
    result_json: text('result_json').notNull(),
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.actor_id, table.request_id] }),
    index('idx_operations_created').on(table.created_at),
  ],
);

export const outbox = sqliteTable(
  'outbox',
  {
    outbox_id: text('outbox_id'),
    topic: text('topic').notNull(),
    event_seq: integer('event_seq').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    next_attempt_at: integer('next_attempt_at').notNull(),
    lease_token: text('lease_token'),
    lease_until: integer('lease_until'),
    completed_at: integer('completed_at'),
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.outbox_id] }),
    index('idx_outbox_due').on(table.status, table.next_attempt_at),
    unique('outbox_topic_event_unique').on(table.topic, table.event_seq),
    check(
      'outbox_status_check',
      sql`${table.status} in ('pending', 'processing', 'completed')`,
    ),
  ],
);

/** 4C-0 覆盖的表；未列出的表仍由迁移 SQL 定义。 */
export const CORE_TABLES = [
  actors,
  credentials,
  rooms,
  roomMembers,
  messages,
  deliveries,
  operations,
  outbox,
] as const;
