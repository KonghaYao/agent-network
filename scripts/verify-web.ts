/**
 * 浏览器验收：SPA 路由、状态缓存、加载/错误收口与响应式布局。
 *
 * 脚本自托管一个临时 Bun 实例（随机端口 + 临时 DATA_DIR，启用 MCPP Files），用 rawRpc
 * 创建人类/Agent/房间 fixture，文件模块使用真实上传与 room_files 工具；只对失败与
 * 延迟场景做请求级故障注入，不替换成功响应。然后由 Playwright 驱动真实页面。
 * 首次运行前如本机没有 Chromium，执行 `bunx playwright install chromium`。
 * 运行：bun run test:web
 */

import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Database } from 'bun:sqlite';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';

import { extractMessageFileLinks } from '../src/contracts/file-links';
import { LIMITS } from '../src/contracts/limits';
import {
  callTool,
  check,
  checkEqual,
  checksPassed,
  connectClient,
  newToken,
  openSubscription,
  rawRpc,
  sleep,
} from './lib/harness';
import { messageFileLinkFixtures } from './lib/room-file-archive';
import { reservePort, startTestServer } from './lib/test-server';
import { runPresenceRestartAcceptance } from './lib/presence-restart';
import { runPresenceIdleNotificationCheck } from './lib/presence-idle';
import { runFileTicketSecretChecks } from './lib/file-ticket-secret-check';

interface Actor {
  actor_id: string;
  agent_session_id?: string | null;
  name: string;
}

interface RoomDetail {
  room: {
    room_id: string;
    kind: string;
    title?: string;
    head_seq: string;
    my_last_read_seq?: string;
    updated_at: string;
    member_count?: number;
  };
  members: { actor_id: string; kind: string; name: string }[];
}

interface McpCall {
  method: string | null;
  name: string | null;
  body: unknown;
  aborted: boolean;
}

function streamCallsExpression(): string {
  return `(window.__mcpCalls || []).filter(function (call) { return call.stream === true; })`;
}

function roomHeadSubscriptionsExpression(): string {
  return `(window.__mcpCalls || []).filter(function (call) {
    return call.method === 'subscriptions/listen' &&
      JSON.stringify(call.subscriptions || []).indexOf('agentnet://rooms/') >= 0;
  }).length`;
}

const IGNORED_CONSOLE = ['Failed to load resource', 'net::ERR_'];
const DEPRECATED_PROMPT_SCRIPTS = ['agentnet.sh', 'agent_tasks.sh', '-watch.sh'];
const PROMPT_SHORT_CLI = [
  '/skills/agentnet.js',
  'bun agentnet.js --help',
  'bun agentnet.js skills --harness',
  'bun agentnet.js monitor --harness',
];
const REMOVED_PROMPT_TEXT = ['群聊 @ 规则', 'share_url', 'AGENTNET_MCP_URL', '身份名称：'];
const DEPRECATED_PROMPT_STEPS = ['curl -fsSL', 'bun agentnet.js login', ' register --name', ' issue'];

export async function rawTool<T>(token: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await rawRpc('tools/call', { name, arguments: args }, { token });
  const result = response.body.result as
    | {
        isError?: boolean;
        structuredContent?: T;
        content?: { type: string; text?: string }[];
      }
    | undefined;
  if (!result) throw new Error(`工具 ${name} 无结果: ${JSON.stringify(response.body)}`);
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (result.isError) {
    let detail: { code?: string; message?: string } = {};
    if (text) {
      try {
        detail = JSON.parse(text) as { code?: string; message?: string };
      } catch {
        detail = { message: text };
      }
    }
    throw new Error(`${detail.code ?? 'UNKNOWN'}: ${detail.message ?? ''}`);
  }
  if (result.structuredContent) return result.structuredContent;
  return text ? (JSON.parse(text) as T) : ({} as T);
}

interface RawContactRequestView {
  status: string;
  request: { contact_request_id: string } | null;
}

/** 建立双向好友：申请后由目标本人接受，绝不因 kind=agent 自动同意。 */
async function rawBefriend(
  requesterToken: string,
  targetToken: string,
  target: { actor_id?: string; agent_session_id?: string },
): Promise<void> {
  const requested = await rawTool<RawContactRequestView>(requesterToken, 'network_contact_request', {
    request_id: requestId('contact_request'),
    ...(target.actor_id
      ? { actor_id: target.actor_id }
      : { agent_session_id: target.agent_session_id }),
  });
  if (requested.status === 'accepted') return;
  if (!requested.request) throw new Error(`好友申请未进入 pending: ${requested.status}`);
  await rawTool(targetToken, 'network_contact_request_respond', {
    request_id: requestId('contact_accept'),
    contact_request_id: requested.request.contact_request_id,
    action: 'accept',
  });
}

