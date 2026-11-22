import { expect, test, type Locator, type Page } from '@playwright/test';
import type { CDPSession } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  buildTextMask,
  clampRect,
  decodePngLuma,
  gradientMeanAtMask,
  meanAbsDiff,
  type LumaImage,
  type RasterRect,
} from './fixtures/png-pixels';

/**
 * 右键菜单首帧回归（像素级）。
 *
 * 真实 Bun 服务与 Chromium；用 CDP screencast 记录右键后的合成帧，逐帧比较
 * 菜单投影/玻璃面与文字边缘。修复前 Lenso 先画 layout 根节点的投影，popup
 * 下一帧才出现，浅色与深色都能截到一帧空白菜单。
 *
 * 每个目标浅色、深色各右键 20 次；任何一帧只要菜单壳（投影或玻璃面）可见，
 * 文字就必须已经出现，否则失败。
 */

const RUNS = 20;
/** 右键后采样的合成帧窗口；覆盖 popup 挂载、内容和详情加载。 */
const CAPTURE_MS = 260;
/**
 * 新增区域/状态的采样窗口。Lenso Menu 的 surface/content 动画在旧实现里
 * 持续约 300ms，800ms 能覆盖入场、异步内容替换与一次完整的合成提交。
 */
const MATRIX_MS = 800;
/** 新增逐帧用例的重复次数；首开/缓存命中都在窗口内覆盖。 */
const MATRIX_RUNS = 3;
/** 菜单框外 28px 内是投影；用投影判断“菜单壳已出现”。 */
const SHADOW_THRESHOLD = 0.6;
/** 菜单内部亮度变化超过该值，说明玻璃面已经绘制。 */
const SURFACE_THRESHOLD = 0.3;
/** 文字掩码位置上的平均局部对比度；空白玻璃面接近 0。 */
const TEXT_THRESHOLD = 8;
/**
 * 下拉菜单的条目动画更长，空白玻璃面实测可达 9–14；用稳定帧文字对比度的
 * 一半作为下限，避免把“只出现投影、文字还没进来”的帧当成正常过渡。
 */
const MENU_TEXT_RATIO = 0.5;
/** 原生右键区域允许的最大的菜单外平均变化；焦点环等局部变化会被目标框排除。 */
const NATIVE_OUTSIDE_DELTA = 2;

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
/** 最小可被 Chromium 识别为 application/pdf 的文档；预览只用外壳与 iframe。 */
const MINIMAL_PDF = Buffer.from(
  `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj
xref
0 4
0000000000 65535 f\x20
trailer<</Size 4/Root 1 0 R>>
startxref
0
%%EOF`,
);

async function baseUrl(): Promise<string> {
  if (process.env.E2E_BASE_URL) return process.env.E2E_BASE_URL;
  const file = resolve(process.cwd(), '.e2e/server.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { base?: unknown };
  if (typeof parsed.base !== 'string') throw new Error('E2E server.json 缺少 base');
  return parsed.base;
}

const requestId = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

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
            name: 'agent-network-e2e-context-flash',
            version: '0.1.0',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const payload = (await response.json()) as {
    error?: { message?: string };
    result?: {
      isError?: boolean;
      structuredContent?: T;
      content?: { type?: string; text?: string }[];
    };
  };
  if (payload.error || payload.result?.isError) {
    const text = payload.result?.content?.find((item) => item.type === 'text')?.text;
    throw new Error(payload.error?.message ?? text ?? `工具调用失败：${name}`);
  }
  if (!payload.result) throw new Error('MCP 响应缺少 result');
  return (
    payload.result.structuredContent ??
    (JSON.parse(payload.result.content?.find((item) => item.type === 'text')?.text ?? 'null') as T)
  );
}

async function contact(base: string, requesterToken: string, targetToken: string, actorId: string) {
  const request = await callTool<{ request: { contact_request_id: string } | null }>(
    base,
    requesterToken,
    'network_contact_request',
    { request_id: requestId('e2e_flash_contact'), actor_id: actorId },
  );
  const contactRequestId = request.request?.contact_request_id;
  if (!contactRequestId) throw new Error('好友申请未创建');
  await callTool(base, targetToken, 'network_contact_request_respond', {
    request_id: requestId('e2e_flash_contact'),
    contact_request_id: contactRequestId,
    action: 'accept',
  });
}

async function registerAgent(base: string, token: string, name: string) {
  return callTool<{ actor_id: string }>(base, token, 'network_register', {
    request_id: requestId('e2e_flash_reg'),
    kind: 'agent',
    name,
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
}

interface UploadedProbeFile {
  fileId: string;
  publicUrl: string;
}

/** 真实 MCPP Files 上传；返回服务端 fileId 与公开地址。 */
async function uploadProbeFile(
  base: string,
  token: string,
  name: string,
  mimeType: string,
  body: Buffer,
): Promise<UploadedProbeFile> {
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
  const uploaded = (await response.json()) as { fileId: string; publicUrl: string };
  return { fileId: uploaded.fileId, publicUrl: uploaded.publicUrl };
}

async function login(page: Page, token: string) {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('agent-network-token', value);
      localStorage.removeItem('agent-network-logged-out');
      localStorage.setItem('agent-network-room-filter', 'group');
    } catch {
      // 浏览器禁用存储时由页面错误态兜底。
    }
  }, token);
}

interface CapturedMenu {
  frames: LumaImage[];
  box: RasterRect;
}

