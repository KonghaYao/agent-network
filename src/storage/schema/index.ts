/**
 * Drizzle schema 汇总入口。
 *
 * 该目录只由 `drizzle-kit` 与 `scripts/verify-drizzle-schema.ts` 使用；
 * 生产运行时不得 import（`test:schema-parity` 会扫描并阻止回退）。
 */
export * from './core';
