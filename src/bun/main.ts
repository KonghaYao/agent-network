import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createApp, runScheduled } from '../app';
import { LIMITS } from '../contracts/limits';
import { createDrive } from '../drive/service';
import { MemoryRuntime } from '../memory/runtime';
import { MemoryIntegration } from '../memory/integration';
import { memoryEngineInfo, type MemoryEngineStatus } from '../memory/capability-catalog';
import { memoryHostPolicyFromEnv } from '../memory/host-bridge';
import {
  loadLangfuseConfigFromEnv,
  resolveLangfuseSourceConfig,
} from '../memory/sources/langfuse-config';
import { LangfuseSourceImporter } from '../memory/sources/langfuse-import';
import { parseMcpImplementation } from '../mcp/transport';
import {
  HindsightMemoryAdapter,
  loadHindsightConfigFromEnv,
} from '../memory/adapters/hindsight';
import { LocalMemoryAdapter } from '../memory/adapters/local';
import type { MemoryAdapter } from '../memory/adapters/types';
import { StubMemoryAdapter } from '../memory/adapters/stub';
import type { Env, EventsConfig } from '../env';
import { loadEncryptionKey } from '../events/security';
import { initEventsFileLog } from '../events/log-file';
import { scheduleEventsTick, stopEventsRuntime } from '../events/runtime';
import type { FileMount } from '@peri-code/mcpp/files';
import { remindStaleDeliveries } from '../domain/delivery-reminders';
import { NotificationHub } from '../realtime/hub';
import { scheduleOutboxDrain } from '../realtime/outbox';
import { AgentPresenceTimeline } from '../realtime/presence-timeline';
import { buildChatIconsBundle } from '../web/chat-icons-bundle';
import { buildDrawboardBundle } from '../web/drawboard-bundle';
import { buildMarkdownBundle } from '../web/markdown-bundle';
import { buildResizerBundle } from '../web/resizer-bundle';
import { loadSpaManifest, parseSpaRoutes } from '../web/spa-manifest';
import { buildCliBundle } from './cli-bundle';
import { createD1 } from './d1';
import { resolveFileTicketSecret } from './file-ticket-secret';
import { migrate } from './migrate';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** `PORT=0` 表示由内核分配端口；测试 harness 依赖启动日志里的真实端口。 */
function portNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 65_535 ? parsed : fallback;
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

const port = portNumber(process.env.PORT, 8792);
const hostname = process.env.HOST ?? '0.0.0.0';
const dataDir = resolve(process.env.DATA_DIR ?? '.data');
const databasePath = resolve(process.env.DATABASE_PATH ?? `${dataDir}/agent-network.sqlite`);
const publicOrigin = process.env.PUBLIC_ORIGIN ?? `http://localhost:${port}`;
// 票据密钥只在这里解析一次：配置值优先，否则读取/创建 DATA_DIR 下的持久化
// 密钥，保证重启后旧票据仍可验证。目录不可写时启动直接失败，不静默降级。
const configuredTicketSecret = process.env.FILE_TICKET_SECRET?.trim();
const fileTicketSecretValue = resolveFileTicketSecret({
  configured: configuredTicketSecret,
  dataDir,
});
if (!configuredTicketSecret) {
  console.log('file ticket secret: using persisted DATA_DIR/file-ticket.key (mode 0600)');
}

