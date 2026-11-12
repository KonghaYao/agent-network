/**
 * Q05 并发故障与越权对抗验收的共享夹具。
 *
 * 只使用公开 HTTP/MCP 工具、临时自托管 Bun 实例与同一 DATA_DIR 的新进程，
 * 不修改生产语义。所有 token 仅保存在内存；日志与失败详情只输出场景、轮次、
 * actor_id、request_id 与错误码，不输出凭据、消息正文或连接串。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { Database } from 'bun:sqlite';

import { parseSseJsonText } from '../../src/contracts/sse';
import { rawRpc, sleep, waitUntil } from './harness';
import { reservePort, startTestServer, type TestServer } from './test-server';

export { sleep, waitUntil };

export const DEFAULT_SEED = 20261108;
export const DEFAULT_ROUNDS = 100;
export const Q05_STREAM_URI = 'agentnet://stream';

const FILE_TICKET_SECRET = `q05_${crypto.randomUUID().replaceAll('-', '')}`;

export function seedFromEnv(): number {
  const raw = process.env.Q05_SEED;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_SEED;
}

export function roundsFromEnv(): number {
  const raw = process.env.Q05_ROUNDS;
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ROUNDS;
}

/** 固定种子的确定性 PRNG；轮次调度、候选顺序与操作顺序都由它派生。 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function roundSeed(seed: number, scenarioIndex: number, round: number): number {
  return (seed ^ Math.imul(scenarioIndex + 1, 0x9e3779b1) ^ Math.imul(round, 0x85ebca6b)) >>> 0;
}

export function shuffle<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    const current = copy[index]!;
    copy[index] = copy[target]!;
    copy[target] = current;
  }
  return copy;
}

export class Q05ToolError extends Error {
  constructor(
    readonly code: string,
    readonly details: Record<string, unknown>,
    message = '',
  ) {
    super(`${code}${message ? `: ${message}` : ''}`);
    this.name = 'Q05ToolError';
  }
}

export interface ToolResultView<T> {
  ok: boolean;
  value?: T;
  code?: string;
  details?: Record<string, unknown>;
}

export interface Q05ServerOptions {
  /** 仅用于断点复现：同一 DATA_DIR 保持，端口可重新分配。 */
  dataDir?: string;
  port?: number;
}

export class Q05Server {
  readonly dataDir: string;
  readonly dbPath: string;
  port: number;
  base: string;
  private server: TestServer | null = null;

  private constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.dbPath = resolve(dataDir, 'agent-network.sqlite');
    this.port = 0;
    this.base = '';
  }

  static async start(options: Q05ServerOptions = {}): Promise<Q05Server> {
    const dataDir =
      options.dataDir ?? (await mkdtemp(join(tmpdir(), `agentnet-q05-${process.pid}-`)));
    const server = new Q05Server(dataDir);
    await server.spawn(options.port);
    process.env.AGENTNET_URL = server.base;
    return server;
  }

  private async spawn(preferredPort?: number): Promise<void> {
    const port = preferredPort ?? reservePort();
    const base = `http://127.0.0.1:${port}`;
    const server = await startTestServer({
      port,
      dataDir: this.dataDir,
      tag: 'q05',
      env: {
        PUBLIC_ORIGIN: base,
        ENVIRONMENT: 'test',
        NODE_ENV: 'test',
        // 短 presence 窗口只影响在线提示，不改变消息、任务与授权语义。
        AGENT_PRESENCE_GRACE_MS: '1200',
        AGENT_PRESENCE_ACTIVITY_TTL_MS: '1200',
        AGENT_PRESENCE_TOUCH_THROTTLE_MS: '100',
        AGENT_PRESENCE_SWEEP_MS: '150',
        // 重启后旧下载票据仍可验证；测试进程内固定，不写入仓库。
        FILE_TICKET_SECRET,
      },
    });
    this.server = server;
    this.port = server.port;
    this.base = server.base;
  }

  stderrSummary(): string {
    // 服务端日志本身不含 token/正文；这里再截断一次，只用于失败诊断。
    return this.server?.tail() ?? '';
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await server.stop();
  }

  /** 用新进程读同一 DATA_DIR；优先复用原端口，让已签发的上传 URL 仍可用。 */
  async restart(): Promise<void> {
    await this.stop();
    const previousPort = this.port;
    try {
      await this.spawn(previousPort);
    } catch {
      await Bun.sleep(200);
      await this.spawn();
    }
    process.env.AGENTNET_URL = this.base;
  }

  async destroy(): Promise<void> {
    await this.stop();
    await rm(this.dataDir, { recursive: true, force: true });
  }

  db(): Q05Db {
    return new Q05Db(this.dbPath);
  }
}