/**
 * 开始 screencast，执行一次交互，采集固定窗口内的合成帧。首帧一定是交互前
 * 的基线；停止 screencast 后再解码，避免 PNG 解码阻塞 CDP 的帧确认。
 *
 * `visibleSelector` 用于菜单：适配器会先以 opacity 0 完成定位，再显示。这里
 * 记录菜单第一次真正可见的时间，丢弃之前的帧，只保留“基线 + 菜单可见后的
 * 帧”。否则右键本身造成的焦点/滚动会被误判成空白菜单。
 */
async function captureFrames(
  page: Page,
  cdp: CDPSession,
  durationMs: number,
  action: () => Promise<void>,
  visibleSelector?: string,
): Promise<LumaImage[]> {
  if (visibleSelector) {
    await page.evaluate((selector) => {
      const state = window as unknown as { __flashShownAt: number | null; __flashProbe: number };
      state.__flashShownAt = null;
      const deadline = performance.now() + 3000;
      const tick = () => {
        if (state.__flashShownAt !== null) return;
        const element = document.querySelector(selector);
        if (element) {
          const rect = element.getBoundingClientRect();
          if (rect.width > 0 && Number(getComputedStyle(element).opacity) > 0.5) {
            state.__flashShownAt = performance.now();
            return;
          }
        }
        if (performance.now() < deadline) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }, visibleSelector);
  }
  const payloads: { data: Buffer; timestamp: number }[] = [];
  const onFrame = (event: {
    data: string;
    sessionId: number;
    metadata?: { timestamp?: number };
  }) => {
    payloads.push({
      data: Buffer.from(event.data, 'base64'),
      timestamp: event.metadata?.timestamp ?? Date.now() / 1000,
    });
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => undefined);
  };
  cdp.on('Page.screencastFrame', onFrame);
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  try {
    await new Promise<void>((resolveFrame, rejectFrame) => {
      const timer = setTimeout(() => rejectFrame(new Error('screencast 未产生首帧')), 3000);
      cdp.once('Page.screencastFrame', () => {
        clearTimeout(timer);
        resolveFrame();
      });
    });
    // 首帧落袋后再交互，保证 frames[0] 是菜单出现前的基线。
    await page.waitForTimeout(24);
    await action();
    await page.waitForTimeout(durationMs);
    let captured = payloads;
    if (visibleSelector) {
      const timing = await page.evaluate(() => ({
        shownAt: (window as unknown as { __flashShownAt: number | null }).__flashShownAt,
        origin: performance.timeOrigin,
      }));
      if (timing.shownAt !== null) {
        const threshold = timing.origin + timing.shownAt - 24;
        const firstVisible = payloads.findIndex((payload) => payload.timestamp * 1000 >= threshold);
        if (firstVisible > 0) {
          // 保留第一张可见帧之前的一张作为基线，避免把页面自身变化算进去。
          captured = [payloads[firstVisible - 1]!, ...payloads.slice(firstVisible)];
        }
      }
    }
    return captured.map((payload) => decodePngLuma(payload.data));
  } finally {
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    cdp.off('Page.screencastFrame', onFrame);
    // 停止后仍可能有在途帧，等一下再返回，避免把残帧算进下一次。
    await page.waitForTimeout(40);
  }
}

/**
 * 右键一次并抓取合成帧。
 */
async function captureMenu(
  page: Page,
  cdp: CDPSession,
  target: Locator,
  menuSelector: string,
  durationMs = CAPTURE_MS,
): Promise<CapturedMenu> {
  const frames = await captureFrames(page, cdp, durationMs, () =>
    target.click({ button: 'right' }), menuSelector);
  const menu = page.locator(menuSelector);
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  if (!box) throw new Error(`菜单没有布局盒：${menuSelector}`);
  return { frames, box };
}

function assertNoBlankFrame(captured: CapturedMenu, textRatio = 0): void {
  assertNoBlankShell(captured.frames, captured.box, textRatio);
}

function assertNoBlankShell(frames: LumaImage[], box: RasterRect, textRatio = 0): void {
  expect(frames.length, 'screencast 帧数不足').toBeGreaterThan(1);
  const viewport = { width: frames[0]!.width, height: frames[0]!.height };
  const innerHeight = Math.min(box.height, 152) - 16;
  const inner = clampRect(
    { x: box.x + 14, y: box.y + 8, width: box.width - 28, height: innerHeight },
    viewport.width,
    viewport.height,
  );
  const rightShadow = clampRect(
    { x: box.x + box.width + 1, y: box.y + 16, width: 27, height: box.height - 32 },
    viewport.width,
    viewport.height,
  );
  const bottomShadow = clampRect(
    { x: box.x + 16, y: box.y + box.height + 1, width: box.width - 32, height: 27 },
    viewport.width,
    viewport.height,
  );
  const baseline = frames[0]!;
  const settled = frames[frames.length - 1]!;
  const textMask = buildTextMask(settled, inner, 30);
  expect(textMask.count, '稳定帧没有提取到文字边缘').toBeGreaterThan(20);
  const settledText = gradientMeanAtMask(settled, inner, textMask.mask);
  const minimumText = Math.max(TEXT_THRESHOLD, settledText * textRatio);

  let textFrames = 0;
  const blankFrames: string[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index]!;
    const innerDiff = meanAbsDiff(frame, baseline, inner);
    const shadow = Math.max(
      meanAbsDiff(frame, baseline, rightShadow),
      meanAbsDiff(frame, baseline, bottomShadow),
    );
    const text = gradientMeanAtMask(frame, inner, textMask.mask);
    if (shadow > SHADOW_THRESHOLD && innerDiff < SURFACE_THRESHOLD) {
      blankFrames.push(`frame ${index}: 只有菜单投影/空白面（shadow=${shadow.toFixed(2)}）`);
    } else if (shadow > SHADOW_THRESHOLD && innerDiff >= SURFACE_THRESHOLD && text < minimumText) {
      blankFrames.push(
        `frame ${index}: 玻璃面已绘制但文字未完成（inner=${innerDiff.toFixed(2)} text=${text.toFixed(1)} < ${minimumText.toFixed(1)}）`,
      );
    }
    if (innerDiff >= SURFACE_THRESHOLD && text >= minimumText) textFrames += 1;
  }
  expect(textFrames, '整段采样都没有看到菜单文字').toBeGreaterThan(0);
  expect(blankFrames, `出现空白菜单帧：\n${blankFrames.join('\n')}`).toEqual([]);
}

