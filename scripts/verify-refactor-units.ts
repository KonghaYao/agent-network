/**
 * Phase 1 重构单测：不依赖外部服务的纯本地断言。
 *
 * 覆盖共享 SSE 解析、GUARDS 与迁移一致性、Range/资源路由、下载原子写、
 * aborted sleep、限流缓存有界、撤销缓存有界与 webhook 工作池。
 */

import { Database } from 'bun:sqlite';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';

import { createD1 } from '../src/bun/d1';
import { migrate } from '../src/bun/migrate';
import { LIMITS } from '../src/contracts/limits';
import { parseSseJsonText, sseMessageStream } from '../src/contracts/sse';
import { encryptSecret } from '../src/events/security';
import { drainEventDeliveries } from '../src/events/dispatcher';
import {
  beginVerification,
  verificationAttemptHostCount,
} from '../src/events/subscriptions';
import type { Env } from '../src/env';
import { NotificationHub } from '../src/realtime/hub';
import { AgentPresenceTimeline } from '../src/realtime/presence-timeline';
import { GUARDS } from '../src/storage/guards';
import { getMember, getRoom } from '../src/storage/queries';
import { CAPABILITY_PREDICATES, roomCapabilitiesFor, type RoomCapability } from '../src/domain/room-access';
import { hashSecret, hashToken, sortedPairKey } from '../src/storage/db';
import { sortedPairKeySql } from '../src/storage/pair-key';
import { decodeCursor, encodeCursor } from '../src/contracts/cursor';
import { parseMetadataObject } from '../src/contracts/metadata';
import {
  exceedsUtf8Bytes,
  hasControlChars,
  replaceControlChars,
  utf8Text,
} from '../src/contracts/text';
import { createApp, parseByteRange } from '../src/app';
import { isSupportedDshVersion } from '../client/monitor/dsh-install';
import { abortableSleep } from '../client/monitor/engine';
import { acquireLock } from '../client/monitor/locks';
import { MonitorState } from '../client/monitor/state';
import { writeAtomic } from '../client/monitor/dsh-state';
import { download } from '../client/commands/files';
import type { McpClient, ResolvedConfig } from '../client/mcp';
import { check, checkEqual, checksPassed, sleep } from './lib/harness';
import {
  ensureTestCertificate,
  startTestReceiver,
} from './lib/events-harness';

const ROOT = resolve(import.meta.dir, '..');
const MIGRATIONS = join(ROOT, 'migrations');
const NOW = Date.now();

async function expectThrows(label: string, fn: () => Promise<unknown>, code?: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (code !== undefined) {
      const actual = (error as { code?: unknown }).code;
      checkEqual(`${label} 错误码`, actual, code);
    }
    return;
  }
  throw new Error(`${label}：预期抛错但成功返回`);
}

function freshDb(): Database {
  const db = new Database(':memory:');
  migrate(db, MIGRATIONS);
  return db;
}

function decodeChunks(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
  });
}

async function sseChecks(): Promise<void> {
  checkEqual(
    'SSE BOM + CRLF 解析',
    JSON.stringify(parseSseJsonText('\uFEFFdata: {"ok":1}\r\n\r\n')),
    JSON.stringify({ ok: 1 }),
  );
  checkEqual(
    'SSE 多行 data 合并',
    JSON.stringify(parseSseJsonText('event: message\nid: 7\ndata: {"a":\ndata: 1}\n\n')),
    JSON.stringify({ a: 1 }),
  );
  checkEqual(
    'SSE CR-only 行结束',
    JSON.stringify(parseSseJsonText('data: {"cr":true}\r\r')),
    JSON.stringify({ cr: true }),
  );
  checkEqual('SSE 注释与 retry 忽略', parseSseJsonText(': keepalive\nretry: 3000\n\n'), null);
  checkEqual('SSE 非法 JSON 忽略', parseSseJsonText('data: not-json\n\n'), null);

  const encoder = new TextEncoder();
  const body = encoder.encode('\uFEFFid: 42\r\ndata: {"text":"中文"}\r\n\r\n');
  const split = Math.floor(body.length / 2);
  const events = [];
  for await (const event of sseMessageStream(
    decodeChunks([body.slice(0, split), body.slice(split)]),
  )) {
    events.push(event);
  }
  checkEqual('SSE 流事件数', events.length, 1);
  checkEqual('SSE 流 id', events[0]?.id, '42');
  checkEqual('SSE 流多字节跨 chunk', events[0]?.data, '{"text":"中文"}');
}

