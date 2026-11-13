import { drizzle } from 'drizzle-orm/d1';

import * as schema from './schema';

/**
 * 4C-1/4C-3 生产只读查询的 Drizzle 入口。
 *
 * Drizzle 只负责构建 SQL；执行仍回到现有 D1 shim（`prepare/bind/first/all`），
 * 事务边界仍然是 `db.batch()` / `runIdempotent`。迁移历史继续由
 * `migrations/*.sql` + `schema_migrations` 管理，禁止 `drizzle-kit push/migrate`。
 *
 * 边界：只有本文件与 `src/storage/queries.ts` 可以 import `drizzle-orm`；只有本文件
 * 可以 import `./schema`。域层继续 import `storage/queries` 的语义化函数。
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
