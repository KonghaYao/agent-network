/**
 * Q04 验收共享夹具：自托管临时 Bun 实例、真实 MCP 对账、浏览器上下文与页面动作。
 *
 * 只复用现有服务端与 `scripts/lib/harness.ts` 的 rawRpc/断言，不替换成功响应；
 * 故障注入只用于明确标注的失败/重试路径。所有 token 只保存在进程内，日志只输出
 * 布尔值和 actor_id，不输出凭据、挑战或消息正文。
 */

import { rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { Database } from 'bun:sqlite';

import { rawRpc, sleep } from './harness';

export { check, checkEqual, checksPassed, ToolError, CheckFailure } from './harness';
export { sleep };

export interface Actor {
  actor_id: string;
  actor_session_id?: string | null;
  agent_session_id?: string | null;
  name: string;
  kind?: string;
}

export interface RoomView {
  room: {
    room_id: string;
    kind: string;
    title?: string;
    head_seq: string;
    my_last_read_seq?: string;
    updated_at: string;
    member_count?: number;
    status?: string;
    owner_id?: string | null;
    policy_revision?: number;
  };
  members: {
    actor_id: string;
    kind: string;
    name: string;
    role?: string;
    role_revision?: number;
    status?: string;
  }[];
  owner_transfer?: Record<string, unknown> | null;
}

export interface ManagedAgentView extends Actor {
  token: string;
  agent_session_id: string | null;
  mcp_url?: string;
}

export function newRequestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

export async function rawTool<T>(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const response = await rawRpc('tools/call', { name, arguments: args }, { token });
  if (response.body.error) {
    const rpcError = response.body.error as {
      code?: number | string;
      message?: string;
      data?: { code?: string };
    };
    const code = rpcError.data?.code ?? String(rpcError.code ?? 'UNKNOWN');
    const error = new Error(`${code}: ${rpcError.message ?? ''}`);
    (error as Error & { code?: string }).code = code;
    throw error;
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
        detail = JSON.parse(text) as { code?: string; message?: string; details?: unknown };
      } catch {
        detail = { message: text };
      }
    }
    const error = new Error(`${detail.code ?? 'UNKNOWN'}: ${detail.message ?? ''}`);
    (error as Error & { code?: string; details?: unknown }).code = detail.code;
    (error as Error & { code?: string; details?: unknown }).details = detail.details;
    throw error;
  }
  if (result.structuredContent) return result.structuredContent;
  return text ? (JSON.parse(text) as T) : ({} as T);
}

export async function rawToolError(
  token: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ code: string; message: string }> {
  try {
    await rawTool(token, name, args);
  } catch (error) {
    const failure = error as Error & { code?: string };
    return { code: failure.code ?? 'UNKNOWN', message: failure.message };
  }
  return { code: 'OK', message: '' };
}