function guardChecks(db: Database): void {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name),
  );
  for (const [name, definition] of Object.entries(GUARDS)) {
    check(`guard ${name} 表存在`, tables.has(definition.table), definition.table);
  }
  checkEqual('删除 taskConflict stale 键', (GUARDS as Record<string, unknown>).taskConflict, undefined);
  checkEqual('删除 handoffConflict stale 键', (GUARDS as Record<string, unknown>).handoffConflict, undefined);
  checkEqual('notMember 错误码不变', GUARDS.notMember.code, 'NOT_MEMBER');
  checkEqual('notMember 文案不变', GUARDS.notMember.message, '当前身份不是该房间的有效成员');
  checkEqual(
    'eventSubscriptionLimit details 不变',
    String(GUARDS.eventSubscriptionLimit.details?.max),
    String(LIMITS.eventsSubscriptionsPerActor),
  );
  checkEqual(
    'roomDissolved details 不变',
    JSON.stringify(GUARDS.roomDissolved.details),
    JSON.stringify({ reason: 'room_dissolved', read_only: true }),
  );
}

function rangeParserChecks(): void {
  checkEqual('Range 闭区间', JSON.stringify(parseByteRange('bytes=0-4', 10)), JSON.stringify({ start: 0, end: 4 }));
  checkEqual('Range 开放结尾', JSON.stringify(parseByteRange('bytes=7-', 10)), JSON.stringify({ start: 7, end: 9 }));
  checkEqual('Range 后缀', JSON.stringify(parseByteRange('bytes=-3', 10)), JSON.stringify({ start: 7, end: 9 }));
  checkEqual('Range 超出返回 416', parseByteRange('bytes=10-', 10), 'unsatisfiable');
  checkEqual('Range 反向返回 416', parseByteRange('bytes=5-2', 10), 'unsatisfiable');
  checkEqual('Range 多段忽略', parseByteRange('bytes=0-1,3-4', 10), null);
  checkEqual('空文件忽略 Range', parseByteRange('bytes=0-1', 0), null);
}

function fakeAppEnv(driveRow: Record<string, unknown>, getStream: (key: string, options?: unknown) => Readable, calls: unknown[]): Env {
  const db = {
    prepare(sql: string) {
      return {
        bind: () => ({
          first: async () => (sql.includes('drive_files') ? driveRow : null),
        }),
      };
    },
  };
  const files = {
    readRecord: async () => ({
      schemaVersion: 2,
      namespace: 'test',
      fileId: `f_${'T'.repeat(22)}`,
      name: 'sample.txt',
      mimeType: 'text/plain',
      size: 10,
      sha256: 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ownerScope: 'scope_test',
      payloadKey: 'payload_test',
    }),
    disk: {
      getStream: async (key: string, options?: unknown) => {
        calls.push({ key, options });
        return getStream(key, options);
      },
    },
  };
  return {
    DB: db as unknown as D1Database,
    NOTIFICATION_HUB: new NotificationHub(new Database(':memory:')),
    ENVIRONMENT: 'test',
    PUBLIC_ORIGIN: 'http://127.0.0.1',
    FILE_TICKET_SECRET: 'unit-secret',
    FILES: files as unknown as Env['FILES'],
  } as Env;
}

