import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createApp, runScheduled } from '../app';
import { LIMITS } from '../contracts/limits';
import { createDrive } from '../drive/service';
import type { Env, EventsConfig } from '../env';
import { loadEncryptionKey } from '../events/security';
import type { FileMount } from '@peri-code/mcpp/files';
import { NotificationHub } from '../realtime/hub';
import { buildMarkdownBundle } from '../web/markdown-bundle';
import { createD1 } from './d1';
import { migrate } from './migrate';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowlist(value: string | undefined): ReadonlySet<string> | null {
  if (!value) return null;
  const hosts = value
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0);
  return hosts.length > 0 ? new Set(hosts) : null;
}

/**
 * MCP Events 配置 fail closed：
 * - 必须显式 EVENTS_ENABLED=1 且 EVENTS_ENCRYPTION_KEY 是 base64 32 字节；
 * - 任一缺失/非法只告警一次，不声明 events、不注册方法；
 * - EVENTS_TEST_ALLOW_PRIVATE 只能与 ENVIRONMENT=test 一起使用。
 */
async function loadEventsConfig(environment: string): Promise<EventsConfig | undefined> {
  const allowPrivateRequested = process.env.EVENTS_TEST_ALLOW_PRIVATE === '1';
  if (allowPrivateRequested && environment !== 'test') {
    throw new Error('EVENTS_TEST_ALLOW_PRIVATE is only allowed when ENVIRONMENT=test');
  }
  if (process.env.EVENTS_ENABLED !== '1') return undefined;

  const rawKey = process.env.EVENTS_ENCRYPTION_KEY;
  if (!rawKey) {
    console.warn('MCP Events disabled: EVENTS_ENCRYPTION_KEY is required when EVENTS_ENABLED=1');
    return undefined;
  }
  const encryptionKey = await loadEncryptionKey(rawKey);
  if (!encryptionKey) {
    console.warn(
      'MCP Events disabled: EVENTS_ENCRYPTION_KEY must be base64-encoded 32 bytes',
    );
    return undefined;
  }

  const allowPrivateCallbacks = environment === 'test' && allowPrivateRequested;
  return {
    encryptionKey,
    callbackAllowlist: parseAllowlist(process.env.EVENTS_CALLBACK_ALLOWLIST),
    allowPrivateCallbacks,
    ...(allowPrivateCallbacks && process.env.EVENTS_TEST_CA
      ? { tlsCa: process.env.EVENTS_TEST_CA }
      : {}),
    verificationTimeoutMs: positiveInt(
      process.env.EVENTS_VERIFICATION_TIMEOUT_MS,
      LIMITS.eventsVerificationTimeoutMs,
    ),
    deliveryTimeoutMs: positiveInt(
      process.env.EVENTS_WEBHOOK_TIMEOUT_MS,
      LIMITS.eventsWebhookTimeoutMs,
    ),
    verificationPerHostPerMinute: positiveInt(
      process.env.EVENTS_VERIFICATION_PER_HOST_PER_MINUTE,
      LIMITS.eventsVerificationPerHostPerMinute,
    ),
  };
}

const port = positiveInt(process.env.PORT, 8792);
const hostname = process.env.HOST ?? '0.0.0.0';
const dataDir = resolve(process.env.DATA_DIR ?? '.data');
const databasePath = resolve(process.env.DATABASE_PATH ?? `${dataDir}/agent-network.sqlite`);
const publicOrigin = process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`;

mkdirSync(dirname(databasePath), { recursive: true });
const db = new Database(databasePath, { create: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const applied = migrate(db, resolve(import.meta.dir, '../../migrations'));
if (applied.length > 0) {
  console.log(`applied migrations: ${applied.join(', ')}`);
}

const environment = process.env.ENVIRONMENT ?? 'development';
const eventsConfig = await loadEventsConfig(environment);

const env: Env = {
  DB: createD1(db),
  NOTIFICATION_HUB: new NotificationHub(db),
  ENVIRONMENT: environment,
  PUBLIC_ORIGIN: publicOrigin,
  ...(eventsConfig ? { EVENTS: eventsConfig } : {}),
};

if (eventsConfig) {
  console.log(
    `MCP Events enabled (callback allowlist: ${eventsConfig.callbackAllowlist ? [...eventsConfig.callbackAllowlist].join(',') : 'none'})`,
  );
}

let mount: FileMount | undefined;
let closeDrive: (() => Promise<void>) | undefined;
let maxFileBytes = 1024 * 1024;

if (process.env.DRIVE_DISABLED !== '1') {
  const drive = createDrive(env, {
    directory: resolve(process.env.DRIVE_DIRECTORY ?? `${dataDir}/files`),
    namespace: process.env.DRIVE_NAMESPACE ?? 'agent-network',
    maxFileBytes: positiveInt(process.env.DRIVE_MAX_FILE_BYTES, 128 * 1024 * 1024),
    ttlSeconds: positiveInt(process.env.DRIVE_TTL_SECONDS, 86400),
  });
  await drive.fileService.ready;
  mount = drive.mount;
  closeDrive = () => drive.fileService.close();
  maxFileBytes = drive.fileService.maxFileBytes;
  console.log(
    `drive enabled: ${resolve(process.env.DRIVE_DIRECTORY ?? `${dataDir}/files`)} (ttl ${drive.fileService.ttlSeconds}s, max ${drive.fileService.maxFileBytes} bytes)`,
  );
}

const markdownAsset = await buildMarkdownBundle();
if (markdownAsset) {
  console.log(`markdown asset ready: ${(markdownAsset.length / 1024).toFixed(0)} KiB`);
}

const app = createApp(env, { mount, markdownAsset });

const server = Bun.serve({
  hostname,
  port,
  idleTimeout: 255,
  maxRequestBodySize: Math.max(maxFileBytes, 1024 * 1024),
  fetch(request) {
    return app.fetch(request);
  },
});

console.log(`agent-network listening on http://${hostname}:${server.port}`);
console.log(`mcp endpoint: ${publicOrigin}/mcp`);
if (mount) console.log(`upload endpoint: ${publicOrigin}${mount.uploadPath}`);

const schedule = setInterval(() => {
  void runScheduled(env);
}, 60_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(schedule);
    // 先给活动 SSE 发 graceful close，再停止接收新请求。
    if (env.NOTIFICATION_HUB.closeAllStreams() > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    server.stop();
    await closeDrive?.();
    db.close();
    process.exit(0);
  });
}
