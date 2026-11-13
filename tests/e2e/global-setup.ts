import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Playwright 的 globalSetup 运行在 Node 下，不能直接使用 `Bun.spawn`。
 * 这里用 Node 原生 API 启动同一个 `src/bun/main.ts`，行为与
 * `scripts/lib/test-server.ts` 一致：PORT=0、临时 DATA_DIR、/health 就绪。
 */
let child: ChildProcess | undefined;
let dataDir: string | undefined;

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port > 0 ? resolvePort(port) : reject(new Error('无法预留端口'))));
    });
  });
}

async function waitForHealth(base: string, deadlineMs = 20_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) return;
    } catch {
      // 尚未监听。
    }
    if (Date.now() > deadline) throw new Error(`E2E 服务未就绪：${base}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
}

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (process.env.E2E_BASE_URL) return undefined;

  const root = resolve(process.cwd());
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  dataDir = await mkdtemp(join(tmpdir(), 'agentnet-e2e-'));
  child = spawn('bun', [resolve(root, 'src/bun/main.ts')], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      DATA_DIR: dataDir,
      PUBLIC_ORIGIN: base,
      ENVIRONMENT: 'test',
      // 默认不启用 SPA；需要 SPA 用例时由调用方显式设置。
      WEB_SPA_ROUTES: process.env.WEB_SPA_ROUTES ?? '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-4000);
  });

  try {
    await waitForHealth(base);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${(error as Error).message}\n${stderr}`);
  }

  const runtimeDir = resolve(root, '.e2e');
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(join(runtimeDir, 'server.json'), JSON.stringify({ base }), 'utf8');
  process.env.E2E_BASE_URL = base;

  return async () => {
    child?.kill('SIGTERM');
    if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  };
}
