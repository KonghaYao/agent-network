import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import { actors, rooms } from './core';

/**
 * 4C-3 rooms 域 Drizzle schema。
 *
 * 只覆盖 rooms 只读查询实际读取的表：邀请、入群申请、群主转让与管理审计。
 * 迁移 SQL 仍是唯一事实源；列顺序、默认值、CHECK、索引与 FK 必须与
 * `migrations/0023`、`0024`、`0027`、`0037` 完全一致，由
 * `test:schema-parity` 逐表校验。guard、FTS、trigger 与写路径不进入这里。
 */

export const roomInvitations = sqliteTable(
  'room_invitations',
  {
    invitation_id: text('invitation_id'),
    room_id: text('room_id')
      .notNull()
      .references(() => rooms.room_id),
    inviter_id: text('inviter_id')
      .notNull()
      .references(() => actors.actor_id),
    target_actor_id: text('target_actor_id').references(() => actors.actor_id),
    token_hash: text('token_hash').unique(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    max_uses: integer('max_uses').notNull().default(1),
    used_count: integer('used_count').notNull().default(0),
    expires_at: integer('expires_at').notNull(),
    revision: integer('revision').notNull().default(1),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.invitation_id] }),
    uniqueIndex('idx_room_invitations_pending_direct')
      .on(table.room_id, table.target_actor_id)
      .where(sql`${table.status} = 'pending' and ${table.kind} = 'direct'`),
    index('idx_room_invitations_target').on(
      table.target_actor_id,
      table.status,
      table.expires_at,
    ),
    index('idx_room_invitations_room').on(table.room_id, table.status, table.expires_at),
    index('idx_room_invitations_token')
      .on(table.token_hash)
      .where(sql`${table.token_hash} is not null`),
    check(
      'room_invitations_kind_check',
      sql`${table.kind} in ('direct', 'link')`,
    ),
    check(
      'room_invitations_status_check',
      sql`${table.status} in ('pending', 'accepted', 'rejected', 'revoked', 'expired', 'exhausted')`,
    ),
    check('room_invitations_max_uses_check', sql`${table.max_uses} > 0`),
    check(
      'room_invitations_used_count_check',
      sql`${table.used_count} >= 0 and ${table.used_count} <= ${table.max_uses}`,
    ),
    check(
      'room_invitations_kind_target_check',
      sql`(${table.kind} = 'direct' and ${table.target_actor_id} is not null) or (${table.kind} = 'link' and ${table.target_actor_id} is null)`,
    ),
  ],
);

export const roomJoinRequests = sqliteTable(
  'room_join_requests',
  {
    join_request_id: text('join_request_id'),
    invitation_id: text('invitation_id')
      .notNull()
      .references(() => roomInvitations.invitation_id),
    room_id: text('room_id')
      .notNull()
      .references(() => rooms.room_id),
    applicant_id: text('applicant_id')
      .notNull()
      .references(() => actors.actor_id),
    status: text('status').notNull(),
    message: text('message').notNull().default(''),
    revision: integer('revision').notNull().default(1),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    decided_at: integer('decided_at'),
    decided_by: text('decided_by').references(() => actors.actor_id),
  },
  (table) => [
    primaryKey({ columns: [table.join_request_id] }),
    uniqueIndex('idx_room_join_requests_pending')
      .on(table.invitation_id, table.applicant_id)
      .where(sql`${table.status} = 'pending'`),
    index('idx_room_join_requests_room').on(
      table.room_id,
      table.status,
      sql`${table.created_at} desc`,
      sql`${table.join_request_id} desc`,
    ),
    index('idx_room_join_requests_applicant').on(
      table.applicant_id,
      table.status,
      sql`${table.created_at} desc`,
    ),
    check(
      'room_join_requests_status_check',
      sql`${table.status} in ('pending', 'approved', 'rejected', 'cancelled', 'expired')`,
    ),
    check('room_join_requests_revision_check', sql`${table.revision} >= 1`),
  ],
);

