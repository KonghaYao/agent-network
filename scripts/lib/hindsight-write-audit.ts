/**
 * Hindsight 写入核对（只读）。
 *
 * 对每个本地 space 派生 per-space bank，拉取远端文档/事实的
 * `agentnet_representation_id` 元数据，与本地 retain 意图逐一对账。
 *
 * 边界：
 * - 只读 SQLite（`readonly: true`）与 Hindsight GET；不写库、不写远端；
 * - 输出只含 id/计数/状态，绝不输出正文、凭据或 provider 原始错误正文；
 * - `--dry-run` 不访问远端，只打印本地待核对范围。
 */
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  loadHindsightConfigFromEnv,
  resolveHindsightConfig,
  type ResolvedHindsightConfig,
} from '../../src/memory/adapters/hindsight-config';
import { bankIdFor } from '../../src/memory/adapters/hindsight-tags';
import { HindsightTransport } from '../../src/memory/adapters/hindsight-transport';

export type AuditSource = 'auto' | 'documents' | 'memories';

export interface AuditArgs {
  dbPath: string;
  bank: string | null;
  agent: string | null;
  space: string | null;
  dryRun: boolean;
  json: boolean;
  showBanks: boolean;
  failOnGap: boolean;
  source: AuditSource;
  pageSize: number;
  maxPages: number;
}

export interface LocalSpaceAudit {
  space_id: string;
  agent_id: string;
  ownership_epoch: number;
  backend_binding_epoch: number;
  active: boolean;
  bank_id: string;
  expected_representations: number;
  known_representations: number;
  retain_intents: Record<string, number>;
  jobs: Record<string, number>;
  jobs_submitted: number;
  jobs_completed_unconfirmed: number;
  expected_ids: string[];
  known_ids: string[];
}

export type RemoteAuditState = 'ok' | 'not_found' | 'error';

export interface RemoteBankAudit {
  bank_id: string;
  state: RemoteAuditState;
  source: 'documents' | 'memories' | 'none';
  items: number;
  metadata_available: boolean;
  representation_ids: string[];
  pages: number;
  error: string | null;
}

export interface WriteCoverage {
  expected: number;
  matched: number;
  missing: string[];
  /** 远端有、本地 space 从未记录过的表示。 */
  extra: string[];
  /** 远端有，但本地已抑制/墓碑化，不应再写入。 */
  suppressed_extra: string[];
}

export interface SpaceAuditReport extends LocalSpaceAudit {
  remote: RemoteBankAudit | null;
  coverage: WriteCoverage | null;
}

export interface AuditTotals {
  spaces: number;
  banks: number;
  /** 本地 retain 期望数；dry-run 也会统计。 */
  local_expected: number;
  local_known: number;
  /** 以下 coverage 字段只在访问远端后统计。 */
  expected: number;
  matched: number;
  missing: number;
  extra: number;
  suppressed_extra: number;
  jobs_submitted: number;
  jobs_completed_unconfirmed: number;
}

export interface AuditReport {
  generated_at: number;
  db_path: string;
  dry_run: boolean;
  show_banks: boolean;
  source: AuditSource;
  hindsight_configured: boolean;
  totals: AuditTotals;
  spaces: SpaceAuditReport[];
}

