/**
 * 4C-0 schema parity harness。
 *
 * 1. 在内存 SQLite 应用全部 `migrations/*.sql`（唯一事实源）；
 * 2. 用 drizzle-kit 从 core schema 生成 DDL，应用到第二个内存库；
 * 3. 逐表比较 columns / indexes / foreign keys / CHECK 约束；
 * 4. 生成并校验可 review 的 `tests/fixtures/schema-surface.json`；
 * 5. 验证 guard 表、FTS5 触发器与 Drizzle 生产边界：
 *    `drizzle-orm` 只允许出现在 `src/storage/drizzle.ts` / `src/storage/queries.ts`，
 *    schema 只允许由 `src/storage/drizzle.ts` 直接引用。
 *
 * 用法：
 *   bun scripts/verify-drizzle-schema.ts            # 校验
 *   bun scripts/verify-drizzle-schema.ts --update   # 迁移变更后刷新 fixture
 */
import { createHash } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { getTableName } from 'drizzle-orm';

import { migrate } from '../src/bun/migrate';
import { GUARDS } from '../src/storage/guards';
import { CORE_TABLES } from '../src/storage/schema';
import { stableStringify } from '../src/storage/db';
import { check, checkEqual, checksPassed } from './lib/harness';

const ROOT = resolve(import.meta.dir, '..');
const MIGRATIONS_DIR = resolve(ROOT, 'migrations');
const SCHEMA_ENTRY = resolve(ROOT, 'src/storage/schema/index.ts');
const DRIZZLE_KIT = resolve(ROOT, 'node_modules/drizzle-kit/bin.cjs');
const FIXTURE = resolve(ROOT, 'tests/fixtures/schema-surface.json');
const UPDATE = process.argv.includes('--update');

const sha256 = (value: string | Uint8Array): string =>
  createHash('sha256').update(value).digest('hex');

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

interface ColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

interface IndexListRow {
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface IndexXInfoRow {
  seqno: number;
  cid: number;
  name: string | null;
  desc: number;
  coll: string | null;
  key: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string;
  on_update: string;
  on_delete: string;
  match: string;
}

interface MasterRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

function normalizeExpr(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('"', '')
    .replaceAll('`', '')
    .replace(/\b[a-z_][a-z0-9_]*\.(?=[a-z_])/gu, '')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),=<>!])\s*/gu, '$1')
    .trim();
}

/** 从 CREATE TABLE / CREATE INDEX SQL 中提取平衡括号内的 CHECK 表达式。 */
function extractChecks(sql: string | null): string[] {
  if (!sql) return [];
  const upper = sql.toUpperCase();
  const checks: string[] = [];
  let cursor = 0;
  for (;;) {
    const found = upper.indexOf('CHECK', cursor);
    if (found < 0) break;
    let index = found + 'CHECK'.length;
    while (index < sql.length && /\s/u.test(sql[index]!)) index += 1;
    if (sql[index] !== '(') {
      cursor = found + 'CHECK'.length;
      continue;
    }
    const start = index;
    let depth = 0;
    let quote: string | null = null;
    for (; index < sql.length; index += 1) {
      const char = sql[index]!;
      if (quote) {
        if (char === quote) {
          if (sql[index + 1] === quote) index += 1;
          else quote = null;
        }
        continue;
      }
      if (char === "'" || char === '"' || char === '`') {
        quote = char;
      } else if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          checks.push(normalizeExpr(sql.slice(start, index + 1)));
          break;
        }
      }
    }
    cursor = Math.max(index + 1, found + 'CHECK'.length);
  }
  return checks.sort();
}

function normalizeDefault(value: string | null): string | null {
  if (value === null) return null;
  let text = value.trim();
  while (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
  return text.toLowerCase();
}

function columnsOf(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_xinfo(${quoteIdent(table)})`).all() as ColumnRow[]).map(
    (row) =>
      `${row.name}|${row.type.toUpperCase()}|nn=${row.notnull}|d=${normalizeDefault(row.dflt_value)}|pk=${row.pk}|h=${row.hidden}`,
  );
}

function foreignKeysOf(db: Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA foreign_key_list(${quoteIdent(table)})`).all() as ForeignKeyRow[]
  )
    .map(
      (row) =>
        `${row.from}->${row.table}.${row.to}|on_update=${row.on_update.toLowerCase()}|on_delete=${row.on_delete.toLowerCase()}|match=${row.match.toLowerCase()}`,
    )
    .sort();
}