mkdirSync(dirname(databasePath), { recursive: true });
const db = new Database(databasePath, { create: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const applied = migrate(db, resolve(import.meta.dir, '../../migrations'));
if (applied.length > 0) {
  console.log(`applied migrations: ${applied.join(', ')}`);
}

const environment = process.env.ENVIRONMENT ?? 'development';
const mcpImplementation = parseMcpImplementation(process.env.MCP_IMPL);
const eventsConfig = await loadEventsConfig(environment);

let hubRef: NotificationHub | null = null;
let envRef: Env | null = null;
const d1 = createD1(db);
const presenceSweepMs = positiveInt(
  process.env.AGENT_PRESENCE_SWEEP_MS,
  LIMITS.agentPresenceSweepMs,
);
const presence = new AgentPresenceTimeline(d1, {
  graceMs: positiveInt(process.env.AGENT_PRESENCE_GRACE_MS, LIMITS.agentPresenceGraceMs),
  activityTtlMs: positiveInt(
    process.env.AGENT_PRESENCE_ACTIVITY_TTL_MS,
    LIMITS.agentPresenceActivityTtlMs,
  ),
  touchThrottleMs: positiveInt(
    process.env.AGENT_PRESENCE_TOUCH_THROTTLE_MS,
    LIMITS.agentPresenceTouchThrottleMs,
  ),
  hasConnection: (actorId) => (hubRef?.actorConnectionCount(actorId) ?? 0) > 0,
  // 下线由 sweep 在空闲时确认；提交后必须主动 drain，不能等 60s 定时任务。
  onPresenceCommitted: () => {
    if (!envRef) return;
    void scheduleOutboxDrain(envRef).catch((error) => {
      console.error('agent-network presence outbox drain failed', error);
    });
  },
});
const hub = new NotificationHub(db, {
  onAgentStreamOpened: (actorId) => presence.connectionOpened(actorId),
  onAgentLastConnectionClosed: (actorId) => presence.connectionClosed(actorId),
});
hubRef = hub;

const env: Env = {
  DB: d1,
  NOTIFICATION_HUB: hub,
  PRESENCE: presence,
  ENVIRONMENT: environment,
  PUBLIC_ORIGIN: publicOrigin,
  MCP_IMPL: mcpImplementation,
  MESSAGE_SEARCH_FTS: process.env.MESSAGE_SEARCH_FTS !== '0',
  FILE_TICKET_SECRET: fileTicketSecretValue,
  ...(eventsConfig ? { EVENTS: eventsConfig } : {}),
};
envRef = env;

// MF07：宿主信任等级只来自部署配置，缺省 tool-only；普通 Agent 不能自报。
env.MEMORY_HOST = memoryHostPolicyFromEnv(process.env.MEMORY_HOST_TRUST);

// MF03/MF04/MF10：Memory 运行时默认关闭；MEMORY_ENABLED=1 才启动作业领取、
// 启动恢复、unknown 对账与来源拉取。适配器配置缺失时 fail closed：不请求后端、
// 不伪报已记住；凭据与 bank 路由只在服务端，开始日志不输出。
let memoryRuntime: MemoryRuntime | undefined;
let memoryIntegration: MemoryIntegration | undefined;
if (process.env.MEMORY_ENABLED === '1') {
  const adapterKind = (process.env.MEMORY_ADAPTER ?? 'stub').trim().toLowerCase();
  if (!['stub', 'hindsight', 'local', 'local-sqlite'].includes(adapterKind)) {
    // 明确配置错误保持 fail loud；未配置引擎与后端故障不影响聊天。
    throw new Error('MEMORY_ADAPTER must be stub, hindsight or local-sqlite');
  }
  let adapter: MemoryAdapter | null = null;
  let engineStatus: MemoryEngineStatus = 'unavailable';
  try {
    if (adapterKind === 'stub') {
      adapter = new StubMemoryAdapter();
      engineStatus = 'unsupported';
      console.warn('memory adapter enabled: stub (no recall/retain backend)');
    } else if (adapterKind === 'hindsight') {
      const loaded = loadHindsightConfigFromEnv(process.env);
      if (loaded.ok) {
        adapter = new HindsightMemoryAdapter(loaded.config);
        engineStatus = 'ready';
        console.log('memory adapter enabled: hindsight');
      } else {
        adapter = new HindsightMemoryAdapter(null);
        engineStatus = 'unavailable';
        console.warn(`memory adapter disabled: ${loaded.error}`);
      }
    } else {
      adapter = new LocalMemoryAdapter({
        path: resolve(process.env.MEMORY_LOCAL_PATH ?? `${dataDir}/memory-local.sqlite`),
      });
      engineStatus = 'ready';
      console.log('memory adapter enabled: local-sqlite');
    }
  } catch (error) {
    // 适配器初始化失败只关闭 Memory；聊天、群聊、任务与文件继续工作。
    console.error('agent-network memory adapter failed to initialize', error);
    adapter = null;
  }
  if (adapter) {
    env.MEMORY_ENGINE = memoryEngineInfo(adapter, engineStatus);
    const candidate = new MemoryRuntime(d1, {
      adapter,
      instanceId: process.env.MEMORY_INSTANCE_ID?.trim() || null,
      capture: process.env.MEMORY_CAPTURE !== '0',
    });
    try {
      await candidate.start();
      memoryRuntime = candidate;
      env.MEMORY = candidate;
      console.log(`memory runtime enabled (instance ${candidate.instanceId ?? 'unknown'})`);
    } catch (error) {
      // Memory 本地启动失败不阻塞聊天；持久账本仍由数据库保留，下一轮部署可恢复。
      console.error('agent-network memory runtime failed to start', error);
    }
  }
}

// MF09/MF10：Langfuse 来源默认关闭；只有 Memory 实际启动后才构造 importer。
// 凭据/host/project 不写入日志或工具/页面结果；调度周期与作业 tick 解耦。
let langfuseImporter: LangfuseSourceImporter | null = null;
if (process.env.LANGFUSE_ENABLED === '1') {
  const loaded = loadLangfuseConfigFromEnv(process.env);
  if (loaded.ok) {
    env.LANGFUSE = loaded.config;
    if (memoryRuntime?.instanceId) {
      try {
        langfuseImporter = new LangfuseSourceImporter({
          db: d1,
          instanceId: memoryRuntime.instanceId,
          config: resolveLangfuseSourceConfig(loaded.config),
        });
        console.log('langfuse source enabled: importer scheduled');
      } catch (error) {
        console.warn(
          `langfuse source disabled: ${error instanceof Error ? error.message : 'invalid configuration'}`,
        );
      }
    } else {
      console.warn('langfuse source configured but Memory runtime is not available');
    }
  } else {
    console.warn(`langfuse source disabled: ${loaded.error}`);
  }
}

if (memoryRuntime) {
  memoryIntegration = new MemoryIntegration({
    runtime: memoryRuntime,
    langfuse: langfuseImporter,
    onError: (error, scope) => {
      // 不记录来源正文、token 或 provider 路由。
      console.error(`agent-network memory ${scope} failed`, error);
    },
  });
  await memoryIntegration.start();
  env.MEMORY_INTEGRATION = memoryIntegration;
}

// 启动扫描：崩溃遗留的 online 转为 pending/inferred；已到期的 pending 立即确认。
await presence.recover();

if (eventsConfig) {
  initEventsFileLog({ dataDir });
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
    // 底层保留远长于业务 TTL：草稿 24h、普通附件 30d、成果保留至显式释放。
    // 实际访问与清理以 drive_files/room_files 为准，载荷由维护任务回收。
    ttlSeconds: positiveInt(process.env.DRIVE_TTL_SECONDS, 10 * 365 * 24 * 60 * 60),
  });
  await drive.fileService.ready;
  mount = drive.mount;
  closeDrive = () => drive.fileService.close();
  maxFileBytes = drive.fileService.maxFileBytes;
  console.log(
    `drive enabled: ${resolve(process.env.DRIVE_DIRECTORY ?? `${dataDir}/files`)} (ttl ${drive.fileService.ttlSeconds}s, max ${drive.fileService.maxFileBytes} bytes)`,
  );
}