async function httpChecks(): Promise<void> {
  const fileId = `f_${'T'.repeat(22)}`;
  const driveRow = {
    file_id: fileId,
    owner_scope: 'scope_test',
    uploader_id: 'actor_test',
    name: 'sample.txt',
    mime_type: 'text/plain',
    size: 10,
    sha256: 'a'.repeat(64),
    state: 'bound',
    visibility: 'public',
    room_id: null,
    created_at: NOW,
    expires_at: null,
    retained: 1,
    deleted_at: null,
    deleted_by: null,
    purged_at: null,
  };
  const calls: Array<{ key: string; options?: unknown }> = [];
  const payload = Buffer.from('0123456789');
  const app = createApp(
    fakeAppEnv(driveRow, (_key, options) => {
      const range = (options as { range?: { start: number; end: number } } | undefined)?.range;
      return Readable.from([range ? payload.subarray(range.start, range.end + 1) : payload]);
    }, calls),
    {},
  );

  const full = await app.request(`/f/${fileId}`);
  checkEqual('GET 完整文件状态', full.status, 200);
  checkEqual('GET 完整文件正文', await full.text(), '0123456789');
  checkEqual('GET 完整文件不传 range', calls[0]?.options, undefined);

  calls.length = 0;
  const partial = await app.request(`/f/${fileId}`, { headers: { range: 'bytes=2-5' } });
  checkEqual('Range 206', partial.status, 206);
  checkEqual('Range 正文', await partial.text(), '2345');
  checkEqual('Range content-range', partial.headers.get('content-range'), 'bytes 2-5/10');
  checkEqual('Range content-length', partial.headers.get('content-length'), '4');
  checkEqual('Range 传偏移给 FlyDrive', JSON.stringify(calls[0]?.options), JSON.stringify({
    range: { start: 2, end: 5 },
  }));

  const invalid = await app.request(`/f/${fileId}`, { headers: { range: 'bytes=20-25' } });
  checkEqual('Range 416', invalid.status, 416);
  checkEqual('Range 416 content-range', invalid.headers.get('content-range'), 'bytes */10');

  calls.length = 0;
  const head = await app.request(`/f/${fileId}`, { method: 'HEAD' });
  checkEqual('HEAD 200', head.status, 200);
  checkEqual('HEAD 不读载荷', calls.length, 0);

  const notModified = await app.request(`/f/${fileId}`, {
    headers: { 'if-none-match': `"${'a'.repeat(64)}"` },
  });
  checkEqual('304', notModified.status, 304);
  checkEqual('304 无正文', await notModified.text(), '');

  const assetDeps = {
    markdownAsset: 'markdown-bundle',
    markdownAssetVersion: 'md-v1',
    resizerAsset: 'resizer-bundle',
    resizerAssetVersion: 'rs-v1',
    drawboardAsset: 'drawboard-bundle',
    drawboardAssetVersion: 'db-v1',
    iconAsset: 'icons-bundle',
    iconAssetVersion: 'ic-v1',
  };
  const assetEnv = fakeAppEnv(driveRow, () => Readable.from([payload]), []);
  const assetApp = createApp(assetEnv, assetDeps);
  const expected: Array<[string, string, string]> = [
    ['chat-markdown.js', 'markdown-bundle', 'md-v1'],
    ['chat-resizer.js', 'resizer-bundle', 'rs-v1'],
    ['chat-drawboard.js', 'drawboard-bundle', 'db-v1'],
    ['chat-icons.js', 'icons-bundle', 'ic-v1'],
  ];
  for (const [name, body, version] of expected) {
    const response = await assetApp.request(`/assets/${name}`);
    checkEqual(`${name} 200`, response.status, 200);
    checkEqual(`${name} content-type`, response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    checkEqual(`${name} cache-control`, response.headers.get('cache-control'), 'public, max-age=300');
    checkEqual(`${name} nosniff`, response.headers.get('x-content-type-options'), 'nosniff');
    checkEqual(`${name} etag`, response.headers.get('etag'), `"${version}"`);
    checkEqual(`${name} 正文`, await response.text(), body);
  }
  const unknown = await assetApp.request('/assets/unknown.js');
  checkEqual('未知 asset 404', unknown.status, 404);
  const missing = await createApp(assetEnv, {}).request('/assets/chat-markdown.js');
  checkEqual('缺失 asset 404', missing.status, 404);
  checkEqual('缺失 asset no-store', missing.headers.get('cache-control'), 'no-store');
}

async function downloadChecks(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'agentnet-unit-download-'));
  const originalFetch = globalThis.fetch;
  try {
    const fileId = `f_${'A'.repeat(22)}`;
    const metadata = (body: string) => ({
      file: {
        file_id: fileId,
        room_file_id: 'rf_test',
        room_id: 'rm_test',
        name: 'report.txt',
        mime_type: 'text/plain',
        size: body.length,
        sha256: new Bun.CryptoHasher('sha256').update(body).digest('hex'),
        download_url: 'http://127.0.0.1/unit-download',
        preview_url: null,
        expires_at: null,
        retained: false,
      },
    });
    const client = (body: string) =>
      ({ callTool: async () => metadata(body) }) as unknown as McpClient;
    const config: ResolvedConfig = {
      endpoint: 'http://127.0.0.1/mcp',
      baseUrl: 'http://127.0.0.1',
      token: null,
      json: true,
    };

    const target = join(workDir, 'target.txt');
    await writeFile(target, 'original');
    globalThis.fetch = (async () => new Response('evil')) as unknown as typeof fetch;
    await expectThrows(
      '下载校验失败',
      () =>
        download(client('good'), config, {
          room: 'rm_test',
          file: fileId,
          out: target,
        }),
      'DOWNLOAD_VERIFY_FAILED',
    );
    checkEqual('校验失败不覆盖原文件', await readFile(target, 'utf8'), 'original');
    check(
      '校验失败不残留 .part- 临时文件',
      (await readdir(workDir)).every((name) => !name.includes('.part-')),
      await readdir(workDir),
    );

    globalThis.fetch = (async () => new Response('good')) as unknown as typeof fetch;
    await download(client('good'), config, { room: 'rm_test', file: fileId, out: target });
    checkEqual('下载成功写入正文', await readFile(target, 'utf8'), 'good');
    check(
      '下载成功不残留临时文件',
      (await readdir(workDir)).every((name) => !name.includes('.part-')),
      await readdir(workDir),
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(workDir, { recursive: true, force: true });
  }
}

