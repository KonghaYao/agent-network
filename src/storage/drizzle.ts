import { drizzle } from 'drizzle-orm/d1';

import * as schema from './schema';

/**
 * Drizzle 只读查询入口与 raw 边界说明。
 *
 * 迁移 SQL（`migrations/*.sql` + `schema_migrations`）是唯一事实源；
 * Drizzle 只负责给只读 SELECT 构建 SQL，`toD1()` 把语句交回现有 D1 shim
 * 执行。禁止 `drizzle-kit push` / `drizzle-kit migrate`；`drizzle-kit generate`
 * 只服务于 schema parity。
 *
 * 固化边界（不要迁移到 Drizzle）：
 * - 写路径：`runIdempotent` 内的 operations 所有权、业务写入与条件闸门，
 *   以及 events/outbox、memory 语句、文件配额等，全部是 raw D1 batch；
 * - guard：`src/storage/guards.ts` 的 `GUARDS` 与 `guard_*` 表；
 * - FTS/trigger：`message_search_fts*` 与 `0047` 的同步触发器；memory 不可变
 *   触发器（`0045`/`0046`）；
 * - 复杂 SQL：JOIN/UNION/EXISTS、`json_each` 权限谓词、`CASE`、CTE 与
 *   `EXPLAIN` 敏感查询；
 * - 未迁移域：messages/deliveries/files/events/tasks 等仍以 raw SQL 为准。
 *
 * 边界约束：
 * - 只有本文件与 `src/storage/queries.ts` 可以 import `drizzle-orm`；
 * - 只有本文件可以 import `./schema`；
 * - 生产路径只允许 `select()`；写操作必须回到 raw 边界；
 * - 域层继续 import `storage/queries` 的语义化函数。
 */
export interface D1Queryable {
  prepare(query: string): D1PreparedStatement;
}

/** Select/Insert 等可编译查询的最小结构；避免把构建器类型扩散到调用方。 */
export interface SqlQuery {
  toSQL(): { sql: string; params: unknown[] };
}

const orms = new WeakMap<object, ReturnType<typeof createOrm>>();

function createOrm(db: D1Database) {
  return drizzle(db, { schema });
}

export type DatabaseOrm = ReturnType<typeof createOrm>;

/** 同一 D1 句柄复用 ORM；Drizzle 构造只保存 client，不会另开连接。 */
export function orm(db: D1Queryable): DatabaseOrm {
  const key = db as unknown as object;
  const cached = orms.get(key);
  if (cached) return cached;
  const instance = createOrm(db as unknown as D1Database);
  orms.set(key, instance);
  return instance;
}

/** 把 Drizzle 查询编译回现有 D1 预编译语句；不执行 Drizzle 自身的事务/批处理。 */
export function toD1(db: D1Queryable, query: SqlQuery): D1PreparedStatement {
  const { sql, params } = query.toSQL();
  return db.prepare(sql).bind(...params);
}

export { schema };
