import { defineConfig } from 'drizzle-kit';

/**
 * 仅供本地/CI 生成 DDL 与 schema parity 使用。
 *
 * 迁移历史仍由 `migrations/*.sql` + `schema_migrations` 管理；
 * 禁止对真实库执行 `drizzle-kit push` / `drizzle-kit migrate`。
 */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/storage/schema/index.ts',
  out: './.drizzle',
});