async function lockChecks(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agentnet-unit-lock-'));
  try {
    const timing = { stale: 300_000, update: 10_000 };
    const release = await acquireLock(directory, timing);
    await expectThrows('并发获取锁失败', () => acquireLock(directory, timing));
    await release();
    const releaseAgain = await acquireLock(directory, timing);
    await releaseAgain();
    check('释放后可再次获取锁', true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function atomicWriteChecks(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), 'agentnet-unit-atomic-'));
  try {
    const target = join(workDir, 'state.json');
    await writeFile(target, 'old');
    await chmod(workDir, 0o500);
    await expectThrows('原子写失败', () => writeAtomic(target, 'new'));
    await chmod(workDir, 0o700);
    checkEqual('原子写失败保留旧内容', await readFile(target, 'utf8'), 'old');
    checkEqual(
      '原子写失败不残留临时文件',
      JSON.stringify((await readdir(workDir)).sort()),
      JSON.stringify(['state.json']),
    );

    const stateDir = join(workDir, 'monitor');
    const state = await MonitorState.create({ directory: stateDir, keep: true });
    const oldEvent = join(state.eventDir, 'old.json');
    await writeFile(oldEvent, '{"old":true}\n');
    await chmod(state.eventDir, 0o500);
    await expectThrows('事件文件原子写失败', () => state.writeEventFile('dlv_unit', { a: 1 }));
    await chmod(state.eventDir, 0o700);
    checkEqual('事件文件失败保留旧内容', await readFile(oldEvent, 'utf8'), '{"old":true}\n');
    checkEqual(
      '事件文件失败不残留临时文件',
      JSON.stringify((await readdir(state.eventDir)).sort()),
      JSON.stringify(['old.json']),
    );
  } finally {
    await chmod(workDir, 0o700).catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }
}

async function cacheChecks(db: Database): Promise<void> {
  const now = 1_000_000;
  beginVerification('host-a', now, 2);
  beginVerification('host-a', now + 1, 2);
  await expectThrows('同 host 限流', async () => beginVerification('host-a', now + 2, 2));
  beginVerification('host-a', now + 61_001, 2);
  check('窗口过期后重新允许', true);

  for (let index = 0; index <= 10_050; index += 1) {
    beginVerification(`host-${index}`, now, 1000);
  }
  check(
    '限流缓存有界',
    verificationAttemptHostCount() <= 10_000,
    verificationAttemptHostCount(),
  );

  const hub = new NotificationHub(db);
  for (let index = 0; index <= 100_050; index += 1) {
    hub.revokeCredential(`cred-${index}`);
  }
  check('撤销缓存有界', hub.revokedCredentialCount() <= 100_000, hub.revokedCredentialCount());
  hub.reset();
  checkEqual('reset 清空撤销缓存', hub.revokedCredentialCount(), 0);
}

