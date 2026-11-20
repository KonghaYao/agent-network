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
/** 菜单框外 28px 内是投影；用投影判断“菜单壳已出现”。 */
const SHADOW_THRESHOLD = 0.6;
/** 菜单内部亮度变化超过该值，说明玻璃面已经绘制。 */
const SURFACE_THRESHOLD = 0.3;
/** 文字掩码位置上的平均局部对比度；空白玻璃面接近 0。 */
const TEXT_THRESHOLD = 8;

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
 * 右键一次并抓取合成帧。先等到一帧 pre-open 画面再点击，首帧即基线；停止
 * screencast 后再解码，避免 PNG 解码阻塞 CDP 的帧确认。
 */
async function captureMenu(
  page: Page,
  cdp: CDPSession,
  target: Locator,
  menuSelector: string,
): Promise<CapturedMenu> {
  const payloads: Buffer[] = [];
  const onFrame = (event: { data: string; sessionId: number }) => {
    payloads.push(Buffer.from(event.data, 'base64'));
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
    // 首帧落袋后再点击，保证 frames[0] 是菜单出现前的基线。
    await page.waitForTimeout(24);
    await target.click({ button: 'right' });
    await page.waitForTimeout(CAPTURE_MS);
    const menu = page.locator(menuSelector);
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    if (!box) throw new Error(`菜单没有布局盒：${menuSelector}`);
    return { frames: payloads.map((payload) => decodePngLuma(payload)), box };
  } finally {
    await cdp.send('Page.stopScreencast').catch(() => undefined);
    cdp.off('Page.screencastFrame', onFrame);
    // 停止后仍可能有在途帧，等一下再返回，避免把残帧算进下一次。
    await page.waitForTimeout(40);
  }
}

function assertNoBlankFrame(captured: CapturedMenu): void {
  const { frames, box } = captured;
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
    } else if (shadow > SHADOW_THRESHOLD && innerDiff >= SURFACE_THRESHOLD && text < TEXT_THRESHOLD) {
      blankFrames.push(
        `frame ${index}: 玻璃面已绘制但没有文字（inner=${innerDiff.toFixed(2)} text=${text.toFixed(1)}）`,
      );
    }
    if (innerDiff >= SURFACE_THRESHOLD && text >= TEXT_THRESHOLD) textFrames += 1;
  }
  expect(textFrames, '整段采样都没有看到菜单文字').toBeGreaterThan(0);
  expect(blankFrames, `出现空白菜单帧：\n${blankFrames.join('\n')}`).toEqual([]);
}

async function gotoChat(page: Page, base: string, roomId: string): Promise<void> {
  await page.goto(`${base}/c/${roomId}`);
  await expect(page.locator('#messages .msg').last()).toBeVisible();
}

const TARGETS = [
  '会话行',
  '消息气泡',
  '消息头像',
  '文件卡',
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

    const fileBody = Buffer.from('flash probe');
    const upload = await fetch(`${base}/mcp-upload`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokenB}`,
        'MCPP-Files-Version': '1',
        'content-type': 'text/plain',
        'MCPP-File-Name': encodeURIComponent('闪烁探针.txt'),
        'MCPP-File-Size': String(fileBody.length),
      },
      body: fileBody,
    });
    if (upload.status !== 201) throw new Error(`文件上传失败：HTTP ${upload.status}`);
    const uploaded = (await upload.json()) as { fileId: string; publicUrl: string };
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
      body: `闪烁文件卡片\n[闪烁探针.txt](${uploaded.publicUrl})`,
      invoke: [],
    });
    fileSent = true;
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
});
