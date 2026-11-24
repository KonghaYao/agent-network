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
  await expect(page.locator('#messages')).toHaveAttribute('data-loaded-ready', 'true');
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

async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const node = document.getElementById('messages');
    if (node) node.scrollTop = node.scrollHeight;
  });
  await expect.poll(() => bottomGap(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
}

async function loadOlderUntil(page: Page, target: number): Promise<void> {
  while ((await loadedCount(page)) < target) {
    const before = await loadedCount(page);
    await page.evaluate(() => {
      (document.getElementById('older') as HTMLButtonElement | null)?.click();
    });
    await expect.poll(() => loadedCount(page), { timeout: 20_000 }).toBeGreaterThan(before);
  }
}

interface BottomFrame {
  top: number;
  height: number;
  gap: number;
}

interface BottomProbeReport {
  frames: number;
  minTop: number;
  maxTop: number;
  range: number;
  scrollEvents: number;
  maxGap: number;
  finalGap: number;
  maxBackward: number;
}

async function startBottomProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const node = document.getElementById('messages') as HTMLElement;
    const state = {
      frames: [] as BottomFrame[],
      scrollEvents: 0,
      stopped: false,
      onScroll: null as (() => void) | null,
    };
    (window as unknown as { __bottomProbe: typeof state }).__bottomProbe = state;
    state.onScroll = () => {
      state.scrollEvents += 1;
    };
    node.addEventListener('scroll', state.onScroll, { passive: true });
    const tick = () => {
      if (state.stopped) return;
      state.frames.push({
        top: node.scrollTop,
        height: node.scrollHeight,
        gap: node.scrollHeight - node.scrollTop - node.clientHeight,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function stopBottomProbe(page: Page): Promise<BottomProbeReport> {
  return page.evaluate(() => {
    const node = document.getElementById('messages') as HTMLElement;
    const state = (window as unknown as {
      __bottomProbe: {
        frames: BottomFrame[];
        scrollEvents: number;
        stopped: boolean;
        onScroll: (() => void) | null;
      };
    }).__bottomProbe;
    state.stopped = true;
    if (state.onScroll) node.removeEventListener('scroll', state.onScroll);
    const frames = state.frames;
    const tops = frames.map((frame) => frame.top);
    let maxBackward = 0;
    for (let index = 1; index < frames.length; index += 1) {
      maxBackward = Math.max(maxBackward, frames[index - 1]!.top - frames[index]!.top);
    }
    const gaps = frames.map((frame) => frame.gap);
    return {
      frames: frames.length,
      minTop: Math.min(...tops),
      maxTop: Math.max(...tops),
      range: Math.round((Math.max(...tops) - Math.min(...tops)) * 100) / 100,
      scrollEvents: state.scrollEvents,
      maxGap: Math.round(Math.max(...gaps) * 100) / 100,
      finalGap: Number(
        (node.scrollHeight - node.scrollTop - node.clientHeight).toFixed(2),
      ),
      maxBackward: Math.round(maxBackward * 100) / 100,
    };
  });
}

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface UploadedFile {
  fileId: string;
  publicUrl: string;
}

async function uploadRoomFile(
  base: string,
  token: string,
  roomId: string,
  name: string,
  mimeType: string,
  body: Buffer,
): Promise<UploadedFile> {
  const response = await fetch(`${base}/mcp-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'MCPP-Files-Version': '1',
      'content-type': mimeType,
      'MCPP-File-Name': encodeURIComponent(name),
      'MCPP-File-Size': String(body.length),
    },
    body: body as unknown as BodyInit,
  });
  if (response.status !== 201) throw new Error(`上传 ${name} 失败：HTTP ${response.status}`);
  const uploaded = (await response.json()) as UploadedFile;
  await callTool(base, token, 'network_room_file_bind', {
    request_id: requestId('virt_file_bind'),
    room_id: roomId,
    file_id: uploaded.fileId,
  });
  await callTool(base, token, 'network_file_publish', {
    request_id: requestId('virt_file_publish'),
    room_id: roomId,
    file_id: uploaded.fileId,
    public: true,
  });
  return uploaded;
}

function richBody(index: number, imageUrl: string, documentUrl: string): string {
  if (index % 5 === 0) {
    return [
      `## Peri 维护记录 ${index}`,
      '',
      '| 检查项 | 结果 | 备注 |',
      '| --- | --- | --- |',
      '| 时间线 | 稳定 | 虚拟化 |',
      '| 贴底 | 观察 | 长内容 |',
      '',
      '```ts',
      'const samples = frames.map((frame) => frame.top);',
      'const range = Math.max(...samples) - Math.min(...samples);',
      '```',
      '',
      `> 第 ${index} 段：底部需要稳定，不应来回跳动。`,
    ].join('\n');
  }
  if (index % 7 === 0) {
    return `Peri 维护截图 ${index}\n\n[Peri 截图.png](${imageUrl})`;
  }
  if (index % 11 === 0) {
    return `Peri 维护长清单 ${index}\n\n${'- 核对 Markdown、图片、文件卡与 Task 的高度变化。\n'.repeat(18)}`;
  }
  if (index % 13 === 0) {
    return `Peri 维护文档 ${index}\n\n[维护记录.md](${documentUrl})`;
  }
  return `Peri 维护进度 ${index}：已完成第 ${index} 项检查，继续观察底部。`;
}

async function seedRichTimeline(
  base: string,
  token: string,
  roomId: string,
  count: number,
  imageUrl: string,
  documentUrl: string,
): Promise<void> {
  const batch = 20;
  for (let start = 1; start <= count; start += batch) {
    await Promise.all(
      Array.from({ length: Math.min(batch, count - start + 1) }, (_, offset) => {
        const index = start + offset;
        return callTool<{ message: { message_id: string } }>(
          base,
          token,
          'network_message_send',
          {
            request_id: requestId('virt_rich'),
            client_message_id: crypto.randomUUID(),
            room_id: roomId,
            invoke: [],
            body: richBody(index, imageUrl, documentUrl),
          },
        ).then(async (sent) => {
          if (index % 29 === 0) {
            await callTool(base, token, 'network_task_mark', {
              request_id: requestId('virt_rich_task'),
              room_id: roomId,
              message_id: sent.message.message_id,
            });
          }
        });
      }),
    );
  }
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
    const bottom = list.getBoundingClientRect().bottom;
    // 选第一条完整落在视口内的消息；半截在顶部的条目会随 overscan 变化，
    // 不适合作为 prepend 前后稳定的锚点。
    const node = Array.from(list.querySelectorAll<HTMLElement>('.msg[data-message-id]')).find(
      (element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= top - 1 && rect.top < bottom - 1;
      },
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
    expect(frames.p95).toBeLessThan(20);
    expect(frames.longFrames).toBe(0);
  });

  test('keeps the prepend anchor within 2px', async ({ page }) => {
    await openRoom(page, roomId);
    await scrollToTop(page);
    // startReached 可能在滚到顶部时自动补一页；先等数据窗口稳定，
    // 再用手动点击验证“一次 prepend”，避免自动补页与点击竞争。
    let loadedBefore = await loadedCount(page);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.waitForTimeout(200);
      const current = await loadedCount(page);
      if (current === loadedBefore) break;
      loadedBefore = current;
    }
    await page.waitForTimeout(300);
    loadedBefore = await loadedCount(page);
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
    await expect.poll(() => loadedCount(page), { timeout: 20_000 }).toBe(loadedBefore + 50);
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
    console.log(
      `VIRTUAL_PREPEND ${JSON.stringify({
        ...report,
        before: before.id,
        after: after?.id,
        loaded: loadedBefore + 50,
        top: after?.top,
      })}`,
    );
    expect(report.correctedDrift).toBeLessThanOrEqual(2);
    expect(report.missed).toBe(false);
    expect(report.maxAbsDrift).toBeLessThanOrEqual(8);
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
    // 点击引用后 Virtuoso 的滚动/测量异步完成；等待目标真正进入视口，
    // 而不是在滚动尚未结束时单次采样。500ms 上限不放宽“在视口内”的要求。
    await page.waitForFunction(
      (messageId) => {
        const list = document.getElementById('messages');
        const node = document.querySelector<HTMLElement>(
          `#messages .msg[data-message-id="${messageId}"]`,
        );
        if (!list || !node) return false;
        const rect = node.getBoundingClientRect();
        const listRect = list.getBoundingClientRect();
        return rect.bottom > listRect.top && rect.top < listRect.bottom;
      },
      target.id,
      { timeout: 500, polling: 'raf' },
    );
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

/**
 * 贴底稳定性：真实「Peri 维护」会话包含大量 Agent 长 Markdown、图片、文件卡
 * 与 Task。旧实现用整棵 scroller 的 MutationObserver + 每次变化强制
 * `scrollTop = scrollHeight`，在隔离夹具的进入/贴底阶段记录到 806px 回跳。
 * 这两条用例固化静止与追加时的位置不变量，不依赖帧率。
 */
test.describe('virtual timeline bottom stability', () => {
  const RICH_TOTAL = 240;
  const LOADED_TARGET = 220;
  let base = '';
  let ownerToken = '';
  let agentToken = '';
  let roomId = '';
  let imageUrl = '';
  let documentUrl = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `贴底 Owner ${suffix}`, `virt-bottom-${suffix}`);
    ownerToken = owner.token;
    const agent = await callTool<{ actor_id: string; token: string }>(
      base,
      ownerToken,
      'network_agent_create',
      { request_id: requestId('virt_bottom_agent'), name: `Peri 维护 ${suffix}` },
    );
    agentToken = agent.token;
    const created = await callTool<{ room: { room_id: string } }>(
      base,
      ownerToken,
      'network_room_create',
      {
        request_id: requestId('virt_bottom_room'),
        kind: 'direct',
        members: [agent.actor_id],
      },
    );
    roomId = created.room.room_id;
    const image = await uploadRoomFile(
      base,
      ownerToken,
      roomId,
      'Peri 截图.png',
      'image/png',
      PIXEL_PNG,
    );
    const document = await uploadRoomFile(
      base,
      ownerToken,
      roomId,
      '维护记录.md',
      'text/markdown',
      Buffer.from('# Peri 维护记录\n\n- 时间线\n- 贴底\n', 'utf8'),
    );
    imageUrl = image.publicUrl;
    documentUrl = document.publicUrl;
    await seedRichTimeline(base, agentToken, roomId, RICH_TOTAL, imageUrl, documentUrl);
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 存储不可用时由页面错误态兜底。
      }
    }, ownerToken);
  });

  test('keeps scrollTop stable for 2s after reaching the bottom', async ({ page }) => {
    await openRoom(page, roomId);
    await loadOlderUntil(page, LOADED_TARGET);
    await scrollToBottom(page);
    // 等 Markdown 岛、图片、文件卡与 Task 摘要完成首轮挂载/测量。
    await page.waitForTimeout(2_000);

    await startBottomProbe(page);
    await page.waitForTimeout(2_000);
    const report = await stopBottomProbe(page);
    console.log(`VIRTUAL_BOTTOM_IDLE ${JSON.stringify(report)}`);

    expect(report.frames).toBeGreaterThan(80);
    // 到底静止后不应再有程序化滚动；scroll 事件为 0 也说明没有与测量互抢。
    expect(report.scrollEvents).toBe(0);
    expect(report.range).toBeLessThanOrEqual(1);
    expect(report.maxBackward).toBeLessThanOrEqual(1);
    expect(report.finalGap).toBeLessThanOrEqual(2);
  });

  test('follows a long append without bouncing back', async ({ page }) => {
    await openRoom(page, roomId);
    await loadOlderUntil(page, LOADED_TARGET);
    await scrollToBottom(page);
    await page.waitForTimeout(1_000);

    await startBottomProbe(page);
    const sent = await callTool<{ message: { message_id: string } }>(
      base,
      agentToken,
      'network_message_send',
      {
        request_id: requestId('virt_bottom_live'),
        client_message_id: crypto.randomUUID(),
        room_id: roomId,
        invoke: [],
        body: [
          '## Peri 维护实时追加',
          '',
          '| 项 | 状态 |',
          '| --- | --- |',
          '| 贴底 | 观察 |',
          '',
          `${'实时追加的长 Markdown 段落，用于观察高度变化后的跟随。\n'.repeat(24)}`,
          `[Peri 截图.png](${imageUrl})`,
        ].join('\n'),
      },
    );
    await expect(
      page.locator(`#messages .msg[data-message-id="${sent.message.message_id}"]`),
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(2_500);
    const report = await stopBottomProbe(page);
    console.log(`VIRTUAL_BOTTOM_APPEND ${JSON.stringify(report)}`);

    expect(await bottomGap(page)).toBeLessThanOrEqual(2);
    expect(report.maxGap).toBeGreaterThan(50);
    expect(report.range).toBeGreaterThan(0);
    // 只允许向下跟随；任何明显的向上回弹都是旧实现的测量争抢。
    expect(report.maxBackward).toBeLessThanOrEqual(2);
    expect(await page.locator('#messages').getAttribute('data-virt-at-bottom')).toBe('true');
  });
});