/** 测试进程侧的权威数据读取；只用于断言与受控故障注入，不替代业务写入。 */
export class Q05Db {
  readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  scalar(sql: string, ...params: (string | number | null)[]): number {
    const row = this.db.prepare(sql).get(...params) as { n?: number | null } | null;
    return Number(row?.n ?? 0);
  }

  row<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T | null {
    return (this.db.prepare(sql).get(...params) as T | undefined) ?? null;
  }

  rows<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  exec(sql: string, ...params: (string | number | null)[]): void {
    this.db.prepare(sql).run(...params);
  }

  close(): void {
    this.db.close();
  }
}

/** 直接对临时数据库做受控夹具注入（仅测试进程，不改业务代码）。 */
export function openQ05Db(dbPath: string): Q05Db {
  return new Q05Db(dbPath);
}

const recentRequestIds: string[] = [];

export function newRequestId(prefix = 'q05'): string {
  const id = `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
  recentRequestIds.push(id);
  if (recentRequestIds.length > 600) recentRequestIds.splice(0, recentRequestIds.length - 600);
  return id;
}

export function beginQ05Round(): void {
  recentRequestIds.length = 0;
}

export function recentQ05RequestIds(limit = 40): string[] {
  return recentRequestIds.slice(-limit);
}

export function newToken(): string {
  return crypto.randomUUID();
}

export async function q05Tool<T = Record<string, unknown>>(
  server: Q05Server,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const response = await rawRpc('tools/call', { name, arguments: args }, {
    token,
    url: new URL(`${server.base}/mcp`),
  });
  const transportError = response.body.error as
    | { code?: number | string; message?: string; data?: Record<string, unknown> }
    | undefined;
  if (transportError) {
    const code = String(transportError.data?.code ?? transportError.code ?? 'UNKNOWN');
    throw new Q05ToolError(
      code,
      (transportError.data as Record<string, unknown> | undefined) ?? {},
      String(transportError.message ?? ''),
    );
  }
  const result = response.body.result as
    | {
        isError?: boolean;
        structuredContent?: T;
        content?: { type: string; text?: string }[];
      }
    | undefined;
  if (!result) throw new Error(`工具 ${name} 无结果`);
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (result.isError) {
    let detail: { code?: string; message?: string; details?: unknown } = {};
    if (text) {
      try {
        detail = JSON.parse(text) as typeof detail;
      } catch {
        detail = { message: text };
      }
    }
    const details =
      typeof detail.details === 'object' && detail.details !== null
        ? (detail.details as Record<string, unknown>)
        : {};
    throw new Q05ToolError(detail.code ?? 'UNKNOWN', details, detail.message ?? '');
  }
  if (result.structuredContent) return result.structuredContent;
  return (text ? JSON.parse(text) : {}) as T;
}

export async function q05ToolOutcome<T>(
  server: Q05Server,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResultView<T>> {
  try {
    return { ok: true, value: await q05Tool<T>(server, token, name, args) };
  } catch (error) {
    if (error instanceof Q05ToolError) {
      return { ok: false, code: error.code, details: error.details };
    }
    throw error;
  }
}

/**
 * 同时放行一批调用：所有 Promise 在放行前已注册，避免串行循环冒充并发。
 * 返回 `Promise.allSettled`，由场景按真实错误码裁决。
 */
export async function burst<T>(
  count: number,
  fn: (index: number) => Promise<T>,
): Promise<PromiseSettledResult<T>[]> {
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const calls = Array.from({ length: count }, (_, index) => gate.then(() => fn(index)));
  release();
  return Promise.allSettled(calls);
}

export function fulfilled<T>(results: PromiseSettledResult<T>[]): T[] {
  return results.flatMap((item) => (item.status === 'fulfilled' ? [item.value] : []));
}

export function rejectedCodes<T>(results: PromiseSettledResult<T>[]): string[] {
  return results.flatMap((item) =>
    item.status === 'rejected'
      ? [item.reason instanceof Q05ToolError ? item.reason.code : String(item.reason)]
      : [],
  );
}

let checks = 0;
const failures: {
  scenario: string;
  round: number;
  label: string;
  requestIds: string[];
}[] = [];

export function q05Check(label: string, condition: unknown, detail?: unknown): void {
  checks += 1;
  if (!condition) {
    const suffix = detail === undefined ? '' : ` (${safeDetail(detail)})`;
    throw new Error(`${label}${suffix}`);
  }
}

export function q05Equal(label: string, actual: unknown, expected: unknown): void {
  q05Check(label, Object.is(actual, expected), { actual, expected });
}

export function q05Checks(): number {
  return checks;
}

export function q05Failures(): typeof failures {
  return failures;
}

export function resetQ05Checks(): void {
  checks = 0;
  failures.length = 0;
}

function safeDetail(detail: unknown): string {
  try {
    // 只输出短结构；调用方不得传入 token/正文。
    return JSON.stringify(detail).slice(0, 600);
  } catch {
    return String(detail).slice(0, 600);
  }
}

export interface ScenarioResult {
  name: string;
  rounds: number;
  passed: number;
  failed: number;
  checks: number;
  failures: { round: number; label: string; requestIds: string[] }[];
  durationMs: number;
}

export type RoundBody = (round: number, random: () => number) => Promise<void>;

export interface ScenarioOptions {
  seed: number;
  rounds: number;
  roundFilter?: number;
  /** 每轮成功后的全局不变量审计；失败计为该轮失败。 */
  audit?: (round: number) => void | Promise<void>;
}

/** 每轮结束后的全局权威不变量审计。 */
export function auditQ05Invariants(db: Q05Db, context: string, round: number): void {
  const prefix = `${context} 第 ${round} 轮全局`;
  q05Equal(
    `${prefix} 单群主`,
    db.scalar(
      `SELECT COUNT(*) AS n FROM rooms r
        WHERE r.kind = 'group' AND r.dissolved_at IS NULL
          AND (r.owner_id IS NULL OR (
            SELECT COUNT(*) FROM room_members m
             WHERE m.room_id = r.room_id AND m.status = 'active' AND m.role = 'owner') <> 1)`,
    ),
    0,
  );
  q05Equal(
    `${prefix} 无双 active 好友关系`,
    db.scalar(
      `SELECT COUNT(*) AS n FROM (
         SELECT pair_key FROM contact_relations
          WHERE status = 'active' GROUP BY pair_key HAVING COUNT(*) > 1)`,
    ),
    0,
  );
  q05Equal(
    `${prefix} 无双有效拉黑`,
    db.scalar(
      `SELECT COUNT(*) AS n FROM (
         SELECT blocker_actor_id, blocked_actor_id FROM contact_blocks
          WHERE released_at IS NULL GROUP BY blocker_actor_id, blocked_actor_id HAVING COUNT(*) > 1)`,
    ),
    0,
  );
  q05Equal(
    `${prefix} 无悬挂 active file_reference`,
    db.scalar(
      `SELECT COUNT(*) AS n FROM file_references fr
         LEFT JOIN drive_files df ON df.file_id = fr.file_id
         LEFT JOIN room_files rf ON rf.file_id = fr.file_id
        WHERE fr.state = 'active'
          AND (df.file_id IS NULL OR df.state = 'deleted' OR df.purged_at IS NOT NULL
               OR rf.deleted_at IS NOT NULL)`,
    ),
    0,
  );
  q05Equal(
    `${prefix} Agent 单有效运行凭据`,
    db.scalar(
      `SELECT COUNT(*) AS n FROM (
         SELECT c.actor_id FROM credentials c JOIN actors a ON a.actor_id = c.actor_id
          WHERE a.kind = 'agent' AND c.revoked_at IS NULL
          GROUP BY c.actor_id HAVING COUNT(*) > 1)`,
    ),
    0,
  );
}

/** 顺序执行轮次；每轮内部自行使用 burst 形成真实并发。 */
export async function runScenario(
  name: string,
  options: ScenarioOptions,
  body: RoundBody,
): Promise<ScenarioResult> {
  const startedAt = Date.now();
  const before = checks;
  const result: ScenarioResult = {
    name,
    rounds: 0,
    passed: 0,
    failed: 0,
    checks: 0,
    failures: [],
    durationMs: 0,
  };
  const rounds = options.roundFilter ? [options.roundFilter] : Array.from({ length: options.rounds }, (_, index) => index + 1);
  process.stdout.write(`· ${name}（${rounds.length} 轮）\n`);
  for (const round of rounds) {
    const random = mulberry32(roundSeed(options.seed, scenarioHash(name), round));
    beginQ05Round();
    try {
      await body(round, random);
      if (options.audit) await options.audit(round);
      result.passed += 1;
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      const requestIds = recentQ05RequestIds();
      result.failures.push({ round, label: message.slice(0, 1800), requestIds });
      failures.push({ scenario: name, round, label: message.slice(0, 1800), requestIds });
      if (result.failed >= 10) break;
    }
    result.rounds += 1;
    if (result.rounds % 20 === 0) {
      process.stdout.write(
        `  ${name}: ${result.rounds} 轮 / 通过 ${result.passed} / 失败 ${result.failed}\n`,
      );
    }
  }
  result.checks = checks - before;
  result.durationMs = Date.now() - startedAt;
  process.stdout.write(
    `  ${name}: ${result.passed}/${result.rounds} 通过，${result.checks} 项断言，${(result.durationMs / 1000).toFixed(1)}s\n`,
  );
  if (result.failed > 0) {
    const first = result.failures[0]!;
    process.stdout.write(`  首个失败：第 ${first.round} 轮 · ${first.label}\n`);
    if (first.requestIds.length > 0) {
      process.stdout.write(`  请求 ID（最后 40 个）：${first.requestIds.join(',')}\n`);
    }
    process.stdout.write(
      `  复现：Q05_SEED=${options.seed} bun scripts/verify-q05.ts --scenario=${name} --round=${first.round}\n`,
    );
  }
  return result;
}

function scenarioHash(name: string): number {
  let hash = 2166136261;
  for (const char of name) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export interface Q05Actor {
  actor_id: string;
  token: string;
  kind: 'human' | 'agent';
  name: string;
  agent_session_id?: string;
  share_url?: string;
}

export async function registerHuman(
  server: Q05Server,
  name: string,
): Promise<Q05Actor> {
  const token = newToken();
  const actor = await q05Tool<{ actor_id: string }>(server, token, 'network_register', {
    request_id: newRequestId('reg'),
    kind: 'human',
    name,
  });
  return { actor_id: actor.actor_id, token, kind: 'human', name };
}

export async function createManagedAgent(
  server: Q05Server,
  managerToken: string,
  name: string,
): Promise<Q05Actor> {
  const created = await q05Tool<{
    actor_id: string;
    token: string;
    agent_session_id: string;
    share_url: string;
  }>(server, managerToken, 'network_agent_create', {
    request_id: newRequestId('agent'),
    name,
  });
  return {
    actor_id: created.actor_id,
    token: created.token,
    kind: 'agent',
    name,
    agent_session_id: created.agent_session_id,
    share_url: created.share_url,
  };
}

export async function befriend(
  server: Q05Server,
  requester: Q05Actor,
  target: Q05Actor,
): Promise<void> {
  const requested = await q05Tool<{
    status: string;
    request?: { contact_request_id: string };
  }>(server, requester.token, 'network_contact_request', {
    request_id: newRequestId('creq'),
    actor_id: target.actor_id,
  });
  if (requested.status === 'accepted') return;
  if (requested.status !== 'pending' || !requested.request) {
    throw new Error(`好友申请未进入 pending/accepted: ${requested.status}`);
  }
  await q05Tool(server, target.token, 'network_contact_request_respond', {
    request_id: newRequestId('cres'),
    contact_request_id: requested.request.contact_request_id,
    action: 'accept',
  });
}

export async function acceptPendingInvites(
  server: Q05Server,
  actor: Q05Actor,
  roomId: string,
): Promise<number> {
  const page = await q05Tool<{
    items: { invitation_id: string; room_id: string; status: string; can_respond: boolean }[];
  }>(server, actor.token, 'network_room_invite_get', { limit: 100 });
  let accepted = 0;
  for (const item of page.items) {
    if (item.room_id !== roomId || item.status !== 'pending' || !item.can_respond) continue;
    await q05Tool(server, actor.token, 'network_room_invite_respond', {
      request_id: newRequestId('invite'),
      invitation_id: item.invitation_id,
      action: 'accept',
    });
    accepted += 1;
  }
  return accepted;
}

/**
 * 建群并让人类成员接受邀请；owner 管理的 Agent 直接 active。
 * 返回 room_id；调用方负责断言成员状态。
 */
export async function createGroup(
  server: Q05Server,
  owner: Q05Actor,
  members: Q05Actor[],
  title: string,
): Promise<string> {
  const created = await q05Tool<{ room: { room_id: string }; results?: unknown[] }>(
    server,
    owner.token,
    'network_room_create',
    {
      request_id: newRequestId('room'),
      kind: 'group',
      members: members.map((member) => member.actor_id),
      title,
    },
  );
  const roomId = created.room.room_id;
  for (const member of members) {
    if (member.kind === 'human') await acceptPendingInvites(server, member, roomId);
  }
  return roomId;
}

export async function sendMessage(
  server: Q05Server,
  actor: Q05Actor,
  roomId: string,
  body: string,
  options: {
    clientMessageId?: string;
    requestId?: string;
    invoke?: string[];
  } = {},
): Promise<{
  message: { message_id: string; created_seq: string; body_bytes: number; preview: string };
  delivery_ids: string[];
}> {
  return q05Tool(server, actor.token, 'network_message_send', {
    request_id: options.requestId ?? newRequestId('send'),
    client_message_id: options.clientMessageId ?? `cm_${crypto.randomUUID()}`,
    room_id: roomId,
    body,
    ...(options.invoke ? { invoke: options.invoke } : {}),
  });
}

/** 清理 Agent 收件箱中本轮产生的投递，避免队列/单 claimed 限制污染后续轮次。 */
export async function drainDelivery(
  server: Q05Server,
  actor: Q05Actor,
  deliveryId: string,
): Promise<void> {
  const claim = await q05ToolOutcome<{ attempt: number; claim_id: string }>(
    server,
    actor.token,
    'network_delivery_claim',
    { request_id: newRequestId('dclaim'), delivery_id: deliveryId },
  ).catch(() => undefined);
  if (!claim?.ok || typeof claim.value?.claim_id !== 'string') {
    await q05ToolOutcome(server, actor.token, 'network_delivery_cancel', {
      request_id: newRequestId('dcancel'),
      delivery_id: deliveryId,
    });
    return;
  }
  await q05ToolOutcome(server, actor.token, 'network_delivery_complete', {
    request_id: newRequestId('dcomplete'),
    delivery_id: deliveryId,
    attempt: claim.value.attempt,
    claim_id: claim.value.claim_id,
    final_body: 'Q05 并发验收清理',
  });
}

/** 保证测试成员在群内 active；被移除后按真实成员入口重新加入。 */
export async function ensureRoomMember(
  server: Q05Server,
  db: Q05Db,
  owner: Q05Actor,
  roomId: string,
  actor: Q05Actor,
): Promise<void> {
  const active = db.scalar(
    "SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND actor_id = ? AND status = 'active'",
    roomId,
    actor.actor_id,
  );
  if (active > 0) return;
  await q05Tool(server, owner.token, 'network_room_members_update', {
    request_id: newRequestId('ensure_member'),
    room_id: roomId,
    add: [actor.actor_id],
  });
}

/** 场景清理：按数据库当前 owner 解散临时群，避免累计触达活跃房间上限。 */
export async function dissolveGroupQuietly(
  server: Q05Server,
  db: Q05Db,
  roomId: string,
  candidates: Q05Actor[],
): Promise<void> {
  const row = db.row<{ owner_id: string | null; dissolved_at: number | null }>(
    'SELECT owner_id, dissolved_at FROM rooms WHERE room_id = ?',
    roomId,
  );
  if (!row || row.dissolved_at !== null || !row.owner_id) return;
  const owner = candidates.find((actor) => actor.actor_id === row.owner_id);
  if (!owner) return;
  await q05ToolOutcome(server, owner.token, 'network_room_dissolve', {
    request_id: newRequestId('scenario_cleanup'),
    room_id: roomId,
    reason: 'Q05 场景清理',
  }).catch(() => undefined);
}

export interface Q05Stream {
  frames: string[];
  response: Response;
  waitFor(predicate: (frame: string) => boolean, label: string, timeoutMs?: number): Promise<string>;
  /** 连接被服务端关闭或客户端中止时 resolve。 */
  closed: Promise<void>;
  isClosed(): boolean;
  close(): Promise<void>;
}

/**
 * 原始 SSE 订阅：与生产客户端一致走 `subscriptions/listen`，用于观察
 * 设备撤销后服务端主动断开，以及重启后的补读去重。
 */
export async function openQ05Stream(
  server: Q05Server,
  token: string,
  uris: string[],
): Promise<Q05Stream> {
  const controller = new AbortController();
  const response = await fetch(`${server.base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'mcp-method': 'subscriptions/listen',
      'mcp-protocol-version': '2026-07-28',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: newRequestId('sub'),
      method: 'subscriptions/listen',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'q05-raw-listen', version: '0.1.0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
        notifications: { resourceSubscriptions: uris },
      },
    }),
    signal: controller.signal,
  });
  const frames: string[] = [];
  let buffer = '';
  let closed = false;
  let resolveClosed!: () => void;
  const closedPromise = new Promise<void>((resolveClosedPromise) => {
    resolveClosed = resolveClosedPromise;
  });
  const pump = (async () => {
    try {
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const index = buffer.indexOf('\n\n');
          if (index < 0) break;
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (frame.trim().length > 0) frames.push(frame);
        }
      }
    } catch {
      // abort / 连接重置都视为关闭
    } finally {
      closed = true;
      resolveClosed();
    }
  })();
  return {
    frames,
    response,
    async waitFor(predicate, label, timeoutMs = 10_000) {
      await waitUntil(
        label,
        () => frames.some(predicate) || closed,
        timeoutMs,
        25,
      );
      const found = frames.find(predicate);
      if (!found) throw new Error(`${label}: 流已关闭或等待帧超时`);
      return found;
    },
    closed: closedPromise,
    isClosed: () => closed,
    async close() {
      controller.abort();
      await pump.catch(() => undefined);
    },
  };
}

