/**
 * 测试自托管实例的统一启动器。
 *
 * 默认 `PORT=0`：由内核分配空闲端口，再从启动日志解析实际端口，避免多个套件
 * 用随机端口互相碰撞。需要 `PUBLIC_ORIGIN` 与监听地址一致的浏览器套件可以先用
 * `reservePort()` 预留端口，再把端口传给 `startTestServer()`；预留与子进程绑定
 * 之间的窗口只有毫秒级，远小于随机端口的冲突面。
 *
 * 这里只负责进程生命周期、日志收集与就绪探测，不改变服务端行为；业务断言仍由
 * 各套件自己维护。
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const WORKTREE_ROOT = resolve(import.meta.dir, '../..');
const LISTENING_PATTERN = /agent-network listening on http:\/\/[^:\s]+:(\d+)/u;
/** 只保留最近的日志；避免长时间套件把进程输出无界累积在内存。 */
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export interface TestServerOptions {
  /** 显式端口；省略或 0 表示由内核分配。 */
  readonly port?: number;
  /** 复用已有数据目录（例如重启验收）；省略时创建临时目录。 */
  readonly dataDir?: string;
  /** 追加/覆盖子进程环境变量；值为 `undefined` 时删除该变量。 */
  readonly env?: Record<string, string | undefined>;
  readonly hostname?: string;
  readonly readyTimeoutMs?: number;
  /** 就绪探测路径，默认 `/health`。 */
  readonly readyPath?: string;
  /** 临时目录前缀，便于失败时定位套件。 */
  readonly tag?: string;
}

export interface TestServer {
  readonly base: string;
  readonly port: number;
  readonly hostname: string;
  readonly dataDir: string;
  readonly proc: Bun.Subprocess;
  /** 子进程 stdout + stderr 的累计输出（用于排查与日志脱敏断言）。 */
  logs(): string;
  /** stdout + stderr 的尾部，避免失败诊断刷屏。 */
  tail(limit?: number): string;
  /** 发送 SIGTERM，超时后 SIGKILL；可重复调用。 */
  stop(): Promise<void>;
  /** stop()，并在本套件创建了临时目录时删除它。 */
  dispose(): Promise<void>;
}

const liveServers = new Set<TestServer>();

function cleanupAll(): void {
  for (const server of liveServers) {
    try {
      server.proc.kill('SIGKILL');
    } catch {
      // 进程已退出。
    }
  }
  liveServers.clear();
}

process.once('exit', cleanupAll);
process.once('SIGINT', () => {
  cleanupAll();
  process.exit(130);
});
process.once('SIGTERM', () => {
  cleanupAll();
  process.exit(143);
});

/** 预留一个空闲端口；用于必须提前知道 PUBLIC_ORIGIN 的浏览器套件。 */
export function reservePort(hostname = '127.0.0.1'): number {
  const probe = Bun.serve({ hostname, port: 0, fetch: () => new Response('') });
  const port = probe.port;
  probe.stop(true);
  if (typeof port !== 'number' || port <= 0) {
    throw new Error('无法预留空闲端口');
  }
  return port;
}

interface RunningProcess {
  readonly proc: Bun.Subprocess;
  readonly port: number;
  readonly logs: () => string;
  readonly tail: (limit?: number) => string;
  /** stdout/stderr 读取结束；stop() 用它保证日志断言看到完整输出。 */
  readonly drained: Promise<void>;
}

async function spawnOnce(options: {
  dataDir: string;
  hostname: string;
  requestedPort: number;
  env: Record<string, string | undefined> | undefined;
  readyPath: string;
  readyTimeoutMs: number;
}): Promise<RunningProcess> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOST: options.hostname,
    PORT: String(options.requestedPort),
    DATA_DIR: options.dataDir,
    ...options.env,
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) delete env[key];
  }
  const proc = Bun.spawn(['bun', resolve(WORKTREE_ROOT, 'src/bun/main.ts')], {
    cwd: WORKTREE_ROOT,
    env: env as Record<string, string>,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const decoder = new TextDecoder();
  let stdout = '';
  let stderr = '';
  let port: number | null = options.requestedPort > 0 ? options.requestedPort : null;

  const pump = async (
    stream: ReadableStream<Uint8Array> | number | undefined,
    append: (text: string) => void,
  ): Promise<void> => {
    if (!stream || typeof stream === 'number') return;
    try {
      for await (const chunk of stream as AsyncIterable<Uint8Array>) {
        append(decoder.decode(chunk, { stream: true }));
      }
    } catch {
      // 管道随进程退出关闭。
    }
  };

  const pumps = Promise.all([
    pump(proc.stdout, (text) => {
      stdout = (stdout + text).slice(-MAX_LOG_BYTES);
      if (port !== null) return;
      const match = LISTENING_PATTERN.exec(stdout);
      if (!match) return;
      const parsed = Number(match[1]);
      if (Number.isSafeInteger(parsed) && parsed > 0) port = parsed;
    }),
    pump(proc.stderr, (text) => {
      stderr = (stderr + text).slice(-MAX_LOG_BYTES);
    }),
  ]).then(() => undefined);

  const logs = (): string => `${stdout}\n${stderr}`;
  const tail = (limit = 12): string => logs().split('\n').slice(-limit).join('\n');
  const deadline = Date.now() + options.readyTimeoutMs;
  for (;;) {
    const candidate = port;
    if (candidate !== null) {
      try {
        const response = await fetch(`http://${options.hostname}:${candidate}${options.readyPath}`);
        if (response.ok) return { proc, port: candidate, logs, tail, drained: pumps };
      } catch {
        // 尚未监听。
      }
    }
    if (Date.now() > deadline) {
      proc.kill('SIGKILL');
      await proc.exited.catch(() => undefined);
      throw new Error(
        `测试实例未在超时内就绪 (PORT=${options.requestedPort}, DATA_DIR=${options.dataDir})\n` +
          `stdout:\n${stdout.slice(-4000)}\nstderr:\n${stderr.slice(-4000)}`,
      );
    }
    await Bun.sleep(50);
  }
}

/** 启动一个隔离实例；失败时清理进程与本次创建的临时目录。 */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const hostname = options.hostname ?? '127.0.0.1';
  const ownsDataDir = options.dataDir === undefined;
  const dataDir =
    options.dataDir ?? (await mkdtemp(join(tmpdir(), `agentnet-${options.tag ?? 'test'}-`)));
  const requestedPort = options.port ?? 0;

  let running: RunningProcess;
  try {
    running = await spawnOnce({
      dataDir,
      hostname,
      requestedPort,
      env: options.env,
      readyPath: options.readyPath ?? '/health',
      readyTimeoutMs: options.readyTimeoutMs ?? 20_000,
    });
  } catch (error) {
    if (ownsDataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  let stopped = false;
  const server: TestServer = {
    base: `http://${hostname}:${running.port}`,
    port: running.port,
    hostname,
    dataDir,
    proc: running.proc,
    logs: running.logs,
    tail: running.tail,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      liveServers.delete(server);
      if (running.proc.exitCode !== null) return;
      running.proc.kill('SIGTERM');
      const exited = await Promise.race([
        running.proc.exited.then(() => true),
        Bun.sleep(5_000).then(() => false),
      ]);
      if (!exited) {
        running.proc.kill('SIGKILL');
        await running.proc.exited.catch(() => undefined);
      }
      await Promise.race([running.drained, Bun.sleep(500)]);
    },
    dispose: async () => {
      await server.stop();
      if (ownsDataDir) {
        await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  };
  liveServers.add(server);
  return server;
}
