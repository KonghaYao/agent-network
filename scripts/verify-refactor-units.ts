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
import { GUARDS } from '../src/storage/guards';
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
  console.log(`\nRefactor units: ${checksPassed()} checks passed`);
}

await main();
