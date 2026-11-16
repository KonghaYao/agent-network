/**
 * 一次性 Memory 回填重放（默认 dry-run）。
 *
 * 常规调度只补最近 `memoryBackfillMaxCatchupWindows` 个 1h 窗口；历史重放如果
 * 用大 `windowMs` 一步跳到过去的粗边界，水位与最近 24h 之间的消息会被永久
 * 跳过。本脚本始终使用 1h 窗口，从 `--from` 顺序推进到 `now - 24h`（默认），
 * 每轮最多处理 `--window-limit` 个窗口；写入仍由 `MemoryBackfill` 的条件插入
 * 保证幂等。
 *
 * 用法：
 *   bun scripts/replay-memory-backfill.ts --from=2026-10-01T00:00:00Z
 *   bun scripts/replay-memory-backfill.ts --from=... --execute --reset-cursors
 *   bun scripts/replay-memory-backfill.ts --execute --resume
 *
 * 生产步骤（必须在服务停止或确认没有并发回填时执行）：
 *   1. 备份 SQLite（`.backup`，含 WAL）；
 *   2. dry-run 确认窗口数、游标与实例；
 *   3. 首次执行 `--execute --reset-cursors`，中断后用 `--execute --resume` 续跑。
 *
 * 输出只包含窗口计数、游标和实例 ID，不输出消息正文、token 或凭据。
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { createD1 } from '../src/bun/d1';
import { LIMITS } from '../src/contracts/limits';
import { MemoryBackfill, type MemoryBackfillRun } from '../src/memory/backfill';
import { planBackfillReplayWindows } from '../src/memory/backfill-window';
import { MEMORY_CURSOR_KINDS, readMemoryCursor } from '../src/memory/jobs';

const BACKFILL_SCOPE_ID = 'memory-backfill';
const WINDOW_MS = LIMITS.memoryBackfillWindowMs;
const CATCHUP_MS = LIMITS.memoryBackfillMaxCatchupWindows * WINDOW_MS;

interface CliOptions {
  dbPath: string;
  from: number | null;
  to: number | null;
  instanceId: string | null;
  windowLimit: number;
  execute: boolean;
  resetCursors: boolean;
  resume: boolean;
  help: boolean;
}

interface InstanceRow {
  instance_id: string;
  capture_default: 'enabled' | 'disabled';
}

function usage(): string {
  return [
    '用法: bun scripts/replay-memory-backfill.ts [选项]',
    '',
    '  --from=<ISO|epoch>       重放起点；默认最早的回填回执（缺失时用最早消息）',
    '  --to=<ISO|epoch>         重放上界；默认 now-24h，且不会超过 now-24h',
    '  --db=<path>              SQLite 路径；默认 DATABASE_PATH 或 DATA_DIR/agent-network.sqlite',
    '  --instance=<id>          指定 memory instance；默认取唯一一行',
    '  --window-limit=<n>       每轮最多处理的窗口数；默认 24',
    '  --execute                真实写入；默认 dry-run',
    '  --reset-cursors          执行前清空 backfill_window_to / backfill_scan_rowid',
    '  --resume                 从现有游标继续（中断后续跑）',
    '  --help                   显示本帮助',
  ].join('\n');
}

function parseTime(value: string, name: string): number {
  const numeric = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (Number.isSafeInteger(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} 不是合法时间: ${value}`);
  }
  return parsed;
}

function takeValue(args: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index]!;
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return null;
}

function parseCli(argv: readonly string[]): CliOptions {
  const dataDir = process.env.DATA_DIR ?? '.data';
  const dbRaw = takeValue(argv, 'db');
  const dbPath =
    dbRaw === null
      ? resolve(process.env.DATABASE_PATH ?? `${dataDir}/agent-network.sqlite`)
      : resolve(dbRaw);
  const fromRaw = takeValue(argv, 'from');
  const toRaw = takeValue(argv, 'to');
  const instanceRaw = takeValue(argv, 'instance');
  const limitRaw = takeValue(argv, 'window-limit');
  const windowLimit = limitRaw === null ? LIMITS.memoryBackfillMaxCatchupWindows : Number(limitRaw);
  if (!Number.isSafeInteger(windowLimit) || windowLimit < 1 || windowLimit > 1_000) {
    throw new Error('--window-limit 必须是 1..1000 的整数');
  }
  return {
    dbPath,
    from: fromRaw === null ? null : parseTime(fromRaw, '--from'),
    to: toRaw === null ? null : parseTime(toRaw, '--to'),
    instanceId: instanceRaw,
    windowLimit,
    execute: argv.includes('--execute'),
    resetCursors: argv.includes('--reset-cursors'),
    resume: argv.includes('--resume'),
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function alignDown(value: number, windowMs: number): number {
  return Math.floor(value / windowMs) * windowMs;
}

async function resolveInstance(
  db: D1Database,
  requested: string | null,
): Promise<InstanceRow> {
  if (requested !== null) {
    const row = await db
      .prepare('SELECT instance_id, capture_default FROM memory_instances WHERE instance_id = ?')
      .bind(requested)
      .first<InstanceRow>();
    if (!row) throw new Error(`memory instance 不存在: ${requested}`);
    return row;
  }
  const rows = await db
    .prepare('SELECT instance_id, capture_default FROM memory_instances ORDER BY created_at LIMIT 2')
    .all<InstanceRow>();
  if (rows.results.length === 0) {
    throw new Error('memory_instances 为空；先启动服务或显式迁移');
  }
  if (rows.results.length > 1) {
    throw new Error('存在多个 memory instance；请用 --instance 指定');
  }
  return rows.results[0]!;
}

async function resolveDefaultFrom(db: D1Database): Promise<number> {
  const receipt = await db
    .prepare(
      `SELECT MIN(recorded_at) AS t FROM memory_receipts
        WHERE evidence = 'gateway_observed_room_history'`,
    )
    .first<{ t: number | null }>();
  if (receipt?.t !== null && receipt?.t !== undefined) return receipt.t;
  const message = await db
    .prepare('SELECT MIN(created_at) AS t FROM messages')
    .first<{ t: number | null }>();
  if (message?.t !== null && message?.t !== undefined) return message.t;
  throw new Error('没有可重放的消息或回填回执；请显式传 --from');
}

function totalsOf(run: MemoryBackfillRun): {
  windows: number;
  scanned: number;
  pairs: number;
  representations: number;
  receipts: number;
  intents: number;
  jobs: number;
  experiences: number;
  errors: number;
} {
  return {
    windows: run.windows,
    scanned: run.scanned,
    pairs: run.pairs,
    representations: run.created.representations,
    receipts: run.created.receipts,
    intents: run.created.intents,
    jobs: run.created.jobs,
    experiences: run.created.experiences,
    errors: run.errors,
  };
}

async function main(): Promise<number> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }
  if (options.execute && options.resetCursors && options.resume) {
    throw new Error('--reset-cursors 与 --resume 不能同时使用');
  }
  if (!existsSync(options.dbPath)) {
    throw new Error(`SQLite 不存在: ${options.dbPath}`);
  }

  const sqlite = new Database(options.dbPath);
  sqlite.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const db = createD1(sqlite);
  try {
    const instance = await resolveInstance(db, options.instanceId);
    const now = Date.now();
    const defaultUntil = now - CATCHUP_MS;
    const from = options.from ?? (await resolveDefaultFrom(db));
    const requestedUntil = options.to ?? defaultUntil;
    const until = Math.min(requestedUntil, defaultUntil);
    if (requestedUntil > until) {
      console.warn(
        `[replay] --to 被收敛到 now-24h=${iso(until)}；更近区间留给常规调度`,
      );
    }
    if (from >= until) {
      console.log(
        `[replay] 目标区间为空: from=${iso(from)} until=${iso(until)}；无需重放`,
      );
      return 0;
    }

    const alignedFrom = alignDown(from, WINDOW_MS);
    const alignedUntil = alignDown(until, WINDOW_MS);
    const totalWindows = Math.max(
      0,
      Math.floor((alignedUntil - alignedFrom) / WINDOW_MS),
    );
    const watermark = await readMemoryCursor(db, {
      scopeKind: 'agent',
      scopeId: BACKFILL_SCOPE_ID,
      cursorKind: MEMORY_CURSOR_KINDS.backfillWindowTo,
    });
    const scanRowid = await readMemoryCursor(db, {
      scopeKind: 'agent',
      scopeId: BACKFILL_SCOPE_ID,
      cursorKind: MEMORY_CURSOR_KINDS.backfillScanRowid,
    });
    const cursorsPresent = watermark !== null || scanRowid !== null;

    const dryRunWatermark = options.resetCursors ? null : watermark;
    const remainingPlan = planBackfillReplayWindows({
      watermark: dryRunWatermark,
      from,
      until,
      windowMs: WINDOW_MS,
      maxWindows: options.windowLimit,
    });
    const remainingWindows = remainingPlan.windows.length + remainingPlan.remainingWindows;
    const rounds = Math.ceil(remainingWindows / options.windowLimit);

    console.log(`[replay] mode=${options.execute ? 'execute' : 'dry-run'}`);
    console.log(`[replay] db=${options.dbPath}`);
    console.log(
      `[replay] instance=${instance.instance_id} capture_default=${instance.capture_default}`,
    );
    console.log(
      `[replay] range=${iso(alignedFrom)} -> ${iso(alignedUntil)} window_ms=${WINDOW_MS}`,
    );
    console.log(
      `[replay] total_windows=${totalWindows} remaining_windows=${remainingWindows} rounds=${rounds} window_limit=${options.windowLimit}`,
    );
    console.log(
      `[replay] cursors backfill_window_to=${watermark ?? 'null'} backfill_scan_rowid=${scanRowid ?? 'null'}`,
    );

    if (!options.execute) {
      if (options.resetCursors) {
        console.log('[replay] --execute 将先清空两类回填游标');
      }
      console.log(
        '[replay] 下一步: --execute --reset-cursors（首次）或 --execute --resume（续跑）',
      );
      return 0;
    }

    if (instance.capture_default !== 'enabled') {
      throw new Error('memory instance 的 capture_default 不是 enabled；不会制造无主意图');
    }
    if (process.env.MEMORY_CAPTURE === '0') {
      throw new Error('MEMORY_CAPTURE=0；请与服务相同的 capture 配置下运行');
    }
    if (cursorsPresent && !options.resetCursors && !options.resume) {
      throw new Error(
        '已有回填游标；首次重放用 --reset-cursors，中断后续跑用 --resume',
      );
    }
    if (options.resume && watermark === null && scanRowid !== null) {
      throw new Error('窗口游标缺失但扫描位存在；请用 --reset-cursors 从头重放');
    }
    if (options.resume && watermark !== null && watermark >= alignedUntil) {
      console.log(
        `[replay] 水位 ${watermark} 已到达/超过 ${alignedUntil}；无需重放`,
      );
      return 0;
    }
    if (options.resume && watermark !== null && watermark > alignedFrom) {
      console.warn(
        `[replay] 从水位 ${watermark} 续跑；水位之前的目标区间不会重访。要补更早缺口请用 --reset-cursors`,
      );
    }

    if (options.resetCursors) {
      await db
        .prepare(
          `DELETE FROM memory_cursors
            WHERE scope_kind = 'agent' AND scope_id = ?
              AND cursor_kind IN (?, ?)`,
        )
        .bind(
          BACKFILL_SCOPE_ID,
          MEMORY_CURSOR_KINDS.backfillWindowTo,
          MEMORY_CURSOR_KINDS.backfillScanRowid,
        )
        .run();
      console.log('[replay] 已清空两类回填游标');
    }

    const started = Date.now();
    const totals = {
      windows: 0,
      scanned: 0,
      pairs: 0,
      representations: 0,
      receipts: 0,
      intents: 0,
      jobs: 0,
      experiences: 0,
      errors: 0,
    };
    const runner = new MemoryBackfill({
      db,
      instanceId: instance.instance_id,
      capture: () => true,
      now: () => Date.now(),
      windowMs: WINDOW_MS,
      maxCatchupWindows: options.windowLimit,
      replayFrom: from,
      replayUntil: until,
      log: (message, detail) => {
        if (message === 'memory-backfill window') {
          const created = detail.created as { experiences?: number } | undefined;
          console.log(
            `[replay] window from=${String(detail.from)} to=${String(detail.to)} scanned=${String(detail.scanned)} pairs=${String(detail.pairs)} experiences=${String(created?.experiences ?? 0)} errors=${String(detail.errors)}`,
          );
        } else if (message === 'memory-backfill message failed') {
          console.error(
            `[replay] window error class=${String(detail.error)} message_id=${String(detail.message_id)}`,
          );
        }
      },
    });

    const maxRounds = Math.ceil(remainingWindows / options.windowLimit) + 2;
    let roundsRun = 0;
    let caughtUp = false;
    while (roundsRun < maxRounds) {
      const run = await runner.runOnce();
      roundsRun += 1;
      if (run.skipped) throw new Error('回填运行中（单轮不重入）；确认没有并发回填后重试');
      const part = totalsOf(run);
      for (const key of Object.keys(totals) as (keyof typeof totals)[]) {
        totals[key] += part[key];
      }
      const cursor = await readMemoryCursor(db, {
        scopeKind: 'agent',
        scopeId: BACKFILL_SCOPE_ID,
        cursorKind: MEMORY_CURSOR_KINDS.backfillWindowTo,
      });
      console.log(
        `[replay] round=${roundsRun} windows=${run.windows} caught_up=${run.caught_up} watermark=${cursor ?? 'null'} errors=${run.errors}`,
      );
      if (run.errors > 0) break;
      if (run.caught_up || run.windows === 0) {
        caughtUp = run.caught_up;
        break;
      }
    }

    const finalWatermark = await readMemoryCursor(db, {
      scopeKind: 'agent',
      scopeId: BACKFILL_SCOPE_ID,
      cursorKind: MEMORY_CURSOR_KINDS.backfillWindowTo,
    });
    const finalScanRowid = await readMemoryCursor(db, {
      scopeKind: 'agent',
      scopeId: BACKFILL_SCOPE_ID,
      cursorKind: MEMORY_CURSOR_KINDS.backfillScanRowid,
    });
    const durationMs = Date.now() - started;
    console.log(
      `[replay] summary ${JSON.stringify({
        mode: 'execute',
        instance_id: instance.instance_id,
        from: alignedFrom,
        until: alignedUntil,
        window_ms: WINDOW_MS,
        rounds: roundsRun,
        windows: totals.windows,
        scanned: totals.scanned,
        pairs: totals.pairs,
        created: {
          representations: totals.representations,
          receipts: totals.receipts,
          intents: totals.intents,
          jobs: totals.jobs,
          experiences: totals.experiences,
        },
        errors: totals.errors,
        caught_up: caughtUp,
        cursor_backfill_window_to: finalWatermark,
        cursor_backfill_scan_rowid: finalScanRowid,
        duration_ms: durationMs,
        ms_per_window: totals.windows > 0 ? Math.round(durationMs / totals.windows) : 0,
      })}`,
    );
    if (totals.errors > 0 || !caughtUp) {
      console.error(
        '[replay] 未完整追平；已提交窗口可安全用 --resume 续跑（不要再次清空游标）',
      );
      return 1;
    }
    console.log(
      '[replay] 完成；请立即在同一整点小时内启动服务，常规调度会补最近 24 个窗口。若跨整点，用 --resume 补到新的 now-24h。',
    );
    return 0;
  } finally {
    sqlite.close();
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error('[replay] failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