export async function startQ04Server(): Promise<{
  base: string;
  dataDir: string;
  dbPath: string;
  stop: () => Promise<void>;
}> {
  const port = 19100 + Math.floor(Math.random() * 700);
  const base = `http://127.0.0.1:${port}`;
  const dataDir = `/tmp/agentnet-q04-${process.pid}-${Date.now()}`;
  const dbPath = resolve(dataDir, 'agent-network.sqlite');
  const proc = Bun.spawn(['bun', resolve(import.meta.dir, '../../src/bun/main.ts')], {
    cwd: resolve(import.meta.dir, '../..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      PUBLIC_ORIGIN: base,
      // Q04 专用短 presence 窗口；生产默认仍由 contracts/limits.ts 决定。
      AGENT_PRESENCE_GRACE_MS: '1200',
      AGENT_PRESENCE_ACTIVITY_TTL_MS: '1200',
      AGENT_PRESENCE_TOUCH_THROTTLE_MS: '100',
      AGENT_PRESENCE_SWEEP_MS: '150',
      // 让测试失败可诊断，但不改变业务分支。
      NODE_ENV: 'test',
    },
    stdout: 'ignore',
    stderr: 'inherit',
  });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try {
        const response = await fetch(`${base}/health`);
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // 服务尚未监听
      }
      await sleep(100);
    }
    if (!ready) throw new Error('Q04 本地实例未在 15s 内就绪');
  } catch (error) {
    proc.kill();
    throw error;
  }
  return {
    base,
    dataDir,
    dbPath,
    async stop() {
      proc.kill();
      await proc.exited.catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/**
 * 浏览器初始化：种子 token、记录 MCP 调用与流信号、支持一次延迟与 stream 中止。
 * `humanAuth` 只记录布尔值，因此错误日志与截图都不会带出凭据。
 */
export function q04InitScript(token: string): string {
  return `(() => {
  const TOKEN = ${JSON.stringify(token)};
  try {
    // 每个浏览器上下文只种一次；页面内导航、重载和身份切换不能把 token 覆盖回夹具值。
    if (sessionStorage.getItem('__q04TokenSeeded') !== '1') {
      localStorage.setItem('agent-network-token', TOKEN);
      sessionStorage.setItem('__q04TokenSeeded', '1');
    }
  } catch (error) {}
  window.__mcpCalls = [];
  window.__fetchLog = [];
  window.__delayMcp = null;
  window.__delayedMcpHit = false;
  window.__failStreams = false;
  window.__streamSignals = [];
  window.__abortControllers = [];
  const NativeAbortController = window.AbortController;
  window.AbortController = function TrackedAbortController() {
    const controller = new NativeAbortController();
    window.__abortControllers.push(controller);
    return controller;
  };
  window.AbortController.prototype = NativeAbortController.prototype;
  window.__abortStream = function () {
    for (let index = window.__abortControllers.length - 1; index >= 0; index -= 1) {
      const controller = window.__abortControllers[index];
      if (!controller.signal.aborted && window.__streamSignals.indexOf(controller.signal) >= 0) {
        controller.abort();
        return true;
      }
    }
    return false;
  };
  const originalFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    const headers = (init && init.headers) || {};
    let body = null;
    try { body = init && init.body ? JSON.parse(init.body) : null; } catch (error) {}
    const notifications = body && body.params && body.params.notifications;
    const subscriptions = notifications && notifications.resourceSubscriptions;
    const isStream = headers['mcp-method'] === 'subscriptions/listen' &&
      Array.isArray(subscriptions) && subscriptions.indexOf('agentnet://stream') >= 0;
    const args = body && body.params && body.params.arguments;
    const call = {
      method: headers['mcp-method'] || null,
      name: headers['mcp-name'] || null,
      roomId: args && args.room_id ? args.room_id : null,
      id: body && body.id,
      subscriptions: Array.isArray(subscriptions) ? subscriptions : null,
      hasAuth: Boolean(headers['authorization']),
      humanAuth: headers['authorization'] === 'Bearer ' + TOKEN,
      stream: isStream,
      aborted: false,
      at: Date.now()
    };
    window.__mcpCalls.push(call);
    if (isStream && init && init.signal) {
      window.__streamSignals.push(init.signal);
      if (window.__failStreams) {
        call.failed = true;
        return Promise.reject(new TypeError('simulated stream failure'));
      }
    }
    if (init && init.signal) {
      if (init.signal.aborted) call.aborted = true;
      else init.signal.addEventListener('abort', function () { call.aborted = true; }, { once: true });
    }
    const delay = window.__delayMcp;
    const shouldDelay = Boolean(
      delay && call.name === delay.name && (!delay.roomId || call.roomId === delay.roomId)
    );
    if (shouldDelay) window.__delayedMcpHit = true;
    return originalFetch(input, init).then(function (response) {
      if (!shouldDelay) return response;
      return new Promise(function (resolve) {
        setTimeout(function () { resolve(response); }, delay.ms);
      });
    });
  };
})();`;
}

export const IGNORED_CONSOLE = [
  'Failed to load resource',
  'net::ERR_',
  'the server responded with a status',
];

export async function makeContext(
  browser: Browser,
  token: string,
  viewport: { width: number; height: number },
  errors: string[],
  options: {
    colorScheme?: 'light' | 'dark';
    hasTouch?: boolean;
    isMobile?: boolean;
    watchConsole?: boolean;
  } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport,
    colorScheme: options.colorScheme ?? 'light',
    hasTouch: options.hasTouch ?? false,
    isMobile: options.isMobile ?? false,
  });
  await context.addInitScript({ content: q04InitScript(token) });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  if (options.watchConsole !== false) {
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (IGNORED_CONSOLE.some((part) => text.includes(part))) return;
      errors.push(`console: ${text}`);
    });
  }
  return { context, page };
}

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export function roomLink(roomId: string): string {
  return `#room-list a.room-item[href="/c/${encodeURIComponent(roomId)}"]`;
}

