/**
 * Drizzle schema 汇总入口。
 *
 * 迁移 SQL 仍是唯一事实源；生产运行时只允许 `src/storage/drizzle.ts` 直接
 * import 本目录，其余代码通过 `storage/queries` 调用语义化函数。
 * `drizzle-kit` 只用于 parity 生成 DDL，禁止对真实库执行 push/migrate。
 */
export * from './contacts';
export * from './core';