export const roomOwnerTransfers = sqliteTable(
  'room_owner_transfers',
  {
    transfer_id: text('transfer_id'),
    room_id: text('room_id')
      .notNull()
      .references(() => rooms.room_id),
    from_owner_id: text('from_owner_id')
      .notNull()
      .references(() => actors.actor_id),
    to_actor_id: text('to_actor_id')
      .notNull()
      .references(() => actors.actor_id),
    status: text('status').notNull(),
    version: integer('version').notNull().default(1),
    target_role_revision: integer('target_role_revision').notNull(),
    invalid_reason: text('invalid_reason'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    expires_at: integer('expires_at').notNull(),
    responded_at: integer('responded_at'),
    responded_by: text('responded_by').references(() => actors.actor_id),
  },
  (table) => [
    primaryKey({ columns: [table.transfer_id] }),
    uniqueIndex('idx_room_owner_transfers_pending')
      .on(table.room_id)
      .where(sql`${table.status} = 'pending'`),
    index('idx_room_owner_transfers_target').on(
      table.to_actor_id,
      table.status,
      table.expires_at,
    ),
    index('idx_room_owner_transfers_room').on(
      table.room_id,
      sql`${table.created_at} desc`,
      sql`${table.transfer_id} desc`,
    ),
    check(
      'room_owner_transfers_status_check',
      sql`${table.status} in ('pending', 'accepted', 'rejected', 'cancelled', 'expired')`,
    ),
    check('room_owner_transfers_version_check', sql`${table.version} >= 1`),
    check(
      'room_owner_transfers_target_role_revision_check',
      sql`${table.target_role_revision} >= 1`,
    ),
    check(
      'room_owner_transfers_distinct_owner_check',
      sql`${table.from_owner_id} <> ${table.to_actor_id}`,
    ),
  ],
);

export const roomManagementAudit = sqliteTable(
  'room_management_audit',
  {
    audit_id: text('audit_id'),
    room_id: text('room_id')
      .notNull()
      .references(() => rooms.room_id),
    action: text('action').notNull(),
    target_actor_id: text('target_actor_id').references(() => actors.actor_id),
    previous_role: text('previous_role'),
    new_role: text('new_role'),
    previous_status: text('previous_status'),
    new_status: text('new_status'),
    expected_revision: integer('expected_revision'),
    resulting_revision: integer('resulting_revision').notNull(),
    changed_by: text('changed_by')
      .notNull()
      .references(() => actors.actor_id),
    request_id: text('request_id').notNull(),
    detail_json: text('detail_json').notNull().default('{}'),
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.audit_id] }),
    index('idx_room_management_audit_room').on(
      table.room_id,
      sql`${table.created_at} desc`,
      sql`${table.audit_id} desc`,
    ),
    index('idx_room_management_audit_actor').on(
      table.target_actor_id,
      sql`${table.created_at} desc`,
    ),
    check(
      'room_management_audit_action_check',
      sql`${table.action} in ('member_added', 'member_removed', 'member_left', 'admin_appointed', 'admin_revoked', 'owner_transferred', 'owner_transfer_proposed', 'owner_transfer_accepted', 'owner_transfer_rejected', 'owner_transfer_cancelled', 'owner_transfer_expired', 'policy_updated', 'announcement_updated', 'invite_created', 'invite_revoked', 'join_requested', 'join_approved', 'join_rejected', 'room_dissolved')`,
    ),
    check(
      'room_management_audit_previous_role_check',
      sql`${table.previous_role} is null or ${table.previous_role} in ('owner', 'admin', 'member')`,
    ),
    check(
      'room_management_audit_new_role_check',
      sql`${table.new_role} is null or ${table.new_role} in ('owner', 'admin', 'member')`,
    ),
    check(
      'room_management_audit_previous_status_check',
      sql`${table.previous_status} is null or ${table.previous_status} in ('active', 'left', 'removed')`,
    ),
    check(
      'room_management_audit_new_status_check',
      sql`${table.new_status} is null or ${table.new_status} in ('active', 'left', 'removed')`,
    ),
  ],
);

/** 4C-3 覆盖的表；未列出的房间表仍由迁移 SQL 定义。 */