const HELP = `用法: bun scripts/verify-hindsight-writes.ts [选项]

只读核对本地 memory_representations/retain 意图与 Hindsight bank 文档元数据
(agentnet_representation_id)。不修改 SQLite 或 Hindsight，不输出正文/凭据。

选项:
  --db <path>          SQLite 路径；默认 DATABASE_PATH 或 DATA_DIR/agent-network.sqlite
  --bank <id>          只核对指定 bank（仍由本地 space 派生映射）
  --agent <actor_id>   只核对指定 Agent
  --space <space_id>   只核对指定 space
  --dry-run            只打印本地待核对范围，不访问 Hindsight
  --source <mode>      auto|documents|memories；默认 auto
  --page-size <n>      远端分页大小；默认 100
  --max-pages <n>      每个 bank 最多拉取页数；默认 1000
  --show-banks         文本输出显示完整 bank id（默认显示短后缀）
  --json               输出 JSON
  --fail-on-gap        存在缺失/多余时退出码 2
  --help               显示帮助

覆盖口径:
  expected = 本地 retain 意图（排除 suppressed/skipped 与已墓碑化 representation）
  matched  = expected 中远端存在 agentnet_representation_id 的表示
  missing  = expected 中远端缺失的表示
  extra    = 远端存在但本地该 space 从未记录过的表示
  suppressed_extra = 远端存在但本地已抑制/墓碑化的表示
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function metadataRepresentationId(item: unknown): string | null {
  if (!isRecord(item)) return null;
  let metadata: Record<string, unknown> | null = null;
  const raw = item.document_metadata ?? item.metadata;
  if (isRecord(raw)) {
    metadata = raw;
  } else if (typeof raw === 'string' && raw.length > 0) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (isRecord(parsed)) metadata = parsed;
    } catch {
      metadata = null;
    }
  }
  return metadata ? stringValue(metadata.agentnet_representation_id) : null;
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/** 纯覆盖计算；测试直接断言缺失/多余/匹配。 */
export function computeWriteCoverage(
  expectedIds: readonly string[],
  knownIds: readonly string[],
  remoteIds: readonly string[],
): WriteCoverage {
  const expected = new Set(expectedIds);
  const known = new Set(knownIds);
  const remote = new Set(remoteIds);
  const matched: string[] = [];
  const missing: string[] = [];
  for (const id of expected) {
    if (remote.has(id)) matched.push(id);
    else missing.push(id);
  }
  const extra: string[] = [];
  const suppressedExtra: string[] = [];
  for (const id of remote) {
    if (!known.has(id)) extra.push(id);
    else if (!expected.has(id)) suppressedExtra.push(id);
  }
  return {
    expected: expected.size,
    matched: matched.length,
    missing: missing.sort(),
    extra: extra.sort(),
    suppressed_extra: suppressedExtra.sort(),
  };
}

function countBy(rows: readonly { status: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.status] = (counts[row.status] ?? 0) + 1;
  return counts;
}

interface SpaceRow {
  space_id: string;
  agent_actor_id: string;
  ownership_epoch: number;
  backend_binding_epoch: number;
  active: number;
}

interface IntentRow {
  representation_id: string;
  status: string;
}

interface JobRow {
  operation_type: string;
  status: string;
  stage: string;
  result_json: string | null;
  provider_job_id: string | null;
}

function loadTombstonedRepresentations(db: Database): Set<string> {
  const rows = db
    .query(
      `SELECT target_id FROM memory_tombstones
        WHERE target_kind = 'representation' AND reason <> 'recall'`,
    )
    .all() as { target_id: string }[];
  return new Set(rows.map((row) => row.target_id));
}

function loadLocalSpaces(args: AuditArgs, db: Database): LocalSpaceAudit[] {
  const spaces = db
    .query(
      `SELECT space_id, agent_actor_id, ownership_epoch, backend_binding_epoch, active
         FROM memory_spaces
        WHERE (? IS NULL OR space_id = ?)
          AND (? IS NULL OR agent_actor_id = ?)
        ORDER BY created_at, space_id`,
    )
    .all(
      args.space,
      args.space,
      args.agent,
      args.agent,
    ) as SpaceRow[];
  const tombstoned = loadTombstonedRepresentations(db);
  const result: LocalSpaceAudit[] = [];
  for (const space of spaces) {
    const intents = db
      .query(
        `SELECT representation_id, status FROM memory_retain_intents
          WHERE space_id = ? AND ownership_epoch = ?`,
      )
      .all(space.space_id, space.ownership_epoch) as IntentRow[];
    const jobs = db
      .query(
        `SELECT operation_type, status, stage, result_json, provider_job_id
           FROM memory_jobs
          WHERE space_id = ? AND ownership_epoch = ? AND operation_type = 'retain'`,
      )
      .all(space.space_id, space.ownership_epoch) as JobRow[];
    const known = new Set<string>();
    const expected = new Set<string>();
    for (const intent of intents) {
      known.add(intent.representation_id);
      if (intent.status === 'suppressed' || intent.status === 'skipped') continue;
      if (tombstoned.has(intent.representation_id)) continue;
      expected.add(intent.representation_id);
    }
    for (const id of tombstoned) known.add(id);
    const completedUnconfirmed = jobs.filter(
      (job) =>
        job.status === 'completed' &&
        (job.result_json === null || !job.result_json.includes('"remote_confirmed_at"')),
    ).length;
    result.push({
      space_id: space.space_id,
      agent_id: space.agent_actor_id,
      ownership_epoch: space.ownership_epoch,
      backend_binding_epoch: space.backend_binding_epoch,
      active: space.active === 1,
      bank_id: '',
      expected_representations: expected.size,
      known_representations: known.size,
      retain_intents: countBy(intents),
      jobs: countBy(jobs),
      jobs_submitted: jobs.filter((job) => job.provider_job_id !== null).length,
      jobs_completed_unconfirmed: completedUnconfirmed,
      expected_ids: sortedUnique(expected),
      known_ids: sortedUnique(known),
    });
  }
  return result;
}

interface FetchOptions {
  transport: HindsightTransport;
  bankId: string;
  source: AuditSource;
  pageSize: number;
  maxPages: number;
}

async function fetchDocumentIds(
  options: FetchOptions,
): Promise<RemoteBankAudit> {
  const ids = new Set<string>();
  let documents = 0;
  let pages = 0;
  let offset = 0;
  let total: number | null = null;
  for (;;) {
    pages += 1;
    const path =
      `/v1/default/banks/${encodeURIComponent(options.bankId)}/documents` +
      `?limit=${options.pageSize}&offset=${offset}`;
    const outcome = await options.transport.request('GET', path, {
      deadlineAt: null,
      retry: true,
    });
    if (outcome.kind === 'http' && outcome.status === 404) {
      return {
        bank_id: options.bankId,
        state: 'not_found',
        source: 'documents',
        items: 0,
        metadata_available: false,
        representation_ids: [],
        pages,
        error: null,
      };
    }
    if (outcome.kind !== 'ok' || !isRecord(outcome.body) || !Array.isArray(outcome.body.items)) {
      return {
        bank_id: options.bankId,
        state: 'error',
        source: 'documents',
        items: documents,
        metadata_available: false,
        representation_ids: [],
        pages,
        error: outcome.kind === 'http' ? `http_${outcome.status}` : outcome.kind,
      };
    }
    const items = outcome.body.items;
    for (const item of items) {
      documents += 1;
      const id = metadataRepresentationId(item);
      if (id) ids.add(id);
    }
    if (typeof outcome.body.total === 'number' && Number.isSafeInteger(outcome.body.total)) {
      total = outcome.body.total;
    }
    const totalIsEstimate = outcome.body.total_is_estimate === true;
    offset += items.length;
    if (
      items.length === 0 ||
      items.length < options.pageSize ||
      (total !== null && !totalIsEstimate && offset >= total) ||
      pages >= options.maxPages
    ) {
      break;
    }
  }
  return {
    bank_id: options.bankId,
    state: 'ok',
    source: 'documents',
    items: documents,
    metadata_available: ids.size > 0,
    representation_ids: sortedUnique(ids),
    pages,
    error: null,
  };
}

async function fetchMemoryIds(options: FetchOptions): Promise<RemoteBankAudit> {
  const ids = new Set<string>();
  let documents = 0;
  let pages = 0;
  let offset = 0;
  let total: number | null = null;
  for (;;) {
    pages += 1;
    const path =
      `/v1/default/banks/${encodeURIComponent(options.bankId)}/memories/list` +
      `?limit=${options.pageSize}&offset=${offset}`;
    const outcome = await options.transport.request('GET', path, {
      deadlineAt: null,
      retry: true,
    });
    if (outcome.kind === 'http' && outcome.status === 404) {
      return {
        bank_id: options.bankId,
        state: 'not_found',
        source: 'memories',
        items: 0,
        metadata_available: false,
        representation_ids: [],
        pages,
        error: null,
      };
    }
    if (outcome.kind !== 'ok' || !isRecord(outcome.body) || !Array.isArray(outcome.body.items)) {
      return {
        bank_id: options.bankId,
        state: 'error',
        source: 'memories',
        items: documents,
        metadata_available: false,
        representation_ids: [],
        pages,
        error: outcome.kind === 'http' ? `http_${outcome.status}` : outcome.kind,
      };
    }
    const items = outcome.body.items;
    for (const item of items) {
      documents += 1;
      const id = metadataRepresentationId(item);
      if (id) ids.add(id);
    }
    if (typeof outcome.body.total === 'number' && Number.isSafeInteger(outcome.body.total)) {
      total = outcome.body.total;
    }
    const totalIsEstimate = outcome.body.total_is_estimate === true;
    offset += items.length;
    if (
      items.length === 0 ||
      items.length < options.pageSize ||
      (total !== null && !totalIsEstimate && offset >= total) ||
      pages >= options.maxPages
    ) {
      break;
    }
  }
  return {
    bank_id: options.bankId,
    state: 'ok',
    source: 'memories',
    items: documents,
    metadata_available: ids.size > 0,
    representation_ids: sortedUnique(ids),
    pages,
    error: null,
  };
}

async function fetchRemoteAudit(options: FetchOptions): Promise<RemoteBankAudit> {
  if (options.source === 'memories') return fetchMemoryIds(options);
  const documents = await fetchDocumentIds(options);
  if (options.source === 'documents') return documents;
  // 文档列表没有元数据时，事实层可能仍带 metadata；自动回退一次。
  if (documents.state === 'ok' && documents.items > 0 && !documents.metadata_available) {
    const memories = await fetchMemoryIds(options);
    if (memories.state === 'ok' && memories.metadata_available) return memories;
  }
  return documents;
}

function configuredTransport(
  env: Record<string, string | undefined>,
): { transport: HindsightTransport; bankPrefix: string } {
  const loaded = loadHindsightConfigFromEnv(env);
  if (!loaded.ok) throw new Error(loaded.error);
  const resolved = resolveHindsightConfig(loaded.config);
  if (!resolved) throw new Error('Hindsight configuration is missing');
  return {
    transport: new HindsightTransport(resolved),
    bankPrefix: resolved.bankPrefix,
  };
}

export async function runHindsightWriteAudit(
  args: AuditArgs,
  env: Record<string, string | undefined> = process.env,
): Promise<AuditReport> {
  if (!existsSync(args.dbPath)) {
    throw new Error(`SQLite database not found: ${args.dbPath}`);
  }
  const db = new Database(args.dbPath, { readonly: true });
  let local: LocalSpaceAudit[];
  try {
    local = loadLocalSpaces(args, db);
  } finally {
    db.close();
  }

  let transport: HindsightTransport | null = null;
  let bankPrefix = (env.HINDSIGHT_BANK_PREFIX ?? 'agentnet').trim() || 'agentnet';
  if (!args.dryRun) {
    const configured = configuredTransport(env);
    transport = configured.transport;
    bankPrefix = configured.bankPrefix;
  }

  const reports: SpaceAuditReport[] = [];
  const seenBanks = new Set<string>();
  for (const space of local) {
    const bankId = await bankIdFor(bankPrefix, {
      space_id: space.space_id,
      ownership_epoch: space.ownership_epoch,
      backend_binding_epoch: space.backend_binding_epoch,
    });
    if (args.bank && bankId !== args.bank) continue;
    seenBanks.add(bankId);
    let remote: RemoteBankAudit | null = null;
    let coverage: WriteCoverage | null = null;
    if (transport) {
      remote = await fetchRemoteAudit({
        transport,
        bankId,
        source: args.source,
        pageSize: args.pageSize,
        maxPages: args.maxPages,
      });
      coverage =
        remote.state === 'ok' || remote.state === 'not_found'
          ? computeWriteCoverage(space.expected_ids, space.known_ids, remote.representation_ids)
          : null;
    }
    reports.push({ ...space, bank_id: bankId, remote, coverage });
  }

  // 指定 bank 在本地没有映射时仍允许只读抽查远端；本地覆盖计为 0。
  if (args.bank && reports.length === 0 && transport) {
    const remote = await fetchRemoteAudit({
      transport,
      bankId: args.bank,
      source: args.source,
      pageSize: args.pageSize,
      maxPages: args.maxPages,
    });
    reports.push({
      space_id: '',
      agent_id: '',
      ownership_epoch: 0,
      backend_binding_epoch: 0,
      active: false,
      bank_id: args.bank,
      expected_representations: 0,
      known_representations: 0,
      retain_intents: {},
      jobs: {},
      jobs_submitted: 0,
      jobs_completed_unconfirmed: 0,
      expected_ids: [],
      known_ids: [],
      remote,
      coverage:
        remote.state === 'ok' || remote.state === 'not_found'
          ? computeWriteCoverage([], [], remote.representation_ids)
          : null,
    });
    seenBanks.add(args.bank);
  }

  const totals: AuditTotals = {
    spaces: reports.length,
    banks: seenBanks.size,
    local_expected: 0,
    local_known: 0,
    expected: 0,
    matched: 0,
    missing: 0,
    extra: 0,
    suppressed_extra: 0,
    jobs_submitted: 0,
    jobs_completed_unconfirmed: 0,
  };
  for (const report of reports) {
    totals.local_expected += report.expected_representations;
    totals.local_known += report.known_representations;
    totals.jobs_submitted += report.jobs_submitted;
    totals.jobs_completed_unconfirmed += report.jobs_completed_unconfirmed;
    if (!report.coverage) continue;
    totals.expected += report.coverage.expected;
    totals.matched += report.coverage.matched;
    totals.missing += report.coverage.missing.length;
    totals.extra += report.coverage.extra.length;
    totals.suppressed_extra += report.coverage.suppressed_extra.length;
  }

  return {
    generated_at: Date.now(),
    db_path: args.dbPath,
    dry_run: args.dryRun,
    show_banks: args.showBanks,
    source: args.source,
    hindsight_configured: transport !== null,
    totals,
    spaces: reports,
  };
}

function shortBank(bankId: string, showBanks: boolean): string {
  return showBanks || bankId.length <= 12 ? bankId : `…${bankId.slice(-8)}`;
}

function formatCounts(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? 'none' : entries.map(([key, value]) => `${key}=${value}`).join(',');
}

function formatIdList(label: string, ids: readonly string[], limit = 20): string[] {
  if (ids.length === 0) return [];
  const shown = ids.slice(0, limit).join(',');
  const suffix = ids.length > limit ? `,…(+${ids.length - limit})` : '';
  return [`  ${label}: ${shown}${suffix}`];
}

export function formatAuditReport(report: AuditReport): string {
  const lines: string[] = [];
  lines.push('Hindsight write audit (read-only)');
  lines.push(`db: ${report.db_path}`);
  lines.push(`dry-run: ${report.dry_run ? 'yes (remote not contacted)' : 'no'}`);
  lines.push(`remote source: ${report.source}`);
  lines.push(
    `totals: spaces=${report.totals.spaces} banks=${report.totals.banks}` +
      ` local_expected=${report.totals.local_expected}` +
      ` local_known=${report.totals.local_known}` +
      ` coverage_expected=${report.totals.expected}` +
      ` matched=${report.totals.matched}` +
      ` missing=${report.totals.missing} extra=${report.totals.extra}` +
      ` suppressed_extra=${report.totals.suppressed_extra}` +
      ` submitted=${report.totals.jobs_submitted}` +
      ` completed_unconfirmed=${report.totals.jobs_completed_unconfirmed}`,
  );
  if (!report.dry_run && !report.hindsight_configured) {
    lines.push('remote: not configured');
  }
  for (const [index, space] of report.spaces.entries()) {
    lines.push('');
    lines.push(
      `#${index + 1} bank=${shortBank(space.bank_id, report.show_banks)}` +
        (space.space_id ? ` space=${space.space_id} agent=${space.agent_id}` : ' remote-only'),
    );
    if (space.space_id) {
      lines.push(
        `  local: expected=${space.expected_representations}` +
          ` known=${space.known_representations}` +
          ` intents={${formatCounts(space.retain_intents)}}` +
          ` jobs={${formatCounts(space.jobs)}}` +
          ` submitted=${space.jobs_submitted}` +
          ` completed_unconfirmed=${space.jobs_completed_unconfirmed}`,
      );
    }
    if (space.remote) {
      lines.push(
        `  remote: state=${space.remote.state} source=${space.remote.source}` +
          ` items=${space.remote.items} pages=${space.remote.pages}` +
          ` metadata=${space.remote.metadata_available ? 'yes' : 'no'}` +
          (space.remote.error ? ` error=${space.remote.error}` : ''),
      );
    }
    if (space.coverage) {
      lines.push(
        `  coverage: expected=${space.coverage.expected} matched=${space.coverage.matched}` +
          ` missing=${space.coverage.missing.length}` +
          ` extra=${space.coverage.extra.length}` +
          ` suppressed_extra=${space.coverage.suppressed_extra.length}`,
      );
      lines.push(...formatIdList('missing_ids', space.coverage.missing));
      lines.push(...formatIdList('extra_ids', space.coverage.extra));
      lines.push(...formatIdList('suppressed_ids', space.coverage.suppressed_extra));
    }
  }
  return lines.join('\n');
}