/** 管理者向自有 Agent 申请会自动接受；用于网络 Agent 创建后的建联。 */
async function rawOwnAgentLink(
  requesterToken: string,
  target: { actor_id?: string; agent_session_id?: string },
): Promise<void> {
  const requested = await rawTool<RawContactRequestView>(requesterToken, 'network_contact_request', {
    request_id: requestId('contact_request'),
    ...(target.actor_id
      ? { actor_id: target.actor_id }
      : { agent_session_id: target.agent_session_id }),
  });
  if (requested.status !== 'accepted') {
    throw new Error(`自有 Agent 未自动建立关系: ${requested.status}`);
  }
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

function parseRgbColor(value: string): [number, number, number] {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(value);
  if (!match) throw new Error(`无法解析颜色：${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance(color: string): number {
  const [r, g, b] = parseRgbColor(color);
  const channel = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 对比度；用于断言 danger 按钮的文字与背景始终可读。 */
function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

export async function startServer(): Promise<{
  base: string;
  dataDir: string;
  stop: () => Promise<void>;
}> {
  // Playwright 需要 PUBLIC_ORIGIN 与访问地址一致，先预留端口再交给共享启动器；
  // 预留与绑定之间只有毫秒级窗口，避免多个套件用随机端口互相碰撞。
  const port = reservePort();
  const base = `http://127.0.0.1:${port}`;
  const server = await startTestServer({
    port,
    tag: 'web',
    env: {
      PUBLIC_ORIGIN: base,
      // 测试专用短宽限；生产默认仍由 contracts/limits.ts 决定。
      AGENT_PRESENCE_GRACE_MS: '1200',
      AGENT_PRESENCE_ACTIVITY_TTL_MS: '1200',
      AGENT_PRESENCE_TOUCH_THROTTLE_MS: '100',
      AGENT_PRESENCE_SWEEP_MS: '150',
    },
  });
  return {
    base: server.base,
    dataDir: server.dataDir,
    stop: () => server.dispose(),
  };
}

function initScript(token: string, seedOnce = false): string {
  return `(() => {
  const TOKEN = ${JSON.stringify(token)};
  const SEED_ONCE = ${seedOnce ? 'true' : 'false'};
  let skipTokenSeed = false;
  if (SEED_ONCE) {
    try { skipTokenSeed = sessionStorage.getItem('__tokenSeeded') === '1'; } catch (error) {}
  }
  try {
    if (!skipTokenSeed) localStorage.setItem('agent-network-token', TOKEN);
    if (SEED_ONCE) sessionStorage.setItem('__tokenSeeded', '1');
    const prior = Number(sessionStorage.getItem('__spaMarker') || '0');
    window.__spaMarker = prior + 1;
    sessionStorage.setItem('__spaMarker', String(prior + 1));
    const loads = Number(sessionStorage.getItem('__loadCount') || '0');
    window.__loadCount = loads;
  } catch (error) {
    window.__spaMarker = 1;
    window.__loadCount = 0;
  }
  window.addEventListener('load', function () {
    window.__loadCount += 1;
    try { sessionStorage.setItem('__loadCount', String(window.__loadCount)); } catch (error) {}
  });
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
    const call = {
      method: headers['mcp-method'] || null,
      name: headers['mcp-name'] || null,
      body: body,
      id: body && body.id,
      subscriptions: Array.isArray(subscriptions) ? subscriptions : null,
      // 只记录布尔值，避免把 token 放进可打印的调用记录。
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
    const args = body && body.params && body.params.arguments;
    const roomId = args && args.room_id ? args.room_id : null;
    const log = function (phase, detail) {
      window.__fetchLog.push({
        name: call.name || call.method,
        roomId: roomId,
        phase: phase,
        detail: detail === undefined ? null : detail,
        at: Date.now()
      });
    };
    log('call');
    if (init && init.signal) {
      if (init.signal.aborted) call.aborted = true;
      else init.signal.addEventListener('abort', function () { call.aborted = true; log('aborted'); }, { once: true });
    }
    const delay = window.__delayMcp;
    const shouldDelay = Boolean(
      delay && call.name === delay.name && (!delay.roomId || roomId === delay.roomId)
    );
    if (shouldDelay) window.__delayedMcpHit = true;
    return originalFetch(input, init).then(
      function (response) {
        log('resolved', response.status);
        if (!shouldDelay) return response;
        log('delaying-response');
        return new Promise(function (resolve) {
          setTimeout(function () { resolve(response); }, delay.ms);
        });
      },
      function (error) { log('rejected', error && error.name); throw error; }
    );
  };
})();`;
}

export async function makeContext(
  browser: Browser,
  token: string,
  viewport: { width: number; height: number },
  allErrors: string[],
  watchConsole = true,
  seedTokenOnce = false,
  contextOptions: { colorScheme?: 'dark' | 'light'; hasTouch?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport, ...contextOptions });
  await context.addInitScript({ content: initScript(token, seedTokenOnce) });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const recordError = (message: string): void => {
    const safe = message.replace(/([?&]token=)[^&\s]+/g, '$1[redacted]');
    allErrors.push(safe);
    console.error('Browser error at', page.url().split(/[?#]/)[0], safe);
  };
  page.on('pageerror', (error) => recordError(`pageerror: ${error.stack || error.message}`));
  if (watchConsole) {
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (IGNORED_CONSOLE.some((part) => text.includes(part))) return;
      recordError(`console: ${text}`);
    });
  }
  return { context, page };
}

function roomLink(roomId: string): string {
  return `#room-list a.room-item[href="/c/${encodeURIComponent(roomId)}"]`;
}

/** 等待左侧会话列表出现指定名称的条目（direct 名称会由后台补全）。 */
async function waitRoomListName(page: Page, name: string): Promise<void> {
  await page.waitForFunction(
    `(function () {
      const items = Array.from(document.querySelectorAll('#room-list a.room-item'));
      return items.some(function (item) {
        const label = item.querySelector('.room-name');
        return label && label.textContent === ${JSON.stringify(name)};
      });
    })()`,
  );
}

async function waitRoom(page: Page, roomId: string, expectedTitle: string): Promise<void> {
  await page.waitForURL(`**/c/${roomId}`);
  try {
    await page.waitForFunction(
      `document.getElementById('title') && document.getElementById('title').textContent === ${JSON.stringify(expectedTitle)} && document.getElementById('chat-body').getAttribute('aria-busy') === 'false'`,
    );
  } catch (error) {
    console.log('DEBUG waitRoom failed', {
      roomId,
      expectedTitle,
      url: page.url(),
      title: await page.locator('#title').textContent(),
      subtitle: await page.locator('#subtitle').textContent(),
      loading: await page.locator('#chat-loading').isVisible(),
      errorText: await page.locator('#chat-error-text').textContent(),
      calls: await page.evaluate(
        `(window.__mcpCalls || []).slice(-10).map(function (call) { return call.name || call.method; }).join(',')`,
      ),
      fetchLog: await page.evaluate(
        `(window.__fetchLog || []).slice(-18).map(function (entry) {
          return entry.phase + ':' + (entry.name || '') + ':' + (entry.roomId || '') + ':' + (entry.detail || '');
        }).join(' | ')`,
      ),
    });
    throw error;
  }
}

async function messageCount(page: Page): Promise<number> {
  return page.locator('#messages .msg').count();
}

async function sendRoomMessage(token: string, roomId: string, body: string): Promise<void> {
  await rawTool(token, 'network_message_send', {
    request_id: requestId('msg'),
    client_message_id: crypto.randomUUID(),
    room_id: roomId,
    body,
  });
}

/** 成员操作在读取好友期间禁用；测试先等 icon 可用再展开菜单。 */
async function openMemberRowMenu(row: Locator): Promise<Locator> {
  const menu = row.locator('.member-menu');
  if (await menu.isVisible()) return menu;
  const toggle = row.locator('.member-menu-toggle');
  await toggle.waitFor();
  await waitUntil(async () => !(await toggle.isDisabled()), '成员操作可用', 10_000);
  await toggle.click();
  await menu.waitFor({ state: 'visible' });
  return menu;
}

/** 刷新/滚动可能在点击前收起菜单；重开后再点，模拟用户重新操作。 */
async function clickMemberMenuItem(row: Locator, label: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const menu = await openMemberRowMenu(row);
    try {
      await menu.locator('.member-menu-item').filter({ hasText: label }).click({ timeout: 3_000 });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** 发送带 invoke 的消息并返回 message_id，用于投递回执验收。 */
async function sendInvokeMessage(
  token: string,
  roomId: string,
  body: string,
  invoke: string[],
): Promise<string> {
  const sent = await rawTool<{ message: { message_id: string } }>(token, 'network_message_send', {
    request_id: requestId('send'),
    client_message_id: crypto.randomUUID(),
    room_id: roomId,
    body,
    invoke,
  });
  return sent.message.message_id;
}

interface PendingDeliveryRef {
  delivery_id: string;
  message_id: string;
}

async function pendingDeliveryFor(token: string, messageId: string): Promise<PendingDeliveryRef> {
  const found = await pendingDeliveryOrNull(token, messageId);
  if (!found) throw new Error(`消息 ${messageId} 没有 pending 投递`);
  return found;
}

/** 负向断言使用：没有 pending 投递时返回 null，而不是让等待/断言提前抛错。 */
async function pendingDeliveryOrNull(
  token: string,
  messageId: string,
): Promise<PendingDeliveryRef | null> {
  const inbox = await rawTool<{ items: PendingDeliveryRef[] }>(token, 'network_inbox_list', {
    state: 'pending',
    limit: 50,
  });
  return inbox.items.find((item) => item.message_id === messageId) ?? null;
}

interface DeliveryClaimRef {
  delivery_id: string;
  attempt: number;
  claim_id: string;
}

async function claimDelivery(token: string, deliveryId: string): Promise<DeliveryClaimRef> {
  return rawTool<DeliveryClaimRef>(token, 'network_delivery_claim', {
    request_id: requestId('claim'),
    delivery_id: deliveryId,
  });
}

async function completeDelivery(token: string, claim: DeliveryClaimRef): Promise<void> {
  await rawTool(token, 'network_delivery_complete', {
    request_id: requestId('complete'),
    delivery_id: claim.delivery_id,
    attempt: claim.attempt,
    claim_id: claim.claim_id,
  });
}

async function failDelivery(token: string, claim: DeliveryClaimRef): Promise<void> {
  await rawTool(token, 'network_delivery_fail', {
    request_id: requestId('fail'),
    delivery_id: claim.delivery_id,
    attempt: claim.attempt,
    claim_id: claim.claim_id,
    error: '验收失败',
  });
}

/** 等待实时订阅建立，避免状态变更通知在页面订阅前发出。 */
async function waitStreamConnected(page: Page): Promise<void> {
  await page.waitForFunction(
    `(window.__fetchLog || []).some(function (entry) {
      return entry.name === 'subscriptions/listen' && entry.phase === 'resolved';
    })`,
  );
}

function receiptSelector(messageId: string): string {
  return `#messages li.msg-receipt[data-receipt-for="${messageId}"]`;
}

/** 创建由指定人类管理的 Agent 并建立双向关系，用于群成员添加场景。 */
async function createAgentFriend(token: string, name: string): Promise<Actor> {
  const created = await rawTool<Actor>(token, 'network_agent_create', {
    request_id: requestId('create_agent'),
    name,
  });
  await rawOwnAgentLink(token, { agent_session_id: created.agent_session_id ?? undefined });
  return created;
}

/** 只写个人收藏；使用未认领 Agent，确认收藏不会被当作候选或群成员。 */
async function createBookmarkFriend(token: string, name: string): Promise<Actor> {
  const agentToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
  const created = await rawTool<Actor>(agentToken, 'network_register', {
    request_id: requestId('register_agent'),
    kind: 'agent',
    name,
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  await rawTool(token, 'network_contact_add', {
    request_id: requestId('contact'),
    agent_session_id: created.agent_session_id,
  });
  return created;
}

/** 批量创建双向好友，覆盖 network_contacts_list 的 100 条分页与第 2 页读取。 */
async function createFillerFriends(token: string, count: number): Promise<Actor[]> {
  const actors: Actor[] = [];
  const batchSize = 10;
  for (let start = 0; start < count; start += batchSize) {
    const size = Math.min(batchSize, count - start);
    const batch = await Promise.all(
      Array.from({ length: size }, (_, offset) =>
        createAgentFriend(token, `分页好友 ${String(start + offset + 1).padStart(3, '0')}`),
      ),
    );
    actors.push(...batch);
  }
  return actors;
}

/** 分页读取全部双向好友，供“选择器候选数”断言避免依赖历史累计条数。 */
async function loadAllContacts(token: string): Promise<{ actor_id: string; name: string }[]> {
  const contacts: { actor_id: string; name: string }[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const args: Record<string, unknown> = { limit: 100 };
    if (cursor) args.cursor = cursor;
    const result = await rawTool<{
      items: { actor_id: string; name: string; relation: string }[];
      has_more: boolean;
      next_cursor: string | null;
    }>(token, 'network_contacts_list', args);
    // 单侧收藏不是好友，不能成为群成员候选。
    contacts.push(...result.items.filter((item) => item.relation === 'active'));
    if (!result.has_more || !result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return contacts;
}

/** 分页读取当前 human 可管理的 Agent，供候选数断言覆盖合并来源（含归档用于断言隐藏）。 */
async function loadAllManagedAgents(token: string): Promise<
  { actor_id: string; name: string; archived?: boolean; disabled?: boolean }[]
> {
  const agents: { actor_id: string; name: string; archived?: boolean; disabled?: boolean }[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const args: Record<string, unknown> = { limit: 100, include_archived: true };
    if (cursor) args.cursor = cursor;
    const result = await rawTool<{
      items: { actor_id: string; name: string; archived?: boolean; disabled?: boolean }[];
      has_more: boolean;
      next_cursor: string | null;
    }>(token, 'network_agents_managed_list', args);
    agents.push(...result.items);
    if (!result.has_more || !result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return agents;
}

/** 接受指定 token 在该房间的全部待确认邀请；夹具用于把 invited 转成 active。 */
async function acceptRoomInvites(token: string, roomId: string): Promise<number> {
  const listing = await rawTool<{
    items: { invitation_id: string; room_id: string; can_respond: boolean }[];
  }>(token, 'network_room_invite_get', { limit: 100 });
  let accepted = 0;
  for (const item of listing.items) {
    if (item.room_id !== roomId || !item.can_respond) continue;
    await rawTool(token, 'network_room_invite_respond', {
      request_id: requestId('invite'),
      invitation_id: item.invitation_id,
      action: 'accept',
    });
    accepted += 1;
  }
  return accepted;
}

/** 统一的 Promise 确认框：读取文案并点击确认/取消，替代原生 window.confirm。 */
async function resolveConfirmDialog(page: Page, accept: boolean): Promise<string> {
  const dialog = page.locator('#confirm-dialog[open]');
  await dialog.waitFor();
  const message = (await dialog.locator('#confirm-dialog-message').textContent()) ?? '';
  await dialog.locator(accept ? '[data-confirm-ok]' : '[data-confirm-cancel]').click();
  return message;
}

async function waitForText(page: Page, selector: string, text: string, timeout = 10_000): Promise<void> {
  if (selector === '#messages') {
    // 本地 outbox 的“发送中”也含正文；只有真实消息行才能证明服务端提交并回读。
    await page.locator('#messages .msg').filter({ hasText: text }).first().waitFor({ state: 'attached', timeout });
    return;
  }
  await page.waitForFunction(
    `(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      return Boolean(node && node.textContent && node.textContent.indexOf(${JSON.stringify(text)}) >= 0);
    })()`,
    undefined,
    { timeout },
  );
}

/** 等待服务端消息气泡（不含本地发送状态行），用于 UI 自发消息的断言。 */
async function waitForMessageText(page: Page, text: string, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    `(() => {
      const items = document.querySelectorAll('#messages .msg');
      return Array.from(items).some(
        (item) => item.textContent && item.textContent.indexOf(${JSON.stringify(text)}) >= 0,
      );
    })()`,
    undefined,
    { timeout },
  );
}

interface PresenceTimelineItem {
  kind: 'message' | 'presence';
  transition?: 'online' | 'offline';
  presence_event_id?: string;
  message_id?: string;
}

/**
 * 模拟关系表建立前创建的旧 direct 房间：保留 contacts，但删掉关系行。
 * 仅用于本地验收实例；生产库不得执行。
 */
function removeLegacyContactRelation(dataDir: string, actorA: string, actorB: string): void {
  const pairKey = [actorA, actorB].sort().join('|');
  const db = new Database(`${dataDir}/agent-network.sqlite`, { readwrite: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000;');
    db.prepare('DELETE FROM contact_relations WHERE pair_key = ?').run(pairKey);
  } finally {
    db.close();
  }
}

/**
 * 等请求触碰产生的在线状态自然过期。
 *
 * A03 的建联 fixture 会先用 Agent token 接受好友申请；请求触碰把 Agent 记为
 * online。若此时直接创建 direct 房间，这次上线的 generation 没有房间可写，
 * 但下线时 `presence_pending_rooms` 已经包含新房间，会留下一条孤立的“下线”
 * 行。因此在建房前等状态回到 offline，让后续真实连接生成完整的一对时间线。
 */
async function waitAgentOffline(dataDir: string, agentId: string): Promise<void> {
  const db = new Database(`${dataDir}/agent-network.sqlite`, { readonly: true });
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const row = db
        .prepare('SELECT phase FROM agent_presence_state WHERE actor_id = ?')
        .get(agentId) as { phase?: string } | null;
      if (row?.phase === 'offline') return;
      if (Date.now() > deadline) {
        throw new Error(`等待 Agent 离线超时: ${JSON.stringify(row)}`);
      }
      await sleep(100);
    }
  } finally {
    db.close();
  }
}

/** 用真实 stream + login 生成一组上线/下线，供浏览器时间线断言。 */
async function seedPresence(
  agentToken: string,
  humanToken: string,
  roomId: string,
  agentId: string,
): Promise<void> {
  const connection = await connectClient(agentToken);
  await openSubscription(connection.client, ['agentnet://stream']);
  await callTool(connection.client, 'network_login', {});
  await sleep(100);
  await connection.close();
  // 上一次转换留下的 offline 行会满足“存在 offline”这一条件，必须等本次
  // generation 的 pending 被确认、房间快照明确回到 false，再核对时间线。
  const deadline = Date.now() + 10_000;
  for (;;) {
    const detail = await rawTool<{
      members: { actor_id: string; online?: boolean | null }[];
    }>(humanToken, 'network_room_get', { room_id: roomId });
    const peer = detail.members.find((member) => member.actor_id === agentId);
    if (peer?.online === false) break;
    if (Date.now() > deadline) throw new Error('等待上下线时间线写入超时');
    await sleep(100);
  }
  const page = await rawTool<{ timeline_items?: PresenceTimelineItem[] }>(
    humanToken,
    'network_history_list',
    { room_id: roomId, view: 'timeline', limit: 100 },
  );
  const items = (page.timeline_items ?? []).filter((item) => item.kind === 'presence');
  if (
    !items.some((item) => item.transition === 'online') ||
    !items.some((item) => item.transition === 'offline')
  ) {
    throw new Error(`上下线时间线缺失: ${JSON.stringify(items)}`);
  }
}

async function fixture(dataDir: string): Promise<{
  humanToken: string;
  human: Actor;
  agentAToken: string;
  agentBToken: string;
  agentA: Actor;
  agentB: Actor;
  direct: RoomDetail;
  group: RoomDetail;
  extra: RoomDetail;
}> {
  const humanToken = crypto.randomUUID();
  const human = await rawTool<Actor>(humanToken, 'network_register', {
    request_id: requestId('web_reg'),
    kind: 'human',
    name: '浏览器验收人类',
  });
  const agentAToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
  const agentBToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
  const agentA = await rawTool<Actor>(agentAToken, 'network_register', {
    request_id: requestId('reg'),
    kind: 'agent',
    name: '验收 Agent A',
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  const agentB = await rawTool<Actor>(agentBToken, 'network_register', {
    request_id: requestId('reg'),
    kind: 'agent',
    name: '验收 Agent B',
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  // A01：归档/重发等管理操作只允许管理者或委托；旧自注册 Agent 通过
  // Agent 发起 + human 确认的双端认领绑定，不再依赖“知道 actor_id 即可管理”。
  const claim = await rawTool<{ claim_id: string; code: string }>(
    agentBToken,
    'network_agent_claim_start',
    { request_id: requestId('claim') },
  );
  await rawTool(humanToken, 'network_agent_claim_confirm', {
    request_id: requestId('claim'),
    claim_id: claim.claim_id,
    code: claim.code,
  });
  // Agent A 是未认领的自注册 Agent，需本人接受；Agent B 已由 human 认领，
  // 管理者申请会按 auto_manager 自动建联。
  await rawBefriend(humanToken, agentAToken, {
    agent_session_id: agentA.agent_session_id ?? undefined,
  });
  await rawOwnAgentLink(humanToken, { agent_session_id: agentB.agent_session_id ?? undefined });
  // 等 A 的请求触碰过期后再建 direct，避免下线转换给新房间补写孤立下线行。
  await waitAgentOffline(dataDir, agentA.actor_id);
  const direct = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('room'),
    kind: 'direct',
    members: [agentA.actor_id],
  });
  // Agent A 未认领、Agent B 由 human 管理：两者都直接 active，无需邀请。
  const group = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('room'),
    kind: 'group',
    title: '测试群',
    members: [agentA.actor_id, agentB.actor_id],
  });
  const extra = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('room'),
    kind: 'direct',
    members: [agentB.actor_id],
  });
  for (let index = 0; index < 30; index += 1) {
    await rawTool(humanToken, 'network_message_send', {
      request_id: requestId('msg'),
      client_message_id: crypto.randomUUID(),
      room_id: direct.room.room_id,
      body: `D 消息 ${index + 1}`,
    });
  }
  for (const text of ['群消息 1', '群消息 2']) {
    await rawTool(humanToken, 'network_message_send', {
      request_id: requestId('msg'),
      client_message_id: crypto.randomUUID(),
      room_id: group.room.room_id,
      body: text,
    });
  }
  for (let index = 0; index < 3; index += 1) {
    await rawTool(humanToken, 'network_message_send', {
      request_id: requestId('msg'),
      client_message_id: crypto.randomUUID(),
      room_id: extra.room.room_id,
      body: `E 消息 ${index + 1}`,
    });
  }
  await seedPresence(agentAToken, humanToken, direct.room.room_id, agentA.actor_id);
  // 所有房间标记已读；presence 不改变 head，之后不应因上下线出现红点。
  for (const room of [direct, group, extra]) {
    const current = await rawTool<RoomDetail>(humanToken, 'network_room_get', {
      room_id: room.room.room_id,
    });
    await rawTool(humanToken, 'network_room_mark_read', {
      room_id: room.room.room_id,
      through_seq: current.room.head_seq,
    });
  }
  return { humanToken, human, agentAToken, agentBToken, agentA, agentB, direct, group, extra };
}

interface UploadCall {
  name: string;
  size: number;
  bodySize: number;
  authorization: boolean;
  version: string | null;
  at: number;
}

interface RealUpload {
  fileId: string;
  name: string;
  mimeType: string;
  size: number;
  publicUrl: string;
}

interface UploadSpec {
  name: string;
  mimeType: string;
  body: string | Uint8Array;
}

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF_BYTES = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  label: string,
  timeout = 10_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`等待超时：${label}`);
}

async function bottomGap(page: Page): Promise<number> {
  return (await page.evaluate(`(() => {
    const node = document.getElementById('messages');
    return node ? node.scrollHeight - node.scrollTop - node.clientHeight : 0;
  })()`)) as number;
}

async function waitForBottom(page: Page, label: string, timeout = 8_000): Promise<void> {
  await waitUntil(async () => (await bottomGap(page)) <= 2, label, timeout);
}

/**
 * 懒 Markdown：消息进入视口附近才升级。先滚到目标消息，再等待 root；
 * 随后回到最新，避免影响后续“粘底发送/冻结”断言。
 */
async function waitForLazyMarkdown(locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.locator('.msg-markdown').waitFor();
  const page = locator.page();
  await scrollMessagesToBottom(page);
}

async function scrollMessagesToBottom(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const node = document.getElementById('messages');
    if (node) node.scrollTop = node.scrollHeight;
  })()`);
  await waitUntil(async () => (await bottomGap(page)) <= 2, '消息区回到底部', 3_000);
}

/** 懒 Markdown 分批升级：等 root 数稳定，避免用升级中途的布局做锚点断言。 */
async function waitForMarkdownSettled(page: Page, timeout = 10_000): Promise<void> {
  let last = -1;
  let stableSince = Date.now();
  await waitUntil(
    async () => {
      const count = await page.locator('#messages .msg-markdown').count();
      if (count !== last) {
        last = count;
        stableSince = Date.now();
        return false;
      }
      return Date.now() - stableSince >= 500;
    },
    'Markdown 升级稳定',
    timeout,
  );
}

interface BubbleLayout {
  view: number;
  doc: number;
  messagesClient: number;
  messagesScroll: number;
  rowWidth: number;
  contentWidth: number;
  contentMaxWidth: number;
  maxWidthRaw: string;
  bubbleWidth: number;
  bubbleClientWidth: number;
  bubbleScrollWidth: number;
  background: string;
  sender: string;
  preScroll: number;
  preClient: number;
  tableScroll: number;
  tableClient: number;
}

/** 读取单条消息的气泡几何与滚动边界，用于宽度、暗色和溢出断言。 */
async function bubbleLayout(locator: Locator): Promise<BubbleLayout> {
  return locator.evaluate((node) => {
    const messages = document.getElementById('messages');
    const content = node.querySelector('.msg-content');
    const bubble = node.querySelector('.bubble');
    const pre = node.querySelector('.msg-markdown .md-pre');
    const table = node.querySelector('.msg-markdown .md-table-wrap');
    if (!messages || !content || !bubble) {
      throw new Error('消息缺少 .msg-content 或 .bubble');
    }
    const row = node.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const sender = node.querySelector('.msg-sender');
    const maxWidthRaw = getComputedStyle(content).maxWidth;
    const parsedMaxWidth = Number.parseFloat(maxWidthRaw);
    // Chrome 对 min()/calc() 返回未解析表达式；按行宽换算成实际上限。
    const percentLimit = /min\(\s*([\d.]+)%/u.exec(maxWidthRaw);
    const subtractLimit = /-\s*([\d.]+)px/u.exec(maxWidthRaw);
    const resolvedMaxWidth = Number.isFinite(parsedMaxWidth)
      ? parsedMaxWidth
      : Math.min(
          percentLimit ? (row.width * Number(percentLimit[1])) / 100 : Number.POSITIVE_INFINITY,
          subtractLimit ? row.width - Number(subtractLimit[1]) : Number.POSITIVE_INFINITY,
        );
    return {
      view: window.innerWidth,
      doc: document.documentElement.scrollWidth,
      messagesClient: messages.clientWidth,
      messagesScroll: messages.scrollWidth,
      rowWidth: row.width,
      contentWidth: contentRect.width,
      contentMaxWidth: Number.isFinite(resolvedMaxWidth) ? resolvedMaxWidth : row.width - 56,
      maxWidthRaw,
      bubbleWidth: bubbleRect.width,
      bubbleClientWidth: bubble.clientWidth,
      bubbleScrollWidth: bubble.scrollWidth,
      background: getComputedStyle(bubble).backgroundColor,
      sender: sender ? (sender.textContent || '').trim() : '',
      preScroll: pre ? pre.scrollWidth : 0,
      preClient: pre ? pre.clientWidth : 0,
      tableScroll: table ? table.scrollWidth : 0,
      tableClient: table ? table.clientWidth : 0,
    };
  });
}

async function messagesScrollTop(page: Page): Promise<number> {
  return (await page.evaluate(
    `document.getElementById('messages') ? document.getElementById('messages').scrollTop : 0`,
  )) as number;
}

interface DrawboardPixels {
  colored: number;
  opaque: number;
  red: number;
  width: number;
  height: number;
}

interface DrawboardState {
  objects: number;
  undoEnabled: boolean;
  redoEnabled: boolean;
  insertEnabled: boolean;
}

/** 画板 canvas 的双帧等待：Fabric 在 pointerup 后异步渲染。 */
async function settleDrawboard(page: Page): Promise<void> {
  await page.evaluate(`new Promise(function (resolve) {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { resolve(true); });
    });
  })`);
}

async function drawboardPixels(page: Page): Promise<DrawboardPixels | null> {
  return (await page.evaluate(`(() => {
    const lower = document.querySelector('[data-drawboard-overlay="1"] .lower-canvas');
    if (!lower) return null;
    const data = lower.getContext('2d').getImageData(0, 0, lower.width, lower.height).data;
    let colored = 0;
    let opaque = 0;
    let red = 0;
    for (let index = 0; index < data.length; index += 4) {
      if (data[index + 3] === 0) continue;
      opaque += 1;
      if (data[index] < 250 || data[index + 1] < 250 || data[index + 2] < 250) colored += 1;
      if (data[index] > 180 && data[index + 1] < 130 && data[index + 2] < 130) red += 1;
    }
    return { colored, opaque, red, width: lower.width, height: lower.height };
  })()`)) as DrawboardPixels | null;
}

async function drawboardState(page: Page): Promise<DrawboardState | null> {
  return (await page.evaluate(`(() => {
    const overlay = document.querySelector('[data-drawboard-overlay="1"]');
    if (!overlay) return null;
    const undo = document.getElementById('db-undo');
    const redo = document.getElementById('db-redo');
    const insert = document.getElementById('db-insert');
    return {
      objects: Number(overlay.dataset.dbObjects || 0),
      undoEnabled: Boolean(undo && !undo.disabled),
      redoEnabled: Boolean(redo && !redo.disabled),
      insertEnabled: Boolean(insert && !insert.disabled)
    };
  })()`)) as DrawboardState | null;
}

async function waitDrawboardObjects(page: Page, count: number): Promise<void> {
  await page.waitForFunction(
    `(function () {
      const overlay = document.querySelector('[data-drawboard-overlay="1"]');
      return overlay ? Number(overlay.dataset.dbObjects || 0) === ${count} : false;
    })()`,
  );
  await settleDrawboard(page);
}

/** 在画板 canvas 上按相对坐标拖拽，避开 Retina/CSS 缩放细节。 */
async function drawboardDrag(
  page: Page,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const box = await page.locator('[data-drawboard-overlay="1"] canvas.upper-canvas').boundingBox();
  if (!box) throw new Error('画板 canvas 不可见');
  const startX = box.x + box.width * from[0];
  const startY = box.y + box.height * from[1];
  const endX = box.x + box.width * to[0];
  const endY = box.y + box.height * to[1];
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 10 });
  await page.mouse.up();
}

async function openDrawboard(page: Page): Promise<void> {
  await page.locator('#attach-file').click();
  await page.locator('#attach-menu-draw').click();
  await page.locator('[data-drawboard-overlay="1"]').waitFor();
  await settleDrawboard(page);
}

/** 与 captureAnchor 一致：视口内第一个相交的消息（忽略时间胶囊/底部 sentinel）。 */
async function firstVisibleMessageId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const list = document.getElementById('messages');
    if (!list) return null;
    const listTop = list.getBoundingClientRect().top;
    const listBottom = list.getBoundingClientRect().bottom;
    for (const node of Array.from(list.children)) {
      if (node.classList.contains('messages-end')) continue;
      const rect = node.getBoundingClientRect();
      if (rect.top >= listBottom || rect.bottom <= listTop) continue;
      const messageId = node.getAttribute('data-message-id');
      if (messageId) return messageId;
    }
    return null;
  });
}

/** 读取某条消息相对消息区顶部的偏移；消息不在 DOM 中时返回 null。 */
async function messageOffset(page: Page, messageId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const list = document.getElementById('messages');
    const node = list ? list.querySelector(`[data-message-id="${id}"]`) : null;
    if (!list || !node) return null;
    return node.getBoundingClientRect().top - list.getBoundingClientRect().top;
  }, messageId);
}

/** 只统计当前房间的 mark_read，避免其他会话的定时已读干扰断言。 */
async function markReadCalls(page: Page, roomId: string): Promise<number> {
  return (await page.evaluate(`(window.__mcpCalls || []).filter(function (call) {
    const args = call.body && call.body.params ? call.body.params.arguments : null;
    return call.name === 'network_room_mark_read' && args && args.room_id === ${JSON.stringify(roomId)};
  }).length`)) as number;
}

async function timelineMessageIds(page: Page): Promise<string[]> {
  return (await page.evaluate(`Array.from(document.querySelectorAll('#messages .msg'))
    .map(function (node) { return node.getAttribute('data-message-id') || ''; })`)) as string[];
}

/** 用真实 MCPP Files 上传；返回真实 fileId 与公开地址。 */
async function uploadRealFile(
  token: string,
  base: string,
  spec: UploadSpec,
): Promise<RealUpload> {
  const bytes = typeof spec.body === 'string' ? new TextEncoder().encode(spec.body) : spec.body;
  const response = await fetch(`${base}/mcp-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'MCPP-Files-Version': '1',
      'content-type': spec.mimeType,
      'MCPP-File-Name': encodeURIComponent(spec.name),
      'MCPP-File-Size': String(bytes.length),
    },
    body: bytes as unknown as BodyInit,
  });
  if (response.status !== 201) {
    throw new Error(`真实上传失败 ${spec.name}: HTTP ${response.status}`);
  }
  return (await response.json()) as RealUpload;
}

async function bindRealFile(token: string, roomId: string, fileId: string): Promise<void> {
  await rawTool(token, 'network_room_file_bind', {
    request_id: requestId('file_bind'),
    room_id: roomId,
    file_id: fileId,
  });
}

/** 真实上传 + bind，用于准备浏览器文件列表。 */
async function seedRoomFiles(
  token: string,
  base: string,
  roomId: string,
  specs: UploadSpec[],
): Promise<RealUpload[]> {
  const uploaded: RealUpload[] = [];
  for (const spec of specs) {
    const file = await uploadRealFile(token, base, spec);
    await bindRealFile(token, roomId, file.fileId);
    uploaded.push(file);
  }
  return uploaded;
}

/** 只观察真实上传请求头，不替换响应。 */
async function observeUploads(page: Page): Promise<{ calls: UploadCall[] }> {
  const calls: UploadCall[] = [];
  await page.route('**/mcp-upload', async (route) => {
    const request = route.request();
    const headers = request.headers();
    const encodedName = headers['mcpp-file-name'] ?? '';
    let name = encodedName;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      name = encodedName;
    }
    calls.push({
      name,
      size: Number(headers['mcpp-file-size'] ?? 0),
      bodySize: request.postDataBuffer()?.length ?? 0,
      authorization: (headers['authorization'] ?? '').startsWith('Bearer '),
      version: headers['mcpp-files-version'] ?? null,
      at: Date.now(),
    });
    await route.continue();
  });
  return { calls };
}

interface DragFileSpec {
  name: string;
  mimeType: string;
  base64?: string;
  text?: string;
}

/** 在页面内构造 DataTransfer 并派发拖拽事件；只用于浏览器验收。 */
async function dispatchDrag(
  page: Page,
  selector: string,
  type: 'dragenter' | 'dragover' | 'dragleave' | 'drop',
  files: DragFileSpec[],
): Promise<void> {
  const dataTransfer = await page.evaluateHandle(`(() => {
    const payload = ${JSON.stringify({ files })};
    const transfer = new DataTransfer();
    for (const file of payload.files) {
      const bytes = file.base64
        ? Uint8Array.from(atob(file.base64), function (char) { return char.charCodeAt(0); })
        : new TextEncoder().encode(file.text || '');
      transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
    }
    return transfer;
  })()`);
  try {
    await page.dispatchEvent(selector, type, { dataTransfer });
  } finally {
    await dataTransfer.dispose();
  }
}

/** 在页面内构造 ClipboardEvent 并派发；返回是否被 preventDefault。 */
async function pasteFiles(
  page: Page,
  selector: string,
  files: DragFileSpec[],
  text = '',
): Promise<boolean> {
  return (await page.evaluate(`(() => {
    const payload = ${JSON.stringify({ files, text })};
    const transfer = new DataTransfer();
    for (const file of payload.files) {
      const bytes = file.base64
        ? Uint8Array.from(atob(file.base64), function (char) { return char.charCodeAt(0); })
        : new TextEncoder().encode(file.text || '');
      transfer.items.add(new File([bytes], file.name, { type: file.mimeType }));
    }
    if (payload.text) transfer.setData('text/plain', payload.text);
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    let event = null;
    try {
      event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer
      });
    } catch (error) {
      event = new ClipboardEvent('paste', { bubbles: true, cancelable: true });
    }
    if (!event.clipboardData) {
      Object.defineProperty(event, 'clipboardData', { value: transfer });
    }
    node.dispatchEvent(event);
    return event.defaultPrevented;
  })()`)) as boolean;
}