function versionAndSleepChecks(): Promise<void> {
  check('0.2.1-rc.5 接受', isSupportedDshVersion('0.2.1-rc.5'));
  check('0.2.2-beta 拒绝', !isSupportedDshVersion('0.2.2-beta'));
  check('0.2.2-rc.1 接受', isSupportedDshVersion('0.2.2-rc.1'));
  check('0.3.0 拒绝', !isSupportedDshVersion('0.3.0'));
  check('0.1.5-rc.2 拒绝', !isSupportedDshVersion('0.1.5-rc.2'));
  return (async () => {
    const controller = new AbortController();
    const startedAt = performance.now();
    const sleeping = abortableSleep(5_000, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await sleeping;
    check('abortableSleep abort 后立即 resolve', performance.now() - startedAt < 500);
  })();
}

async function webhookChecks(): Promise<void> {
  const certificate = await ensureTestCertificate(join(tmpdir(), 'agentnet-unit-cert'));
  const receiver = startTestReceiver({ certificate });
  try {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const encryptionKey = await crypto.subtle.importKey(
      'raw',
      keyBytes,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    const secret = `whsec_${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;
    const encrypted = await encryptSecret(encryptionKey, secret);

    const seed = (db: Database): void => {
      db.prepare(
        `INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata, inbox_head_seq,
          inbox_min_seq, pending_count, created_at, updated_at)
         VALUES (?, 'agent', NULL, 'unit', '{}', 0, 0, 0, ?, ?)`,
      ).run('actor_unit', NOW, NOW);
      db.prepare(
        `INSERT INTO credentials (credential_id, actor_id, device_id, token_hash, revoked_at, created_at)
         VALUES (?, ?, 'device', ?, NULL, ?)`,
      ).run('cred_unit', 'actor_unit', `hash-${crypto.randomUUID()}`, NOW);
    };

    const addSubscription = (
      db: Database,
      id: string,
      url: string,
      nextAttemptAt: number,
    ): void => {
      db.prepare(
        `INSERT INTO mcp_event_subscriptions
          (subscription_id, actor_id, event_name, arguments_json, callback_url, callback_url_key,
           credential_id, secret_ciphertext, secret_nonce, refresh_before, verified_at,
           created_at, updated_at)
         VALUES (?, 'actor_unit', 'agentnet.message.created', '{}', ?, ?, 'cred_unit',
           ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        url,
        `${id}-key`,
        encrypted.ciphertext,
        encrypted.nonce,
        NOW + 600_000,
        NOW,
        NOW,
        NOW,
      );
      db.prepare(
        `INSERT INTO mcp_event_deliveries
          (delivery_id, subscription_id, event_seq, event_id, payload_json, status,
           attempts, next_attempt_at, created_at)
         VALUES (?, ?, 1, ?, ?, 'pending', 0, ?, ?)`,
      ).run(
        `dlv_${id}`,
        id,
        `evt_${id}`,
        JSON.stringify({ type: 'event', eventId: `evt_${id}` }),
        nextAttemptAt,
        NOW,
      );
    };

    const envFor = (db: Database): Env =>
      ({
        DB: createD1(db),
        NOTIFICATION_HUB: new NotificationHub(db),
        ENVIRONMENT: 'test',
        PUBLIC_ORIGIN: receiver.url(),
        EVENTS: {
          encryptionKey,
          callbackAllowlist: null,
          allowPrivateCallbacks: true,
          verificationTimeoutMs: 2000,
          deliveryTimeoutMs: 5000,
          verificationPerHostPerMinute: 100,
        },
      }) as Env;

    // 工作池：慢回调和 5 条快回调同时开始，快回调不被第一批阻塞。
    const poolDb = freshDb();
    seed(poolDb);
    addSubscription(poolDb, 'sub_slow', receiver.url('/slow', '?pool=slow'), NOW - 100);
    for (let index = 0; index < 5; index += 1) {
      addSubscription(poolDb, `sub_fast_${index}`, receiver.url('/fast', `?pool=${index}`), NOW);
    }
    const poolResult = await drainEventDeliveries(envFor(poolDb));
    checkEqual('工作池全部投递', poolResult.delivered, 6);
    const slow = receiver.events('/slow').find((item) => item.query === '?pool=slow');
    const fast = receiver.events('/fast');
    checkEqual('工作池快回调数量', fast.length, 5);
    check(
      '慢回调不阻塞其他 delivery',
      fast.every((item) => slow !== undefined && item.at - slow.at < 1_000),
      { slow: slow?.at, fast: fast.map((item) => item.at) },
    );

    // 并发上限：6 条慢回调，最多同时 4 条；后 2 条必须等第一批完成。
    const limitDb = freshDb();
    seed(limitDb);
    for (let index = 0; index < 6; index += 1) {
      addSubscription(limitDb, `sub_limit_${index}`, receiver.url('/slow', `?limit=${index}`), NOW - index);
    }
    const limitResult = await drainEventDeliveries(envFor(limitDb));
    checkEqual('限流全部投递', limitResult.delivered, 6);
    const limited = receiver
      .events('/slow')
      .filter((item) => item.query.startsWith('?limit='))
      .sort((a, b) => a.at - b.at);
    checkEqual('限流投递数量', limited.length, 6);
    const firstWave = limited.filter((item) => item.at - limited[0]!.at < 500);
    checkEqual('并发上限 4', firstWave.length, LIMITS.eventsWebhookConcurrency);
    check(
      '后 2 条等待第一批完成',
      limited.slice(4).every((item) => item.at - limited[0]!.at >= 1_500),
      limited.map((item) => item.at - limited[0]!.at),
    );

    // 每订阅顺序：seq 2 在 seq 1 投递前不可见。
    const orderDb = freshDb();
    seed(orderDb);
    orderDb.prepare(
      `INSERT INTO mcp_event_subscriptions
        (subscription_id, actor_id, event_name, arguments_json, callback_url, callback_url_key,
         credential_id, secret_ciphertext, secret_nonce, refresh_before, verified_at,
         created_at, updated_at)
       VALUES ('sub_order', 'actor_unit', 'agentnet.message.created', '{}', ?, 'order-key',
         'cred_unit', ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiver.url('/order'),
      encrypted.ciphertext,
      encrypted.nonce,
      NOW + 600_000,
      NOW,
      NOW,
      NOW,
    );
    orderDb.prepare(
      `INSERT INTO mcp_event_deliveries
        (delivery_id, subscription_id, event_seq, event_id, payload_json, status,
         attempts, next_attempt_at, created_at)
       VALUES ('dlv_order_1', 'sub_order', 1, 'evt_order_1', ?, 'pending', 0, ?, ?)`,
    ).run(JSON.stringify({ type: 'event', eventId: 'evt_order_1' }), NOW, NOW);
    orderDb.prepare(
      `INSERT INTO mcp_event_deliveries
        (delivery_id, subscription_id, event_seq, event_id, payload_json, status,
         attempts, next_attempt_at, created_at)
       VALUES ('dlv_order_2', 'sub_order', 2, 'evt_order_2', ?, 'pending', 0, ?, ?)`,
    ).run(JSON.stringify({ type: 'event', eventId: 'evt_order_2' }), NOW, NOW);
    await drainEventDeliveries(envFor(orderDb));
    const orderEnv = envFor(orderDb);
    await drainEventDeliveries(orderEnv);
    await sleep(100);
    const ordered = receiver.events('/order');
    checkEqual(
      '每订阅按 event_seq 顺序投递',
      ordered.map((item) => item.eventId).join(','),
      'evt_order_1,evt_order_2',
    );
  } finally {
    receiver.stop();
  }
}

/**
 * 凭据摘要 golden vectors：输出必须与收口前逐字节一致。
 *
 * 期望值由旧实现（`sha256Hex('agent-network:<purpose>:<value>')`）生成；任何
 * 前缀、分隔符或编码变化都会让这些断言失败，禁止改测试值。
 */
async function secretHashChecks(): Promise<void> {
  const vectors: [string, string, string][] = [
    ['token', 'ank_test_token', '8a9376f77209f52a94456f8a620b35f94103c02fdfbc193be6c34868dcd1e583'],
    ['ticket', 'ticket-value', '8eab9e540238821f143031be924f235252962783009cd0de54de5f7fad1244b2'],
    ['room-invite', 'rinv_value', '2fae7300807788f13fe5c6c0214c386ba7138e2c9ed6accb37e91277193a5287'],
    ['claim', 'claim-code', '01beff931d91fefe25825187322c7b379dae86e065b58d3a0e013cf04126f5ee'],
    ['pairing', 'PAIRING12', 'c79fbd361ae7e384f73d68ebfe59697a2fd073bd0d01ce47da8c830101c7764f'],
    ['pairing-confirm', 'pr_1:digest', 'ccec9128111ccc21ecb998358855a2c9cfb661afde84a9062f820a4f8462ba8a'],
    ['contact-link', 'clink-token', '911d3f85a729bfdbf118e2fb8bf6572ca3d1f67652683dc80680852d1e6b24b2'],
  ];
  for (const [purpose, value, expected] of vectors) {
    checkEqual(`hashSecret ${purpose} golden`, await hashSecret(purpose as never, value), expected);
  }
  checkEqual('hashToken 与 hashSecret token 一致', await hashToken('ank_test_token'), vectors[0]![2]);
}

/** metadata 解析矩阵：坏 JSON/数组/null 都退化为空对象。 */
function metadataChecks(): void {
  checkEqual('metadata 解析对象', parseMetadataObject('{"a":1}').a, 1);
  checkEqual('metadata 坏 JSON 退化为空对象', Object.keys(parseMetadataObject('{')).length, 0);
  checkEqual('metadata 数组退化为空对象', Object.keys(parseMetadataObject('[1,2]')).length, 0);
  checkEqual('metadata null 退化为空对象', Object.keys(parseMetadataObject('null')).length, 0);
  checkEqual('metadata 字符串退化为空对象', Object.keys(parseMetadataObject('"x"')).length, 0);
}

/** pair_key SQL 片段只接受固定标识符，生成的 CASE 两侧顺序稳定。 */
function pairKeySqlChecks(): void {
  const sql = sortedPairKeySql('a', 'b');
  check('pair_key SQL 含前后两向', sql.includes("a < b") && sql.includes("a || '|' || b"));
  checkEqual('sortedPairKey 字典序', sortedPairKey('b', 'a'), 'a|b');
  checkEqual('sortedPairKey 相同输入', sortedPairKey('a', 'a'), 'a|a');
}

/** 控制字符矩阵：C0/C1/DEL/U+2028/U+2029 与换行放行规则。 */
function textValidationChecks(): void {
  const cases: [string, string][] = [
    ['NUL', '\u0000'],
    ['C0 换行', '\n'],
    ['DEL', '\u007f'],
    ['C1', '\u0085'],
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ];
  for (const [label, value] of cases) {
    check(`${label} 被拒绝`, hasControlChars(value));
    check(`${label} 在 allowControl 下放行`, !hasControlChars(value, { allowControl: true }));
  }
  check('allowNewlines 放行 \\t\\n\\r', !hasControlChars('\t\n\r', { allowNewlines: true }));
  check('allowNewlines 仍拒绝 C1', hasControlChars('\u0085', { allowNewlines: true }));
  check('allowNewlines 仍拒绝 U+2028', hasControlChars('\u2028', { allowNewlines: true }));
  check('普通中文与 emoji 合法', !hasControlChars('你好 👋'));
  check('字节上限按 UTF-8 计算', exceedsUtf8Bytes('你好', 5) && !exceedsUtf8Bytes('你好', 6));
  checkEqual(
    'replaceControlChars 折叠为空格',
    replaceControlChars('a\nb\u0085c', ' '),
    'a b c',
  );
  const schema = utf8Text({ maxBytes: 6 });
  check('Zod 合法中文', schema.safeParse('你好').success);
  check('Zod 拒绝超字节', !schema.safeParse('你好吗').success);
  check('Zod 拒绝控制字符', !schema.safeParse('a\u0000').success);
}

/** 游标：旧格式可读、坏 JSON/base64 与字段错误保持原错误码。 */
function cursorChecks(): void {
  const encoded = encodeCursor({
    v: 1,
    scope: 'room:rm_1',
    dir: 'after',
    seq: 42,
    snapshot: 99,
  });
  const decoded = decodeCursor(encoded, 'room:rm_1');
  checkEqual('游标 round-trip seq', decoded.seq, 42);
  checkEqual('游标 round-trip snapshot', decoded.snapshot, 99);

  const legacy = Buffer.from(JSON.stringify({ v: 1, scope: 'room:rm_1', dir: 'before', seq: 1, snapshot: 1 }))
    .toString('base64url');
  checkEqual('旧游标仍可读取', decodeCursor(legacy, 'room:rm_1').dir, 'before');

  const expectCode = (label: string, fn: () => unknown, message: string): void => {
    try {
      fn();
      check(label, false);
    } catch (error) {
      check(label, (error as { code?: string }).code === 'INVALID_ARGUMENT');
      check(`${label} 文案`, (error as Error).message === message);
    }
  };
  expectCode('坏 base64', () => decodeCursor('***', 'room:rm_1'), 'cursor 不是合法的版本化游标');
  expectCode(
    '坏 JSON',
    () => decodeCursor(Buffer.from('{').toString('base64url'), 'room:rm_1'),
    'cursor 不是合法的版本化游标',
  );
  expectCode(
    '坏字段',
    () => decodeCursor(Buffer.from(JSON.stringify({ v: 2 })).toString('base64url'), 'room:rm_1'),
    'cursor 字段不完整或版本不受支持',
  );
  expectCode(
    '跨 scope',
    () => decodeCursor(encoded, 'room:rm_2'),
    'cursor 不能跨 scope 重用',
  );
  check(
    '未知字段透传',
    decodeCursor(
      Buffer.from(JSON.stringify({ v: 1, scope: 'room:rm_1', dir: 'after', seq: 1, snapshot: 1, extra: true }))
        .toString('base64url'),
      'room:rm_1',
    ).seq === 1,
  );
}

/**
 * C10 权限一致性矩阵：同一房间/成员组合下，SQL 谓词与 TS 能力表必须一致。
 *
 * SQL 谓词只覆盖角色与策略；写能力还要叠加“群未解散”这一事务 guard，
 * `view_role_history` 是读能力，不受解散影响。矩阵同时覆盖 direct/group、
 * owner/admin/member、active/left/removed 与解散状态。
 */
async function permissionMatrixChecks(db: Database): Promise<void> {
  const d1 = createD1(db);
  const now = NOW;
  db.prepare("INSERT OR IGNORE INTO actors (actor_id, kind, name, created_at, updated_at) VALUES ('a_owner', 'human', 'owner', ?, ?)").run(now, now);
  db.prepare("INSERT OR IGNORE INTO actors (actor_id, kind, name, created_at, updated_at) VALUES ('a_subject', 'human', 'subject', ?, ?)").run(now, now);
  const capabilities = Object.keys(CAPABILITY_PREDICATES) as RoomCapability[];
  let mismatches = 0;
  for (const kind of ['direct', 'group'] as const) {
    for (const role of ['owner', 'admin', 'member'] as const) {
      for (const status of ['active', 'left', 'removed'] as const) {
        for (const dissolved of [null, now]) {
          const roomId = `rm_m_${kind}_${role}_${status}_${dissolved === null ? 'live' : 'gone'}`;
          db.prepare(
            `INSERT OR REPLACE INTO rooms (room_id, kind, owner_id, title, created_at, updated_at, dissolved_at)
             VALUES (?, ?, ?, '', ?, ?, ?)`,
          ).run(roomId, kind, kind === 'group' ? 'a_owner' : null, now, now, dissolved);
          db.prepare(
            `INSERT OR REPLACE INTO room_members
               (room_id, actor_id, role, status, joined_at, updated_at)
             VALUES (?, 'a_owner', 'owner', 'active', ?, ?)`,
          ).run(roomId, now, now);
          db.prepare(
            `INSERT OR REPLACE INTO room_members
               (room_id, actor_id, role, status, joined_at, updated_at)
             VALUES (?, 'a_subject', ?, ?, ?, ?)`,
          ).run(roomId, role, status, now, now);
          const room = await getRoom(d1, roomId);
          const member = await getMember(d1, roomId, 'a_subject');
          if (!room || !member) throw new Error('权限矩阵 fixture 读取失败');
          const writable = !(kind === 'group' && dissolved !== null);
          const active = member.status === 'active';
          const ts = roomCapabilitiesFor(room, member);
          for (const capability of capabilities) {
            const row = db
              .prepare(
                `SELECT (${CAPABILITY_PREDICATES[capability]}) AS ok
                   FROM rooms r
                   JOIN room_members m
                     ON m.room_id = r.room_id AND m.actor_id = 'a_subject'
                  WHERE r.room_id = ?`,
              )
              .get(roomId) as { ok: number } | null;
            const predicate = row?.ok === 1;
            const sql =
              capability === 'view_role_history'
                ? predicate && active
                : predicate && active && writable;
            if (sql !== ts[capability]) {
              mismatches += 1;
              if (mismatches <= 5) {
                check(
                  `权限矩阵一致 ${kind}/${role}/${status}/${dissolved === null ? 'live' : 'gone'}/${capability}`,
                  false,
                  { sql, ts: ts[capability] },
                );
              }
            }
          }
        }
      }
    }
  }
  checkEqual('C10 权限矩阵 SQL 与 TS 完全一致', mismatches, 0);
}

/**
 * B10b presence touch 缓存：节流窗口内只读一次状态；任何状态转换后必须重新读。
 */
async function presenceTouchChecks(db: Database): Promise<void> {
  const d1 = createD1(db);
  const now = NOW;
  await d1
    .prepare(
      "INSERT OR IGNORE INTO actors (actor_id, kind, name, created_at, updated_at) VALUES ('a_presence', 'agent', 'presence', ?, ?)",
    )
    .bind(now, now)
    .run();
  let reads = 0;
  const counting = {
    prepare(sql: string) {
      if (/^SELECT \* FROM agent_presence_state/u.test(sql.trim())) reads += 1;
      return d1.prepare(sql);
    },
    batch: d1.batch.bind(d1),
  } as unknown as D1Database;
  const timeline = new AgentPresenceTimeline(counting, {
    graceMs: 1_000,
    activityTtlMs: 1_000,
    touchThrottleMs: 1_000,
    now: () => now,
  });
  await timeline.recordLogin('a_presence', now);
  const afterLogin = reads;
  await timeline.touch('a_presence', now + 100);
  const afterFirstTouch = reads;
  await timeline.touch('a_presence', now + 200);
  checkEqual('节流窗口内第二次 touch 不读状态', reads, afterFirstTouch);
  check('首次 touch 读取状态', afterFirstTouch > afterLogin);

  await timeline.recordLogin('a_presence', now + 300);
  await timeline.touch('a_presence', now + 350);
  check('状态转换后 touch 重新读状态', reads > afterFirstTouch);

  const beforeDisconnect = reads;
  timeline.connectionClosed('a_presence', now + 400);
  await timeline.touch('a_presence', now + 410);
  check('断连转换后 touch 重新读状态', reads > beforeDisconnect);
}

async function main(): Promise<void> {
  await sseChecks();
  const db = freshDb();
  guardChecks(db);
  rangeParserChecks();
  await httpChecks();
  await downloadChecks();
  await lockChecks();
  await atomicWriteChecks();
  await cacheChecks(db);
  await versionAndSleepChecks();
  await webhookChecks();
  await secretHashChecks();
  metadataChecks();
  pairKeySqlChecks();
  textValidationChecks();
  cursorChecks();
  await permissionMatrixChecks(db);
  await presenceTouchChecks(db);
  console.log(`\nRefactor units: ${checksPassed()} checks passed`);
}

await main();