const [markdownBundle, resizerBundle, drawboardBundle, iconBundle, cliBundle] = await Promise.all([
  buildMarkdownBundle(),
  buildResizerBundle(),
  buildDrawboardBundle(),
  buildChatIconsBundle(),
  buildCliBundle(),
]);
if (markdownBundle) {
  console.log(
    `markdown asset ready: ${(markdownBundle.code.length / 1024).toFixed(0)} KiB (v${markdownBundle.version})`,
  );
}
if (resizerBundle) {
  console.log(
    `resizer asset ready: ${(resizerBundle.code.length / 1024).toFixed(0)} KiB (v${resizerBundle.version})`,
  );
}
if (drawboardBundle) {
  console.log(
    `drawboard asset ready: ${(drawboardBundle.code.length / 1024).toFixed(0)} KiB (v${drawboardBundle.version})`,
  );
}
if (iconBundle) {
  console.log(
    `icon motion asset ready: ${(iconBundle.code.length / 1024).toFixed(0)} KiB (v${iconBundle.version})`,
  );
}
if (cliBundle) {
  console.log(
    `cli asset ready: ${(cliBundle.code.length / 1024).toFixed(0)} KiB (v${cliBundle.version})`,
  );
}

// 4B-0：只有显式配置 `WEB_SPA_ROUTES` 时才读取 manifest；默认空集合保持 legacy。
// manifest 缺失或引用文件不存在时回退旧页面，不阻塞启动、不返回 500。
const spaRoutes = parseSpaRoutes(process.env.WEB_SPA_ROUTES);
const spaDistDir = resolve(
  process.env.WEB_DIST_DIR ?? resolve(import.meta.dir, '../../dist/web'),
);
const spaManifest = spaRoutes.size > 0 ? await loadSpaManifest(spaDistDir) : null;
if (spaRoutes.size > 0) {
  console.log(
    spaManifest
      ? `web spa routes enabled: ${[...spaRoutes].join(',')} (${spaDistDir})`
      : `web spa manifest unavailable; falling back to legacy pages (${spaDistDir})`,
  );
}