function indexSqlOf(db: Database, name: string): string {
  const row = db
    .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get('index', name) as { sql: string | null } | undefined;
  return row?.sql ?? '';
}

function whereOf(sql: string): string {
  const match = /WHERE\s+([\s\S]+)$/iu.exec(sql);
  return match ? normalizeExpr(match[1]!) : '';
}

/** 语义化 index fingerprint：忽略 autoindex 名称，但保留唯一/部分/列/DESC/谓词。 */
function indexesOf(db: Database, table: string): string[] {
  const list = db
    .prepare(`PRAGMA index_list(${quoteIdent(table)})`)
    .all() as IndexListRow[];
  return list
    .map((row) => {
      const xinfo = db
        .prepare(`PRAGMA index_xinfo(${quoteIdent(row.name)})`)
        .all() as IndexXInfoRow[];
      const keys = xinfo.filter((item) => item.key === 1);
      const fingerprint = {
        pk: row.origin === 'pk',
        unique: row.unique === 1,
        partial: row.partial === 1,
        columns: keys.map((item) => item.name),
        desc: keys.map((item) => item.desc),
        where: whereOf(indexSqlOf(db, row.name)),
      };
      return stableStringify(fingerprint);
    })
    .sort();
}

function tableSql(db: Database, table: string): string | null {
  const row = db
    .prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get('table', table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

function checksOf(db: Database, table: string): string[] {
  return extractChecks(tableSql(db, table));
}

function tableNames(db: Database): string[] {
  return (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
}

function sorted(values: string[]): string[] {
  return [...values].sort();
}

function assertTableParity(
  label: string,
  migrated: Database,
  drizzleDb: Database,
  table: string,
): void {
  const migratedColumns = columnsOf(migrated, table);
  const drizzleColumns = columnsOf(drizzleDb, table);
  checkEqual(
    `${label} ${table} columns`,
    stableStringify(drizzleColumns),
    stableStringify(migratedColumns),
  );
  checkEqual(
    `${label} ${table} indexes`,
    stableStringify(indexesOf(drizzleDb, table)),
    stableStringify(indexesOf(migrated, table)),
  );
  checkEqual(
    `${label} ${table} foreign keys`,
    stableStringify(foreignKeysOf(drizzleDb, table)),
    stableStringify(foreignKeysOf(migrated, table)),
  );
  checkEqual(
    `${label} ${table} checks`,
    stableStringify(checksOf(drizzleDb, table)),
    stableStringify(checksOf(migrated, table)),
  );
}

async function generateDrizzleSql(): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), 'agentnet-drizzle-'));
  try {
    const proc = Bun.spawn(
      [
        process.execPath,
        DRIZZLE_KIT,
        'generate',
        '--dialect',
        'sqlite',
        '--schema',
        SCHEMA_ENTRY,
        '--out',
        out,
        '--name',
        'parity',
      ],
      { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      throw new Error(`drizzle-kit generate 失败 (${code})\n${stdout}\n${stderr}`);
    }
    const files = (await readdir(out)).filter((file) => file.endsWith('.sql')).sort();
    const file = files.at(-1);
    if (!file) throw new Error('drizzle-kit 未生成 SQL');
    return readFile(join(out, file), 'utf8');
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

function applyDrizzleSql(sql: string): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = OFF');
  for (const statement of sql.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed.length > 0) db.exec(trimmed);
  }
  return db;
}

async function migrationNames(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

async function migrationsDigest(names: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update(await readFile(join(MIGRATIONS_DIR, name)));
  }
  return hash.digest('hex');
}

interface TableSurface {
  type: string;
  virtual: boolean;
  columns: string[];
  indexes: string[];
  foreignKeys: string[];
  checks: string[];
  sqlDigest: string;
}

