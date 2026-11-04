import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createApp, runScheduled } from '../app';
import { createDrive } from '../drive/service';
import type { Env } from '../env';
import type { FileMount } from '@peri-code/mcpp/files';
import { NotificationHub } from '../realtime/hub';
import { createD1 } from './d1';
import { migrate } from './migrate';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function origins(value: string | undefined, fallbackOrigin: string): string[] {
  const list = (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.length > 0) return list;
  try {
    return [new URL(fallbackOrigin).origin];
  } catch {
    return [];
  }
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

const env: Env = {
  DB: createD1(db),
  NOTIFICATION_HUB: new NotificationHub(db),
  ENVIRONMENT: process.env.ENVIRONMENT ?? 'development',
  PUBLIC_ORIGIN: publicOrigin,
};

let mount: FileMount | undefined;
let closeDrive: (() => Promise<void>) | undefined;
let maxFileBytes = 1024 * 1024;

if (process.env.DRIVE_DISABLED !== '1') {
  const drive = createDrive(env, {
    directory: resolve(process.env.DRIVE_DIRECTORY ?? `${dataDir}/files`),
    namespace: process.env.DRIVE_NAMESPACE ?? 'agent-network',
    maxFileBytes: positiveInt(process.env.DRIVE_MAX_FILE_BYTES, 128 * 1024 * 1024),
    ttlSeconds: positiveInt(process.env.DRIVE_TTL_SECONDS, 86400),
    allowedOrigins: origins(process.env.ALLOWED_ORIGINS, publicOrigin),
  });
  await drive.fileService.ready;
  mount = drive.mount;
  closeDrive = () => drive.fileService.close();
  maxFileBytes = drive.fileService.maxFileBytes;
  console.log(
    `drive enabled: ${resolve(process.env.DRIVE_DIRECTORY ?? `${dataDir}/files`)} (ttl ${drive.fileService.ttlSeconds}s, max ${drive.fileService.maxFileBytes} bytes)`,
  );
}

const app = createApp(env, { mount });

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
    server.stop();
    await closeDrive?.();
    db.close();
    process.exit(0);
  });
}
