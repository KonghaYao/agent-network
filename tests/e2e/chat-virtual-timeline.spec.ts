import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 虚拟时间线 P0 验收：DOM 上限、prepend 锚定、跳转、已读水位与移动端。
 *
 * 默认种子 400 条；用 `E2E_VIRTUAL_MESSAGES=1000|3000|5000` 跑规模基线。
 * 报告只依赖确定性指标（条数、节点数、锚点漂移），帧率仅记录不门禁。
 */

const TOTAL = Math.max(60, Number(process.env.E2E_VIRTUAL_MESSAGES ?? 400));

async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const file = resolve(process.cwd(), '.e2e/server.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { base?: unknown };
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

function requestId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
}

interface ToolEnvelope {
  isError?: boolean;
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
}

async function callTool<T>(
  base: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: crypto.randomUUID(),
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'agent-network-e2e',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: ToolEnvelope;
  };
  if (payload.error) throw new Error(payload.error.message ?? 'MCP 调用失败');
  const result = payload.result;
  if (!result) throw new Error('MCP 响应缺少 result');
  if (result.isError === true) {
    const text = result.content?.find((item) => item.type === 'text')?.text;
    throw new Error(text ?? '工具调用失败');
  }
  if (result.structuredContent !== undefined) return result.structuredContent as T;
  const text = result.content?.find((item) => item.type === 'text')?.text;
  if (!text) throw new Error('MCP 响应缺少正文');
  return JSON.parse(text) as T;
}

interface Registered {
  actor_id: string;
  name: string;
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

interface RoomsList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface RoomDetail {
  room: { room_id: string; my_last_read_seq: string; head_seq: string };
}

interface HistoryPage {
  items: { message_id: string; created_seq: string }[];
}

async function registerHuman(
  base: string,
  name: string,
  device: string,
): Promise<{ token: string; actor: Registered }> {
  const token = crypto.randomUUID();
  const actor = await callTool<Registered>(base, token, 'network_register', {
    request_id: requestId('virt_reg'),
    kind: 'human',
    name,
    device_id: device,
  });
  return { token, actor };
}

async function befriend(
  base: string,
  fromToken: string,
  peer: Registered,
  peerToken: string,
): Promise<string> {
  const contact = await callTool<ContactRequestResult>(base, fromToken, 'network_contact_request', {
    request_id: requestId('virt_contact'),
    actor_id: peer.actor_id,
  });
  const contactRequestId = contact.request?.contact_request_id;
  if (!contactRequestId) throw new Error('好友申请未创建');
  await callTool(base, peerToken, 'network_contact_request_respond', {
    request_id: requestId('virt_contact'),
    contact_request_id: contactRequestId,
    action: 'accept',
  });
  const rooms = await callTool<RoomsList>(base, fromToken, 'network_rooms_list', { limit: 50 });
  const direct = rooms.items.find(
    (room) => room.kind === 'direct' && room.peer?.actor_id === peer.actor_id,
  );
  if (!direct) throw new Error('好友通过后未生成 direct 会话');
  return direct.room_id;
}

async function seedMessages(
  base: string,
  token: string,
  roomId: string,
  count: number,
): Promise<void> {
  const batch = 25;
  for (let start = 1; start <= count; start += batch) {
    await Promise.all(
      Array.from({ length: Math.min(batch, count - start + 1) }, (_, offset) => {
        const index = start + offset;
        const body =
          index % 17 === 0
            ? `## 虚拟时间线报告 ${index}\n\n- 第一条\n- 第二条\n- 第三条`
            : index % 41 === 0
              ? `虚拟时间线长消息 ${index}\n\n${'长段落内容。'.repeat(90)}`
              : `虚拟时间线消息 ${index}`;
        return callTool(base, token, 'network_message_send', {
          request_id: requestId('virt_seed'),
          client_message_id: crypto.randomUUID(),
          room_id: roomId,
          invoke: [],
          body,
        });
      }),
    );
  }
}

async function openRoom(page: Page, roomId: string): Promise<void> {
  const origin = await baseUrl();
  await page.goto(`${origin}/c/${roomId}`);
  await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
  await expect(page.locator('#messages')).toHaveAttribute('data-timeline-mode', 'virtual');
  await expect.poll(() => loadedCount(page), { timeout: 20_000 }).toBe(50);
}

async function loadedCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const node = document.getElementById('messages');
    return Number(node?.getAttribute('data-loaded-message-count') ?? '0');
  });
}