const app = createApp(env, {
  mount,
  markdownAsset: markdownBundle?.code ?? null,
  markdownAssetVersion: markdownBundle?.version ?? null,
  resizerAsset: resizerBundle?.code ?? null,
  resizerAssetVersion: resizerBundle?.version ?? null,
  drawboardAsset: drawboardBundle?.code ?? null,
  drawboardAssetVersion: drawboardBundle?.version ?? null,
  iconAsset: iconBundle?.code ?? null,
  iconAssetVersion: iconBundle?.version ?? null,
  clientAsset: cliBundle?.code ?? null,
  clientAssetVersion: cliBundle?.version ?? null,
  spaRoutes,
  spaManifest,
  spaDistDir,
});

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
console.log(`mcp implementation: ${mcpImplementation}`);
if (mount) console.log(`upload endpoint: ${publicOrigin}${mount.uploadPath}`);
// 重启后立即接回持久队列；无需等待新的工具请求或一分钟维护周期。
scheduleEventsTick(env);

const schedule = setInterval(() => {
  void runScheduled(env);
}, 60_000);

// 上下线 grace 扫描独立于 60s 维护周期；阈值只在 contracts/limits.ts 维护。
const presenceSweep = setInterval(() => {
  void env.PRESENCE?.sweep().catch((error) => {
    console.error('agent-network presence sweep failed', error);
  });
}, presenceSweepMs);

// claimed 投递 3 分钟无 progress 更新时提醒 recipient；扫描周期与维护周期解耦。
// 同一进程内只允许一轮扫描在跑，避免慢查询叠加重入；跨进程/重启由
// deliveries.last_reminded_at 与 event_key 唯一约束收敛。
let reminderSweepRunning = false;
const reminderSweep = setInterval(() => {
  if (reminderSweepRunning) return;
  reminderSweepRunning = true;
  void remindStaleDeliveries(env.DB)
    .then(async (result) => {
      if (result.failed > 0) {
        console.error('agent-network delivery reminder sweep had failures', result.failed);
      }
      if (result.reminded > 0) await scheduleOutboxDrain(env);
    })
    .catch(() => {
      // 不记录 SQL bind、token 或消息正文；下一轮继续。
      console.error('agent-network delivery reminder sweep failed');
    })
    .finally(() => {
      reminderSweepRunning = false;
    });
}, LIMITS.deliveryReminderScanMs);

// Memory 作业租约、unknown 对账与 Langfuse 拉取由 MemoryIntegration 统一调度；
// 它与 outbox/maintenance 解耦，tick 内部保证单轮不重入。

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(schedule);
    clearInterval(presenceSweep);
    clearInterval(reminderSweep);
    await memoryIntegration?.stop();
    // 先给活动 SSE 发 graceful close，再停止接收新请求。
    if (env.NOTIFICATION_HUB.closeAllStreams() > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // closeAllStreams 会触发 pending 写入；尽量在退出前落库。
    await env.PRESENCE?.flush();
    server.stop();
    await stopEventsRuntime(env);
    await closeDrive?.();
    db.close();
    process.exit(0);
  });
}
