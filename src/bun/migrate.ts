import type { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Database as SQLite } from 'bun:sqlite';

/**
 * 顺序应用 migrations/*.sql。
 *
 * SQL 文件是 schema 的单一事实源；已应用文件名记录在 schema_migrations，
 * 与 wrangler d1 migrations 的文件语义保持一致。
 */
export function migrate(db: Database, directory: string): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const applied = new Set(
    (db.prepare('SELECT name FROM schema_migrations').all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  const appliedNow: string[] = [];
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const name of files) {
    if (applied.has(name)) continue;
    const sql = readFileSync(join(directory, name), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(
        name,
        Date.now(),
      );
    });
    apply();
    appliedNow.push(name);
  }
  return appliedNow;
}

if (import.meta.main) {
  const dbPath = resolve(process.env.DATABASE_PATH ?? '.data/agent-network.sqlite');
  const migrationsDir = resolve(process.env.MIGRATIONS_DIR ?? join(import.meta.dir, '../../migrations'));
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new SQLite(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  const applied = migrate(db, migrationsDir);
  db.close();
  if (applied.length === 0) {
    console.log(`database up to date: ${dbPath}`);
  } else {
    console.log(`applied ${applied.length} migration(s) to ${dbPath}: ${applied.join(', ')}`);
  }
}