async function domNodeCount(page: Page): Promise<number> {
  return page.evaluate(
    () => document.getElementById('messages')?.querySelectorAll('*').length ?? 0,
  );
}

async function bottomGap(page: Page): Promise<number> {
  return page.evaluate(() => {
    const node = document.getElementById('messages');
    return node ? node.scrollHeight - node.scrollTop - node.clientHeight : 0;
  });
}

async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const node = document.getElementById('messages');
    if (!node) return;
    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -800, bubbles: true }));
    node.scrollTop = 0;
  });
}

interface AnchorSample {
  id: string;
  top: number;
}

async function firstVisibleAnchor(page: Page): Promise<AnchorSample | null> {
  return page.evaluate(() => {
    const list = document.getElementById('messages');
    if (!list) return null;
    const top = list.getBoundingClientRect().top;
    const node = Array.from(list.querySelectorAll<HTMLElement>('.msg[data-message-id]')).find(
      (element) => element.getBoundingClientRect().bottom > top + 1,
    );
    if (!node) return null;
    return { id: node.dataset.messageId ?? '', top: node.getBoundingClientRect().top };
  });
}

test.describe.configure({ timeout: 300_000 });

test.describe('virtual chat timeline', () => {
  let base = '';
  let tokenA = '';
  let tokenB = '';
  let roomId = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const a = await registerHuman(base, `虚拟 A ${suffix}`, `virt-${suffix}-a`);
    const b = await registerHuman(base, `虚拟 B ${suffix}`, `virt-${suffix}-b`);
    tokenA = a.token;
    tokenB = b.token;
    roomId = await befriend(base, tokenA, b.actor, tokenB);
    await seedMessages(base, tokenB, roomId, TOTAL);
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 存储不可用时由页面错误态兜底。
      }
    }, tokenA);
  });

  test(`keeps a bounded DOM window with ${TOTAL} loaded messages`, async ({ page }) => {
    await openRoom(page, roomId);
    expect(await domNodeCount(page)).toBeLessThan(2000);

    const started = Date.now();
    while ((await loadedCount(page)) < TOTAL) {
      const before = await loadedCount(page);
      await expect(page.locator('#older')).toBeEnabled({ timeout: 10_000 });
      await page.evaluate(() => {
        (document.getElementById('older') as HTMLButtonElement | null)?.click();
      });
      await expect.poll(() => loadedCount(page), { timeout: 20_000 }).toBeGreaterThan(before);
    }
    expect(await loadedCount(page)).toBe(TOTAL);
    expect(Date.now() - started).toBeLessThan(120_000);

    const nodes = await domNodeCount(page);
    const visible = await page.locator('#messages .msg[data-message-id]').count();
    expect(nodes).toBeLessThanOrEqual(2000);
    expect(visible).toBeLessThan(300);

    const frames = await page.evaluate(async () => {
      const node = document.getElementById('messages');
      if (!node) return { p50: 0, p95: 0, max: 0, longFrames: 0 };
      const samples: number[] = [];
      let last = performance.now();
      let running = true;
      const tick = (now: number) => {
        samples.push(now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const max = node.scrollHeight - node.clientHeight;
      for (let index = 0; index < 40; index += 1) {
        node.scrollTop = index % 2 === 0 ? max * 0.35 : max * 0.65;
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      running = false;
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      const sorted = samples.slice().sort((left, right) => left - right);
      const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
      return {
        p50: at(0.5),
        p95: at(0.95),
        max: sorted.at(-1) ?? 0,
        longFrames: samples.filter((value) => value > 50).length,
      };
    });

    console.log(
      `VIRTUAL_SCALE ${JSON.stringify({
        loaded: TOTAL,
        domNodes: nodes,
        visibleMessages: visible,
        frameP50: Number(frames.p50.toFixed(1)),
        frameP95: Number(frames.p95.toFixed(1)),
        frameMax: Number(frames.max.toFixed(1)),
        longFrames: frames.longFrames,
      })}`,
    );
    expect(frames.p95).toBeLessThan(100);
  });

  test('keeps the prepend anchor within 2px', async ({ page }) => {
    await openRoom(page, roomId);
    await scrollToTop(page);
    await page.waitForTimeout(250);
    const before = await firstVisibleAnchor(page);
    expect(before).not.toBeNull();
    if (!before) return;

    await page.evaluate((anchorId) => {
      const target = (window as unknown as { __virtDrift?: unknown }).__virtDrift;
      void target;
      const list = document.getElementById('messages');
      if (!list) return;
      const record = {
        id: anchorId,
        initialTop: 0,
        samples: [] as number[],
        scrollTops: [] as number[],
      };
      const node = list.querySelector<HTMLElement>(
        `.msg[data-message-id="${anchorId}"]`,
      );
      record.initialTop = node?.getBoundingClientRect().top ?? 0;
      const started = performance.now();
      const tick = () => {
        const current = list.querySelector<HTMLElement>(
          `.msg[data-message-id="${anchorId}"]`,
        );
        if (current) {
          record.samples.push(current.getBoundingClientRect().top - record.initialTop);
        }
        record.scrollTops.push(list.scrollTop);
        if (performance.now() - started < 2_500) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (window as unknown as { __virtDrift?: unknown }).__virtDrift = record;
    }, before.id);

    await page.evaluate(() => {
      (document.getElementById('older') as HTMLButtonElement | null)?.click();
    });
    await expect.poll(() => loadedCount(page), { timeout: 20_000 }).toBe(100);
    await page.waitForTimeout(2_600);

    const report = await page.evaluate(() => {
      const record = (window as unknown as { __virtDrift?: {
        samples: number[];
        scrollTops: number[];
      } }).__virtDrift;
      const samples = record?.samples ?? [];
      const scrollTops = record?.scrollTops ?? [];
      const absolute = samples.map((value) => Math.abs(value));
      return {
        maxAbsDrift: absolute.length ? Math.max(...absolute) : 0,
        correctedDrift: absolute.length ? absolute[absolute.length - 1] ?? 0 : 0,
        missed: scrollTops.length > 1 && scrollTops.every((value) => value === scrollTops[0]),
        samples: samples.length,
      };
    });

    const after = await firstVisibleAnchor(page);
    expect(after?.id).toBe(before.id);
    expect(Math.abs((after?.top ?? 0) - before.top)).toBeLessThanOrEqual(2);
    console.log(`VIRTUAL_PREPEND ${JSON.stringify(report)}`);
    expect(report.correctedDrift).toBeLessThanOrEqual(2);
    expect(report.missed).toBe(false);
  });

  test('jumps to a quoted message inside the virtual window', async ({ page }) => {
    await openRoom(page, roomId);
    const target = await firstVisibleAnchor(page);
    expect(target).not.toBeNull();
    if (!target) return;

    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('virt_reply'),
      client_message_id: crypto.randomUUID(),
      room_id: roomId,
      reply_to: target.id,
      invoke: [],
      body: '虚拟时间线引用跳转',
    });
    const reply = page
      .locator('#messages .msg[data-message-id]')
      .filter({ hasText: '虚拟时间线引用跳转' });
    await expect(reply).toBeVisible({ timeout: 15_000 });
    await reply.locator('.reply-reference').click();

    const jumped = page.locator(`#messages .msg[data-message-id="${target.id}"]`);
    await expect(jumped).toBeVisible({ timeout: 10_000 });
    const withinViewport = await jumped.evaluate((node) => {
      const list = document.getElementById('messages');
      if (!list) return false;
      const rect = node.getBoundingClientRect();
      const listRect = list.getBoundingClientRect();
      return rect.bottom > listRect.top && rect.top < listRect.bottom;
    });
    expect(withinViewport).toBe(true);
  });

  test('does not advance the read watermark while scrolled away', async ({ page }) => {
    await openRoom(page, roomId);
    await expect.poll(() => bottomGap(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
    await page.waitForTimeout(600);
    const read = await callTool<RoomDetail>(base, tokenA, 'network_room_get', {
      room_id: roomId,
    });
    expect(Number(read.room.my_last_read_seq)).toBeGreaterThan(0);

    await scrollToTop(page);
    await page.waitForTimeout(400);
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('virt_live'),
      client_message_id: crypto.randomUUID(),
      room_id: roomId,
      invoke: [],
      body: '虚拟时间线未读消息',
    });
    await page.waitForTimeout(1_000);
    const after = await callTool<RoomDetail>(base, tokenA, 'network_room_get', {
      room_id: roomId,
    });
    expect(after.room.my_last_read_seq).toBe(read.room.my_last_read_seq);
  });

  test('keeps the mobile single column without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openRoom(page, roomId);
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('#composer')).toBeVisible();
    expect(await domNodeCount(page)).toBeLessThan(2000);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  });
});