/** 记录拖拽上传，并支持用一次 413 模拟超大文件，不真正构造大文件。 */
async function observeDropUploads(
  page: Page,
): Promise<{ calls: UploadCall[]; failNext: boolean; delayMs: number }> {
  const state = { calls: [] as UploadCall[], failNext: false, delayMs: 0 };
  await page.route('**/mcp-upload', async (route) => {
    const request = route.request();
    const headers = request.headers();
    const encodedName = headers['mcpp-file-name'] ?? '';
    let name = encodedName;
    try {
      name = decodeURIComponent(encodedName);
    } catch {
      name = encodedName;
    }
    state.calls.push({
      name,
      size: Number(headers['mcpp-file-size'] ?? 0),
      bodySize: request.postDataBuffer()?.length ?? 0,
      authorization: (headers['authorization'] ?? '').startsWith('Bearer '),
      version: headers['mcpp-files-version'] ?? null,
      at: Date.now(),
    });
    if (state.delayMs > 0) await sleep(state.delayMs);
    if (state.failNext) {
      state.failNext = false;
      await route.fulfill({
        status: 413,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'FILE_TOO_LARGE', message: '文件超过大小限制' },
        }),
      });
      return;
    }
    await route.continue();
  });
  return state;
}

/** 记录真实 `/f/` 请求的 Range 头，不替换服务端响应。 */
async function observeFileRanges(page: Page): Promise<{ ranges: Record<string, string> }> {
  const ranges: Record<string, string> = {};
  await page.route('**/f/**', async (route) => {
    const range = route.request().headers()['range'];
    if (range) ranges[new URL(route.request().url()).pathname] = range;
    try {
      await route.continue();
    } catch {
      // 关闭预览会中止请求；记录已发生即可。
    }
  });
  return { ranges };
}

interface HeadCall {
  path: string;
  at: number;
}

interface HeadObserver {
  heads: HeadCall[];
  maxActive: number;
  delayMs: number;
}

/** 记录消息卡片的 HEAD；可临时延迟以观察客户端并发上限。 */
async function observeFileHeads(page: Page): Promise<HeadObserver> {
  const state: HeadObserver = { heads: [], maxActive: 0, delayMs: 0 };
  let active = 0;
  await page.route('**/f/**', async (route) => {
    if (route.request().method() !== 'HEAD') {
      await route.fallback();
      return;
    }
    state.heads.push({ path: new URL(route.request().url()).pathname, at: Date.now() });
    active += 1;
    if (active > state.maxActive) state.maxActive = active;
    try {
      if (state.delayMs > 0) await sleep(state.delayMs);
      await route.fallback();
    } finally {
      active -= 1;
    }
  });
  return state;
}

function headCount(observer: HeadObserver, fileId: string): number {
  return observer.heads.filter((call) => call.path === `/f/${fileId}`).length;
}

async function mcpCallCount(page: Page, name: string): Promise<number> {
  return (await page.evaluate(
    `(window.__mcpCalls || []).filter(function (call) { return call.name === ${JSON.stringify(name)}; }).length`,
  )) as number;
}

/**
 * 带 cursor 的“更早”历史请求 = “加载更早”；首屏不带 cursor。
 * after 是断线补页，单独统计，不能算作加载更早。
 */
async function olderCursors(page: Page): Promise<string[]> {
  return (await page.evaluate(`(() => {
    return (window.__mcpCalls || []).filter(function (call) {
      const args = call.body && call.body.params ? call.body.params.arguments : null;
      return call.name === 'network_history_list' && args && args.cursor &&
        args.direction !== 'after';
    }).map(function (call) { return call.body.params.arguments.cursor; });
  })()`)) as string[];
}

interface TimelineAfterCall {
  cursor?: string;
  view?: string;
  limit?: number;
}

/** 断线补页请求：只统计当前房间 direction=after 的时间线游标。 */
async function timelineAfterCalls(
  page: Page,
  roomId: string,
): Promise<TimelineAfterCall[]> {
  return (await page.evaluate(`(() => {
    return (window.__mcpCalls || []).filter(function (call) {
      const args = call.body && call.body.params ? call.body.params.arguments : null;
      return call.name === 'network_history_list' && args &&
        args.room_id === ${JSON.stringify(roomId)} && args.direction === 'after';
    }).map(function (call) { return call.body.params.arguments; });
  })()`)) as TimelineAfterCall[];
}

interface OlderUiState {
  hidden: boolean;
  disabled: boolean;
  text: string;
  statusText: string;
  statusHidden: boolean;
  pagerHidden: boolean;
}

async function olderUiState(page: Page): Promise<OlderUiState> {
  return (await page.evaluate(`(() => {
    const older = document.getElementById('older');
    const status = document.getElementById('older-status');
    const pager = document.getElementById('history-pager');
    return {
      hidden: Boolean(older && older.hidden),
      disabled: Boolean(older && older.disabled),
      text: older ? older.textContent : '',
      statusText: status ? status.textContent : '',
      statusHidden: Boolean(status && status.hidden),
      pagerHidden: Boolean(pager && pager.hidden)
    };
  })()`)) as OlderUiState;
}

async function fileListCallCount(page: Page): Promise<number> {
  return mcpCallCount(page, 'network_room_file_list');
}

const AVATAR_ICON_FILES = [
  'codex-color.svg',
  'claude-color.svg',
  'anthropic.svg',
  'gemini-color.svg',
  'deepseek-color.svg',
  'qwen-color.svg',
  'grok.svg',
  'xai.svg',
  'mistral-color.svg',
  'perplexity-color.svg',
  'cursor.svg',
  'githubcopilot.svg',
  'openai.svg',
  'meta-color.svg',
];

const TIBO_ICON_FILE = 'tibo.png';
const TIBO_ICON_SRC = '/agent-icons/tibo.png';
const POTETO_ICON_FILE = 'poteto.png';
const POTETO_ICON_SRC = '/agent-icons/poteto.png';
const KONGHAYAO_ICON_FILE = 'konghayao.png';
const KONGHAYAO_ICON_SRC = '/agent-icons/konghayao.png';

const AVATAR_MAPPINGS: [string, string | null][] = [
  ['Tibo Reset', TIBO_ICON_SRC],
  ['tibo-agent', TIBO_ICON_SRC],
  ['Agent Tibo', TIBO_ICON_SRC],
  ['poteto', POTETO_ICON_SRC],
  ['Poteto Agent', POTETO_ICON_SRC],
  ['KonghaYao', KONGHAYAO_ICON_SRC],
  ['konghayao', KONGHAYAO_ICON_SRC],
  ['Codex 测试', '/agent-icons/codex-color.svg'],
  ['Claude 测试员', '/agent-icons/claude-color.svg'],
  ['Gemini 2.5', '/agent-icons/gemini-color.svg'],
  ['DeepSeek R1', '/agent-icons/deepseek-color.svg'],
  ['Qwen 通义千问', '/agent-icons/qwen-color.svg'],
  ['通义千问', '/agent-icons/qwen-color.svg'],
  ['千问', '/agent-icons/qwen-color.svg'],
  ['Grok 4', '/agent-icons/grok.svg'],
  ['xAI', '/agent-icons/xai.svg'],
  ['Mistral Large', '/agent-icons/mistral-color.svg'],
  ['Perplexity Sonar', '/agent-icons/perplexity-color.svg'],
  ['Cursor Agent', '/agent-icons/cursor.svg'],
  ['GitHub Copilot', '/agent-icons/githubcopilot.svg'],
  ['Copilot', '/agent-icons/githubcopilot.svg'],
  ['OpenAI GPT', '/agent-icons/openai.svg'],
  ['GPT-5', '/agent-icons/openai.svg'],
  ['ChatGPT', '/agent-icons/openai.svg'],
  ['Anthropic', '/agent-icons/anthropic.svg'],
  ['Meta Llama', '/agent-icons/meta-color.svg'],
  ['Llama 3', '/agent-icons/meta-color.svg'],
  ['Google Bard', '/agent-icons/gemini-color.svg'],
  ['琶洲-dsh-dsh', null],
  ['Ver 部署 Agent', null],
  ['Peri 部署 Agent', null],
];

interface AvatarAgent {
  actor: Actor;
  token: string;
}

async function registerAvatarAgent(humanToken: string, name: string): Promise<AvatarAgent> {
  const created = await rawTool<Actor & { token: string }>(humanToken, 'network_agent_create', {
    request_id: requestId('avatar_create'),
    name,
  });
  await rawOwnAgentLink(humanToken, { agent_session_id: created.agent_session_id ?? undefined });
  return {
    actor: {
      actor_id: created.actor_id,
      name: created.name,
      agent_session_id: created.agent_session_id,
    },
    token: created.token,
  };
}

/**
 * 品牌头像验收：资源可访问、关键词映射、侧栏/消息/成员/归档集成、
 * 群聊 2×2 不变、暗色 390px 与图片失败回退。
 *
 * 独立创建 Agent 与房间，放在主流程末尾执行，避免影响既有列表/联系人计数。
 */
