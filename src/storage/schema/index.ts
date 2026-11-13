/**
 * Drizzle schema 汇总入口。
 *
 * 迁移 SQL 仍是唯一事实源；生产运行时只允许 `src/storage/drizzle.ts` 直接
 * import 本目录，其余代码通过 `storage/queries` 调用语义化函数。
 * `drizzle-kit` 只用于 parity 生成 DDL，禁止对真实库执行 push/migrate。
 */
import {
  actors,
  credentials,
  deliveries,
  messages,
  operations,
  outbox,
  roomMembers,
  rooms,
} from './core';
import {
  driveFiles,
  mcpEventDeliveries,
  mcpEventSubscriptions,
  roomFiles,
} from './files-events';

export * from './core';
export * from './files-events';

/** 4C 已声明的表；未列出的表仍由迁移 SQL 定义。 */
export const CORE_TABLES = [
  actors,
  credentials,
  rooms,
  roomMembers,
  messages,
  deliveries,
  operations,
  outbox,
  driveFiles,
  roomFiles,
  mcpEventSubscriptions,
  mcpEventDeliveries,
] as const;