export async function waitRoom(page: Page, roomId: string, title: string): Promise<void> {
  // 移动端 page-room 会隐藏侧栏，但会话项仍应存在于 DOM；只要求 attached。
  await page.locator(roomLink(roomId)).waitFor({ state: 'attached' });
  await page.waitForFunction(
    `document.getElementById('title') && document.getElementById('title').textContent === ${JSON.stringify(title)}`,
  );
  await page.waitForFunction(
    `document.getElementById('chat-skeleton') && document.getElementById('chat-skeleton').hidden === true`,
  );
}

export async function waitText(page: Page, selector: string, text: string, timeout = 12_000): Promise<void> {
  await page.waitForFunction(
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return Boolean(node && (node.innerText || node.textContent || '').includes(${JSON.stringify(text)}));
    })()`,
    undefined,
    { timeout },
  );
}

export async function waitMessageText(page: Page, text: string, timeout = 12_000): Promise<void> {
  await page.waitForFunction(
    `(() => Array.from(document.querySelectorAll('#messages .msg')).some((node) =>
      (node.innerText || '').includes(${JSON.stringify(text)})))()`,
    undefined,
    { timeout },
  );
}

export async function waitStreamConnected(page: Page): Promise<void> {
  await page.waitForFunction(
    `(window.__mcpCalls || []).filter(function (call) {
      return call.method === 'subscriptions/listen' && call.stream === true;
    }).length >= 1`,
  );
}

export async function sendMessage(
  token: string,
  roomId: string,
  body: string,
  extra: Record<string, unknown> = {},
): Promise<{ message: { message_id: string; seq?: number } }> {
  return rawTool(token, 'network_message_send', {
    request_id: newRequestId('q04_msg'),
    client_message_id: crypto.randomUUID(),
    room_id: roomId,
    body,
    ...extra,
  });
}

export async function befriend(
  requesterToken: string,
  targetToken: string,
  target: { actor_id?: string; agent_session_id?: string },
): Promise<void> {
  const requested = await rawTool<{
    status: string;
    request: { contact_request_id: string } | null;
  }>(requesterToken, 'network_contact_request', {
    request_id: newRequestId('q04_contact'),
    ...(target.actor_id ? { actor_id: target.actor_id } : { agent_session_id: target.agent_session_id }),
  });
  if (requested.status === 'accepted') return;
  if (!requested.request) throw new Error(`好友申请未进入 pending: ${requested.status}`);
  await rawTool(targetToken, 'network_contact_request_respond', {
    request_id: newRequestId('q04_contact_respond'),
    contact_request_id: requested.request.contact_request_id,
    action: 'accept',
  });
}

export async function createManagedAgent(
  managerToken: string,
  name: string,
): Promise<ManagedAgentView> {
  const created = await rawTool<ManagedAgentView>(managerToken, 'network_agent_create', {
    request_id: newRequestId('q04_agent_create'),
    name,
  });
  // 管理者向自有 Agent 申请会自动建立关系；这里只补 direct，便于 UI 菜单。
  await rawTool(managerToken, 'network_contact_request', {
    request_id: newRequestId('q04_agent_contact'),
    actor_id: created.actor_id,
  }).catch(() => undefined);
  return created;
}

export async function findDirectRoom(token: string, actorId: string): Promise<RoomView> {
  const rooms = await rawTool<{ items: { room_id: string; kind: string; peer?: { actor_id: string } }[] }>(
    token,
    'network_rooms_list',
    { limit: 100 },
  );
  for (const item of rooms.items) {
    if (item.kind !== 'direct') continue;
    const detail = await rawTool<RoomView>(token, 'network_room_get', { room_id: item.room_id });
    if (detail.members.some((member) => member.actor_id === actorId)) return detail;
  }
  throw new Error('未找到 direct 会话');
}

export async function acceptRoomInvites(token: string, roomId: string): Promise<number> {
  const page = await rawTool<{
    items: { invitation_id: string; room_id: string; status: string; can_respond?: boolean }[];
  }>(token, 'network_room_invite_get', { status: 'pending', limit: 100 });
  let accepted = 0;
  for (const item of page.items) {
    if (item.room_id !== roomId || item.status !== 'pending') continue;
    await rawTool(token, 'network_room_invite_respond', {
      request_id: newRequestId('q04_invite_respond'),
      invitation_id: item.invitation_id,
      action: 'accept',
    });
    accepted += 1;
  }
  return accepted;
}

export interface UploadedFile {
  fileId: string;
  name: string;
}

export async function uploadFile(
  token: string,
  base: string,
  name: string,
  mimeType: string,
  bytes: Uint8Array,
): Promise<UploadedFile> {
  const response = await fetch(`${base}/mcp-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'MCPP-Files-Version': '1',
      'content-type': mimeType,
      'MCPP-File-Name': encodeURIComponent(name),
      'MCPP-File-Size': String(bytes.length),
    },
    body: bytes as unknown as BodyInit,
  });
  if (response.status !== 201) throw new Error(`上传失败 ${name}: HTTP ${response.status}`);
  const body = (await response.json()) as { fileId: string };
  return { fileId: body.fileId, name };
}