async function runAvatarAcceptance(
  browser: Browser,
  base: string,
  humanToken: string,
): Promise<void> {
  console.log('  品牌头像');
  for (const file of AVATAR_ICON_FILES) {
    const response = await fetch(`${base}/agent-icons/${file}`);
    const body = await response.text();
    checkEqual(`图标 ${file} HTTP 200`, response.status, 200);
    check(
      `图标 ${file} content-type`,
      (response.headers.get('content-type') ?? '').startsWith('image/svg+xml'),
      response.headers.get('content-type'),
    );
    check(`图标 ${file} 非空且为 SVG`, body.trimStart().startsWith('<svg') && body.length > 0);
  }
  const tiboResponse = await fetch(`${base}/agent-icons/${TIBO_ICON_FILE}`);
  const tiboBytes = new Uint8Array(await tiboResponse.arrayBuffer());
  const tiboLocalBytes = new Uint8Array(
    await Bun.file(resolve(import.meta.dir, '../public/agent-icons', TIBO_ICON_FILE)).arrayBuffer(),
  );
  checkEqual('图标 tibo.png HTTP 200', tiboResponse.status, 200);
  checkEqual(
    '图标 tibo.png content-type',
    tiboResponse.headers.get('content-type'),
    'image/png',
  );
  check(
    '图标 tibo.png 字节与本地一致',
    tiboBytes.length === tiboLocalBytes.length &&
      tiboBytes.every((value, index) => value === tiboLocalBytes[index]),
    { remote: tiboBytes.length, local: tiboLocalBytes.length },
  );
  const tiboView = new DataView(tiboBytes.buffer, tiboBytes.byteOffset, tiboBytes.byteLength);
  check(
    '图标 tibo.png 为 192×192 PNG',
    tiboBytes.length > 24 &&
      tiboBytes[0] === 0x89 &&
      tiboBytes[1] === 0x50 &&
      tiboBytes[2] === 0x4e &&
      tiboBytes[3] === 0x47 &&
      tiboView.getUint32(16) === 192 &&
      tiboView.getUint32(20) === 192,
    `${tiboView.getUint32(16)}×${tiboView.getUint32(20)}`,
  );
  for (const file of [POTETO_ICON_FILE, KONGHAYAO_ICON_FILE]) {
    const response = await fetch(`${base}/agent-icons/${file}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const localBytes = new Uint8Array(
      await Bun.file(resolve(import.meta.dir, '../public/agent-icons', file)).arrayBuffer(),
    );
    checkEqual(`图标 ${file} HTTP 200`, response.status, 200);
    checkEqual(`图标 ${file} content-type`, response.headers.get('content-type'), 'image/png');
    check(
      `图标 ${file} 字节与本地一致`,
      bytes.length === localBytes.length &&
        bytes.every((value, index) => value === localBytes[index]),
      { remote: bytes.length, local: localBytes.length },
    );
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    check(
      `图标 ${file} 为 192×192 PNG`,
      bytes.length > 24 &&
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        view.getUint32(16) === 192 &&
        view.getUint32(20) === 192,
      `${view.getUint32(16)}×${view.getUint32(20)}`,
    );
  }
  const licenseResponse = await fetch(`${base}/agent-icons/LICENSE`);
  const licenseText = await licenseResponse.text();
  check(
    '图标 LICENSE 可访问且为 MIT',
    licenseResponse.status === 200 && licenseText.includes('MIT License') &&
      licenseText.includes('LobeHub'),
  );
  const attributionResponse = await fetch(`${base}/agent-icons/ATTRIBUTION.md`);
  const attributionText = await attributionResponse.text();
  check(
    '图标 ATTRIBUTION 可访问',
    attributionResponse.status === 200 && attributionText.includes('LobeHub Icons'),
  );
  check(
    'ATTRIBUTION 标明 tibo.png 为用户提供且不属于 LobeHub/MIT',
    attributionText.includes('tibo.png') &&
      attributionText.includes('用户提供') &&
      attributionText.includes('不是来自 LobeHub Icons') &&
      attributionText.includes('不在 MIT'),
  );
  check(
    'ATTRIBUTION 标明 poteto.png 与 konghayao.png 为用户提供',
    attributionText.includes('poteto.png') &&
      attributionText.includes('konghayao.png') &&
      attributionText.includes('KonghaYao') &&
      attributionText.includes('用户提供'),
  );
  checkEqual(
    '未知图标返回 404',
    (await fetch(`${base}/agent-icons/unknown.svg`)).status,
    404,
  );
  checkEqual(
    '图标路径穿越返回 404',
    (await fetch(`${base}/agent-icons/..%2Fpackage.json`)).status,
    404,
  );

  const codex = await registerAvatarAgent(humanToken, 'Codex 测试');
  const plain = await registerAvatarAgent(humanToken, '琶洲-dsh-dsh');
  const gemini = await registerAvatarAgent(humanToken, 'Gemini 候选');
  const tibo = await registerAvatarAgent(humanToken, 'Tibo Reset');
  const poteto = await registerAvatarAgent(humanToken, 'poteto');
  const kongToken = crypto.randomUUID();
  const kong = await rawTool<Actor>(kongToken, 'network_register', {
    request_id: requestId('avatar_reg'),
    kind: 'human',
    name: 'KonghaYao',
  });
  await rawBefriend(humanToken, kongToken, { actor_id: kong.actor_id });
  const codexRoom = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('avatar_room'),
    kind: 'direct',
    members: [codex.actor.actor_id],
  });
  const plainRoom = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('avatar_room'),
    kind: 'direct',
    members: [plain.actor.actor_id],
  });
  const tiboRoom = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('avatar_room'),
    kind: 'direct',
    members: [tibo.actor.actor_id],
  });
  const potetoRoom = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('avatar_room'),
    kind: 'direct',
    members: [poteto.actor.actor_id],
  });
  const kongRoom = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('avatar_room'),
    kind: 'direct',
    members: [kong.actor_id],
  });
  const groupRoom = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('avatar_room'),
    kind: 'group',
    title: '头像测试群',
    members: [
      codex.actor.actor_id,
      plain.actor.actor_id,
      tibo.actor.actor_id,
      poteto.actor.actor_id,
      kong.actor_id,
    ],
  });
  // 人类成员也先收到邀请；接受后才能发送群消息。
  await acceptRoomInvites(kongToken, groupRoom.room.room_id);
  await rawTool(codex.token, 'network_message_send', {
    request_id: requestId('avatar_msg'),
    client_message_id: crypto.randomUUID(),
    room_id: codexRoom.room.room_id,
    body: 'Codex 的直聊消息',
  });
  await rawTool(codex.token, 'network_message_send', {
    request_id: requestId('avatar_msg'),
    client_message_id: crypto.randomUUID(),
    room_id: groupRoom.room.room_id,
    body: '群里的 Codex 消息',
  });
  await rawTool(tibo.token, 'network_message_send', {
    request_id: requestId('avatar_msg'),
    client_message_id: crypto.randomUUID(),
    room_id: tiboRoom.room.room_id,
    body: 'Tibo 的直聊消息',
  });
  await rawTool(tibo.token, 'network_message_send', {
    request_id: requestId('avatar_msg'),
    client_message_id: crypto.randomUUID(),
    room_id: groupRoom.room.room_id,
    body: '群里的 Tibo 消息',
  });
  await rawTool(poteto.token, 'network_message_send', {
    request_id: requestId('avatar_msg'),
    client_message_id: crypto.randomUUID(),
    room_id: potetoRoom.room.room_id,
    body: 'poteto 的直聊消息',
  });
  await rawTool(poteto.token, 'network_message_send', {
    request_id: requestId('avatar_msg'),
    client_message_id: crypto.randomUUID(),
    room_id: groupRoom.room.room_id,
    body: '群里的 poteto 消息',
  });
  await rawTool(kongToken, 'network_message_send', {
    request_id: requestId('avatar_msg'),
    client_message_id: crypto.randomUUID(),
    room_id: kongRoom.room.room_id,
    body: 'KonghaYao 的直聊消息',
  });
  await rawTool(kongToken, 'network_message_send', {
    request_id: requestId('avatar_msg'),
    client_message_id: crypto.randomUUID(),
    room_id: groupRoom.room.room_id,
    body: '群里的 KonghaYao 消息',
  });

  const { context, page } = await makeContext(
    browser,
    humanToken,
    { width: 1280, height: 800 },
    [],
    false,
  );
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('http') && !url.startsWith(base)) externalRequests.push(url);
  });
  await page.goto(`${base}/`);
  await page.locator('#room-filter-agent').click();
  await waitRoomListName(page, 'Codex 测试');
  await waitRoomListName(page, 'Tibo Reset');
  await waitRoomListName(page, 'poteto');
  await page.waitForFunction(
    `(() => {
      const img = document.querySelector(${JSON.stringify(`${roomLink(codexRoom.room.room_id)} .avatar-img`)});
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  await page.locator('#room-filter-friend').click();
  await waitRoomListName(page, 'KonghaYao');
  const ownAccount = (await page.evaluate(
    `(() => {
      const avatar = document.getElementById('account-avatar');
      const name = document.getElementById('account-name');
      if (!avatar || !name) return null;
      return {
        name: name.textContent,
        text: avatar.textContent,
        image: Boolean(avatar.querySelector('img.avatar-img')),
        icon: avatar.classList.contains('avatar-icon'),
        background: avatar.style.background
      };
    })()`,
  )) as {
    name: string;
    text: string;
    image: boolean;
    icon: boolean;
    background: string;
  } | null;
  check(
    '本人账号未命中名称保留首字',
    Boolean(ownAccount) &&
      ownAccount!.image === false &&
      ownAccount!.icon === false &&
      ownAccount!.text === Array.from(ownAccount!.name ?? '')[0] &&
      ownAccount!.background !== '',
    ownAccount,
  );

  const mapping = (await page.evaluate(
    `(() => {
      const names = ${JSON.stringify(AVATAR_MAPPINGS.map(([name]) => name))};
      return names.map(function (name) {
        const value = agentAvatarFor(name);
        return {
          name: name,
          src: value ? value.src : null,
          brand: value ? value.brand : null,
          mono: value ? value.mono : null
        };
      });
    })()`,
  )) as { name: string; src: string | null; brand: string | null; mono: boolean | null }[];
  const expectedByName = new Map(AVATAR_MAPPINGS);
  for (const item of mapping) {
    checkEqual(`关键词映射 ${item.name}`, item.src, expectedByName.get(item.name) ?? null);
  }
  const tiboBrand = (await page.evaluate(
    `(() => {
      const value = agentAvatarFor('Tibo Reset');
      return value ? { brand: value.brand, mono: value.mono } : null;
    })()`,
  )) as { brand: string | null; mono: boolean | null } | null;
  checkEqual('Tibo 品牌标记', tiboBrand?.brand, 'Tibo');
  checkEqual('Tibo 使用彩色专用头像', tiboBrand?.mono, false);
  const monoFlags = (await page.evaluate(
    `(() => {
      const names = ['OpenAI', 'Anthropic', 'Grok', 'xAI', 'Cursor', 'GitHub Copilot', 'Codex', 'Claude'];
      return names.map(function (name) {
        const value = agentAvatarFor(name);
        return value ? value.mono : null;
      });
    })()`,
  )) as (boolean | null)[];
  check(
    '单色与彩色图标标记正确',
    monoFlags.every((value, index) => value === (index < 6)),
    monoFlags,
  );
  const kindMapping = (await page.evaluate(
    `(() => {
      function read(name, kind) {
        const value = agentAvatarFor(name, kind);
        return value ? value.src : null;
      }
      return [
        read('KonghaYao', 'human'),
        read('KonghaYao', 'direct'),
        read('KonghaYao', 'agent'),
        read('poteto', 'agent'),
        read('Codex 测试', 'human'),
        read('Codex 测试', 'agent')
      ];
    })()`,
  )) as (string | null)[];
  check(
    '用户头像对人类与 Agent 均生效',
    kindMapping[0] === KONGHAYAO_ICON_SRC &&
      kindMapping[1] === KONGHAYAO_ICON_SRC &&
      kindMapping[2] === KONGHAYAO_ICON_SRC &&
      kindMapping[3] === POTETO_ICON_SRC,
    kindMapping,
  );
  check(
    '品牌图标仍只用于 Agent',
    kindMapping[4] === null && kindMapping[5] === '/agent-icons/codex-color.svg',
    kindMapping,
  );

  await page.locator('#room-filter-agent').click();
  await page.locator(roomLink(codexRoom.room.room_id)).waitFor();
  const agentSidebar = (await page.evaluate(
    `(() => {
      function read(roomId) {
        const link = document.querySelector('#room-list a.room-item[href="/c/' + roomId + '"]');
        if (!link) return null;
        const avatar = link.querySelector('.avatar');
        const image = avatar ? avatar.querySelector('img.avatar-img') : null;
        return {
          src: image ? image.getAttribute('src') : null,
          text: avatar ? avatar.textContent : null,
          icon: avatar ? avatar.classList.contains('avatar-icon') : false,
          cells: link.querySelectorAll('.avatar-cell').length
        };
      }
      return {
        codex: read(${JSON.stringify(codexRoom.room.room_id)}),
        plain: read(${JSON.stringify(plainRoom.room.room_id)}),
        tibo: read(${JSON.stringify(tiboRoom.room.room_id)}),
        poteto: read(${JSON.stringify(potetoRoom.room.room_id)}),
        kong: read(${JSON.stringify(kongRoom.room.room_id)})
      };
    })()`,
  )) as {
    codex: { src: string | null; text: string | null; icon: boolean; cells: number } | null;
    plain: { src: string | null; text: string | null; icon: boolean; cells: number } | null;
    tibo: { src: string | null; text: string | null; icon: boolean; cells: number } | null;
    poteto: { src: string | null; text: string | null; icon: boolean; cells: number } | null;
    kong: { src: string | null; text: string | null; icon: boolean; cells: number } | null;
  };
  await page.locator('#room-filter-friend').click();
  await page.locator(roomLink(kongRoom.room.room_id)).waitFor();
  const friendSidebar = (await page.evaluate(
    `(() => {
      const link = document.querySelector(${JSON.stringify(roomLink(kongRoom.room.room_id))});
      if (!link) return null;
      const avatar = link.querySelector('.avatar');
      const image = avatar ? avatar.querySelector('img.avatar-img') : null;
      return {
        src: image ? image.getAttribute('src') : null,
        text: avatar ? avatar.textContent : null,
        icon: avatar ? avatar.classList.contains('avatar-icon') : false,
        cells: link.querySelectorAll('.avatar-cell').length
      };
    })()`,
  )) as { src: string | null; text: string | null; icon: boolean; cells: number } | null;
  const directSidebar = { ...agentSidebar, kong: friendSidebar };
  await page.locator('#room-filter-group').click();
  const groupSidebar = (await page.evaluate(
    `(() => {
      const link = document.querySelector('#room-list a.room-item[href="/c/' + ${JSON.stringify(groupRoom.room.room_id)} + '"]');
      if (!link) return null;
      return {
        src: null,
        text: link.querySelector('.avatar') ? link.querySelector('.avatar').textContent : null,
        icon: false,
        cells: link.querySelectorAll('.avatar-cell').length
      };
    })()`,
  )) as { src: string | null; text: string | null; icon: boolean; cells: number } | null;
  const sidebar = { ...directSidebar, group: groupSidebar };
  checkEqual('侧栏 Codex 品牌图标', sidebar.codex?.src, '/agent-icons/codex-color.svg');
  checkEqual('侧栏 Tibo 专用头像', sidebar.tibo?.src, TIBO_ICON_SRC);
  checkEqual('侧栏 Tibo 标记品牌图标', sidebar.tibo?.icon, true);
  checkEqual('侧栏 poteto 专用头像', sidebar.poteto?.src, POTETO_ICON_SRC);
  checkEqual('侧栏 poteto 标记品牌图标', sidebar.poteto?.icon, true);
  checkEqual('侧栏 KonghaYao 专用头像', sidebar.kong?.src, KONGHAYAO_ICON_SRC);
  checkEqual('侧栏 KonghaYao 标记品牌图标', sidebar.kong?.icon, true);
  checkEqual('侧栏未命中保留首字', sidebar.plain?.src, null);
  checkEqual('侧栏未命中显示首字', sidebar.plain?.text, '琶');
  checkEqual('侧栏未命中不标记品牌图标', sidebar.plain?.icon, false);
  checkEqual('群聊头像仍为 2×2', sidebar.group?.cells, 4);
  checkEqual('群聊不渲染单图图标', sidebar.group?.src, null);

  const pageHtml = await page.content();
  check(
    '页面不引用外链图标',
    !pageHtml.includes('unpkg.com') && !pageHtml.includes('raw.githubusercontent.com'),
  );
  check('页面无外部请求', externalRequests.length === 0, externalRequests);

  await page.goto(`${base}/c/${codexRoom.room.room_id}`);
  await waitRoom(page, codexRoom.room.room_id, 'Codex 测试');
  await page.waitForFunction(
    `(() => {
      const img = document.querySelector('#messages .msg .msg-avatar img.avatar-img');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  checkEqual(
    'Agent 消息气泡使用品牌图标',
    await page.locator('#messages .msg .msg-avatar img.avatar-img').first().getAttribute('src'),
    '/agent-icons/codex-color.svg',
  );

  await page.goto(`${base}/c/${tiboRoom.room.room_id}`);
  await waitRoom(page, tiboRoom.room.room_id, 'Tibo Reset');
  await page.waitForFunction(
    `(() => {
      const img = document.querySelector('#messages .msg .msg-avatar img.avatar-img');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  checkEqual(
    'Tibo 直聊消息使用专用头像',
    await page.locator('#messages .msg .msg-avatar img.avatar-img').first().getAttribute('src'),
    TIBO_ICON_SRC,
  );

  await page.goto(`${base}/c/${potetoRoom.room.room_id}`);
  await waitRoom(page, potetoRoom.room.room_id, 'poteto');
  await page.waitForFunction(
    `(() => {
      const img = document.querySelector('#messages .msg .msg-avatar img.avatar-img');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  checkEqual(
    'poteto 直聊消息使用专用头像',
    await page.locator('#messages .msg .msg-avatar img.avatar-img').first().getAttribute('src'),
    POTETO_ICON_SRC,
  );

  await page.goto(`${base}/c/${kongRoom.room.room_id}`);
  await waitRoom(page, kongRoom.room.room_id, 'KonghaYao');
  await page.waitForFunction(
    `(() => {
      const img = document.querySelector('#messages .msg .msg-avatar img.avatar-img');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  checkEqual(
    'KonghaYao 人类消息使用专用头像',
    await page.locator('#messages .msg .msg-avatar img.avatar-img').first().getAttribute('src'),
    KONGHAYAO_ICON_SRC,
  );

  await page.goto(`${base}/c/${groupRoom.room.room_id}`);
  await waitRoom(page, groupRoom.room.room_id, '头像测试群');
  await page.waitForFunction(
    `(() => {
      const img = document.querySelector('#messages .msg .msg-avatar img.avatar-img');
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  checkEqual(
    '群聊 Agent 消息使用品牌图标',
    await page.locator('#messages .msg .msg-avatar img.avatar-img').first().getAttribute('src'),
    '/agent-icons/codex-color.svg',
  );
  await page.waitForFunction(
    `(() => {
      const messages = Array.from(document.querySelectorAll('#messages .msg'));
      const target = messages.find(function (item) {
        return item.textContent.indexOf('群里的 Tibo 消息') >= 0;
      });
      const img = target ? target.querySelector('.msg-avatar img.avatar-img') : null;
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  const groupTiboAvatar = await page.evaluate(
    `(() => {
      const messages = Array.from(document.querySelectorAll('#messages .msg'));
      const target = messages.find(function (item) {
        return item.textContent.indexOf('群里的 Tibo 消息') >= 0;
      });
      const img = target ? target.querySelector('.msg-avatar img.avatar-img') : null;
      return img ? img.getAttribute('src') : null;
    })()`,
  );
  checkEqual('群聊 Tibo 消息使用专用头像', groupTiboAvatar, TIBO_ICON_SRC);
  for (const [body, expected] of [
    ['群里的 poteto 消息', POTETO_ICON_SRC],
    ['群里的 KonghaYao 消息', KONGHAYAO_ICON_SRC],
  ] as const) {
    await page.waitForFunction(
      `(() => {
        const messages = Array.from(document.querySelectorAll('#messages .msg'));
        const target = messages.find(function (item) {
          return item.textContent.indexOf(${JSON.stringify(body)}) >= 0;
        });
        const img = target ? target.querySelector('.msg-avatar img.avatar-img') : null;
        return Boolean(img && img.complete && img.naturalWidth > 0);
      })()`,
    );
    const groupAvatar = await page.evaluate(
      `(() => {
        const messages = Array.from(document.querySelectorAll('#messages .msg'));
        const target = messages.find(function (item) {
          return item.textContent.indexOf(${JSON.stringify(body)}) >= 0;
        });
        const img = target ? target.querySelector('.msg-avatar img.avatar-img') : null;
        return img ? img.getAttribute('src') : null;
      })()`,
    );
    checkEqual(`群聊 ${body} 使用专用头像`, groupAvatar, expected);
  }

  await page.locator('#add-members').click();
  await page.locator('#members-modal').waitFor({ state: 'visible' });
  await page.waitForFunction(
    `document.querySelectorAll('#members-current .member-roster-item').length >= 3`,
  );
  await page.waitForFunction(
    `Array.from(document.querySelectorAll('#members-contacts .contact-choice')).some(function (item) {
      return item.textContent.indexOf('Gemini 候选') >= 0;
    })`,
  );
  const roster = (await page.evaluate(
    `(() => Array.from(document.querySelectorAll('#members-current .member-roster-item')).map(function (item) {
      const image = item.querySelector('img.avatar-img');
      const name = item.querySelector('.member-roster-name');
      const avatar = item.querySelector('.avatar');
      return {
        name: name ? name.textContent : '',
        src: image ? image.getAttribute('src') : null,
        text: avatar ? avatar.textContent : null
      };
    }))()`,
  )) as { name: string; src: string | null; text: string | null }[];
  const codexMember = roster.find((item) => item.name.includes('Codex 测试'));
  const plainMember = roster.find((item) => item.name.includes('琶洲-dsh-dsh'));
  const tiboMember = roster.find((item) => item.name.includes('Tibo Reset'));
  const potetoMember = roster.find((item) => item.name.includes('poteto'));
  const kongMember = roster.find((item) => item.name.includes('KonghaYao'));
  checkEqual(
    '群成员列表 Codex 品牌图标',
    codexMember?.src,
    '/agent-icons/codex-color.svg',
  );
  checkEqual('群成员列表 Tibo 专用头像', tiboMember?.src, TIBO_ICON_SRC);
  checkEqual('群成员列表 poteto 专用头像', potetoMember?.src, POTETO_ICON_SRC);
  checkEqual('群成员列表 KonghaYao 专用头像', kongMember?.src, KONGHAYAO_ICON_SRC);
  checkEqual('群成员列表未命中无图标', plainMember?.src, null);
  checkEqual('群成员列表未命中保留首字', plainMember?.text, '琶');
  const candidates = (await page.evaluate(
    `(() => Array.from(document.querySelectorAll('#members-contacts .contact-choice')).map(function (item) {
      const image = item.querySelector('img.avatar-img');
      return { name: item.textContent, src: image ? image.getAttribute('src') : null };
    }))()`,
  )) as { name: string; src: string | null }[];
  const geminiCandidate = candidates.find((item) => item.name.includes('Gemini 候选'));
  checkEqual(
    '成员候选 Gemini 品牌图标',
    geminiCandidate?.src,
    '/agent-icons/gemini-color.svg',
  );
  await page.locator('#members-cancel').click();

  await rawTool(humanToken, 'network_agent_archive', {
    request_id: requestId('avatar_archive'),
    actor_id: codex.actor.actor_id,
  });
  await rawTool(humanToken, 'network_agent_archive', {
    request_id: requestId('avatar_archive'),
    actor_id: tibo.actor.actor_id,
  });
  await rawTool(humanToken, 'network_agent_archive', {
    request_id: requestId('avatar_archive'),
    actor_id: poteto.actor.actor_id,
  });
  await page.goto(`${base}/`);
  await page.locator('#room-filter-agent').click();
  await waitRoomListName(page, '琶洲-dsh-dsh');
  await page.locator('#archived-agents').click();
  await page.waitForFunction(
    `(() => {
      const row = document.querySelector(${JSON.stringify(
        `#archive-popover-list .archive-item[data-actor-id="${codex.actor.actor_id}"]`,
      )});
      const img = row ? row.querySelector('img.avatar-img') : null;
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  checkEqual(
    '已归档 Agents 使用品牌图标',
    await page
      .locator(
        `#archive-popover-list .archive-item[data-actor-id="${codex.actor.actor_id}"] img.avatar-img`,
      )
      .getAttribute('src'),
    '/agent-icons/codex-color.svg',
  );
  await page.waitForFunction(
    `(() => {
      const row = document.querySelector(${JSON.stringify(
        `#archive-popover-list .archive-item[data-actor-id="${tibo.actor.actor_id}"]`,
      )});
      const img = row ? row.querySelector('img.avatar-img') : null;
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  checkEqual(
    '已归档 Agents Tibo 专用头像',
    await page
      .locator(
        `#archive-popover-list .archive-item[data-actor-id="${tibo.actor.actor_id}"] img.avatar-img`,
      )
      .getAttribute('src'),
    TIBO_ICON_SRC,
  );
  await page.waitForFunction(
    `(() => {
      const row = document.querySelector(${JSON.stringify(
        `#archive-popover-list .archive-item[data-actor-id="${poteto.actor.actor_id}"]`,
      )});
      const img = row ? row.querySelector('img.avatar-img') : null;
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  checkEqual(
    '已归档 Agents poteto 专用头像',
    await page
      .locator(
        `#archive-popover-list .archive-item[data-actor-id="${poteto.actor.actor_id}"] img.avatar-img`,
      )
      .getAttribute('src'),
    POTETO_ICON_SRC,
  );
  await rawTool(humanToken, 'network_agent_unarchive', {
    request_id: requestId('avatar_unarchive'),
    actor_id: codex.actor.actor_id,
  });
  await rawTool(humanToken, 'network_agent_unarchive', {
    request_id: requestId('avatar_unarchive'),
    actor_id: tibo.actor.actor_id,
  });
  await rawTool(humanToken, 'network_agent_unarchive', {
    request_id: requestId('avatar_unarchive'),
    actor_id: poteto.actor.actor_id,
  });
  await context.close();

  const kongAccountContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await kongAccountContext.addInitScript({ content: initScript(kongToken) });
  const kongAccountPage = await kongAccountContext.newPage();
  kongAccountPage.setDefaultTimeout(15_000);
  await kongAccountPage.goto(`${base}/`);
  await kongAccountPage.waitForFunction(
    `document.getElementById('account-name').textContent === 'KonghaYao'`,
  );
  await kongAccountPage.waitForFunction(
    `(() => {
      const avatar = document.getElementById('account-avatar');
      const image = avatar ? avatar.querySelector('img.avatar-img') : null;
      return Boolean(image && image.complete && image.naturalWidth > 0);
    })()`,
  );
  checkEqual(
    '本人账号 KonghaYao 显示专用头像',
    await kongAccountPage.locator('#account-avatar img.avatar-img').getAttribute('src'),
    KONGHAYAO_ICON_SRC,
  );
  checkEqual(
    '本人账号 KonghaYao 标记品牌图标',
    await kongAccountPage.evaluate(
      `document.getElementById('account-avatar').classList.contains('avatar-icon')`,
    ),
    true,
  );
  await kongAccountPage.evaluate('window.__accountAvatarInPlace = true');
  await kongAccountPage.locator('#account-rename').click();
  await kongAccountPage.fill('#me-rename-input', '普通人类');
  await kongAccountPage.locator('#me-rename-save').click();
  await kongAccountPage.waitForFunction(
    `document.getElementById('account-name').textContent === '普通人类'`,
  );
  await kongAccountPage.waitForFunction(
    `(() => {
      const avatar = document.getElementById('account-avatar');
      return Boolean(avatar && !avatar.querySelector('img.avatar-img') &&
        !avatar.classList.contains('avatar-icon') && avatar.textContent === '普');
    })()`,
  );
  checkEqual(
    '改名后本人账号立即回退首字',
    (await kongAccountPage.locator('#account-avatar').textContent())?.trim(),
    '普',
  );
  check(
    '改名后本人账号回退颜色',
    Boolean(
      await kongAccountPage.evaluate(
        `document.getElementById('account-avatar').style.background`,
      ),
    ),
  );
  await kongAccountPage.locator('#account-rename').click();
  await kongAccountPage.fill('#me-rename-input', 'KonghaYao');
  await kongAccountPage.locator('#me-rename-save').click();
  await kongAccountPage.waitForFunction(
    `document.getElementById('account-name').textContent === 'KonghaYao'`,
  );
  await kongAccountPage.waitForFunction(
    `(() => {
      const avatar = document.getElementById('account-avatar');
      const image = avatar ? avatar.querySelector('img.avatar-img') : null;
      return Boolean(image && image.complete && image.naturalWidth > 0);
    })()`,
  );
  checkEqual(
    '改名回 KonghaYao 后原地恢复专用头像',
    await kongAccountPage.locator('#account-avatar img.avatar-img').getAttribute('src'),
    KONGHAYAO_ICON_SRC,
  );
  checkEqual(
    '本人账号头像不重复叠加',
    await kongAccountPage.locator('#account-avatar img.avatar-img').count(),
    1,
  );
  checkEqual(
    '改名后头像原地更新未整页刷新',
    await kongAccountPage.evaluate('window.__accountAvatarInPlace === true'),
    true,
  );
  await kongAccountContext.close();

  const kongDarkContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  });
  await kongDarkContext.addInitScript({ content: initScript(kongToken) });
  const kongDarkPage = await kongDarkContext.newPage();
  kongDarkPage.setDefaultTimeout(15_000);
  await kongDarkPage.goto(`${base}/`);
  await kongDarkPage.waitForFunction(
    `document.getElementById('account-name').textContent === 'KonghaYao'`,
  );
  await kongDarkPage.waitForFunction(
    `(() => {
      const avatar = document.getElementById('account-avatar');
      const image = avatar ? avatar.querySelector('img.avatar-img') : null;
      return Boolean(image && image.complete && image.naturalWidth > 0);
    })()`,
  );
  const accountMobileMetrics = (await kongDarkPage.evaluate(
    `(() => {
      const avatar = document.getElementById('account-avatar');
      const image = avatar ? avatar.querySelector('img.avatar-img') : null;
      if (!avatar || !image) return null;
      const avatarBox = avatar.getBoundingClientRect();
      const imageBox = image.getBoundingClientRect();
      return {
        dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
        pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        inside: imageBox.left >= avatarBox.left - 0.5 &&
          imageBox.right <= avatarBox.right + 0.5 &&
          imageBox.top >= avatarBox.top - 0.5 &&
          imageBox.bottom <= avatarBox.bottom + 0.5,
        background: getComputedStyle(image).backgroundColor
      };
    })()`,
  )) as { dark: boolean; pageFits: boolean; inside: boolean; background: string } | null;
  checkEqual('390px 暗色本人账号头像可见', Boolean(accountMobileMetrics), true);
  checkEqual('390px 页面不横向溢出（本人账号头像）', accountMobileMetrics?.pageFits, true);
  checkEqual('390px 本人账号专用头像不溢出', accountMobileMetrics?.inside, true);
  checkEqual(
    '暗色模式本人账号专用头像仍为浅色底',
    accountMobileMetrics?.background,
    'rgb(242, 243, 245)',
  );
  await kongDarkContext.close();

  const darkContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  });
  await darkContext.addInitScript({ content: initScript(humanToken) });
  const darkPage = await darkContext.newPage();
  darkPage.setDefaultTimeout(15_000);
  await darkPage.goto(`${base}/`);
  await darkPage.locator('#room-filter-agent').click();
  await waitRoomListName(darkPage, 'Codex 测试');
  await darkPage.waitForFunction(
    `(() => {
      const img = document.querySelector(${JSON.stringify(`${roomLink(codexRoom.room.room_id)} .avatar-img`)});
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  const mobileMetrics = (await darkPage.evaluate(
    `(() => {
      const link = document.querySelector(${JSON.stringify(roomLink(codexRoom.room.room_id))});
      const avatar = link ? link.querySelector('.avatar-icon') : null;
      const image = avatar ? avatar.querySelector('img.avatar-img') : null;
      if (!avatar || !image) return null;
      const avatarBox = avatar.getBoundingClientRect();
      const imageBox = image.getBoundingClientRect();
      return {
        dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
        pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        inside: imageBox.left >= avatarBox.left - 0.5 &&
          imageBox.right <= avatarBox.right + 0.5 &&
          imageBox.top >= avatarBox.top - 0.5 &&
          imageBox.bottom <= avatarBox.bottom + 0.5,
        background: getComputedStyle(image).backgroundColor
      };
    })()`,
  )) as { dark: boolean; pageFits: boolean; inside: boolean; background: string } | null;
  checkEqual('暗色主题生效', mobileMetrics?.dark, true);
  checkEqual('390px 页面不横向溢出（头像）', mobileMetrics?.pageFits, true);
  checkEqual('390px 品牌头像不溢出', mobileMetrics?.inside, true);
  checkEqual('暗色模式品牌图标仍为浅色底', mobileMetrics?.background, 'rgb(242, 243, 245)');
  await darkPage.waitForFunction(
    `(() => {
      const img = document.querySelector(${JSON.stringify(`${roomLink(tiboRoom.room.room_id)} .avatar-img`)});
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  const tiboMobileMetrics = (await darkPage.evaluate(
    `(() => {
      const link = document.querySelector(${JSON.stringify(roomLink(tiboRoom.room.room_id))});
      const avatar = link ? link.querySelector('.avatar-icon') : null;
      const image = avatar ? avatar.querySelector('img.avatar-img') : null;
      if (!avatar || !image) return null;
      const avatarBox = avatar.getBoundingClientRect();
      const imageBox = image.getBoundingClientRect();
      return {
        pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        inside: imageBox.left >= avatarBox.left - 0.5 &&
          imageBox.right <= avatarBox.right + 0.5 &&
          imageBox.top >= avatarBox.top - 0.5 &&
          imageBox.bottom <= avatarBox.bottom + 0.5,
        background: getComputedStyle(image).backgroundColor
      };
    })()`,
  )) as { pageFits: boolean; inside: boolean; background: string } | null;
  checkEqual('390px 页面不横向溢出（Tibo 头像）', tiboMobileMetrics?.pageFits, true);
  checkEqual('390px Tibo 专用头像不溢出', tiboMobileMetrics?.inside, true);
  checkEqual(
    '暗色模式 Tibo 专用头像仍为浅色底',
    tiboMobileMetrics?.background,
    'rgb(242, 243, 245)',
  );
  await darkPage.waitForFunction(
    `(() => {
      const img = document.querySelector(${JSON.stringify(`${roomLink(potetoRoom.room.room_id)} .avatar-img`)});
      return Boolean(img && img.complete && img.naturalWidth > 0);
    })()`,
  );
  const potetoMobileMetrics = (await darkPage.evaluate(
    `(() => {
      const link = document.querySelector(${JSON.stringify(roomLink(potetoRoom.room.room_id))});
      const avatar = link ? link.querySelector('.avatar-icon') : null;
      const image = avatar ? avatar.querySelector('img.avatar-img') : null;
      if (!avatar || !image) return null;
      const avatarBox = avatar.getBoundingClientRect();
      const imageBox = image.getBoundingClientRect();
      return {
        pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        inside: imageBox.left >= avatarBox.left - 0.5 &&
          imageBox.right <= avatarBox.right + 0.5 &&
          imageBox.top >= avatarBox.top - 0.5 &&
          imageBox.bottom <= avatarBox.bottom + 0.5,
        background: getComputedStyle(image).backgroundColor
      };
    })()`,
  )) as { pageFits: boolean; inside: boolean; background: string } | null;
  checkEqual('390px 页面不横向溢出（poteto 头像）', potetoMobileMetrics?.pageFits, true);
  checkEqual('390px poteto 专用头像不溢出', potetoMobileMetrics?.inside, true);
  checkEqual(
    '暗色模式 poteto 专用头像仍为浅色底',
    potetoMobileMetrics?.background,
    'rgb(242, 243, 245)',
  );
  await darkContext.close();

  const failContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await failContext.addInitScript({ content: initScript(humanToken) });
  const failPage = await failContext.newPage();
  failPage.setDefaultTimeout(15_000);
  await failPage.route('**/agent-icons/codex-color.svg', async (route) => {
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
  });
  await failPage.route('**/agent-icons/tibo.png', async (route) => {
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
  });
  await failPage.route('**/agent-icons/poteto.png', async (route) => {
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'missing' });
  });
  await failPage.goto(`${base}/`);
  await failPage.locator('#room-filter-agent').click();
  await waitRoomListName(failPage, 'Codex 测试');
  await failPage.waitForFunction(
    `(() => {
      const link = document.querySelector(${JSON.stringify(roomLink(codexRoom.room.room_id))});
      const avatar = link ? link.querySelector('.avatar') : null;
      return Boolean(avatar && !avatar.querySelector('img.avatar-img') && avatar.textContent === 'C');
    })()`,
  );
  await failPage.waitForFunction(
    `(() => {
      const link = document.querySelector(${JSON.stringify(roomLink(tiboRoom.room.room_id))});
      const avatar = link ? link.querySelector('.avatar') : null;
      return Boolean(avatar && !avatar.querySelector('img.avatar-img') && avatar.textContent === 'T');
    })()`,
  );
  await failPage.waitForFunction(
    `(() => {
      const link = document.querySelector(${JSON.stringify(roomLink(potetoRoom.room.room_id))});
      const avatar = link ? link.querySelector('.avatar') : null;
      return Boolean(avatar && !avatar.querySelector('img.avatar-img') && avatar.textContent === 'p');
    })()`,
  );
  check('品牌图标加载失败回退首字', true);
  check('Tibo 专用头像加载失败回退首字', true);
  await failContext.close();
}

async function runMessageOutboxAcceptance(
  browser: Browser,
  base: string,
  allErrors: string[],
): Promise<void> {
  console.log('· M02 发送状态与可靠补读 UI');
  const humanToken = crypto.randomUUID();
  await rawTool<Actor>(humanToken, 'network_register', {
    request_id: requestId('m02_human'),
    kind: 'human',
    name: 'M02 网页人类',
  });
  const agentToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
  const agent = await rawTool<Actor>(agentToken, 'network_register', {
    request_id: requestId('m02_agent'),
    kind: 'agent',
    name: 'M02 网页 Agent',
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  await rawBefriend(humanToken, agentToken, { actor_id: agent.actor_id });
  const roomA = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('m02_room'),
    kind: 'group',
    title: 'M02 发送状态群',
    members: [agent.actor_id],
  });
  const roomB = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('m02_room'),
    kind: 'group',
    title: 'M02 第二会话',
    members: [agent.actor_id],
  });
  const roomAId = roomA.room.room_id;
  const roomBId = roomB.room.room_id;
  await acceptRoomInvites(agentToken, roomAId);
  await acceptRoomInvites(agentToken, roomBId);

  const { context, page } = await makeContext(
    browser,
    humanToken,
    { width: 1280, height: 800 },
    allErrors,
  );
  let heldRelease: (() => void) | null = null;
  let holdNext = false;
  let loseNext = false;
  let failNextRetryable = false;
  let failNextPermanent = false;
  const outboxRows = (): Locator => page.locator('#messages .msg-outbox');
  /**
   * 状态行按稳定 `client_message_id` 定位：正文预览会截断，文本匹配在
   * 长正文下不可靠；意图被清理后返回不存在的 ID，count 仍为 0。
   */
  const outboxFor = async (marker: string): Promise<Locator> => {
    const intent = (await outboxItems()).find((item) => item.body.includes(marker));
    return page.locator(
      `#messages .msg-outbox[data-client-message-id="${intent ? intent.client_message_id : '__missing__'}"]`,
    );
  };
  const sendCallsFor = async (
    marker: string,
  ): Promise<{ request_id?: string; client_message_id?: string; body?: string }[]> =>
    (await page.evaluate(
      `(function () {
        return (window.__mcpCalls || [])
          .filter(function (call) {
            return call.name === 'network_message_send' &&
              call.body && call.body.params && call.body.params.arguments &&
              String(call.body.params.arguments.body || '').indexOf(${JSON.stringify(marker)}) >= 0;
          })
          .map(function (call) { return call.body.params.arguments; });
      })()`,
    )) as { request_id?: string; client_message_id?: string; body?: string }[];
  const outboxItems = async (): Promise<
    { client_message_id: string; body: string; status: string; message_id?: string }[]
  > =>
    (await page.evaluate(
      `(function () {
        const items = [];
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (!key || key.indexOf('agent-network-outbox:v1:') !== 0) continue;
          try {
            const parsed = JSON.parse(window.localStorage.getItem(key) || '[]');
            if (Array.isArray(parsed)) items.push.apply(items, parsed);
          } catch (error) {
            // 损坏的本地意图不应让验收中断；生产代码同样按空列表处理。
          }
        }
        return items;
      })()`,
    )) as {
      client_message_id: string;
      body: string;
      status: string;
      message_id?: string;
    }[];

  try {
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      if (request.headers()['mcp-name'] !== 'network_message_send') {
        await route.continue();
        return;
      }
      if (holdNext) {
        holdNext = false;
        await new Promise<void>((resolve) => {
          heldRelease = resolve;
        });
        await route.continue();
        return;
      }
      if (loseNext) {
        loseNext = false;
        // 服务端正常提交，但客户端拿不到响应。
        await route.fetch();
        await route.abort('failed');
        return;
      }
      const body = request.postDataJSON() as { id?: unknown } | null;
      if (failNextRetryable) {
        failNextRetryable = false;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: body?.id ?? null,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ code: 'RATE_LIMITED', message: '模拟限流' }),
                },
              ],
            },
          }),
        });
        return;
      }
      if (failNextPermanent) {
        failNextPermanent = false;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: body?.id ?? null,
            result: {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ code: 'NOT_MEMBER', message: '模拟越权' }),
                },
              ],
            },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.goto(`${base}/c/${roomAId}`);
    await waitRoom(page, roomAId, 'M02 发送状态群');

    // A. 发送中切群：状态与草稿不跨房间，迟到响应不覆盖新房间。
    const markerA = `M02 跨房发送 ${crypto.randomUUID()}`;
    holdNext = true;
    await page.locator('#body').fill(markerA);
    await page.locator('#send').click();
    await waitUntil(async () => (await outboxRows().count()) === 1, 'A 显示发送中状态行');
    check(
      '发送中状态行显示本地意图',
      ((await outboxRows().first().textContent()) ?? '').includes('发送中'),
      await outboxRows().first().textContent(),
    );
    await waitUntil(() => heldRelease !== null, 'A 的发送请求已挂起');
    await page.locator(roomLink(roomBId)).click();
    await waitRoom(page, roomBId, 'M02 第二会话');
    checkEqual('切换房间后 B 不显示 A 的发送状态', await outboxRows().count(), 0);
    checkEqual('切换房间后 B 草稿为空', await page.locator('#body').inputValue(), '');
    await page.locator('#body').fill('B 的独立草稿');
    heldRelease!();
    await waitUntil(
      async () => {
        const items = await outboxItems();
        return items.some((item) => item.body.includes(markerA) && item.status === 'committed');
      },
      'A 的意图在后台标记为已提交',
    );
    checkEqual(
      'A 的迟到响应不覆盖 B 草稿',
      await page.locator('#body').inputValue(),
      'B 的独立草稿',
    );
    checkEqual('A 的已提交状态不渲染到 B', await outboxRows().count(), 0);
    await page.locator(roomLink(roomAId)).click();
    await waitRoom(page, roomAId, 'M02 发送状态群');
    await waitUntil(
      async () =>
        (await page.locator('#messages .msg').filter({ hasText: markerA }).count()) === 1,
      'A 时间线出现已提交消息',
    );
    await waitUntil(async () => (await outboxRows().count()) === 0, 'A 的已提交状态行清理');
    checkEqual(
      '切回 A 后只有一条跨房消息',
      await page.locator('#messages .msg').filter({ hasText: markerA }).count(),
      1,
    );
    const historyA = await rawTool<{ items: { preview: string }[] }>(
      humanToken,
      'network_history_list',
      { room_id: roomAId, limit: 50 },
    );
    checkEqual(
      '服务端只有一条跨房消息',
      historyA.items.filter((item) => item.preview.includes(markerA)).length,
      1,
    );
    await page.locator(roomLink(roomBId)).click();
    await waitRoom(page, roomBId, 'M02 第二会话');
    checkEqual(
      '往返切换后 B 草稿保持',
      await page.locator('#body').inputValue(),
      'B 的独立草稿',
    );
    checkEqual('B 中仍不显示 A 的状态行', await outboxRows().count(), 0);
    await page.locator(roomLink(roomAId)).click();
    await waitRoom(page, roomAId, 'M02 发送状态群');

    // B. 服务端已提交但响应丢失：先对账，不生成第二条消息。
    const markerB = `M02 响应丢失 ${crypto.randomUUID()}`;
    loseNext = true;
    await page.locator('#body').fill(markerB);
    await page.locator('#send').click();
    await waitUntil(
      async () =>
        (await page.locator('#messages .msg').filter({ hasText: markerB }).count()) === 1,
      '对账后补拉已提交消息',
      15_000,
    );
    await waitUntil(async () => (await page.locator('#body').inputValue()) === '', '对账成功后清空草稿');
    const statusB = (await page.locator('#status').textContent()) ?? '';
    check('响应丢失不显示发送失败', !statusB.includes('发送失败'), statusB);
    const reconcileCalls = (await page.evaluate(
      `(window.__mcpCalls || []).filter(function (call) { return call.name === 'network_message_send_status'; }).length`,
    )) as number;
    check('响应丢失后先调用发送对账', reconcileCalls > 0, reconcileCalls);
    const historyB = await rawTool<{ items: { preview: string }[] }>(
      humanToken,
      'network_history_list',
      { room_id: roomAId, limit: 50 },
    );
    checkEqual(
      '响应丢失后服务端只有一条消息',
      historyB.items.filter((item) => item.preview.includes(markerB)).length,
      1,
    );
    check(
      '对账确认已提交后不保留本地意图',
      !(await outboxItems()).some((item) => item.body.includes(markerB)),
      await outboxItems(),
    );
    checkEqual('对账确认后不显示重试按钮', await (await outboxFor(markerB)).count(), 0);

    // C. 可重试失败：显示重试，重试复用原 request_id/client_message_id。
    const markerC = `M02 可重试失败 ${crypto.randomUUID()}`;
    failNextRetryable = true;
    await page.locator('#body').fill(markerC);
    await page.locator('#send').click();
    await waitForText(page, '#status', '发送失败：模拟限流');
    await (await outboxFor(markerC)).waitFor();
    checkEqual('可重试失败保留草稿', await page.locator('#body').inputValue(), markerC);
    checkEqual('可重试失败提供重试按钮', await (await outboxFor(markerC)).locator('.outbox-retry').count(), 1);
    await (await outboxFor(markerC)).locator('.outbox-retry').click();
    await waitUntil(
      async () =>
        (await page.locator('#messages .msg').filter({ hasText: markerC }).count()) === 1,
      '重试后出现消息',
      15_000,
    );
    const retryCalls = await sendCallsFor(markerC);
    checkEqual('重试共发出两次发送调用', retryCalls.length, 2);
    checkEqual(
      '重试复用原 client_message_id',
      new Set(retryCalls.map((call) => call.client_message_id)).size,
      1,
    );
    checkEqual(
      '重试复用原 request_id',
      new Set(retryCalls.map((call) => call.request_id)).size,
      1,
    );
    const historyC = await rawTool<{ items: { preview: string }[] }>(
      humanToken,
      'network_history_list',
      { room_id: roomAId, limit: 50 },
    );
    checkEqual(
      '重试成功不生成第二条消息',
      historyC.items.filter((item) => item.preview.includes(markerC)).length,
      1,
    );
    await waitUntil(async () => (await (await outboxFor(markerC)).count()) === 0, '重试成功后清理状态行');

    // D. 不可重试失败 + 刷新恢复 + 移除。
    const markerD = `M02 失败持久化 ${crypto.randomUUID()}`;
    failNextPermanent = true;
    await page.locator('#body').fill(markerD);
    await page.locator('#send').click();
    await waitForText(page, '#status', '发送失败：模拟越权');
    await (await outboxFor(markerD)).waitFor();
    checkEqual('不可重试失败不提供重试按钮', await (await outboxFor(markerD)).locator('.outbox-retry').count(), 0);
    checkEqual('不可重试失败提供移除按钮', await (await outboxFor(markerD)).locator('.outbox-dismiss').count(), 1);
    await page.reload();
    await waitRoom(page, roomAId, 'M02 发送状态群');
    await waitUntil(
      async () => (await (await outboxFor(markerD)).count()) === 1,
      '刷新后恢复本地失败状态',
    );
    check(
      '刷新后失败状态仍可读',
      ((await (await outboxFor(markerD)).textContent()) ?? '').includes('发送失败'),
      await (await outboxFor(markerD)).textContent(),
    );
    await (await outboxFor(markerD)).locator('.outbox-dismiss').click();
    await waitUntil(async () => (await (await outboxFor(markerD)).count()) === 0, '移除本地失败意图');
    check(
      '移除后本地不再保留失败意图',
      !(await outboxItems()).some((item) => item.body.includes(markerD)),
      await outboxItems(),
    );

    // E. 修改正文后重发必须新建意图，旧 ID 不被复用。
    const markerE = `M02 修改正文原意图 ${crypto.randomUUID()}`;
    failNextRetryable = true;
    await page.locator('#body').fill(markerE);
    await page.locator('#send').click();
    await waitForText(page, '#status', '发送失败：模拟限流');
    const failedE = await sendCallsFor(markerE);
    checkEqual('修改正文前有一次失败发送', failedE.length, 1);
    const edited = `M02 修改正文新意图 ${crypto.randomUUID()}`;
    await page.locator('#body').fill(edited);
    await page.locator('#send').click();
    await waitUntil(
      async () =>
        (await page.locator('#messages .msg').filter({ hasText: edited }).count()) === 1,
      '修改正文后发送成功',
      15_000,
    );
    const editedCalls = await sendCallsFor(edited);
    checkEqual('修改正文后发出新请求', editedCalls.length, 1);
    check(
      '修改正文后使用新的 client_message_id',
      editedCalls[0]?.client_message_id !== failedE[0]?.client_message_id,
      { before: failedE[0]?.client_message_id, after: editedCalls[0]?.client_message_id },
    );
    check(
      '原失败意图仍保留原正文',
      (await outboxItems()).some(
        (item) => item.body.includes(markerE) && item.status === 'failed',
      ),
      await outboxItems(),
    );
    await (await outboxFor(markerE)).locator('.outbox-dismiss').click();
    await waitUntil(async () => (await (await outboxFor(markerE)).count()) === 0, '清理修改正文前的失败意图');
  } finally {
    await context.close();
  }
}

