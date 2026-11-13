/**
 * Drizzle schema 唯一汇总入口。
 *
 * 迁移 SQL 仍是唯一事实源；生产运行时只允许 `src/storage/drizzle.ts` 直接
 * import 本目录，其余代码通过 `storage/queries` 调用语义化函数。
 * `drizzle-kit` 只用于 parity 生成 DDL，禁止对真实库执行 push/migrate。
 *
 * 本入口只导出表对象；表清单由 parity 脚本从导出直接派生，不再维护
 * `CORE_TABLES` / `MEMORY_TABLES` 之类的重复清单。未迁移域、guard、FTS5
 * 与 trigger 不在这里登记。
 */
export * from './core';
export * from './memory';
