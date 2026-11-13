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

import { actors } from './core';

/**
 * 4C-2 身份/联系人只读 schema。
 *
 * 只声明已在迁移中收口的最终结构；写入仍由 `db.batch()` / `runIdempotent`
 * 使用手写 SQL。`contact_relations.source` 包含 0040 重建后的 `invite_link`，
 * 不能按 0019 的旧 CHECK 声明。
 */

export const contacts = sqliteTable(
  'contacts',
  {
    owner_actor_id: text('owner_actor_id').notNull(),
    target_actor_id: text('target_actor_id').notNull(),
    created_at: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.owner_actor_id, table.target_actor_id] }),
    index('idx_contacts_owner_created').on(
      table.owner_actor_id,
      sql`${table.created_at} desc`,
      table.target_actor_id,
    ),
  ],
);

export const contactRelations = sqliteTable(
  'contact_relations',
  {
    pair_key: text('pair_key'),
    actor_a: text('actor_a')
      .notNull()
      .references(() => actors.actor_id),
    actor_b: text('actor_b')
      .notNull()
      .references(() => actors.actor_id),
    status: text('status').notNull(),
    source: text('source').notNull(),
    request_id: text('request_id'),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    ended_at: integer('ended_at'),
    ended_by: text('ended_by'),
  },
  (table) => [
    primaryKey({ columns: [table.pair_key] }),
    index('idx_contact_relations_actor_a').on(
      table.actor_a,
      table.status,
      sql`${table.updated_at} desc`,
    ),
    index('idx_contact_relations_actor_b').on(
      table.actor_b,
      table.status,
      sql`${table.updated_at} desc`,
    ),
    check('contact_relations_status_check', sql`${table.status} in ('active', 'ended')`),
    check(
      'contact_relations_source_check',
      sql`${table.source} in ('request', 'auto_manager', 'invite_link')`,
    ),
    check('contact_relations_pair_order_check', sql`${table.actor_a} < ${table.actor_b}`),
  ],
);

export const contactRequests = sqliteTable(
  'contact_requests',
  {
    contact_request_id: text('contact_request_id'),
    pair_key: text('pair_key').notNull(),
    from_actor_id: text('from_actor_id')
      .notNull()
      .references(() => actors.actor_id),
    to_actor_id: text('to_actor_id')
      .notNull()
      .references(() => actors.actor_id),
    message: text('message').notNull().default(''),
    status: text('status').notNull(),
    auto_accepted: integer('auto_accepted').notNull().default(0),
    created_at: integer('created_at').notNull(),
    updated_at: integer('updated_at').notNull(),
    expires_at: integer('expires_at').notNull(),
    responded_at: integer('responded_at'),
    responded_by: text('responded_by'),
  },
  (table) => [
    primaryKey({ columns: [table.contact_request_id] }),
    uniqueIndex('idx_contact_requests_pending_pair')
      .on(table.pair_key)
      .where(sql`${table.status} = 'pending'`),
    index('idx_contact_requests_target').on(
      table.to_actor_id,
      table.status,
      sql`${table.created_at} desc`,
    ),
    index('idx_contact_requests_source').on(
      table.from_actor_id,
      table.status,
      sql`${table.created_at} desc`,
    ),
    index('idx_contact_requests_expiry').on(table.status, table.expires_at),
    index('idx_contact_requests_actor_created').on(
      table.from_actor_id,
      sql`${table.created_at} desc`,
    ),
    index('idx_contact_requests_pair_created').on(
      table.pair_key,
      sql`${table.created_at} desc`,
    ),
    check(
      'contact_requests_status_check',
      sql`${table.status} in ('pending', 'accepted', 'rejected', 'cancelled', 'expired')`,
    ),
    check('contact_requests_auto_accepted_check', sql`${table.auto_accepted} in (0, 1)`),
    check(
      'contact_requests_distinct_actors_check',
      sql`${table.from_actor_id} <> ${table.to_actor_id}`,
    ),
  ],
);

export const contactBlocks = sqliteTable(
  'contact_blocks',
  {
    block_id: text('block_id'),
    blocker_actor_id: text('blocker_actor_id')
      .notNull()
      .references(() => actors.actor_id),
    blocked_actor_id: text('blocked_actor_id')
      .notNull()
      .references(() => actors.actor_id),
    reason: text('reason').notNull().default(''),
    mute_mentions: integer('mute_mentions').notNull().default(1),
    created_at: integer('created_at').notNull(),
    released_at: integer('released_at'),
    released_by: text('released_by').references(() => actors.actor_id),
  },
  (table) => [
    primaryKey({ columns: [table.block_id] }),
    uniqueIndex('idx_contact_blocks_active')
      .on(table.blocker_actor_id, table.blocked_actor_id)
      .where(sql`${table.released_at} is null`),
    index('idx_contact_blocks_blocker').on(
      table.blocker_actor_id,
      table.released_at,
      sql`${table.created_at} desc`,
    ),
    index('idx_contact_blocks_blocked').on(
      table.blocked_actor_id,
      table.released_at,
      sql`${table.created_at} desc`,
    ),
    check('contact_blocks_mute_mentions_check', sql`${table.mute_mentions} in (0, 1)`),
    check(
      'contact_blocks_distinct_actors_check',
      sql`${table.blocker_actor_id} <> ${table.blocked_actor_id}`,
    ),
  ],
);

export const agentManagements = sqliteTable(
  'agent_managements',
  {
    binding_id: text('binding_id'),
    agent_id: text('agent_id')
      .notNull()
      .references(() => actors.actor_id),
    manager_id: text('manager_id')
      .notNull()
      .references(() => actors.actor_id),
    status: text('status').notNull(),
    grant_source: text('grant_source').notNull(),
    scopes_json: text('scopes_json').notNull().default('[]'),
    permission_version: integer('permission_version').notNull().default(1),
    initiated_by: text('initiated_by').notNull(),
    confirmed_by: text('confirmed_by'),
    created_at: integer('created_at').notNull(),
    confirmed_at: integer('confirmed_at'),
    expires_at: integer('expires_at'),
    revoked_at: integer('revoked_at'),
    revoked_by: text('revoked_by'),
    updated_at: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.binding_id] }),
    uniqueIndex('idx_agent_managements_active')
      .on(table.agent_id)
      .where(sql`${table.status} = 'active'`),
    index('idx_agent_managements_manager').on(
      table.manager_id,
      table.status,
      sql`${table.updated_at} desc`,
    ),
    index('idx_agent_managements_agent').on(table.agent_id, table.status),
    check(
      'agent_managements_status_check',
      sql`${table.status} in ('active', 'revoked', 'expired')`,
    ),
    check(
      'agent_managements_grant_source_check',
      sql`${table.grant_source} in ('created', 'claim', 'transfer', 'legacy')`,
    ),
    check('agent_managements_permission_version_check', sql`${table.permission_version} >= 1`),
  ],
);

/** 4C-2 覆盖的表；未列出的联系人表仍由迁移 SQL 定义。 */
export const CONTACT_TABLES = [
  contacts,
  contactRelations,
  contactRequests,
  contactBlocks,
  agentManagements,
] as const;