/**
 * 长历史分片验收：首屏只读取视口附近的 Agent 截断消息，滚动触发增量读取，
 * 手动展开与「加载更早」游标分页仍然可用。
 */
async function runLongHistoryAcceptance(
  browser: Browser,
  base: string,
  allErrors: string[],
): Promise<void> {
  const humanToken = crypto.randomUUID();
  await rawTool<Actor>(humanToken, 'network_register', {
    request_id: requestId('web_reg'),
    kind: 'human',
    name: '长历史验收人类',
  });
  const agentToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
  const agent = await rawTool<Actor>(agentToken, 'network_register', {
    request_id: requestId('reg'),
    kind: 'agent',
    name: '长历史验收 Agent',
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  await rawBefriend(humanToken, agentToken, { actor_id: agent.actor_id });
  const group = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('room'),
    kind: 'group',
    title: '长历史分片验收群',
    members: [agent.actor_id],
  });
  const roomId = group.room.room_id;
  await acceptRoomInvites(agentToken, roomId);

  // 55 条预览被截断但低于 16KB 的 Agent 消息 + 1 条超过阈值的消息。
  for (let index = 1; index <= 55; index += 1) {
    const marker = `长历史消息 ${String(index).padStart(2, '0')} 标记`;
    await rawTool(agentToken, 'network_message_send', {
      request_id: requestId('msg'),
      client_message_id: crypto.randomUUID(),
      room_id: roomId,
      invoke: [],
      body: `${marker}\n\n${'长历史填充内容。'.repeat(120)}`,
    });
  }
  const hugeMarker = '超大消息 16KB 标记';
  const hugeTail = '超大消息完整结尾';
  await rawTool(agentToken, 'network_message_send', {
    request_id: requestId('msg'),
    client_message_id: crypto.randomUUID(),
    room_id: roomId,
    invoke: [],
    body: `${hugeMarker}\n\n${'超'.repeat(9000)}\n${hugeTail}`,
  });

  const { context, page } = await makeContext(
    browser,
    humanToken,
    { width: 1280, height: 900 },
    allErrors,
  );
  try {
    await page.goto(`${base}/c/${roomId}`);
    await waitRoom(page, roomId, '长历史分片验收群');
    await waitUntil(
      async () => (await page.locator('#messages .msg[data-message-id]').count()) === 50,
      '长历史首屏 50 条消息',
      20_000,
    );
    await waitUntil(
      async () => (await mcpCallCount(page, 'network_message_read')) >= 1,
      '首屏视口内自动展开',
      10_000,
    );
    await sleep(800);
    const initialReads = await mcpCallCount(page, 'network_message_read');
    check(
      `长历史首屏只读取视口附近少量消息（${initialReads}/50）`,
      initialReads >= 1 && initialReads <= 10,
      initialReads,
    );
    check('首屏读取数量明显小于消息总数', initialReads < 50, initialReads);
    const offscreenButtons = await page.locator('#messages .msg .expand').count();
    check(
      '未进入视口的截断消息保留展开按钮',
      offscreenButtons >= 30,
      offscreenButtons,
    );

    // 滚到中部而不是顶部，避免触发“加载更早”的自动入口。
    await page.locator('#messages .msg[data-message-id]').nth(20).scrollIntoViewIfNeeded();
    await waitUntil(
      async () => (await mcpCallCount(page, 'network_message_read')) > initialReads,
      '滚动到未展开消息触发读取',
      10_000,
    );
    await sleep(400);
    const scrolledReads = await mcpCallCount(page, 'network_message_read');
    check(
      `滚动只为新进入视口的消息补读（${initialReads}→${scrolledReads}）`,
      scrolledReads > initialReads && scrolledReads <= initialReads + 10,
      { initialReads, scrolledReads },
    );

    const hugeMessage = page
      .locator('#messages .msg[data-message-id]')
      .filter({ hasText: hugeMarker })
      .last();
    await hugeMessage.scrollIntoViewIfNeeded();
    checkEqual(
      '超过 16KB 的 Agent 消息保留手动展开按钮',
      await hugeMessage.locator('.expand').count(),
      1,
    );
    await hugeMessage.locator('.expand').click();
    await hugeMessage.locator('.expand').waitFor({ state: 'detached' });
    await waitUntil(
      async () => ((await hugeMessage.locator('.bubble').textContent()) ?? '').includes(hugeTail),
      '超过阈值的消息可手动展开全文',
      15_000,
    );

    const readsBeforeOlder = await mcpCallCount(page, 'network_message_read');
    const olderBefore = await olderCursors(page);
    checkEqual(
      '手动加载更早前仍停留在首屏分片',
      await page.locator('#messages .msg[data-message-id]').count(),
      50,
    );
    await page.evaluate(`document.getElementById('older').click()`);
    await waitUntil(
      async () => (await page.locator('#messages .msg[data-message-id]').count()) === 56,
      '加载更早补齐 56 条消息',
      20_000,
    );
    await sleep(400);
    const olderAfter = await olderCursors(page);
    checkEqual('加载更早只按一个游标分片', olderAfter.length - olderBefore.length, 1);
    const readsAfterOlder = await mcpCallCount(page, 'network_message_read');
    check(
      '加载更早 prepend 不批量读取新增消息',
      readsAfterOlder - readsBeforeOlder <= 3,
      { readsBeforeOlder, readsAfterOlder },
    );
    const timelineIds = (await page.evaluate(`(() => {
      return Array.from(document.querySelectorAll('#messages .msg[data-message-id]'))
        .map(function (item) { return item.dataset.messageId; });
    })()`)) as string[];
    checkEqual('长历史加载更早后无重复消息', new Set(timelineIds).size, timelineIds.length);
    checkEqual('长历史加载更早后共 56 条', timelineIds.length, 56);

    const readsBeforeTop = await mcpCallCount(page, 'network_message_read');
    await page.evaluate(`document.getElementById('messages').scrollTop = 0`);
    await waitUntil(
      async () => (await mcpCallCount(page, 'network_message_read')) > readsBeforeTop,
      '滚动到历史顶部触发自动展开',
      10_000,
    );
    await sleep(400);
    const readsAfterTop = await mcpCallCount(page, 'network_message_read');
    check(
      `滚动到历史顶部后仍只读取视口附近消息（${readsBeforeTop}→${readsAfterTop}/56）`,
      readsAfterTop > readsBeforeTop && readsAfterTop < 56,
      { readsBeforeTop, readsAfterTop },
    );
  } finally {
    await context.close();
  }
}