function buildSurface(db: Database, names: string[], digest: string) {
  const master = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger') ORDER BY type, name",
    )
    .all() as MasterRow[];
  const tables: Record<string, TableSurface> = {};
  for (const row of master.filter((item) => item.type === 'table' && !item.name.startsWith('sqlite_'))) {
    const indexes = (
      db.prepare(`PRAGMA index_list(${quoteIdent(row.name)})`).all() as IndexListRow[]
    ).map((index) => {
      const xinfo = db
        .prepare(`PRAGMA index_xinfo(${quoteIdent(index.name)})`)
        .all() as IndexXInfoRow[];
      const keys = xinfo.filter((item) => item.key === 1);
      return `${index.name}|u=${index.unique}|o=${index.origin}|p=${index.partial}|cols=${keys
        .map((item) => item.name)
        .join(',')}|desc=${keys.map((item) => item.desc).join(',')}`;
    });
    tables[row.name] = {
      type: row.type,
      virtual: /^\s*CREATE\s+VIRTUAL\s+TABLE/iu.test(row.sql ?? ''),
      columns: columnsOf(db, row.name),
      indexes: sorted(indexes),
      foreignKeys: foreignKeysOf(db, row.name),
      checks: checksOf(db, row.name),
      sqlDigest: sha256(normalizeExpr(row.sql ?? '')),
    };
  }
  const triggers: Record<string, string> = {};
  for (const row of master.filter((item) => item.type === 'trigger')) {
    triggers[row.name] = sha256(normalizeExpr(row.sql ?? ''));
  }
  const tableNamesList = Object.keys(tables);
  const surface = {
    version: 1,
    migrations: names,
    migrationsDigest: digest,
    counts: {
      tables: tableNamesList.length,
      guardTables: tableNamesList.filter((name) => name.startsWith('guard_')).length,
      messageSearchTables: tableNamesList.filter((name) => name.startsWith('message_search_fts'))
        .length,
      indexes: master.filter((item) => item.type === 'index').length,
      triggers: master.filter((item) => item.type === 'trigger').length,
    },
    tables,
    triggers,
  };
  return { ...surface, digest: sha256(stableStringify(surface)) };
}

async function checkGuardTables(db: Database): Promise<void> {
  const tables = tableNames(db).filter((name) => name.startsWith('guard_'));
  const expected = sorted(Object.values(GUARDS).map((guard) => guard.table));
  checkEqual('GUARDS 与迁移中的 guard 表一致', stableStringify(sorted(tables)), stableStringify(expected));
  for (const table of tables) {
    const columns = db.prepare(`PRAGMA table_xinfo(${quoteIdent(table)})`).all() as ColumnRow[];
    checkEqual(`${table} 只有 x 列`, columns.map((column) => column.name).join(','), 'x');
    checkEqual(`${table} x 为 NOT NULL INTEGER`, `${columns[0]?.type}|${columns[0]?.notnull}`, 'INTEGER|1');
    const sql = normalizeExpr(tableSql(db, table) ?? '');
    check(`${table} 有命名 CHECK`, sql.includes(`constraint ${table} check`), sql);
    db.prepare(`INSERT INTO ${quoteIdent(table)} (x) VALUES (0)`).run();
    db.prepare(`DELETE FROM ${quoteIdent(table)}`).run();
    let rejected = false;
    try {
      db.prepare(`INSERT INTO ${quoteIdent(table)} (x) VALUES (1)`).run();
    } catch {
      rejected = true;
    }
    check(`${table} 拒绝 x=1`, rejected);
  }
}

function checkFts(db: Database): void {
  const triggers = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'message_search_fts_%' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
  checkEqual(
    'FTS 触发器齐全',
    triggers.join(','),
    'message_search_fts_ad,message_search_fts_ai,message_search_fts_au',
  );
  const match = (term: string): number => {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM message_search_fts WHERE message_search_fts MATCH ?')
      .get(term) as { n: number };
    return row.n;
  };
  db.prepare(
    `INSERT INTO messages
       (message_id, room_id, sender_id, client_message_id, created_seq, body, body_bytes, preview, created_at)
     VALUES ('msg_fts_parity', 'room_fts_parity', 'act_fts_parity', 'cm_fts_parity', 1, ?, 16, ?, 0)`,
  ).run('alpha beta gamma', 'alpha beta gamma');
  checkEqual('FTS insert 后可搜索', match('beta'), 1);
  db.prepare("UPDATE messages SET body = 'delta epsilon zeta' WHERE message_id = 'msg_fts_parity'").run();
  checkEqual('FTS update 后旧词不可搜索', match('beta'), 0);
  checkEqual('FTS update 后新词可搜索', match('delta'), 1);
  db.prepare("UPDATE messages SET preview = 'ignored' WHERE message_id = 'msg_fts_parity'").run();
  checkEqual('FTS 只同步 body，不同步 preview', match('delta'), 1);
  db.prepare("DELETE FROM messages WHERE message_id = 'msg_fts_parity'").run();
  checkEqual('FTS delete 后不可搜索', match('delta'), 0);
}