export function streamEventIds(frames: string[]): string[] {
  const ids: string[] = [];
  for (const frame of frames) {
    const payload = parseSseJsonText(frame) as {
      params?: {
        _meta?: {
          'io.agent-network/event'?: { items?: { event_id?: string; seq?: string }[] };
        };
      };
    } | null;
    if (!payload) continue;
    for (const item of payload.params?._meta?.['io.agent-network/event']?.items ?? []) {
      const id = item.event_id ?? item.seq;
      if (id) ids.push(String(id));
    }
  }
  return ids;
}

export function waitForCondition(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 25,
): Promise<void> {
  return waitUntil(label, predicate, timeoutMs, intervalMs);
}

/**
 * 受控 HTTP 边界故障：命中 `x-q05-drop: 1` 的请求先完整转发到被测服务，
 * 等业务提交后再让客户端读到断开的响应体。用于“提交成功 × 响应丢失”，
 * 不改服务端语义，也不记录请求正文。
 */
export function startDropProxy(targetBase: string): {
  base: string;
  stop(): Promise<void>;
} {
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const drop = request.headers.get('x-q05-drop') === '1';
      const forwardedHeaders = new Headers(request.headers);
      forwardedHeaders.delete('host');
      forwardedHeaders.delete('x-q05-drop');
      const upstream = await fetch(`${targetBase}${url.pathname}${url.search}`, {
        method: request.method,
        headers: forwardedHeaders,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer(),
      });
      if (!drop) {
        return new Response(upstream.body, {
          status: upstream.status,
          headers: upstream.headers,
        });
      }
      // 先把上游完整读完，确保 side effect 已提交；再把客户端连接打断。
      await upstream.arrayBuffer();
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('q05 response dropped after commit'));
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });
  return {
    base: `http://127.0.0.1:${proxy.port}`,
    async stop() {
      proxy.stop(true);
      await Promise.resolve();
    },
  };
}