/**
 * 切房缓存渲染边界：长缓存回到会话时只恢复房间元数据并加载最新页，
 * 不再预渲染全部已加载历史；短缓存仍保持即时预览。
 */
async function runRoomSwitchCacheAcceptance(
  browser: Browser,
  base: string,
  allErrors: string[],
): Promise<void> {
  const humanToken = crypto.randomUUID();
  await rawTool<Actor>(humanToken, 'network_register', {
    request_id: requestId('web_reg'),
    kind: 'human',
    name: '切房缓存验收人类',
  });
  const agentToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
  const agent = await rawTool<Actor>(agentToken, 'network_register', {
    request_id: requestId('reg'),
    kind: 'agent',
    name: '切房缓存验收 Agent',
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  await rawBefriend(humanToken, agentToken, { actor_id: agent.actor_id });
  const longRoom = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('room'),
    kind: 'group',
    title: '长缓存切房群',
    members: [agent.actor_id],
  });
  const longRoomId = longRoom.room.room_id;
  await acceptRoomInvites(agentToken, longRoomId);
  for (let index = 1; index <= 150; index += 1) {
    await rawTool(agentToken, 'network_message_send', {
      request_id: requestId('msg'),
      client_message_id: crypto.randomUUID(),
      room_id: longRoomId,
      invoke: [],
      body: `长缓存切换消息 ${String(index).padStart(3, '0')}`,
    });
  }
  const shortRoom = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('room'),
    kind: 'group',
    title: '短缓存切房群',
    members: [agent.actor_id],
  });
  const shortRoomId = shortRoom.room.room_id;
  await acceptRoomInvites(agentToken, shortRoomId);
  for (let index = 1; index <= 6; index += 1) {
    await rawTool(agentToken, 'network_message_send', {
      request_id: requestId('msg'),
      client_message_id: crypto.randomUUID(),
      room_id: shortRoomId,
      invoke: [],
      body: `短缓存切换消息 ${index}`,
    });
  }

  const { context, page } = await makeContext(
    browser,
    humanToken,
    { width: 1280, height: 900 },
    allErrors,
  );
  try {
    await page.goto(`${base}/c/${longRoomId}`);
    await waitRoom(page, longRoomId, '长缓存切房群');
    await waitUntil(
      async () => (await messageCount(page)) === 50,
      '长缓存会话首屏 50 条',
      20_000,
    );
    await page.evaluate(`document.getElementById('older').click()`);
    await waitUntil(
      async () => (await messageCount(page)) >= 100,
      '长缓存会话加载到 100 条',
      15_000,
    );
    await page.evaluate(`document.getElementById('older').click()`);
    await waitUntil(
      async () => (await messageCount(page)) >= 150,
      '长缓存会话加载到 150 条',
      15_000,
    );
    await sleep(300);
    const loadedIds = await timelineMessageIds(page);
    checkEqual('长缓存场景已加载 150 条', loadedIds.length, 150);
    checkEqual('长缓存场景消息无重复', new Set(loadedIds).size, loadedIds.length);
    await page.fill('#body', '长缓存草稿');

    // 先进入短会话建立缓存，再切回长会话验证渲染边界。
    await page.locator(roomLink(shortRoomId)).click();
    await waitRoom(page, shortRoomId, '短缓存切房群');
    await waitUntil(
      async () => (await messageCount(page)) === 6,
      '短缓存会话首屏 6 条',
      15_000,
    );
    await sleep(200);

    let releaseLongHistory: (() => void) | null = null;
    let longHistoryStarted = false;
    let longHistoryFinished = false;
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      if (request.headers()['mcp-name'] !== 'network_history_list') {
        await route.continue();
        return;
      }
      const body = request.postDataJSON() as {
        params?: { arguments?: { room_id?: string; cursor?: string | null } };
      } | null;
      const args = body?.params?.arguments;
      if (args?.room_id !== longRoomId || args.cursor) {
        await route.continue();
        return;
      }
      longHistoryStarted = true;
      await new Promise<void>((resolve) => {
        releaseLongHistory = resolve;
      });
      await route.continue();
      longHistoryFinished = true;
    });

    await page.locator(roomLink(longRoomId)).click();
    await waitUntil(
      async () => longHistoryStarted && releaseLongHistory !== null,
      '长缓存切回请求进入等待',
      10_000,
    );
    const duringSwitch = {
      messages: await messageCount(page),
      loading: await page.locator('#chat-loading').isVisible(),
      skeleton: await page.locator('#chat-skeleton').isVisible(),
      title: await page.locator('#title').textContent(),
      draft: await page.inputValue('#body'),
      errorHidden: await page.locator('#chat-error').isHidden(),
    };
    checkEqual('长缓存切回加载态不预渲染历史', duringSwitch.messages, 0);
    check(
      '长缓存切回加载态消息数不超过阈值',
      duringSwitch.messages <= LIMITS.webRoomCacheRenderMax,
      duringSwitch,
    );
    checkEqual('长缓存切回显示加载条', duringSwitch.loading, true);
    checkEqual('长缓存切回显示骨架', duringSwitch.skeleton, true);
    checkEqual('长缓存切回标题来自缓存', duringSwitch.title, '长缓存切房群');
    checkEqual('长缓存切回保留草稿', duringSwitch.draft, '长缓存草稿');
    checkEqual('长缓存切回未显示错误', duringSwitch.errorHidden, true);

    releaseLongHistory!();
    await waitUntil(
      async () => (await messageCount(page)) === 50,
      '长缓存切回只渲染最新页 50 条',
      20_000,
    );
    await waitUntil(
      async () => page.locator('#chat-loading').isHidden(),
      '长缓存切回加载态收口',
      10_000,
    );
    await waitUntil(async () => longHistoryFinished, '长缓存切回请求完成', 10_000);
    await page.unroute('**/mcp');
    await sleep(300);
    const latestIds = await timelineMessageIds(page);
    checkEqual('长缓存切回最终只有最新页', latestIds.length, 50);
    checkEqual('长缓存切回消息无重复', new Set(latestIds).size, latestIds.length);
    checkEqual('长缓存切回标题正确', await page.locator('#title').textContent(), '长缓存切房群');
    checkEqual('长缓存切回草稿正确', await page.inputValue('#body'), '长缓存草稿');
    await waitForBottom(page, '长缓存切回后仍到底');
    check('长缓存切回后回到底部', (await bottomGap(page)) <= 2, await bottomGap(page));

    // 最新页仍保留更早游标。
    await page.evaluate(`document.getElementById('older').click()`);
    await waitUntil(
      async () => (await messageCount(page)) >= 100,
      '长缓存切回后仍能加载更早',
      15_000,
    );
    await sleep(200);
    const olderIds = await timelineMessageIds(page);
    checkEqual('长缓存切回后加载更早共 100 条', olderIds.length, 100);
    checkEqual('长缓存切回后加载更早无重复', new Set(olderIds).size, olderIds.length);

    // 短缓存切回仍立即显示缓存内容，不闪加载态/错误。
    await page.locator(roomLink(shortRoomId)).click();
    const shortBackImmediate = {
      messages: await messageCount(page),
      loading: await page.locator('#chat-loading').isVisible(),
      skeleton: await page.locator('#chat-skeleton').isVisible(),
      title: await page.locator('#title').textContent(),
      errorHidden: await page.locator('#chat-error').isHidden(),
    };
    checkEqual('短缓存切回立即显示缓存消息', shortBackImmediate.messages, 6);
    checkEqual('短缓存切回不显示加载态', shortBackImmediate.loading, false);
    checkEqual('短缓存切回不显示骨架', shortBackImmediate.skeleton, false);
    checkEqual('短缓存切回标题正确', shortBackImmediate.title, '短缓存切房群');
    checkEqual('短缓存切回无错误', shortBackImmediate.errorHidden, true);
    await waitRoom(page, shortRoomId, '短缓存切房群');
    await sleep(300);
    checkEqual('短缓存切回刷新后仍 6 条', await messageCount(page), 6);

    // 长缓存刷新失败必须给出明确错误与重试，而不是空白或旧长缓存。
    let failedLongRoomGet = false;
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      if (request.headers()['mcp-name'] !== 'network_room_get' || failedLongRoomGet) {
        await route.continue();
        return;
      }
      const body = request.postDataJSON() as {
        id?: unknown;
        params?: { arguments?: { room_id?: string } };
      } | null;
      if (body?.params?.arguments?.room_id !== longRoomId) {
        await route.continue();
        return;
      }
      failedLongRoomGet = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: body?.id ?? null,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({ code: 'INTERNAL', message: '模拟长缓存刷新失败' }),
              },
            ],
          },
        }),
      });
    });
    await page.locator(roomLink(longRoomId)).click();
    await waitUntil(
      async () => page.locator('#chat-error').isVisible(),
      '长缓存刷新失败显示错误',
      10_000,
    );
    check(
      '长缓存刷新失败错误文案可读',
      ((await page.locator('#chat-error-text').textContent()) ?? '').includes('加载会话失败'),
      await page.locator('#chat-error-text').textContent(),
    );
    checkEqual('长缓存刷新失败不显示旧缓存消息', await messageCount(page), 0);
    checkEqual('长缓存刷新失败提供重试', await page.locator('#chat-error-retry').isVisible(), true);
    await page.unroute('**/mcp');
    await page.locator('#chat-error-retry').click();
    await waitUntil(
      async () => (await messageCount(page)) === 50,
      '长缓存刷新失败后可重试',
      20_000,
    );
    checkEqual('长缓存重试后恢复最新页', await messageCount(page), 50);
    checkEqual('长缓存重试后隐藏错误', await page.locator('#chat-error').isHidden(), true);

    // 390px 下长缓存切回后的消息区不横向溢出（此时仍在长会话最新页）。
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(200);
    const mobileLayout = (await page.evaluate(`(() => {
      const messages = document.getElementById('messages');
      return {
        view: window.innerWidth,
        doc: document.documentElement.scrollWidth,
        messagesClient: messages ? messages.clientWidth : 0,
        messagesScroll: messages ? messages.scrollWidth : 0
      };
    })()`)) as {
      view: number;
      doc: number;
      messagesClient: number;
      messagesScroll: number;
    };
    check('390px 长缓存切回不横向溢出', mobileLayout.doc <= mobileLayout.view + 1, mobileLayout);
    check(
      '390px 长缓存切回消息区不横向溢出',
      mobileLayout.messagesScroll <= mobileLayout.messagesClient + 1,
      mobileLayout,
    );
  } finally {
    await context.close();
  }
}

/** 会话列表分片验收：首屏 50、失败重试、滚动/按钮加载剩余房间且 active 不重置。 */
async function runRoomListPaginationAcceptance(
  browser: Browser,
  base: string,
  allErrors: string[],
  agentAToken: string,
  agentA: Actor,
): Promise<void> {
  const humanToken = crypto.randomUUID();
  await rawTool<Actor>(humanToken, 'network_register', {
    request_id: requestId('web_reg'),
    kind: 'human',
    name: '会话分页验收人类',
  });
  await rawBefriend(humanToken, agentAToken, { actor_id: agentA.actor_id });
  let createdRooms = 0;
  for (let index = 1; index <= 55; index += 1) {
    await rawTool<RoomDetail>(humanToken, 'network_room_create', {
      request_id: requestId('room'),
      kind: 'group',
      title: `分页会话 ${String(index).padStart(2, '0')}`,
      members: [agentA.actor_id],
    });
    createdRooms += 1;
  }
  checkEqual('会话分页 fixture 创建 55 个房间', createdRooms, 55);
  const firstPage = await rawTool<{
    items: { room_id: string; title?: string }[];
  }>(humanToken, 'network_rooms_list', { limit: 50 });
  const activeRoomId = firstPage.items[0]!.room_id;
  const activeTitle = firstPage.items[0]!.title ?? '';

  const { context, page } = await makeContext(
    browser,
    humanToken,
    { width: 1280, height: 900 },
    allErrors,
  );
  try {
    await page.goto(`${base}/c/${activeRoomId}`);
    await waitRoom(page, activeRoomId, activeTitle);
    if ((await page.locator('#room-filter-group').getAttribute('aria-selected')) !== 'true') {
      await page.locator('#room-filter-group').click();
    }
    await waitUntil(
      async () => (await page.locator('#room-list .room-item').count()) === 50,
      '会话列表首屏 50 条',
      20_000,
    );
    const firstPageArgs = (await page.evaluate(`(window.__mcpCalls || [])
      .filter(function (call) { return call.name === 'network_rooms_list'; })
      .map(function (call) {
        return call.body && call.body.params ? call.body.params.arguments : null;
      })`)) as ({ limit?: number; cursor?: string } | null)[];
    checkEqual('会话列表首屏只请求一页', firstPageArgs.length, 1);
    checkEqual('会话列表首屏请求 50 条', firstPageArgs[0]?.limit, 50);
    check('会话列表首屏不带游标', !firstPageArgs[0]?.cursor);
    checkEqual(
      '分页前 active 会话正确',
      await page.locator('#room-list .room-item.active').getAttribute('data-room-id'),
      activeRoomId,
    );

    let failNextPage = true;
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as {
        params?: { arguments?: { cursor?: string } };
      } | null;
      if (
        failNextPage &&
        request.headers()['mcp-name'] === 'network_rooms_list' &&
        body?.params?.arguments?.cursor
      ) {
        failNextPage = false;
        await route.abort();
        return;
      }
      await route.continue();
    });
    await page.evaluate(`(() => {
      const scroller = document.querySelector('.sidebar-list');
      scroller.scrollTop = scroller.scrollHeight;
    })()`);
    await waitUntil(
      async () =>
        ((await page.locator('#room-list-more').textContent()) ?? '').includes('加载更多失败'),
      '会话列表分页失败可读',
      10_000,
    );
    checkEqual(
      '分页失败后保留已加载的 50 条',
      await page.locator('#room-list .room-item').count(),
      50,
    );
    checkEqual(
      '分页失败后 active 会话不重置',
      await page.locator('#room-list .room-item.active').getAttribute('data-room-id'),
      activeRoomId,
    );
    await page.unroute('**/mcp');
    await page.evaluate(`document.getElementById('room-list-more').click()`);
    await waitUntil(
      async () => (await page.locator('#room-list .room-item').count()) === 55,
      '重试后加载全部 55 个会话',
      20_000,
    );
    const roomCalls = (await page.evaluate(`(window.__mcpCalls || [])
      .filter(function (call) { return call.name === 'network_rooms_list'; })
      .map(function (call) {
        return call.body && call.body.params ? call.body.params.arguments : null;
      })`)) as ({ limit?: number; cursor?: string } | null)[];
    check('会话列表分页发生两次请求', roomCalls.length >= 2, roomCalls.length);
    check(
      '会话列表下一页携带游标',
      typeof roomCalls[1]?.cursor === 'string' && roomCalls[1]!.cursor!.length > 0,
      roomCalls[1],
    );
    checkEqual('会话列表下一页仍请求 50 条', roomCalls[1]?.limit, 50);
    const roomIds = (await page.evaluate(`(() => {
      return Array.from(document.querySelectorAll('#room-list .room-item'))
        .map(function (item) { return item.dataset.roomId; });
    })()`)) as string[];
    checkEqual('会话列表分页后无重复', new Set(roomIds).size, roomIds.length);
    checkEqual('会话列表分页后共 55 个', roomIds.length, 55);
    checkEqual(
      '加载更多后 active 会话不变',
      await page.locator('#room-list .room-item.active').getAttribute('data-room-id'),
      activeRoomId,
    );
    checkEqual(
      '加载更多后聊天标题不变',
      (await page.locator('#title').textContent())?.trim(),
      activeTitle,
    );
    checkEqual(
      '会话列表到底显示可读状态',
      (await page.locator('#room-list-more').textContent())?.trim(),
      '已加载全部会话',
    );
    checkEqual('会话列表到底按钮禁用', await page.locator('#room-list-more').isDisabled(), true);

    const mobile = await makeContext(
      browser,
      humanToken,
      { width: 390, height: 844 },
      allErrors,
    );
    try {
      await mobile.page.goto(`${base}/`);
      await mobile.page.locator('#room-filter-group').click();
      await waitUntil(
        async () => (await mobile.page.locator('#room-list .room-item').count()) === 50,
        '390px 会话列表首屏 50 条',
        20_000,
      );
      const beforeMetrics = (await mobile.page.evaluate(`(() => {
        return {
          view: window.innerWidth,
          doc: document.documentElement.scrollWidth,
          list: document.getElementById('room-list').scrollWidth,
          sidebar: document.querySelector('.sidebar').clientWidth
        };
      })()`)) as { view: number; doc: number; list: number; sidebar: number };
      check(
        '390px 会话列表首屏不横向溢出',
        beforeMetrics.doc <= beforeMetrics.view + 1 &&
          beforeMetrics.list <= beforeMetrics.sidebar + 1,
        beforeMetrics,
      );
      await mobile.page.evaluate(`document.getElementById('room-list-more').click()`);
      await waitUntil(
        async () => (await mobile.page.locator('#room-list .room-item').count()) === 55,
        '390px 会话列表分页后 55 条',
        20_000,
      );
      const afterMetrics = (await mobile.page.evaluate(`(() => {
        return {
          view: window.innerWidth,
          doc: document.documentElement.scrollWidth,
          list: document.getElementById('room-list').scrollWidth,
          sidebar: document.querySelector('.sidebar').clientWidth
        };
      })()`)) as { view: number; doc: number; list: number; sidebar: number };
      check(
        '390px 会话列表分页后不横向溢出',
        afterMetrics.doc <= afterMetrics.view + 1 &&
          afterMetrics.list <= afterMetrics.sidebar + 1,
        afterMetrics,
      );
    } finally {
      await mobile.context.close();
    }
  } finally {
    await context.close();
  }
}

/**
 * 新服务端冷启动：50 个 direct 会话只发 1 次 rooms_list、0 次 room_get。
 *
 * 同时验证列表摘要直接提供名称/类型/在线/归档，旧服务端路径由主流程的
 * 兼容用例覆盖。
 */
