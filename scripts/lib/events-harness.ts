/**
 * MCP Events 验收共享工具：自签 HTTPS receiver、独立 WeBots 进程与
 * Standard Webhooks 签名校验。测试私钥只在临时目录生成，不提交。
 */

import { createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { waitUntil } from './harness';

export const MCP_EVENT_NAME = 'agentnet.message.created';

export interface TestCertificate {
  cert: string;
  key: string;
}

export async function ensureTestCertificate(directory: string): Promise<TestCertificate> {
  mkdirSync(directory, { recursive: true });
  const certPath = join(directory, 'cert.pem');
  const keyPath = join(directory, 'key.pem');
  if (!existsSync(certPath) || !existsSync(keyPath)) {
    const configPath = join(directory, 'openssl.cnf');
    writeFileSync(
      configPath,
      [
        '[req]',
        'distinguished_name = dn',
        'x509_extensions = v3',
        'prompt = no',
        '[dn]',
        'CN = 127.0.0.1',
        '[v3]',
        'subjectAltName = IP:127.0.0.1, DNS:localhost',
        '',
      ].join('\n'),
    );
    const result = Bun.spawnSync(
      [
        'openssl',
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        keyPath,
        '-out',
        certPath,
        '-days',
        '1',
        '-config',
        configPath,
      ],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    if (result.exitCode !== 0) {
      throw new Error(`openssl 生成测试证书失败: ${result.stderr.toString()}`);
    }
  }
  return {
    cert: readFileSync(certPath, 'utf8'),
    key: readFileSync(keyPath, 'utf8'),
  };
}

export interface ReceiverRequest {
  path: string;
  query: string;
  headers: Headers;
  body: string;
  at: number;
  isVerification: boolean;
  eventId: string | null;
  subscriptionId: string | null;
}

export interface TestReceiver {
  port: number;
  requests: ReceiverRequest[];
  url(path?: string, query?: string): string;
  events(path: string): ReceiverRequest[];
  verificationRequests(): ReceiverRequest[];
  waitForRequest(
    predicate: (request: ReceiverRequest) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<ReceiverRequest>;
  waitForEvent(
    predicate: (request: ReceiverRequest) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<ReceiverRequest>;
  stop(): void;
}

const sleep = (ms: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, ms));

export function startTestReceiver(input: {
  port?: number;
  certificate: TestCertificate;
}): TestReceiver {
  const requests: ReceiverRequest[] = [];
  const eventCounts = new Map<string, number>();

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: input.port ?? 0,
    tls: { cert: input.certificate.cert, key: input.certificate.key },
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const isVerification = parsed.type === 'verification';
      const key = `${url.pathname}${url.search}`;
      requests.push({
        path: url.pathname,
        query: url.search,
        headers: request.headers,
        body: text,
        at: Date.now(),
        isVerification,
        eventId: typeof parsed.eventId === 'string' ? parsed.eventId : null,
        subscriptionId: request.headers.get('x-mcp-subscription-id'),
      });

      if (isVerification) {
        if (url.pathname === '/verify-500') {
          return new Response('verification failed', { status: 500 });
        }
        if (url.pathname === '/verify-bad') {
          return Response.json({ challenge: 'wrong-challenge' });
        }
        if (url.pathname === '/verify-slow') {
          await sleep(2_000);
        }
        return Response.json({ challenge: parsed.challenge });
      }

      const count = (eventCounts.get(key) ?? 0) + 1;
      eventCounts.set(key, count);
      if (url.pathname === '/always-500') {
        return new Response('failed', { status: 500 });
      }
      if (url.pathname === '/fail-once') {
        return new Response(count === 1 ? 'failed' : '{}', {
          status: count === 1 ? 500 : 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname === '/gone') return new Response('gone', { status: 410 });
      if (url.pathname === '/too-large') return new Response('too large', { status: 413 });
      if (url.pathname === '/slow') {
        await sleep(2_000);
        return Response.json({});
      }
      return Response.json({});
    },
  });

  return {
    port: server.port ?? 0,
    requests,
    url(path = '/callback', query = '') {
      return `https://127.0.0.1:${server.port}${path}${query}`;
    },
    events(path) {
      return requests.filter((item) => !item.isVerification && item.path === path);
    },
    verificationRequests() {
      return requests.filter((item) => item.isVerification);
    },
    async waitForRequest(predicate, label, timeoutMs = 8_000) {
      let found: ReceiverRequest | undefined;
      await waitUntil(
        label,
        () => {
          found = requests.find(predicate);
          return found !== undefined;
        },
        timeoutMs,
        50,
      );
      return found!;
    },
    async waitForEvent(predicate, label, timeoutMs = 8_000) {
      return this.waitForRequest(
        (item) => !item.isVerification && predicate(item),
        label,
        timeoutMs,
      );
    },
    stop() {
      server.stop(true);
    },
  };
}

export function webhookSignature(
  secret: string,
  webhookId: string,
  timestamp: string,
  body: string,
): string {
  const secretBytes = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const digest = createHmac('sha256', secretBytes)
    .update(`${webhookId}.${timestamp}.${body}`)
    .digest('base64');
  return `v1,${digest}`;
}

export function signatureCandidates(request: ReceiverRequest): string[] {
  const header = request.headers.get('webhook-signature') ?? '';
  return header
    .split(' ')
    .map((value) => value.trim())
    .filter((value) => value.startsWith('v1,'));
}

export function verifyWebhookSignature(secret: string, request: ReceiverRequest): boolean {
  const webhookId = request.headers.get('webhook-id');
  const timestamp = request.headers.get('webhook-timestamp');
  if (!webhookId || !timestamp) return false;
  const expected = webhookSignature(secret, webhookId, timestamp, request.body);
  return signatureCandidates(request).includes(expected);
}

export function verifyAnyWebhookSignature(
  secrets: string[],
  request: ReceiverRequest,
): boolean {
  return secrets.some((secret) => verifyWebhookSignature(secret, request));
}

export interface TestServer {
  readonly port: number;
  readonly dataDir: string;
  readonly dbPath: string;
  logs(): string;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

export interface TestServerOptions {
  port: number;
  dataDir: string;
  encryptionKey: string;
  extraEnv?: Record<string, string>;
}

function collectStream(
  stream: ReadableStream<Uint8Array> | undefined,
  sink: string[],
): void {
  if (!stream) return;
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        sink.push(decoder.decode(value, { stream: true }));
      }
    } catch {
      // 进程退出时流可能被关闭。
    }
  })();
}

