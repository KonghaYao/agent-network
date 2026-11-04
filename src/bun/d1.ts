import type { Database } from 'bun:sqlite';

type BindValue = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;

function normalize(value: unknown): string | number | bigint | null | Uint8Array {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return value;
  }
  throw new TypeError(`D1 bind 不支持的类型: ${Object.prototype.toString.call(value)}`);
}

function meta(changes: number, lastRowId: number | bigint, duration: number): D1Meta {
  return {
    changes,
    last_row_id: Number(lastRowId),
    duration,
    rows_read: 0,
    rows_written: 0,
  };
}

/** 单条语句的 bun:sqlite 实现；同时提供同步执行入口给 batch 事务。 */
class BunD1Statement implements D1PreparedStatement {
  readonly #db: Database;
  readonly #sql: string;
  readonly #values: unknown[];

  constructor(db: Database, sql: string, values: unknown[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#values = values;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new BunD1Statement(this.#db, this.#sql, values);
  }

  #args(): Array<string | number | bigint | null | Uint8Array> {
    return this.#values.map(normalize);
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = this.#db.prepare(this.#sql).get(...this.#args()) as Record<string, unknown> | null;
    if (row === null || row === undefined) return null;
    return (colName ? row[colName] : row) as T | null;
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const started = performance.now();
    const results = this.#db.prepare(this.#sql).all(...this.#args()) as T[];
    return {
      results,
      success: true,
      meta: meta(0, 0, performance.now() - started),
    };
  }

  async run<T = unknown>(): Promise<D1Result<T>> {
    return this.executeSync<T>();
  }

  async raw<T = unknown>(): Promise<T[]> {
    return this.#db.prepare(this.#sql).values(...this.#args()) as T[];
  }

  /** batch 必须同步执行，保证整个数组在同一个 SQLite 事务里。 */
  executeSync<T = unknown>(): D1Result<T> {
    const started = performance.now();
    const info = this.#db.prepare(this.#sql).run(...this.#args());
    return {
      results: [],
      success: true,
      meta: meta(info.changes, info.lastInsertRowid, performance.now() - started),
    };
  }
}

class BunD1Database implements D1Database {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  prepare(query: string): D1PreparedStatement {
    return new BunD1Statement(this.#db, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const run = this.#db.transaction(() =>
      statements.map((statement) => (statement as BunD1Statement).executeSync<T>()),
    );
    return run();
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    this.#db.exec(query);
    return { count: 0, duration: performance.now() - started };
  }
}

/** 用 bun:sqlite 构造一个行为与业务查询层现有用法一致的 D1 兼容对象。 */
export function createD1(db: Database): D1Database {
  return new BunD1Database(db);
}

export type { BindValue };
