/**
 * Drizzle schema 汇总入口。
 *
 * 迁移 SQL 仍是唯一事实源；生产运行时只允许 `src/storage/drizzle.ts` 直接
 * import 本目录，其余代码通过 `storage/queries` 调用语义化函数。
 * `drizzle-kit` 只用于 parity 生成 DDL，禁止对真实库执行 push/migrate。
 */
export * from './contacts';
export * from './core';
export * from './files-events';
export * from './memory';
export * from './rooms';

import { CONTACT_TABLES } from './contacts';
import { CORE_TABLES } from './core';
import { driveFiles, mcpEventDeliveries, mcpEventSubscriptions, roomFiles } from './files-events';
import { MEMORY_TABLES } from './memory';
import { ROOMS_TABLES } from './rooms';

/** schema parity 与运行时共用的表清单；新增域表时同时加入这里。 */
export const SCHEMA_TABLES = [
  ...CORE_TABLES,
  ...CONTACT_TABLES,
  ...ROOMS_TABLES,
  ...MEMORY_TABLES,
  driveFiles,
  roomFiles,
  mcpEventSubscriptions,
  mcpEventDeliveries,
] as const;