/** 等聊天列表停止滚动/重排；首屏平滑滚底与文件卡元数据都会改变基线。 */
async function waitForChatIdle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const element = document.querySelector<HTMLElement>('#messages');
    if (!element) { resolve(); return; }
    let last = element.scrollTop;
    let stableSince = performance.now();
    const tick = () => {
      if (element.scrollTop !== last) {
        last = element.scrollTop;
        stableSince = performance.now();
      }
      if (performance.now() - stableSince >= 150) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
}

/** 等置顶区、Task 摘要与文件卡元数据都落位，避免把晚到的布局变化算成右键闪烁。 */
async function waitForChatStable(page: Page): Promise<void> {
  await expect(page.locator('#pinned-messages')).toBeVisible({ timeout: 5000 }).catch(() => undefined);
  await expect(page.locator('[data-task-surface="summary"]').first()).toBeVisible({ timeout: 5000 }).catch(() => undefined);
  await expect(page.locator('.msg-file[data-loading="1"]')).toHaveCount(0, { timeout: 2000 }).catch(() => undefined);
  await waitForChatIdle(page);
}

async function gotoChat(page: Page, base: string, roomId: string): Promise<void> {
  await page.goto(`${base}/c/${roomId}`);
  await expect(page.locator('#messages .msg').last()).toBeVisible();
  await waitForChatStable(page);
}

const TARGETS = [
  '会话行',
  '消息气泡',
  '消息头像',
  '文件卡',
  '任务卡',
  '群成员头像',
] as const;
type TargetName = (typeof TARGETS)[number];