export const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=',
  'base64',
);

export async function screenshot(
  page: Page,
  name: string,
  options: { mask?: string[]; fullPage?: boolean } = {},
): Promise<string> {
  const dir = resolve(import.meta.dir, '../../reports/evidence/q04');
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${name}.png`);
  await page.screenshot({
    path,
    fullPage: options.fullPage ?? false,
    ...(options.mask && options.mask.length > 0
      ? { mask: options.mask.map((selector) => page.locator(selector)) }
      : {}),
  });
  return `reports/evidence/q04/${name}.png`;
}

/**
 * 只用于构造验收夹具难以自然到达的状态（例如 ownerless 遗留群、failed 任务）。
 * 不修改业务代码；使用后立即关闭连接。
 */
export function withDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const db = new Database(dbPath);
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    return fn(db);
  } finally {
    db.close();
  }
}

export async function noHorizontalOverflow(page: Page, label: string): Promise<void> {
  const metrics = (await page.evaluate(`(() => ({
    view: window.innerWidth,
    doc: document.documentElement.scrollWidth,
    body: document.body ? document.body.scrollWidth : 0
  }))()`)) as { view: number; doc: number; body: number };
  if (metrics.doc > metrics.view + 1 || metrics.body > metrics.view + 1) {
    throw new Error(`${label}: 横向溢出 ${JSON.stringify(metrics)}`);
  }
}

export async function waitForFunctionText(
  page: Page,
  expression: string,
  label: string,
  timeout = 12_000,
): Promise<void> {
  try {
    await page.waitForFunction(expression, undefined, { timeout });
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`);
  }
}