async function runRoomListPeerSummaryAcceptance(
  browser: Browser,
  base: string,
  allErrors: string[],
): Promise<void> {
  const humanToken = crypto.randomUUID();
  const human = await rawTool<Actor>(humanToken, 'network_register', {
    request_id: requestId('web_peer_human'),
    kind: 'human',
    name: '50 单聊冷启动用户',
  });
  const agentNames: string[] = [];
  const roomIds: string[] = [];
  let firstAgentId = '';
  for (let index = 0; index < 50; index += 1) {
    const name = `冷启动 Agent ${String(index + 1).padStart(2, '0')}`;
    const agent = await rawTool<Actor>(humanToken, 'network_agent_create', {
      request_id: requestId('web_peer_agent'),
      name,
    });
    const room = await rawTool<{ room: { room_id: string } }>(
      humanToken,
      'network_room_create',
      {
        request_id: requestId('web_peer_room'),
        kind: 'direct',
        members: [agent.actor_id],
      },
    );
    agentNames.push(name);
    roomIds.push(room.room.room_id);
    if (index === 0) firstAgentId = agent.actor_id;
  }
  const rawPage = await rawTool<{
    items: {
      room_id: string;
      kind: string;
      peer?: { actor_id: string; name: string; kind: string; online: boolean | null } | null;
      peer_archived?: boolean;
    }[];
  }>(humanToken, 'network_rooms_list', { limit: 100 });
  checkEqual('50 单聊直接返回 50 条摘要', rawPage.items.length, 50);
  check(
    '每条 direct 摘要含对端名称/类型/在线',
    rawPage.items.every(
      (item) =>
        item.kind === 'direct' &&
        item.peer &&
        item.peer.kind === 'agent' &&
        typeof item.peer.name === 'string' &&
        item.peer.name.length > 0 &&
        typeof item.peer.online === 'boolean' &&
        item.peer_archived === false,
    ),
    rawPage.items.slice(0, 2),
  );
  checkEqual(
    '50 条摘要名称与创建的 Agent 一致',
    new Set(rawPage.items.map((item) => item.peer?.name)).size,
    50,
  );
  check(
    '摘要包含全部创建的 room_id',
    roomIds.every((roomId) => rawPage.items.some((item) => item.room_id === roomId)),
  );

  const { context, page } = await makeContext(
    browser,
    humanToken,
    { width: 1280, height: 800 },
    allErrors,
  );
  try {
    // 在文档启动前选中 Agent 分类，避免用额外刷新污染冷启动请求计数。
    await context.addInitScript(
      `try { localStorage.setItem('agent-network-room-filter', 'agent'); } catch (error) {}`,
    );
    await page.goto(`${base}/`);
    await waitUntil(
      async () => (await page.locator('#room-list .room-item').count()) === 50,
      '50 个 direct 首屏一次渲染',
      20_000,
    );
    const roomListCalls = (await page.evaluate(`(window.__mcpCalls || [])
      .filter(function (call) { return call.name === 'network_rooms_list'; })
      .map(function (call) {
        return call.body && call.body.params ? call.body.params.arguments : null;
      })`)) as ({ limit?: number; cursor?: string } | null)[];
    checkEqual('50 个 direct 冷启动只请求一次 rooms_list', roomListCalls.length, 1);
    check('冷启动 rooms_list 不带游标', !roomListCalls[0]?.cursor);
    checkEqual('50 个 direct 冷启动不逐房间 room_get', await mcpCallCount(page, 'network_room_get'), 0);
    check(
      '列表直接显示对端名称而非单聊占位',
      (await page.locator('#room-list .room-name').allTextContents()).every(
        (name) => name !== '单聊' && name.includes('冷启动 Agent'),
      ),
      (await page.locator('#room-list .room-name').allTextContents()).slice(0, 3),
    );
    checkEqual(
      '列表条目类型为 direct',
      (await page.evaluate(
        `Array.from(document.querySelectorAll('#room-list .room-item')).every(function (item) {
          return item.dataset.roomKind === 'direct';
        })`,
      )) as boolean,
      true,
    );

    await rawTool(humanToken, 'network_agent_archive', {
      request_id: requestId('web_peer_archive'),
      actor_id: firstAgentId,
    });
    const archivedPage = await rawTool<{
      items: { room_id: string; peer_archived?: boolean }[];
    }>(humanToken, 'network_rooms_list', { limit: 100 });
    checkEqual(
      'rooms_list peer_archived 反映归档状态',
      archivedPage.items.find((item) => item.room_id === roomIds[0])?.peer_archived,
      true,
    );
    checkEqual('归档不影响其余摘要条数', archivedPage.items.length, 50);
  } finally {
    await context.close();
  }
}

/** 身份就绪后好友角标必须真实发一次请求，而不是等待提前返回的 Promise。 */
async function runIdentityReadyBadgeAcceptance(
  browser: Browser,
  base: string,
  allErrors: string[],
): Promise<void> {
  const targetToken = crypto.randomUUID();
  const target = await rawTool<Actor>(targetToken, 'network_register', {
    request_id: requestId('web_badge_target'),
    kind: 'human',
    name: '角标验收用户',
  });
  const requesterToken = crypto.randomUUID();
  const requester = await rawTool<Actor>(requesterToken, 'network_register', {
    request_id: requestId('web_badge_requester'),
    kind: 'human',
    name: '角标验收申请人',
  });
  await rawTool(requesterToken, 'network_contact_request', {
    request_id: requestId('web_badge_request'),
    actor_id: target.actor_id,
  });
  const { context, page } = await makeContext(
    browser,
    targetToken,
    { width: 1280, height: 800 },
    allErrors,
  );
  try {
    await page.goto(`${base}/`);
    await page.waitForFunction(
      `(() => {
        const badge = document.getElementById('contact-requests-badge');
        return Boolean(badge && !badge.hidden && badge.textContent === '1');
      })()`,
    );
    const calls = (await page.evaluate(`(window.__mcpCalls || []).map(function (call) {
      return call.name || call.method;
    })`)) as string[];
    const meIndex = calls.indexOf('network_me');
    const badgeIndex = calls.indexOf('network_contact_requests_list');
    check('身份确认后发出好友角标请求', badgeIndex >= 0, calls);
    check('好友角标请求发生在身份确认之后', meIndex >= 0 && meIndex < badgeIndex, calls);
    checkEqual(
      '初始化只发一次好友角标请求',
      calls.filter((name) => name === 'network_contact_requests_list').length,
      1,
    );
    check('身份就绪同时启动会话列表', calls.includes('network_rooms_list'), calls);
  } finally {
    await context.close();
  }
}

/** 普通 RPC 的截止时间覆盖响应头之后的正文读取。 */
async function runRpcBodyDeadlineAcceptance(
  browser: Browser,
  base: string,
  allErrors: string[],
): Promise<void> {
  const token = crypto.randomUUID();
  await rawTool<Actor>(token, 'network_register', {
    request_id: requestId('web_rpc_timeout'),
    kind: 'human',
    name: 'RPC 正文超时用户',
  });
  const { context, page } = await makeContext(
    browser,
    token,
    { width: 1280, height: 800 },
    allErrors,
  );
  try {
    await page.goto(`${base}/`);
    await page.waitForFunction(`document.getElementById('account-name').textContent === 'RPC 正文超时用户'`);
    await page.evaluate(`(() => {
      const originalFetch = window.fetch;
      window.__stalledBodySignal = null;
      window.fetch = function (input, init) {
        const body = init && init.body ? JSON.parse(init.body) : null;
        if (body && body.params && body.params.name === 'network_me') {
          window.__stalledBodySignal = init && init.signal;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: function () {
              return new Promise(function (resolve, reject) {
                if (init.signal) {
                  init.signal.addEventListener('abort', function () {
                    const error = new Error('aborted');
                    error.name = 'AbortError';
                    reject(error);
                  }, { once: true });
                }
              });
            }
          });
        }
        return originalFetch(input, init);
      };
    })()`);
    const startedAt = Date.now();
    const outcome = (await page.evaluate(`(async function () {
      try {
        await window.callTool('network_me', {});
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          name: error && error.name,
          code: error && error.code,
          message: error && error.message,
          aborted: Boolean(window.__stalledBodySignal && window.__stalledBodySignal.aborted)
        };
      }
    })()`)) as {
      ok: boolean;
      name?: string;
      code?: string;
      message?: string;
      aborted?: boolean;
    };
    const elapsed = Date.now() - startedAt;
    check('正文停住时普通 RPC 不会成功返回', outcome.ok === false, outcome);
    checkEqual('正文停住返回可识别超时错误', outcome.name, 'TimeoutError');
    checkEqual('超时错误码可识别', outcome.code, 'TIMEOUT');
    check('超时提示可读', (outcome.message ?? '').includes('请求超时'), outcome.message);
    check('总截止时间到达后中止底层请求', outcome.aborted === true, outcome);
    check(
      '正文停住不会无限等待',
      elapsed >= 14_500 && elapsed < 20_000,
      elapsed,
    );
  } finally {
    await context.close();
  }
}

/**
 * 引用块布局：消息内引用位于正文下方、长文本两行截断、暗色可读；输入框引用条位于输入框上方。
 */