test.describe('右键菜单逐帧像素回归', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  let base = '';
  let tokenA = '';
  let groupId = '';
  let agentName = '';
  let fileSent = false;

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    const tokenC = crypto.randomUUID();
    agentName = `闪烁 Agent ${suffix}`;

    await callTool<{ actor_id: string }>(base, tokenA, 'network_register', {
      request_id: requestId('e2e_flash_reg'),
      kind: 'human',
      name: `闪烁主人 ${suffix}`,
      device_id: `e2e-flash-${suffix}-a`,
    });
    const b = await callTool<{ actor_id: string }>(base, tokenB, 'network_register', {
      request_id: requestId('e2e_flash_reg'),
      kind: 'human',
      name: `闪烁好友 ${suffix}`,
      device_id: `e2e-flash-${suffix}-b`,
    });
    const c = await registerAgent(base, tokenC, agentName);

    await contact(base, tokenA, tokenB, b.actor_id);

    const group = await callTool<{ room: { room_id: string } }>(base, tokenA, 'network_room_create', {
      request_id: requestId('e2e_flash_group'),
      kind: 'group',
      title: `闪烁群 ${suffix}`,
      members: [b.actor_id, c.actor_id],
    });
    groupId = group.room.room_id;

    for (let index = 0; index < 6; index += 1) {
      await callTool(base, tokenB, 'network_message_send', {
        request_id: requestId('e2e_flash_send'),
        client_message_id: requestId('e2e_flash_cm'),
        room_id: groupId,
        body: `右键闪烁探针消息 ${index}`,
        invoke: [],
      });
    }

    const probeFiles: { name: string; mime: string; body: Buffer }[] = [
      { name: '闪烁探针.txt', mime: 'text/plain', body: Buffer.from('flash probe') },
      { name: '闪烁探针.md', mime: 'text/markdown', body: Buffer.from('# 闪烁探针\n\n预览正文') },
      {
        name: '闪烁探针.html',
        mime: 'text/html',
        body: Buffer.from('<!doctype html><h1>闪烁探针</h1><p>html preview</p>'),
      },
      { name: '闪烁探针.png', mime: 'image/png', body: PIXEL_PNG },
      { name: '闪烁探针.pdf', mime: 'application/pdf', body: MINIMAL_PDF },
    ];
    for (const file of probeFiles) {
      const uploaded = await uploadProbeFile(base, tokenB, file.name, file.mime, file.body);
      await callTool(base, tokenB, 'network_room_file_bind', {
        request_id: requestId('e2e_flash_bind'),
        room_id: groupId,
        file_id: uploaded.fileId,
      });
      await callTool(base, tokenB, 'network_file_publish', {
        request_id: requestId('e2e_flash_publish'),
        room_id: groupId,
        file_id: uploaded.fileId,
        public: true,
      });
      await callTool(base, tokenB, 'network_message_send', {
        request_id: requestId('e2e_flash_send_file'),
        client_message_id: requestId('e2e_flash_cm_file'),
        room_id: groupId,
        body: `闪烁文件卡片 ${file.name}\n[${file.name}](${uploaded.publicUrl})`,
        invoke: [],
      });
    }
    fileSent = true;

    // 任务卡与置顶区需要真实数据；群主操作，失败会直接影响对应用例。
    const history = await callTool<{
      items: { message_id: string; preview: string }[];
    }>(base, tokenA, 'network_history_list', { room_id: groupId, limit: 50 });
    const taskMessage = history.items.find((item) => item.preview.includes('右键闪烁探针消息 3'));
    if (!taskMessage) throw new Error('没有找到用于标记 Task 的消息');
    await callTool(base, tokenA, 'network_task_mark', {
      request_id: requestId('e2e_flash_task'),
      room_id: groupId,
      message_id: taskMessage.message_id,
    });
    const pinnedMessage = history.items.find((item) => item.preview.includes('右键闪烁探针消息 5'));
    if (!pinnedMessage) throw new Error('没有找到用于置顶的消息');
    await callTool(base, tokenA, 'network_room_message_pin', {
      request_id: requestId('e2e_flash_pin'),
      room_id: groupId,
      message_id: pinnedMessage.message_id,
      pinned: true,
    });

    const detail = await callTool<{ room: { announcement_revision: number } }>(
      base,
      tokenA,
      'network_room_get',
      { room_id: groupId },
    );
    await callTool(base, tokenA, 'network_room_announcement_set', {
      request_id: requestId('e2e_flash_announcement'),
      room_id: groupId,
      announcement: '闪烁探针公告',
      expected_announcement_revision: detail.room.announcement_revision,
    });
  });

  test.beforeEach(async ({ page }) => {
    await login(page, tokenA);
  });

  async function targetFor(page: Page, name: TargetName): Promise<{ target: Locator; menu: string }> {
    switch (name) {
      case '会话行': {
        await page.goto(`${base}/`);
        const row = page.locator(`#room-list a[data-room-id="${groupId}"]`);
        await expect(row).toBeVisible();
        return { target: row, menu: '#room-row-menu' };
      }
      case '消息气泡': {
        await gotoChat(page, base, groupId);
        return { target: page.locator('.msg:not(.mine) .bubble').last(), menu: '#message-context-menu' };
      }
      case '消息头像': {
        await gotoChat(page, base, groupId);
        return { target: page.locator('.msg:not(.mine) .msg-avatar').last(), menu: '#message-context-menu' };
      }
      case '文件卡': {
        await gotoChat(page, base, groupId);
        expect(fileSent).toBe(true);
        return { target: page.locator('.msg-file').last(), menu: '#message-context-menu' };
      }
      case '任务卡': {
        await gotoChat(page, base, groupId);
        const summary = page.locator('[data-task-surface="summary"]').first();
        await expect(summary).toBeVisible();
        return { target: summary, menu: '#message-context-menu' };
      }
      case '群成员头像': {
        await gotoChat(page, base, groupId);
        await page.locator('#members-button').click();
        await expect(page.locator('#members-modal')).toBeVisible();
        return {
          target: page
            .locator('#members-modal .member-roster-item', { hasText: agentName })
            .locator('.memory-avatar-trigger'),
          menu: '#memory-avatar-menu',
        };
      }
    }
  }

  for (const theme of ['light', 'dark'] as const) {
    test.describe(theme === 'light' ? '浅色' : '深色', () => {
      test.use({ colorScheme: theme });

      for (const name of TARGETS) {
        test(`${name}：20 次右键都没有空白首帧`, async ({ page, context }) => {
          const cdp = await context.newCDPSession(page);
          const { target, menu } = await targetFor(page, name);
          await expect(target).toBeVisible();

          for (let run = 0; run < RUNS; run += 1) {
            const captured = await captureMenu(page, cdp, target, menu);
            expect(captured.frames[0]?.width, 'screencast 与视口尺寸不一致').toBe(1280);
            assertNoBlankFrame(captured);

            await page.keyboard.press('Escape');
            await expect(page.locator(menu)).toBeHidden();
            // 等 Lenso 卸载完成，避免下一次右键仍处于退场状态。
            await page.waitForTimeout(24);
          }

          // 首帧检查不替代交互：最后一次打开后确认菜单可定位、可 Esc 关闭。
          const final = await captureMenu(page, cdp, target, menu);
          expect(final.box.width).toBeGreaterThan(100);
          expect(final.box.height).toBeGreaterThanOrEqual(44);
          const firstItem = page.locator(`${menu} [role="menuitem"]`).first();
          await expect(firstItem).toBeVisible();
          const itemBox = await firstItem.boundingBox();
          expect(itemBox?.height ?? 0).toBeGreaterThanOrEqual(24);
          await page.keyboard.press('Escape');
          await expect(page.locator(menu)).toBeHidden();
        });
      }
    });
  }

  /** 等聊天列表停止滚动/重排；首屏平滑滚底与文件卡元数据都会改变基线。 */
  async function waitForChatIdle(page: Page): Promise<void> {
    await page.evaluate(() => new Promise<void>((resolve) => {
      const element = document.querySelector<HTMLElement>('#messages');
      if (!element) { resolve(); return; }
      let last = element.scrollTop;
      let stableSince = performance.now();
      const tick = () => {
        if (element.scrollTop !== last) {
          last = element.scrollTop;
          stableSince = performance.now();
        }
        if (performance.now() - stableSince >= 150) resolve();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }));
  }

  /** 等置顶区、Task 摘要与文件卡元数据都落位，避免把晚到的布局变化算成右键闪烁。 */
  async function waitForChatStable(page: Page): Promise<void> {
    await expect(page.locator('#pinned-messages')).toBeVisible({ timeout: 5000 }).catch(() => undefined);
    await expect(page.locator('[data-task-surface="summary"]').first()).toBeVisible({ timeout: 5000 }).catch(() => undefined);
    await expect(page.locator('.msg-file[data-loading="1"]')).toHaveCount(0, { timeout: 2000 }).catch(() => undefined);
    await waitForChatIdle(page);
  }

  /** 确保文件栏打开；默认偏好可能因上一用例/本机存储不同。 */
  async function ensureFilesPane(page: Page): Promise<void> {
    if ((await page.locator('#files-toggle').getAttribute('aria-expanded')) !== 'true') {
      await page.locator('#files-toggle').click();
    }
    await expect(page.locator('#files-pane')).toBeVisible();
  }

  /** 打开消息里的文件卡片预览；图片点缩略图，其他类型点“预览”。 */
  async function openFileCard(page: Page, name: string): Promise<void> {
    const card = page.locator('.msg-file').filter({ hasText: name }).last();
    await card.scrollIntoViewIfNeeded();
    await expect(card).toBeVisible();
    const thumb = card.locator('.msg-file-thumb');
    if ((await thumb.count()) > 0 && (await thumb.first().isVisible())) {
      await thumb.first().click();
    } else {
      const preview = card.locator('.msg-file-preview');
      await expect(preview).toBeVisible();
      await preview.click();
    }
  }

  /** 长按 500ms：合成 touch pointer 事件，菜单由适配器自身的计时器打开。 */
  async function longPress(page: Page, target: Locator): Promise<void> {
    const dispatch = (type: 'pointerdown' | 'pointerup') => target.evaluate((element, eventType) => {
      element.dispatchEvent(new PointerEvent(eventType, {
        bubbles: true,
        cancelable: true,
        pointerType: 'touch',
        pointerId: 1,
        isPrimary: true,
        clientX: 60,
        clientY: 140,
        button: 0,
        buttons: eventType === 'pointerdown' ? 1 : 0,
      }));
    }, type);
    await dispatch('pointerdown');
    await page.waitForTimeout(650);
    await dispatch('pointerup');
  }

  /** 目标之外的平均亮度变化；用来发现整屏/大面积重绘，不把目标自身焦点环算进去。 */
  function assertNoLargeChangeOutside(
    frames: LumaImage[],
    box: RasterRect,
    label: string,
  ): void {
    expect(frames.length, `${label}：screencast 没有帧`).toBeGreaterThan(0);
    const first = frames[0]!;
    // 焦点环可能落在目标盒外几像素；把目标周围 20px 一并排除，只检查真正
    // 远离触发点的区域，避免把输入框 focus ring 当成整屏闪烁。
    const padded = clampRect(
      { x: box.x - 20, y: box.y - 20, width: box.width + 40, height: box.height + 40 },
      first.width,
      first.height,
    );
    const regions = [
      { x: 0, y: 0, width: padded.x, height: first.height },
      { x: padded.x + padded.width, y: 0, width: first.width - padded.x - padded.width, height: first.height },
      { x: padded.x, y: 0, width: padded.width, height: padded.y },
      { x: padded.x, y: padded.y + padded.height, width: padded.width, height: first.height - padded.y - padded.height },
    ]
      .map((rect) => clampRect(rect, first.width, first.height))
      .filter((rect) => rect.width > 0 && rect.height > 0);
    let max = 0;
    let worst = 0;
    for (let index = 1; index < frames.length; index += 1) {
      for (const rect of regions) {
        const diff = meanAbsDiff(frames[index]!, first, rect);
        if (diff > max) {
          max = diff;
          worst = index;
        }
      }
    }
    expect(max, `${label}：菜单外出现大面积变化（frame ${worst}，Δ=${max.toFixed(2)}）`)
      .toBeLessThan(NATIVE_OUTSIDE_DELTA);
  }

  /**
   * 原生右键区域：没有自定义菜单时保留浏览器菜单，应用本身不应挂载浮层或
   * 大面积重绘。这些区域在父提交上通常也通过，用于防止后续统一拦截或
   * 背景层改动把原生菜单路径带出新的闪烁。
   */
  function nativeScenarios(page: Page): {
    name: string;
    setup?: () => Promise<void>;
    target: () => Locator;
  }[] {
    return [
      { name: '聊天头部群名', target: () => page.locator('#title') },
      { name: '聊天头部更多按钮', target: () => page.locator('#room-menu-toggle') },
      { name: '聊天头部公告按钮', target: () => page.locator('#room-announcement-info') },
      { name: 'Composer 输入框', target: () => page.locator('#body') },
      {
        name: '群成员弹窗行',
        setup: async () => {
          await page.locator('#members-button').click();
          await expect(page.locator('#members-modal')).toBeVisible();
        },
        target: () => page.locator('#members-modal .member-roster-name').first(),
      },
      {
        name: 'Files 面板行',
        setup: () => ensureFilesPane(page),
        target: () => page.locator('#files-pane .file-row').first(),
      },
      { name: '置顶区', target: () => page.locator('#pinned-messages') },
      {
        name: 'Task dock 行',
        setup: async () => {
          if ((await page.locator('#task-dock-toggle').getAttribute('aria-expanded')) !== 'true') {
            await page.locator('#task-dock-toggle').click();
          }
          await expect(page.locator('#task-dock-panel')).toBeVisible();
        },
        target: () => page.locator('.task-dock-item').first(),
      },
      {
        name: '搜索弹窗结果',
        setup: async () => {
          await page.locator('#message-search-button').click();
          await page.locator('#message-search-input').fill('探针');
          await page.locator('#message-search-form').press('Enter');
          await expect(page.locator('.message-search-result').first()).toBeVisible();
        },
        target: () => page.locator('.message-search-result').first(),
      },
      {
        name: 'Memory 抽屉',
        setup: async () => {
          await page.locator('#memory-open').click();
          await expect(page.locator('#memory-drawer')).toBeVisible();
        },
        target: () => page.locator('#memory-drawer'),
      },
      {
        name: '文本预览',
        setup: async () => {
          await openFileCard(page, '闪烁探针.txt');
          await expect(page.locator('#file-preview')).toBeVisible();
          await expect(page.locator('#file-preview-body')).toBeVisible();
        },
        target: () => page.locator('#file-preview-body'),
      },
      {
        name: '图片预览',
        setup: async () => {
          await openFileCard(page, '闪烁探针.png');
          await expect(page.locator('#file-preview-body img')).toBeVisible();
        },
        target: () => page.locator('#file-preview-body img'),
      },
      {
        name: 'Markdown 预览',
        setup: async () => {
          await openFileCard(page, '闪烁探针.md');
          await expect(page.locator('#file-preview-pane .file-preview-markdown')).toBeVisible();
        },
        target: () => page.locator('#file-preview-pane .file-preview-markdown'),
      },
      {
        name: 'HTML 预览 iframe',
        setup: async () => {
          await openFileCard(page, '闪烁探针.html');
          await expect(page.locator('#file-preview-pane iframe')).toBeVisible();
        },
        target: () => page.locator('#file-preview-pane iframe'),
      },
      {
        name: 'PDF 预览 iframe',
        setup: async () => {
          await openFileCard(page, '闪烁探针.pdf');
          await expect(page.locator('#file-preview iframe')).toBeVisible();
        },
        target: () => page.locator('#file-preview iframe'),
      },
      {
        name: '画板 canvas',
        setup: async () => {
          await page.locator('#attach-file').click();
          await expect(page.locator('#attach-menu')).toBeVisible();
          await page.locator('#attach-menu-draw').click();
          await expect(page.locator('#db-canvas')).toBeVisible({ timeout: 20_000 });
        },
        // Fabric 会在 #db-canvas 上叠一张 upper-canvas；右键落在 stage 容器上，
        // 事件仍由画布接收，但命中检测不会被下层 canvas 挡住。
        target: () => page.locator('#db-stage'),
      },
      { name: '账号菜单入口', target: () => page.locator('#account') },
      {
        name: '已归档 Agents 弹窗',
        setup: async () => {
          await page.locator('#archived-agents').click();
          await expect(page.locator('#archive-popover')).toBeVisible();
        },
        target: () => page.locator('#archive-popover'),
      },
    ];
  }

  for (const theme of ['light', 'dark'] as const) {
    test.describe(`原生右键区域:${theme === 'light' ? '浅色' : '深色'}`, () => {
      test.use({ colorScheme: theme });

      test('原生菜单路径不挂载浮层、不触发菜单外大面积重绘', async ({ page, context }) => {
        test.setTimeout(180_000);
        const cdp = await context.newCDPSession(page);
        const chatUrl = `${base}/c/${groupId}`;
        for (const scenario of nativeScenarios(page)) {
          await page.goto(chatUrl);
          await expect(page.locator('#messages .msg').last()).toBeVisible();
          await page.waitForTimeout(250);
          await waitForChatStable(page);
          await scenario.setup?.();
          const target = scenario.target();
          await target.scrollIntoViewIfNeeded().catch(() => undefined);
          await expect(target, `${scenario.name}：目标不可见`).toBeVisible();

          const menusBefore = await page.locator('[role="menu"]:visible').count();
          await page.evaluate(() => {
            (window as unknown as { __ctx: boolean[] }).__ctx = [];
            window.addEventListener('contextmenu', (event) => {
              (window as unknown as { __ctx: boolean[] }).__ctx.push(event.defaultPrevented);
            }, { once: true });
          });
          const frames = await captureFrames(page, cdp, 320, () =>
            target.click({ button: 'right' }));
          const events = await page.evaluate(() =>
            (window as unknown as { __ctx: boolean[] }).__ctx ?? []);
          // iframe 内的 contextmenu 不会冒泡到父文档；其余区域必须保留原生菜单。
          if (!(await target.evaluate((element) => element.tagName === 'IFRAME').catch(() => false))) {
            expect(events.length, `${scenario.name}：没有收到 contextmenu`).toBeGreaterThan(0);
            expect(events.some(Boolean), `${scenario.name}：原生菜单被 preventDefault`).toBe(false);
          }
          expect(
            await page.locator('[role="menu"]:visible').count(),
            `${scenario.name}：右键挂载了自定义菜单`,
          ).toBe(menusBefore);
          const box = await target.boundingBox();
          if (!box) throw new Error(`${scenario.name}：目标没有布局盒`);
          assertNoLargeChangeOutside(frames, box, scenario.name);
          await page.keyboard.press('Escape');
        }
      });
    });
  }

  const MENU_PROBES = [
    { name: '头部会话菜单', trigger: '#room-menu-toggle', menu: '#room-menu' },
    { name: '附件菜单', trigger: '#attach-file', menu: '#attach-menu' },
  ] as const;

  for (const theme of ['light', 'dark'] as const) {
    test.describe(`Lenso 下拉菜单首帧:${theme === 'light' ? '浅色' : '深色'}`, () => {
      test.use({ colorScheme: theme });

      for (const probe of MENU_PROBES) {
        test(`${probe.name}：首帧就带完整条目`, async ({ page, context }) => {
          const cdp = await context.newCDPSession(page);
          await gotoChat(page, base, groupId);
          for (let run = 0; run < MATRIX_RUNS; run += 1) {
            const frames = await captureFrames(page, cdp, MATRIX_MS, () =>
              page.locator(probe.trigger).click(), probe.menu);
            const box = await page.locator(probe.menu).boundingBox();
            if (!box) throw new Error(`${probe.name}：菜单没有布局盒`);
            assertNoBlankShell(frames, box, MENU_TEXT_RATIO);
            await page.keyboard.press('Escape');
            await expect(page.locator(probe.menu)).toBeHidden();
            await page.waitForTimeout(30);
          }
        });
      }

      test('消息操作菜单：首帧就带完整条目', async ({ page, context }) => {
        const cdp = await context.newCDPSession(page);
        await gotoChat(page, base, groupId);
        const row = page.locator('.msg:not(.mine)').last();
        for (let run = 0; run < MATRIX_RUNS; run += 1) {
          await row.hover();
          await page.waitForTimeout(120);
          const frames = await captureFrames(page, cdp, MATRIX_MS, () =>
            row.locator('.message-actions-trigger').click(), '#message-action-menu');
          const box = await page.locator('#message-action-menu').boundingBox();
          if (!box) throw new Error('消息操作菜单没有布局盒');
          assertNoBlankShell(frames, box, MENU_TEXT_RATIO);
          await page.keyboard.press('Escape');
          await expect(page.locator('#message-action-menu')).toBeHidden();
          await page.waitForTimeout(30);
        }
      });
    });
  }

  test.describe('390 账号菜单首帧', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('下拉菜单首帧就带完整条目', async ({ page, context }) => {
      const cdp = await context.newCDPSession(page);
      await gotoChat(page, base, groupId);
      for (let run = 0; run < MATRIX_RUNS; run += 1) {
        const frames = await captureFrames(page, cdp, MATRIX_MS, () =>
          page.locator('#account-menu-toggle').click(), '#account-menu');
        const box = await page.locator('#account-menu').boundingBox();
        if (!box) throw new Error('账号菜单没有布局盒');
        assertNoBlankShell(frames, box, MENU_TEXT_RATIO);
        await page.keyboard.press('Escape');
        await expect(page.locator('#account-menu')).toBeHidden();
        await page.waitForTimeout(30);
      }
    });
  });

  for (const theme of ['light', 'dark'] as const) {
    test.describe(`浮层叠右键:${theme === 'light' ? '浅色' : '深色'}`, () => {
      test.use({ colorScheme: theme });

      test('消息操作菜单打开时右键：旧菜单不残影', async ({ page, context }) => {
        const cdp = await context.newCDPSession(page);
        await gotoChat(page, base, groupId);
        const row = page.locator('.msg:not(.mine)').last();
        await row.hover();
        await page.waitForTimeout(120);
        await row.locator('.message-actions-trigger').click();
        await expect(page.locator('#message-action-menu')).toBeVisible();

        await page.evaluate(() => {
          const track = (window as unknown as { __overlap: unknown[] });
          track.__overlap = [];
          const tick = () => {
            const old = document.getElementById('message-action-menu');
            const next = document.getElementById('message-context-menu');
            const box = (element: HTMLElement | null) => {
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            };
            track.__overlap.push({
              old: box(old),
              oldDisplay: old ? getComputedStyle(old).display : 'absent',
              next: box(next),
            });
            if (next || !old) return;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const frames = await captureFrames(page, cdp, MATRIX_MS, () =>
          row.locator('.bubble').last().click({ button: 'right' }));
        const timeline = await page.evaluate(() =>
          (window as unknown as { __overlap: { old: boolean | null; oldDisplay: string; next: boolean | null }[] }).__overlap);
        const ghosts = timeline.filter((sample) => sample.next && sample.old);
        expect(ghosts, '新右键菜单可见时旧菜单仍在绘制').toEqual([]);
        expect(frames.length, '没有采集到右键帧').toBeGreaterThan(1);
        await page.keyboard.press('Escape');
      });

      test('头部会话菜单打开时右键：旧菜单不残影', async ({ page, context }) => {
        const cdp = await context.newCDPSession(page);
        await gotoChat(page, base, groupId);
        await page.locator('#room-menu-toggle').click();
        await expect(page.locator('#room-menu')).toBeVisible();
        await page.evaluate(() => {
          const track = (window as unknown as { __overlap: unknown[] });
          track.__overlap = [];
          const tick = () => {
            const old = document.getElementById('room-menu');
            const next = document.getElementById('message-context-menu');
            const box = (element: HTMLElement | null) => {
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0;
            };
            track.__overlap.push({
              old: box(old),
              oldDisplay: old ? getComputedStyle(old).display : 'absent',
              next: box(next),
            });
            if (next || !old) return;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        const frames = await captureFrames(page, cdp, MATRIX_MS, () =>
          page.locator('.msg:not(.mine) .bubble').last().click({ button: 'right' }));
        const timeline = await page.evaluate(() =>
          (window as unknown as { __overlap: { old: boolean | null; oldDisplay: string; next: boolean | null }[] }).__overlap);
        expect(timeline.filter((sample) => sample.next && sample.old),
          '新右键菜单可见时旧头部菜单仍在绘制').toEqual([]);
        expect(frames.length, '没有采集到右键帧').toBeGreaterThan(1);
        await page.keyboard.press('Escape');
      });
    });
  }

  for (const theme of ['light', 'dark'] as const) {
    test.describe(`悬停/边缘状态:${theme === 'light' ? '浅色' : '深色'}`, () => {
      test.use({ colorScheme: theme });

      test('消息悬停操作按钮可见时右键', async ({ page, context }) => {
        const cdp = await context.newCDPSession(page);
        await gotoChat(page, base, groupId);
        const row = page.locator('.msg:not(.mine)').last();
        for (let run = 0; run < MATRIX_RUNS; run += 1) {
          await row.hover();
          await page.waitForTimeout(160);
          await expect(row.locator('.message-actions-trigger')).toBeVisible();
          const captured = await captureMenu(
            page, cdp, row.locator('.bubble').last(), '#message-context-menu', MATRIX_MS);
          assertNoBlankFrame(captured);
          await page.keyboard.press('Escape');
          await expect(page.locator('#message-context-menu')).toBeHidden();
          await page.waitForTimeout(30);
        }
      });

      test('tooltip 打开时右键', async ({ page, context }) => {
        const cdp = await context.newCDPSession(page);
        await gotoChat(page, base, groupId);
        const bubble = page.locator('.msg:not(.mine) .bubble').last();
        await bubble.scrollIntoViewIfNeeded();
        await waitForChatIdle(page);
        const box = await bubble.boundingBox();
        if (!box) throw new Error('消息气泡没有布局盒');
        // 直接移动鼠标，避免 Playwright 的 hover 二次滚动触发 tooltip 的
        // window scroll 监听，把刚出现的提示关掉。
        const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        for (let run = 0; run < MATRIX_RUNS; run += 1) {
          await page.mouse.move(point.x, point.y);
          await expect(page.locator('[role="tooltip"]')).toBeVisible({ timeout: 3000 });
          const captured = await captureMenu(page, cdp, bubble, '#message-context-menu', MATRIX_MS);
          assertNoBlankFrame(captured);
          await expect(page.locator('[role="tooltip"]')).toBeHidden();
          await page.keyboard.press('Escape');
          await expect(page.locator('#message-context-menu')).toBeHidden();
          await page.mouse.move(0, 0);
          await page.waitForTimeout(50);
        }
      });

      test('靠近视口顶部时右键，菜单定位稳定且没有空白首帧', async ({ page, context }) => {
        const cdp = await context.newCDPSession(page);
        await gotoChat(page, base, groupId);
        await page.locator('#messages').evaluate((element) => {
          element.scrollTop = 0;
        });
        const bubble = page.locator('.msg:not(.mine) .bubble').first();
        await expect(bubble).toBeVisible();
        const captured = await captureMenu(page, cdp, bubble, '#message-context-menu', MATRIX_MS);
        assertNoBlankFrame(captured);
        expect(captured.box.y).toBeGreaterThanOrEqual(8);
        expect(captured.box.y + captured.box.height).toBeLessThanOrEqual(800 - 8);
        await page.keyboard.press('Escape');
        await expect(page.locator('#message-context-menu')).toBeHidden();
      });
    });
  }

  test.describe('390 长按', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

    test('会话行长按 500ms 没有空白首帧', async ({ page, context }) => {
      test.setTimeout(60_000);
      const cdp = await context.newCDPSession(page);
      await page.goto(`${base}/`);
      const row = page.locator(`#room-list a[data-room-id="${groupId}"]`);
      await expect(row).toBeVisible();
      for (let run = 0; run < MATRIX_RUNS; run += 1) {
        const frames = await captureFrames(page, cdp, MATRIX_MS, () => longPress(page, row), '#room-row-menu');
        const box = await page.locator('#room-row-menu').boundingBox();
        if (!box) throw new Error('长按后没有会话行菜单');
        assertNoBlankShell(frames, box);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
        await page.keyboard.press('Escape');
        await expect(page.locator('#room-row-menu')).toBeHidden();
        await page.waitForTimeout(30);
      }
    });

    test('消息长按 500ms 没有空白首帧', async ({ page, context }) => {
      test.setTimeout(60_000);
      const cdp = await context.newCDPSession(page);
      await gotoChat(page, base, groupId);
      const row = page.locator('.msg:not(.mine)').last();
      for (let run = 0; run < MATRIX_RUNS; run += 1) {
        const frames = await captureFrames(page, cdp, MATRIX_MS, () => longPress(page, row), '#message-context-menu');
        const box = await page.locator('#message-context-menu').boundingBox();
        if (!box) throw new Error('长按后没有消息菜单');
        assertNoBlankShell(frames, box);
        await page.keyboard.press('Escape');
        await expect(page.locator('#message-context-menu')).toBeHidden();
        await page.waitForTimeout(30);
      }
    });
  });
});