export async function startTestServer(options: TestServerOptions): Promise<TestServer> {
  const root = resolve(import.meta.dir, '../..');
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'agent-network.sqlite');
  const logs: string[] = [];
  let processHandle: ReturnType<typeof Bun.spawn> | null = null;

  try {
    const existing = await fetch(`http://127.0.0.1:${options.port}/health`);
    if (existing.ok) {
      throw new Error(`端口 ${options.port} 已被占用；先停止已有 WeBots 实例`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('已被占用')) throw error;
  }

  const spawnServer = (): void => {
    const environment: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PORT: String(options.port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PUBLIC_ORIGIN: `http://127.0.0.1:${options.port}`,
      ENVIRONMENT: 'test',
      EVENTS_ENABLED: '1',
      EVENTS_ENCRYPTION_KEY: options.encryptionKey,
      EVENTS_TEST_ALLOW_PRIVATE: '1',
      EVENTS_VERIFICATION_TIMEOUT_MS: '500',
      EVENTS_WEBHOOK_TIMEOUT_MS: '400',
      EVENTS_VERIFICATION_PER_HOST_PER_MINUTE: '1000',
      DRIVE_DISABLED: '1',
      ...options.extraEnv,
    };
    const child = Bun.spawn(['bun', 'src/bun/main.ts'], {
      cwd: root,
      env: environment,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    processHandle = child;
    collectStream(child.stdout, logs);
    collectStream(child.stderr, logs);
  };

  const stopProcess = async (): Promise<void> => {
    if (!processHandle || processHandle.exitCode !== null) return;
    processHandle.kill('SIGTERM');
    await Promise.race([processHandle.exited, sleep(5_000)]);
    if (processHandle.exitCode === null) processHandle.kill('SIGKILL');
  };

  const waitForHealth = async (): Promise<void> => {
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (processHandle && processHandle.exitCode !== null) {
        throw new Error(`WeBots 测试进程提前退出:\n${logs.join('')}`);
      }
      try {
        const response = await fetch(`http://127.0.0.1:${options.port}/health`);
        if (response.ok) return;
      } catch {
        // 尚未监听。
      }
      if (Date.now() > deadline) {
        throw new Error(`等待 WeBots 测试进程超时:\n${logs.join('')}`);
      }
      await sleep(100);
    }
  };

  spawnServer();
  try {
    await waitForHealth();
  } catch (error) {
    await stopProcess();
    throw error;
  }

  return {
    port: options.port,
    dataDir,
    dbPath,
    logs() {
      return logs.join('');
    },
    async stop() {
      await stopProcess();
    },
    async restart() {
      await stopProcess();
      spawnServer();
      await waitForHealth();
    },
  };
}

export function removeTestData(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}
