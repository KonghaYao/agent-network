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

import { actors, credentials } from './core';

/**
 * 4C-5 files / events 域的只读 schema。
 *
 * 迁移 SQL 仍是唯一事实源：这里只声明被生产只读查询实际使用的表，供 Drizzle
 * 构建 `SELECT`。写路径、guard、触发器、配额与清理语句继续保留 raw。
 *
 * 列顺序必须与迁移后的实际列顺序一致（`0025` 先加 `created_seq`，`0026` 再
 * 加 `retained`），否则 `SELECT *` 的字段顺序会与 raw 查询不同。
 */
export const driveFiles = sqliteTable(
  'drive_files',
  {
    file_id: text('file_id'),
    owner_scope: text('owner_scope').notNull(),
    uploader_id: text('uploader_id'),
    name: text('name').notNull(),
    mime_type: text('mime_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    state: text('state').notNull(),
    visibility: text('visibility').notNull().default('private'),
    room_id: text('room_id'),
    created_at: integer('created_at').notNull(),
    expires_at: integer('expires_at'),
    retained: integer('retained').notNull().default(0),
    deleted_at: integer('deleted_at'),
    deleted_by: text('deleted_by'),
    purged_at: integer('purged_at'),
  },
  (table) => [
    primaryKey({ columns: [table.file_id] }),
    index('idx_drive_files_owner').on(
      table.owner_scope,
      table.state,
      sql`${table.created_at} desc`,
      sql`${table.file_id} desc`,
    ),
    index('idx_drive_files_expiry')
      .on(table.expires_at)
      .where(sql`${table.state} in ('draft', 'bound')`),
    index('idx_drive_files_room').on(
      table.room_id,
      table.state,
      sql`${table.created_at} desc`,
    ),
    check('drive_files_size_check', sql`${table.size} >= 0`),
    check('drive_files_sha256_check', sql`length(${table.sha256}) = 64`),
    check('drive_files_state_check', sql`${table.state} in ('draft', 'bound', 'deleted')`),
    check('drive_files_visibility_check', sql`${table.visibility} in ('private', 'public')`),
    check('drive_files_retained_check', sql`${table.retained} in (0, 1)`),
  ],
);

export const roomFiles = sqliteTable(
  'room_files',
  {
    room_file_id: text('room_file_id'),
    room_id: text('room_id').notNull(),
    file_id: text('file_id').notNull(),
    uploader_id: text('uploader_id').notNull(),
    name: text('name').notNull(),
    mime_type: text('mime_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    created_at: integer('created_at').notNull(),
    expires_at: integer('expires_at').notNull(),
    deleted_at: integer('deleted_at'),
    deleted_by: text('deleted_by'),
    created_seq: integer('created_seq'),
    retained: integer('retained').notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.room_file_id] }),
    uniqueIndex('idx_room_files_file').on(table.file_id),
    index('idx_room_files_room_created').on(
      table.room_id,
      sql`${table.created_at} desc`,
      sql`${table.room_file_id} desc`,
    ),
    index('idx_room_files_uploader').on(table.uploader_id, sql`${table.created_at} desc`),
    index('idx_room_files_expiry').on(table.expires_at),
    index('idx_room_files_room_seq').on(table.room_id, table.created_seq, table.file_id),
    check('room_files_size_check', sql`${table.size} >= 0`),
    check('room_files_sha256_check', sql`length(${table.sha256}) = 64`),
    check('room_files_expiry_check', sql`${table.expires_at} > ${table.created_at}`),
    check('room_files_retained_check', sql`${table.retained} in (0, 1)`),
  ],
);

export const mcpEventSubscriptions = sqliteTable(
  'mcp_event_subscriptions',
  {
    subscription_id: text('subscription_id'),
    actor_id: text('actor_id')
      .notNull()
      .references(() => actors.actor_id),
    event_name: text('event_name').notNull(),
    arguments_json: text('arguments_json').notNull(),
    callback_url: text('callback_url').notNull(),
    callback_url_key: text('callback_url_key').notNull(),
    credential_id: text('credential_id')
      .notNull()
      .references(() => credentials.credential_id),
    secret_ciphertext: text('secret_ciphertext').notNull(),
    secret_nonce: text('secret_nonce').notNull(),
    previous_secret_ciphertext: text('previous_secret_ciphertext'),
    previous_secret_nonce: text('previous_secret_nonce'),
    previous_secret_expires_at: integer('previous_secret_expires_at'),
    refresh_before: integer('refresh_before').notNull(),
    scanned_seq: integer('scanned_seq').notNull().default(0),
    last_scan_at: integer('last_scan_at').notNull().default(0),
    last_delivery_at: integer('last_delivery_at'),
    last_error: text('last_error'),
    consecutive_failures: integer('consecutive_failures').notNull().default(0),
    active: integer('active').notNull().default(1),
    verified_at: integer('verified_at').notNull(),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.subscription_id] }),
    unique('mcp_event_subs_identity_unique').on(
      table.actor_id,
      table.callback_url_key,
      table.event_name,
      table.arguments_json,
    ),
    index('idx_mcp_event_subs_scan').on(
      table.active,
      table.refresh_before,
      table.last_scan_at,
      table.subscription_id,
    ),
    index('idx_mcp_event_subs_actor').on(table.actor_id, table.active),
    check('mcp_event_subs_active_check', sql`${table.active} in (0, 1)`),
  ],
);

export const mcpEventDeliveries = sqliteTable(
  'mcp_event_deliveries',
  {
    delivery_id: text('delivery_id'),
    subscription_id: text('subscription_id')
      .notNull()
      .references(() => mcpEventSubscriptions.subscription_id, { onDelete: 'cascade' }),
    event_seq: integer('event_seq').notNull(),
    event_id: text('event_id').notNull(),
    payload_json: text('payload_json').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    next_attempt_at: integer('next_attempt_at').notNull(),
    lease_token: text('lease_token'),
    lease_until: integer('lease_until'),
    last_http_status: integer('last_http_status'),
    last_error: text('last_error'),
    created_at: integer('created_at').notNull(),
    delivered_at: integer('delivered_at'),
  },
  (table) => [
    primaryKey({ columns: [table.delivery_id] }),
    unique('mcp_event_deliveries_seq_unique').on(table.subscription_id, table.event_seq),
    index('idx_mcp_event_deliveries_due').on(table.status, table.next_attempt_at),
    index('idx_mcp_event_deliveries_sub').on(table.subscription_id, table.event_seq),
    index('idx_mcp_event_deliveries_cleanup').on(table.status, table.created_at),
    check(
      'mcp_event_deliveries_status_check',
      sql`${table.status} in ('pending', 'processing', 'delivered', 'abandoned')`,
    ),
  ],
);