/** Drizzle 只允许出现在核心存储查询层；域层统一 import `storage/queries`。 */
const DRIZZLE_IMPORTERS = new Set(['src/storage/drizzle.ts', 'src/storage/queries.ts']);
/** schema 模块只允许由运行时入口引用，避免表定义扩散到业务代码。 */
const SCHEMA_IMPORTERS = new Set(['src/storage/drizzle.ts']);

function checkDrizzleBoundary(): void {
  const files = [
    ...new Bun.Glob('src/**/*.ts').scanSync({ cwd: ROOT }),
    ...new Bun.Glob('src/**/*.tsx').scanSync({ cwd: ROOT }),
  ].filter((file) => !file.startsWith('src/storage/schema/'));
  const drizzleOffenders: string[] = [];
  const schemaOffenders: string[] = [];
  const drizzlePattern =
    /(?:from\s+|require\()\s*['"]drizzle-(?:orm|kit)(?:\/[^'"]*)?['"]/u;
  const schemaPattern = /(?:from\s+|require\()\s*['"](?:[^'"]*\/)?schema(?:\/index)?['"]/u;
  for (const file of files) {
    const source = readFileSync(resolve(ROOT, file), 'utf8');
    if (drizzlePattern.test(source) && !DRIZZLE_IMPORTERS.has(file)) {
      drizzleOffenders.push(file);
    }
    if (schemaPattern.test(source) && !SCHEMA_IMPORTERS.has(file)) {
      schemaOffenders.push(file);
    }
  }
  checkEqual('Drizzle import 限定在存储查询层', drizzleOffenders.join(','), '');
  checkEqual('只有 storage/drizzle.ts 直接 import schema', schemaOffenders.join(','), '');
  for (const required of ['src/app.ts', 'src/bun/main.ts']) {
    const source = readFileSync(resolve(ROOT, required), 'utf8');
    check(`${required} 不引用 schema`, !source.includes('storage/schema'));
  }
}

async function main() {
  const names = await migrationNames();
  checkEqual('迁移数量为 43', names.length, 43);
  const digest = await migrationsDigest(names);

  const migrated = new Database(':memory:');
  migrated.exec('PRAGMA foreign_keys = OFF');
  migrate(migrated, MIGRATIONS_DIR);

  const drizzleSql = await generateDrizzleSql();
  const drizzleDb = applyDrizzleSql(drizzleSql);
  try {
    const expectedTables: string[] = CORE_TABLES.map((table) => getTableName(table)).sort();
    checkEqual(
      'Drizzle 只生成 core 表',
      tableNames(drizzleDb).join(','),
      expectedTables.join(','),
    );
    for (const table of expectedTables) {
      assertTableParity('parity', migrated, drizzleDb, table);
    }
    checkEqual(
      'Drizzle 不生成 guard 表',
      tableNames(drizzleDb).filter((name) => name.startsWith('guard_')).length,
      0,
    );
    checkEqual(
      'Drizzle 不生成 FTS 表',
      tableNames(drizzleDb).filter((name) => name.startsWith('message_search_fts')).length,
      0,
    );
    checkEqual(
      'Drizzle 不生成触发器',
      (
        drizzleDb
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'")
          .get() as { n: number }
      ).n,
      0,
    );
    const rawOnly = tableNames(migrated).filter(
      (name) => !expectedTables.includes(name) && !name.startsWith('guard_'),
    );
    console.log(`\nDrizzle core coverage: ${expectedTables.join(', ')}`);
    console.log(`raw-only tables (${rawOnly.length}): ${rawOnly.join(', ')}\n`);

    const surface = buildSurface(migrated, names, digest);
    if (UPDATE) {
      await mkdir(resolve(ROOT, 'tests/fixtures'), { recursive: true });
      await writeFile(FIXTURE, `${JSON.stringify(surface, null, 2)}\n`);
      console.log(`schema surface updated: ${FIXTURE}`);
    } else {
      const current = JSON.parse(await readFile(FIXTURE, 'utf8')) as unknown;
      checkEqual(
        'schema surface fixture 与迁移一致（变更后运行 --update）',
        stableStringify(surface),
        stableStringify(current),
      );
    }

    await checkGuardTables(migrated);
    checkFts(migrated);
    checkDrizzleBoundary();

    console.log(`\nschema parity checks passed: ${checksPassed()}`);
  } finally {
    migrated.close();
    drizzleDb.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