async function runQuoteReferenceAcceptance(
  browser: Browser,
  base: string,
  allErrors: string[],
): Promise<void> {
  console.log('· 引用块布局与可读性');
  const humanToken = crypto.randomUUID();
  await rawTool<Actor>(humanToken, 'network_register', {
    request_id: requestId('quote_human'),
    kind: 'human',
    name: '引用验收人类',
  });
  const agentToken = `ank_${crypto.randomUUID().replaceAll('-', '')}`;
  const agent = await rawTool<Actor>(agentToken, 'network_register', {
    request_id: requestId('quote_agent'),
    kind: 'agent',
    name: '引用验收 Agent',
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  await rawBefriend(humanToken, agentToken, { actor_id: agent.actor_id });
  const room = await rawTool<RoomDetail>(humanToken, 'network_room_create', {
    request_id: requestId('quote_room'),
    kind: 'direct',
    members: [agent.actor_id],
  });
  const roomId = room.room.room_id;
  const targetBody = '引用目标消息：' + '这是一段用于验证两行截断的长文本。'.repeat(12);
  const target = await rawTool<{ message: { message_id: string } }>(
    agentToken,
    'network_message_send',
    {
      request_id: requestId('quote_target'),
      client_message_id: crypto.randomUUID(),
      room_id: roomId,
      body: targetBody,
    },
  );
  const reply = await rawTool<{ message: { message_id: string } }>(
    humanToken,
    'network_message_send',
    {
      request_id: requestId('quote_reply'),
      client_message_id: crypto.randomUUID(),
      room_id: roomId,
      body: '引用布局验收正文',
      reply_to: target.message.message_id,
    },
  );
  const { context, page } = await makeContext(
    browser,
    humanToken,
    { width: 1280, height: 800 },
    allErrors,
  );
  try {
    await page.goto(`${base}/c/${roomId}`);
    const replyNode = page.locator(
      `#messages .msg[data-message-id="${reply.message.message_id}"]`,
    );
    await replyNode.waitFor();
    const layout = (await replyNode.evaluate((node) => {
      const content = node.querySelector('.msg-content');
      const bubble = content ? content.querySelector('.bubble') : null;
      const quote = content ? content.querySelector('.reply-reference') : null;
      if (!content || !bubble || !quote) return null;
      const children = Array.from(content.children);
      const style = getComputedStyle(quote);
      return {
        quoteIndex: children.indexOf(quote),
        bubbleIndex: children.indexOf(bubble),
        text: quote.textContent || '',
        lineClamp: style.webkitLineClamp,
        overflow: style.overflow,
        textOverflow: style.textOverflow,
        clientHeight: quote.clientHeight,
        scrollHeight: quote.scrollHeight,
      };
    })) as {
      quoteIndex: number;
      bubbleIndex: number;
      text: string;
      lineClamp: string;
      overflow: string;
      textOverflow: string;
      clientHeight: number;
      scrollHeight: number;
    } | null;
    check(
      '引用节点位于正文之后',
      Boolean(layout && layout.quoteIndex > layout.bubbleIndex && layout.bubbleIndex >= 0),
      layout,
    );
    checkEqual(
      '引用紧贴正文下方',
      layout ? layout.quoteIndex : -1,
      layout ? layout.bubbleIndex + 1 : -2,
    );
    check('引用显示原消息摘要', Boolean(layout && layout.text.includes('引用目标消息')), layout?.text);
    checkEqual('引用最多两行', layout?.lineClamp, '2');
    checkEqual('引用隐藏溢出', layout?.overflow, 'hidden');
    checkEqual('引用使用省略号', layout?.textOverflow, 'ellipsis');
    check('长引用发生截断', Boolean(layout && layout.scrollHeight > layout.clientHeight), layout);

    const targetNode = page.locator(
      `#messages .msg[data-message-id="${target.message.message_id}"]`,
    );
    await targetNode.scrollIntoViewIfNeeded();
    await targetNode.getByRole('button', { name: '消息操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '引用', exact: true }).click();
    await page.locator('#composer-reply').waitFor();
    const composerLayout = (await page.evaluate(`(() => {
      const bar = document.getElementById('composer-reply');
      const body = document.getElementById('body');
      const label = bar ? bar.querySelector('span') : null;
      if (!bar || !body || !label) return null;
      const barBox = bar.getBoundingClientRect();
      const bodyBox = body.getBoundingClientRect();
      return {
        parentClass: bar.parentElement ? bar.parentElement.className : '',
        barBottom: barBox.bottom,
        bodyTop: bodyBox.top,
        labelScrollWidth: label.scrollWidth,
        labelClientWidth: label.clientWidth,
      };
    })()`)) as {
      parentClass: string;
      barBottom: number;
      bodyTop: number;
      labelScrollWidth: number;
      labelClientWidth: number;
    } | null;
    check(
      '输入框引用条位于输入框上方',
      Boolean(
        composerLayout &&
          composerLayout.parentClass.includes('composer-main') &&
          composerLayout.barBottom <= composerLayout.bodyTop + 1,
      ),
      composerLayout,
    );
    check(
      '输入框引用条长文本单行截断',
      Boolean(
        composerLayout && composerLayout.labelScrollWidth > composerLayout.labelClientWidth,
      ),
      composerLayout,
    );
    await page.locator('#composer-reply button').click();

    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(`matchMedia('(prefers-color-scheme: dark)').matches`);
    const dark = (await replyNode.locator('.reply-reference').evaluate((node) => {
      const style = getComputedStyle(node);
      return { color: style.color, background: style.backgroundColor };
    })) as { color: string; background: string };
    check(
      '暗色引用文字与底色保持可读对比',
      contrastRatio(dark.color, dark.background) >= 3,
      dark,
    );

    await replyNode.locator('.reply-reference').click();
    const dialog = page.getByRole('dialog', { name: '查看上下文' });
    await dialog.waitFor();
    await dialog.getByText('引用目标消息', { exact: false }).first().waitFor();
    check('点击引用打开原消息上下文', await dialog.isVisible());
    await page.getByRole('button', { name: '关闭上下文' }).click();
  } finally {
    await context.close();
  }
}

/**
 * Phase 3 可访问性验收：原生 dialog 焦点陷阱、Esc/背板关闭、焦点恢复，
 * 以及 Promise 版 confirmDialog 的确认/取消/危险色/IME 键盘行为。
 */
async function runDialogAccessibilityAcceptance(
  browser: Browser,
  base: string,
  token: string,
  allErrors: string[],
): Promise<void> {
  const { context, page } = await makeContext(
    browser,
    token,
    { width: 1280, height: 800 },
    allErrors,
  );
  try {
    await page.goto(`${base}/`);
    const opener = page.locator('#new-group');
    await opener.waitFor();
    await opener.focus();
    await opener.click();
    const groupDialog = page.locator('#group-modal');
    await groupDialog.waitFor({ state: 'visible' });
    checkEqual(
      '建群弹窗使用原生 dialog',
      await groupDialog.evaluate((node) => node.tagName),
      'DIALOG',
    );
    checkEqual(
      '建群弹窗以模态方式打开',
      await groupDialog.evaluate((node: HTMLDialogElement) => node.open),
      true,
    );
    const focusInsideGroup = (): Promise<boolean> =>
      page.evaluate(
        `(() => {
          const dialog = document.getElementById('group-modal');
          return Boolean(dialog && dialog.contains(document.activeElement));
        })()`,
      );
    check('建群弹窗打开后焦点进入内部', await focusInsideGroup());
    for (let index = 0; index < 20; index += 1) await page.keyboard.press('Tab');
    check('Tab 不逃逸建群弹窗', await focusInsideGroup());
    for (let index = 0; index < 20; index += 1) await page.keyboard.press('Shift+Tab');
    check('Shift+Tab 不逃逸建群弹窗', await focusInsideGroup());
    await page.keyboard.press('Escape');
    await groupDialog.waitFor({ state: 'hidden' });
    checkEqual(
      'Esc 关闭建群弹窗后焦点回到触发按钮',
      await page.evaluate('document.activeElement ? document.activeElement.id : ""'),
      'new-group',
    );

    await opener.click();
    await groupDialog.waitFor({ state: 'visible' });
    const groupBox = await groupDialog.boundingBox();
    await page.mouse.click((groupBox?.x ?? 0) + 3, (groupBox?.y ?? 0) + 3);
    await groupDialog.waitFor({ state: 'hidden' });
    check('点击背板关闭建群弹窗', true);

    // confirmDialog 直接调用：确认/取消、危险色、焦点与 IME。
    await page.evaluate(`(() => {
      window.__confirmResult = null;
      document.getElementById('new-group').focus();
      confirmDialog('危险操作文案', {
        title: '危险确认',
        danger: true,
        confirmText: '执行'
      }).then(function (value) { window.__confirmResult = value; });
    })()`);
    const confirm = page.locator('#confirm-dialog[open]');
    await confirm.waitFor();
    checkEqual(
      '确认框使用统一标题',
      await confirm.locator('#confirm-dialog-title').textContent(),
      '危险确认',
    );
    checkEqual(
      '确认框使用调用方按钮文案',
      await confirm.locator('[data-confirm-ok]').textContent(),
      '执行',
    );
    checkEqual(
      '危险确认使用统一危险色',
      await confirm.locator('[data-confirm-ok]').evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      ),
      'rgb(192, 57, 43)',
    );
    check(
      '确认框默认聚焦取消按钮',
      await page.evaluate(
        `document.activeElement === document.querySelector('#confirm-dialog [data-confirm-cancel]')`,
      ),
    );
    for (let index = 0; index < 10; index += 1) await page.keyboard.press('Tab');
    check(
      'Tab 不逃逸确认框',
      await page.evaluate(
        `(() => {
          const dialog = document.getElementById('confirm-dialog');
          return Boolean(dialog && dialog.contains(document.activeElement));
        })()`,
      ),
    );
    await confirm.locator('[data-confirm-cancel]').click();
    await page.waitForFunction('window.__confirmResult === false');
    checkEqual('取消返回 false', await page.evaluate('window.__confirmResult'), false);
    checkEqual(
      '取消后焦点回到触发按钮',
      await page.evaluate('document.activeElement ? document.activeElement.id : ""'),
      'new-group',
    );

    await page.evaluate(`(() => {
      window.__confirmResult = null;
      confirmDialog('二次确认').then(function (value) { window.__confirmResult = value; });
    })()`);
    await confirm.waitFor();
    await confirm.locator('[data-confirm-ok]').click();
    await page.waitForFunction('window.__confirmResult === true');
    checkEqual('确认返回 true', await page.evaluate('window.__confirmResult'), true);

    await page.evaluate(`(() => {
      window.__confirmResult = null;
      confirmDialog('输入法测试').then(function (value) { window.__confirmResult = value; });
    })()`);
    await confirm.waitFor();
    await page.evaluate(`(() => {
      document.getElementById('confirm-dialog').dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', isComposing: true, bubbles: true
      }));
    })()`);
    checkEqual(
      'IME 组合期间 Esc 不关闭确认框',
      await page.evaluate(`document.getElementById('confirm-dialog').open`),
      true,
    );
    await page.keyboard.press('Escape');
    await page.waitForFunction('window.__confirmResult === false');
    checkEqual('普通 Esc 取消确认', await page.evaluate('window.__confirmResult'), false);

    await page.evaluate(`(() => {
      window.__confirmResult = null;
      confirmDialog('背板测试').then(function (value) { window.__confirmResult = value; });
    })()`);
    await confirm.waitFor();
    await page.mouse.click(2, 2);
    await page.waitForFunction('window.__confirmResult === false');
    checkEqual('点击确认框背板返回 false', await page.evaluate('window.__confirmResult'), false);
  } finally {
    await context.close();
  }
}

async function main(): Promise<void> {
  await runFileTicketSecretChecks();
  const server = await startServer();
  process.env.AGENTNET_URL = server.base;
  let browser: Browser | null = null;
  const allErrors: string[] = [];
  try {
    const data = await fixture(server.dataDir);
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });
    console.log(`浏览器验收: ${server.base}`);

    // 1. Home：React 壳、会话列表、搜索/分类、好友申请、建群与单订阅。
    {
      const { context, page } = await makeContext(
        browser,
        data.humanToken,
        { width: 1280, height: 800 },
        allErrors,
      );
      await page.goto(`${server.base}/`);
      await page.locator('#room-filter-agent').click();
      await waitRoomListName(page, data.agentA.name);
      checkEqual('首页由 React 壳渲染', await page.locator('body').getAttribute('data-spa-route'), 'home');
      checkEqual('桌面首页显示侧栏', await page.locator('.sidebar').isVisible(), true);
      checkEqual('首页显示空状态', await page.locator('#empty-state').isVisible(), true);
      checkEqual('账号名来自 network_me', await page.locator('#account-name').textContent(), data.human.name);
      await waitRoomListName(page, data.agentB.name);
      const homeListens = (await page.evaluate(`(() => {
        return (window.__mcpCalls || []).filter(function (call) {
          return call.method === 'subscriptions/listen';
        }).length;
      })()`)) as number;
      check('首页只有一条 subscriptions/listen', homeListens === 1, homeListens);

      await page.fill('#room-search', '不存在的会话');
      await page.locator('#room-list-status').waitFor({ state: 'visible' });
      checkEqual(
        '搜索无匹配显示空态',
        (await page.locator('#room-list-status').textContent())?.trim(),
        '没有匹配的会话',
      );
      await page.press('#room-search', 'Escape');
      checkEqual('Escape 清空搜索', await page.locator('#room-search').inputValue(), '');

      await page.locator('#room-filter-agent').click();
      check(
        'Agent 分类只显示 direct Agent 会话',
        (await page.locator('#room-list .room-item[data-room-kind="direct"]').count()) >= 1,
      );
      checkEqual('Agent 分类不含群聊', await page.locator('#room-list .room-item[data-room-kind="group"]').count(), 0);
      await page.locator('#room-filter-group').click();
      check('群聊分类只显示群聊', (await page.locator('#room-list .room-item[data-room-kind="group"]').count()) >= 1);
      check(
        '会话列表包含群聊',
        (await page.locator('#room-list .room-item[data-room-kind="group"]').count()) >= 1,
      );
      await page.locator('#room-filter-friend').click();
      checkEqual('好友分类不误报 Agent 会话', await page.locator('#room-list .room-item').count(), 0);
      await page.locator('#room-filter-agent').click();

      // 好友申请收件箱：React 只渲染申请列表；接受后列表刷新。
      await page.locator('#contact-requests').click();
      await page.locator('#contact-modal').waitFor({ state: 'visible' });
      checkEqual('好友申请弹窗可打开', await page.locator('#contact-modal').isVisible(), true);
      await page.locator('#contact-modal-close').click();
      await page.locator('#contact-modal').waitFor({ state: 'hidden' });

      // 建群：从好友候选选择成员，成功后跳到新会话。
      await page.locator('#new-group').click();
      await page.locator('#group-modal').waitFor({ state: 'visible' });
      await page.locator('#group-contacts .spa-combobox-item').first().waitFor();
      const selectedBefore = await page.locator('#group-selection .spa-chip').count();
      await page.locator('#group-contacts .spa-combobox-item').first().click();
      checkEqual('建群选择成员写入已选区', await page.locator('#group-selection .spa-chip').count(), selectedBefore + 1);
      await page.fill('#group-name-input', 'React 建群验收');
      await page.locator('#group-create').click();
      await page.waitForFunction('location.pathname.startsWith("/c/")');
      await waitRoom(page, decodeURIComponent(new URL(page.url()).pathname.slice(3)), 'React 建群验收');
      check(
        '建群后进入 React Chat',
        (await page.locator('body').getAttribute('data-spa-route')) === 'room',
      );

      await context.close();
    }

    // 2. Chat：发送、IME、引用、Markdown、更早历史与返回首页。
    {
      const roomId = data.direct.room.room_id;
      const { context, page } = await makeContext(
        browser,
        data.humanToken,
        { width: 1280, height: 900 },
        allErrors,
      );
      await page.goto(`${server.base}/c/${roomId}`);
      await waitRoom(page, roomId, data.agentA.name);
      const listens = (await page.evaluate(`(() => {
        return (window.__mcpCalls || []).filter(function (call) {
          return call.method === 'subscriptions/listen';
        }).length;
      })()`)) as number;
      check('Chat 页只有一条 subscriptions/listen', listens === 1, listens);
      checkEqual('聊天页由 React 壳渲染', await page.locator('body').getAttribute('data-spa-route'), 'room');
      checkEqual('聊天页桌面保留返回入口', await page.locator('#back').isVisible(), true);
      check('首屏加载消息', (await page.locator('#messages .msg').count()) >= 10);

      // 中文输入法组合期间 Enter 不发送；组合结束后的 Enter 发送。
      await page.locator('#body').click();
      await page.locator('#body').fill('组合中的中文');
      await page.evaluate(`(() => {
        const input = document.getElementById('body');
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, bubbles: true }));
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      })()`);
      await sleep(120);
      checkEqual('IME 组合期间 Enter 不发送', await page.locator('#body').inputValue(), '组合中的中文');
      await page.locator('#body').fill('React 发送验收');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('第二行');
      checkEqual(
        'Shift+Enter 保留换行',
        (await page.locator('#body').inputValue()).includes('\n'),
        true,
      );
      await page.locator('#send').click();
      await waitForMessageText(page, 'React 发送验收');

      // 引用：消息操作菜单 -> 引用；引用块显示原消息摘要。
      const target = page.locator('#messages .msg').first();
      const targetId = await target.getAttribute('data-message-id');
      await target.getByRole('button', { name: '消息操作', exact: true }).click();
      await page.locator('#message-action-quote').click();
      await page.locator('#composer-reply').waitFor({ state: 'visible' });
      await page.locator('#body').fill('React 引用验收');
      await page.locator('#send').click();
      const quoted = page.locator('#messages .msg').filter({ hasText: 'React 引用验收' });
      await quoted.locator('.reply-reference').waitFor();
      check('引用写入 reply_to', targetId !== null);
      check(
        '成功后清除引用条',
        await page.locator('#composer-reply').isHidden(),
      );

      // Agent Markdown：复用 /assets/chat-markdown.js，脚本被清洗。
      const markdown = '**安全 Markdown** <img src=x onerror=alert(1)> [链接](javascript:alert(1))';
      await rawTool(data.agentAToken, 'network_message_send', {
        request_id: requestId('msg'),
        client_message_id: crypto.randomUUID(),
        room_id: roomId,
        body: markdown,
        invoke: [],
      });
      await page.locator('#messages .msg-markdown strong').first().waitFor({ timeout: 15_000 });
      check('Agent Markdown 渲染粗体', (await page.locator('#messages .msg-markdown strong').count()) >= 1);
      checkEqual('Markdown 不渲染 img 标签', await page.locator('#messages .msg-markdown img').count(), 0);

      // 更早历史：首屏之后可继续请求。
      const older = page.locator('#messages #older');
      if (await older.count()) {
        const before = await page.locator('#messages .msg').count();
        await older.click();
        await waitUntil(
          async () => (await page.locator('#messages .msg').count()) > before,
          '加载更早消息',
        );
        check('加载更早消息追加到时间线', (await page.locator('#messages .msg').count()) > before);
      }

      await page.locator('#back').click();
      await page.locator('body[data-spa-route="home"]').waitFor();
      check('返回首页', page.url().endsWith('/'));
      await context.close();
    }

    // 3. 文件面板：真实上传、列表、预览与删除。
    {
      const roomId = data.extra.room.room_id;
      const { context, page } = await makeContext(
        browser,
        data.humanToken,
        { width: 1440, height: 900 },
        allErrors,
      );
      await page.addInitScript(() => {
        localStorage.setItem('agent-network-files-open', '1');
      });
      await page.goto(`${server.base}/c/${roomId}`);
      await waitRoom(page, roomId, data.agentB.name);
      await page.locator('#files-pane').waitFor({ state: 'visible' });
      await page.setInputFiles('#files-input', [
        { name: 'react-file.txt', mimeType: 'text/plain', buffer: Buffer.from('react file') },
      ]);
      await waitForText(page, '#files-list', 'react-file.txt');
      check('文件上传后出现在列表', true);
      await page
        .locator('#files-list .file-item')
        .filter({ hasText: 'react-file.txt' })
        .getByRole('button', { name: '预览', exact: true })
        .click();
      await page.locator('#file-preview').waitFor({ state: 'visible' });
      check('文件可预览', await page.locator('#file-preview').isVisible());
      await page.locator('#file-preview-close').click();
      checkEqual('关闭预览', await page.locator('#file-preview').isHidden(), true);
      await page.locator('#files-close').click();
      checkEqual('关闭文件面板', await page.locator('#files-pane').isHidden(), true);
      await context.close();
    }

    // 4. 网页监控：保存地址、iframe 加载与互斥。
    {
      const roomId = data.extra.room.room_id;
      const { context, page } = await makeContext(
        browser,
        data.humanToken,
        { width: 1440, height: 900 },
        allErrors,
      );
      await page.goto(`${server.base}/c/${roomId}`);
      await waitRoom(page, roomId, data.agentB.name);
      await page.locator('#monitor-toggle').click();
      await page.locator('#monitor-pane').waitFor({ state: 'visible' });
      await page.locator('#monitor-empty').waitFor({ state: 'visible' });
      await page.fill('#monitor-url', `${server.base}/health`);
      await page.locator('#monitor-save').click();
      await page.waitForFunction(
        `(() => { const frame = document.getElementById('monitor-frame'); return frame && !frame.hidden && frame.src.includes('/health'); })()`,
      );
      check('监控保存后 iframe 指向配置地址', true);
      await page.locator('#monitor-close').click();
      checkEqual('关闭监控面板', await page.locator('#monitor-pane').isHidden(), true);
      await context.close();
    }

    // 5. 账号入口：Memory、已归档、新建 Agent、配对与退出登录。
    {
      const { context, page } = await makeContext(
        browser,
        data.humanToken,
        { width: 1280, height: 900 },
        allErrors,
        true,
        true,
      );
      await page.goto(`${server.base}/`);
      await page.locator('#room-filter-agent').click();
      await waitRoomListName(page, data.agentA.name);

      await page.locator('#account-menu-toggle').click();
      await page.locator('#memory-open').click();
      await page.locator('#memory-drawer').waitFor({ state: 'visible' });
      check('Memory 抽屉可打开', await page.locator('#memory-drawer').isVisible());
      await page.locator('#memory-close').click();

      await page.locator('#account-menu-toggle').click();
      await page.locator('#archived-agents').click();
      await page.locator('#archive-popover').waitFor({ state: 'visible' });
      check('已归档 Agents 浮层可打开', await page.locator('#archive-popover').isVisible());
      await page.locator('#archive-popover-close').click();

      await page.locator('#account-menu-toggle').click();
      await page.locator('#device-handoff').click();
      await page.locator('#handoff-modal').waitFor({ state: 'visible' });
      await page.locator('#pairing-qr-wrap').waitFor({ state: 'visible' });
      check('配对弹窗显示二维码与短码', await page.locator('#pairing-code').isVisible());
      await page.locator('#handoff-close').click();

      await page.locator('#account-menu-toggle').click();
      await page.locator('#new-agent').click();
      await page.locator('#new-agent-modal').waitFor({ state: 'visible' });
      await page.fill('#new-agent-name', 'React 新建 Agent');
      await page.locator('#new-agent-create').click();
      await page.locator('#new-agent-result').waitFor({ state: 'visible', timeout: 20_000 });
      check('新建 Agent 展示一次性结果', await page.locator('#new-agent-url').isVisible());
      await page.locator('#new-agent-close').click();

      await page.locator('#account-menu-toggle').click();
      await page.locator('#account-logout').click();
      await page.locator('#logout-modal').waitFor({ state: 'visible' });
      await page.locator('#logout-confirm').click();
      await page.waitForFunction(
        `localStorage.getItem('agent-network-token') === null`,
      );
      checkEqual('退出登录清除本机 token', true, true);
      await context.close();
    }

    // 6. 群管理：成员、公告、改名、群主转让入口与退群预览。
    {
      const roomId = data.group.room.room_id;
      // 新增一个好友作为可添加成员，避免候选为空。
      const newcomerToken = crypto.randomUUID();
      const newcomer = await rawTool<Actor>(newcomerToken, 'network_register', {
        request_id: requestId('reg'),
        kind: 'human',
        name: '群管理新成员',
      });
      await rawBefriend(data.humanToken, newcomerToken, { actor_id: newcomer.actor_id });

      const { context, page } = await makeContext(
        browser,
        data.humanToken,
        { width: 1280, height: 900 },
        allErrors,
      );
      await page.goto(`${server.base}/c/${roomId}`);
      await waitRoom(page, roomId, '测试群');

      const openMenu = async (item: string): Promise<void> => {
        await page.locator('#room-menu-toggle').click();
        await page.locator('#room-menu').waitFor({ state: 'visible' });
        await page.locator(`#${item}`).click();
      };

      await openMenu('room-menu-members');
      await page.locator('#members-modal').waitFor({ state: 'visible' });
      check(
        '成员弹窗列出 Agent 成员',
        (await page.locator('#members-current .spa-member').count()) >= 2,
      );
      await page.locator('#members-search').fill('群管理新成员');
      await page.locator('#members-contacts .spa-combobox-item').first().click();
      await page.waitForFunction(
        `Array.from(document.querySelectorAll('#members-current .spa-member')).some(function (node) { return node.textContent.includes('群管理新成员'); })`,
      );
      check('成员弹窗可直接添加好友', true);
      await page.locator('#members-close').click();

      await openMenu('room-menu-announcement');
      await page.locator('#announcement-modal').waitFor({ state: 'visible' });
      await page.fill('#announcement-input', 'React 公告验收');
      await page.locator('#announcement-save').click();
      await page.locator('#room-announcement').waitFor({ state: 'visible' });
      checkEqual('公告保存后显示横幅', (await page.locator('#room-announcement').textContent())?.trim(), 'React 公告验收');

      await openMenu('room-menu-rename');
      await page.locator('#room-rename-dialog').waitFor({ state: 'visible' });
      await page.fill('#room-rename-input', 'React 改名群');
      await page.locator('#room-rename-save').click();
      await waitRoom(page, roomId, 'React 改名群');
      check('群名保存后标题更新', true);

      await openMenu('room-menu-leave-group');
      await page.locator('#leave-dialog').waitFor({ state: 'visible' });
      await page.waitForFunction(
        `(document.getElementById('leave-message')?.textContent || '').includes('群主不能直接退群')`,
      );
      check('群主退群入口先说明需转让或解散', true);
      await page.locator('#leave-cancel').click();
      await context.close();
    }

    // 7. 移动端与暗色：单栏、返回入口、无横向溢出。
    {
      const roomId = data.direct.room.room_id;
      const { context, page } = await makeContext(
        browser,
        data.humanToken,
        { width: 390, height: 844 },
        allErrors,
        true,
        false,
        { colorScheme: 'dark', hasTouch: true },
      );
      await page.goto(`${server.base}/c/${roomId}`);
      await waitRoom(page, roomId, data.agentA.name);
      checkEqual('移动端聊天页隐藏侧栏', await page.locator('.sidebar').isHidden(), true);
      checkEqual('移动端显示返回箭头', await page.locator('#back').isVisible(), true);
      const layout = (await page.evaluate(`(() => ({
        width: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
        bg: getComputedStyle(document.body).backgroundColor
      }))()`)) as { width: number; viewport: number; bg: string };
      check('移动端无横向溢出', layout.width <= layout.viewport + 1, layout);
      check('暗色背景生效', layout.bg === 'rgb(25, 25, 25)', layout.bg);
      await context.close();
    }

    // 8. 分享/邀请/配对：SSR 公开资料与安全边界。
    {
      const agent = data.agentA;
      const shareHtml = await (await fetch(`${server.base}/a/${encodeURIComponent(agent.agent_session_id ?? '')}`)).text();
      check('分享页 SSR 含公开资料', shareHtml.includes(agent.actor_id) && shareHtml.includes('发送好友申请'));
      check('分享页不含 token', !shareHtml.includes('Bearer ') && !shareHtml.includes('agent-network-token='));
      checkEqual(
        '未知分享 session 404',
        (await fetch(`${server.base}/a/${encodeURIComponent('sess_missing')}`)).status,
        404,
      );
      const joinHtml = await (await fetch(`${server.base}/j/${'b'.repeat(32)}`)).text();
      check('邀请页 SSR 含加入入口', joinHtml.includes('id="join-action"') && joinHtml.includes('邀请码有效不等于已加入'));
      checkEqual('非法邀请码 404', (await fetch(`${server.base}/j/bad-key`)).status, 404);
      const pairHtml = await (await fetch(`${server.base}/pair`)).text();
      check('配对页 CSR 壳', pairHtml.includes('data-spa-route="pair"') && pairHtml.includes('<div id="root"></div>'));
      check('配对页 HTML 不含 challenge', !pairHtml.includes('pair-challenge'));
    }

    // 9. 错误收口与重试：列表失败与历史失败。
    {
      const { context, page } = await makeContext(
        browser,
        data.humanToken,
        { width: 1280, height: 800 },
        allErrors,
      );
      let failRooms = true;
      await page.route('**/mcp', async (route) => {
        const name = route.request().headers()['mcp-name'];
        if (name === 'network_rooms_list' && failRooms) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { isError: true, content: [{ type: 'text', text: '模拟列表失败' }] },
            }),
          });
          return;
        }
        await route.continue();
      });
      await page.goto(`${server.base}/`);
      await page.locator('#room-list-retry').waitFor({ state: 'visible' });
      check('列表失败显示重试入口', await page.locator('#room-list-retry').isVisible());
      failRooms = false;
      await page.locator('#room-list-retry').click();
      await page.locator('#room-filter-agent').click();
      await waitRoomListName(page, data.agentA.name);
      check('列表重试后恢复', true);
      await context.close();
    }
    {
      const roomId = data.direct.room.room_id;
      const { context, page } = await makeContext(
        browser,
        data.humanToken,
        { width: 1280, height: 800 },
        allErrors,
      );
      let failHistory = true;
      await page.route('**/mcp', async (route) => {
        const name = route.request().headers()['mcp-name'];
        if (name === 'network_history_list' && failHistory) {
          failHistory = false;
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: { isError: true, content: [{ type: 'text', text: '模拟历史失败' }] },
            }),
          });
          return;
        }
        await route.continue();
      });
      await page.goto(`${server.base}/c/${roomId}`);
      await page.locator('#chat-error').waitFor({ state: 'visible' });
      check('历史失败显示错误态', await page.locator('#chat-error-text').isVisible());
      await page.locator('#chat-error-retry').click();
      await waitRoom(page, roomId, data.agentA.name);
      check('历史重试后恢复', true);
      await context.close();
    }

    // 10. 投递回执：claim/complete 后发送方页面原地更新。
    {
      const roomId = data.direct.room.room_id;
      const { context, page } = await makeContext(
        browser,
        data.humanToken,
        { width: 1280, height: 900 },
        allErrors,
      );
      await page.goto(`${server.base}/c/${roomId}`);
      await waitRoom(page, roomId, data.agentA.name);
      const sent = await rawTool<{
        message: { message_id: string };
        delivery: { delivery_id: string; attempt: number; claim_id: string | null } | null;
      }>(data.humanToken, 'network_message_send', {
        request_id: requestId('msg'),
        client_message_id: crypto.randomUUID(),
        room_id: roomId,
        body: '回执验收消息',
        invoke: [data.agentA.actor_id],
      });
      const delivery = sent.delivery;
      check('发送生成 delivery', delivery !== null);
      if (delivery) {
        await rawTool(data.agentAToken, 'network_delivery_claim', {
          request_id: requestId('claim'),
          delivery_id: delivery.delivery_id,
          expected_attempt: delivery.attempt,
        });
        const claimed = await rawTool<{
          delivery_id: string;
          status: string;
          attempt: number;
          claim_id: string;
        }>(data.agentAToken, 'network_delivery_get', {
          delivery_id: delivery.delivery_id,
        });
        await rawTool(data.agentAToken, 'network_delivery_complete', {
          request_id: requestId('complete'),
          delivery_id: delivery.delivery_id,
          attempt: claimed.attempt,
          claim_id: claimed.claim_id,
          summary: 'React 回执验收完成',
        });
        await page.waitForFunction(
          `(() => {
            const node = document.querySelector('[data-message-id="${sent.message.message_id}"]');
            return node && /已处理/.test(node.textContent || '');
          })()`,
          undefined,
          { timeout: 15_000 },
        );
        check('回执完成状态原地更新', true);
      }
      await context.close();
    }

    await runPresenceRestartAcceptance();
    await runPresenceIdleNotificationCheck();

    checkEqual('无未捕获页面错误', allErrors.length, 0);
    console.log(`\n浏览器验收通过 ${checksPassed()} 项`);
  } finally {
    await browser?.close().catch(() => undefined);
    await server.stop();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