export function parseAuditArgs(argv: readonly string[]): AuditArgs | { help: true } {
  const env = process.env;
  let dbPath = env.DATABASE_PATH?.trim() || '';
  if (!dbPath) {
    const dataDir = env.DATA_DIR?.trim() || '.data';
    dbPath = resolve(dataDir, 'agent-network.sqlite');
  }
  const args: AuditArgs = {
    dbPath,
    bank: null,
    agent: null,
    space: null,
    dryRun: false,
    json: false,
    showBanks: false,
    failOnGap: false,
    source: 'auto',
    pageSize: 100,
    maxPages: 1000,
  };
  const value = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    return next;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    switch (arg) {
      case '--help':
      case '-h':
        return { help: true };
      case '--db':
        args.dbPath = value(index, arg);
        index += 1;
        break;
      case '--bank':
        args.bank = value(index, arg);
        index += 1;
        break;
      case '--agent':
        args.agent = value(index, arg);
        index += 1;
        break;
      case '--space':
        args.space = value(index, arg);
        index += 1;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--show-banks':
        args.showBanks = true;
        break;
      case '--fail-on-gap':
        args.failOnGap = true;
        break;
      case '--source': {
        const source = value(index, arg) as AuditSource;
        if (!['auto', 'documents', 'memories'].includes(source)) {
          throw new Error('--source must be auto, documents or memories');
        }
        args.source = source;
        index += 1;
        break;
      }
      case '--page-size': {
        const parsed = Number(value(index, arg));
        if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) {
          throw new Error('--page-size must be an integer between 1 and 1000');
        }
        args.pageSize = parsed;
        index += 1;
        break;
      }
      case '--max-pages': {
        const parsed = Number(value(index, arg));
        if (!Number.isSafeInteger(parsed) || parsed < 1) {
          throw new Error('--max-pages must be a positive integer');
        }
        args.maxPages = parsed;
        index += 1;
        break;
      }
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return args;
}

export function auditHelp(): string {
  return HELP;
}

/** 供测试与运维复用的只读配置解析；不打印凭据。 */
export function auditTransport(
  env: Record<string, string | undefined> = process.env,
): { transport: HindsightTransport; bankPrefix: string } {
  return configuredTransport(env);
}
