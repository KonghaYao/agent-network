import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 右键菜单瞬态闪烁回归。
 *
 * 真实 Bun 服务与 Chromium；消息、群成员与文件卡都走真实 MCP 工具。每种目标
 * 右键后逐动画帧采样 600ms：页面底色/根节点透明度、滚动尺寸、菜单 root 与
 * 内容层的透明度必须同步出现，不能先铺一块空白玻璃面再淡入条目。
 */

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

interface FlashFrame {
  t: number;
  html: {
    bg: string;
    opacity: string;
    filter: string;
    transform: string;
    scrollWidth: number;
    scrollHeight: number;
    scrollTop: number;
  };
  body: { bg: string; opacity: string; filter: string; transform: string };
  root: {
    bg: string;
    opacity: string;
    filter: string;
    transform: string;
    width: number;
    height: number;
  } | null;
  menu: {
    slot: string | null;
    popup: boolean;
    surfaceOpacity: number | null;
    contentOpacity: number | null;
    contentFilter: string | null;
    contentTransform: string | null;
    itemHeight: number;
    itemCount: number;
    width: number;
    height: number;
  } | null;
  fullscreen: string[];
}

/**
 * 在动画帧里采样；菜单出现后的任意一帧，只要玻璃面可见，内容层也必须可见。
 * 修复前 Lenso 会先画一块最终尺寸的玻璃面，再把条目从 opacity 0 淡入。
 */
async function installFlashProbe(page: Page, menuSelector: string): Promise<void> {
  await page.evaluate((selector) => {
    const signature = (element: Element) =>
      `${element.tagName}#${element.id}|${element.getAttribute('data-lenso-slot') ?? ''}|${element.getAttribute('role') ?? ''}|${String(element.className).slice(0, 120)}`;
    const visibleFullscreen = (element: Element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (rect.width < innerWidth * 0.95 || rect.height < innerHeight * 0.95) return false;
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) <= 0.01) return false;
      return (
        style.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
        style.backdropFilter !== 'none' ||
        style.backgroundImage !== 'none'
      );
    };
    const menuScope = '[role="menu"], [data-lenso-slot*="context-menu"], [data-lenso-slot*="menu"], [data-lenso-slot*="backdrop"], [data-lenso-slot*="scrim"], [data-material-live-paints], [data-lenso-live-rim], .spa-dialog-overlay';
    const baseline = new Set(
      [...document.querySelectorAll(menuScope)].filter(visibleFullscreen).map(signature),
    );
    const frames: FlashFrame[] = [];
    const started = performance.now();
    const probe = window as unknown as {
      __flashFrames: FlashFrame[];
      __flashStop: boolean;
    };
    probe.__flashFrames = frames;
    probe.__flashStop = false;
    const read = () => {
      const menu = document.querySelector<HTMLElement>(selector);
      const popup = menu?.querySelector<HTMLElement>('[data-lenso-slot="menu-popup"]') ?? null;
      const surface = popup?.querySelector<HTMLElement>(':scope > [data-lenso-slot="menu-surface"]') ?? null;
      const content = popup?.querySelector<HTMLElement>(':scope > [data-lenso-slot="menu-content"]') ?? null;
      const items = menu ? [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
      const firstItem = items.find((item) => {
        const rect = item.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const htmlStyle = getComputedStyle(document.documentElement);
      const bodyStyle = getComputedStyle(document.body);
      const rootNode = document.getElementById('root');
      const rootStyle = rootNode ? getComputedStyle(rootNode) : null;
      const rootRect = rootNode?.getBoundingClientRect();
      const menuRect = menu?.getBoundingClientRect();
      frames.push({
        t: Math.round(performance.now() - started),
        html: {
          bg: htmlStyle.backgroundColor,
          opacity: htmlStyle.opacity,
          filter: htmlStyle.filter,
          transform: htmlStyle.transform,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          scrollTop: document.documentElement.scrollTop,
        },
        body: {
          bg: bodyStyle.backgroundColor,
          opacity: bodyStyle.opacity,
          filter: bodyStyle.filter,
          transform: bodyStyle.transform,
        },
        root: rootStyle
          ? {
              bg: rootStyle.backgroundColor,
              opacity: rootStyle.opacity,
              filter: rootStyle.filter,
              transform: rootStyle.transform,
              width: Math.round(rootRect?.width ?? 0),
              height: Math.round(rootRect?.height ?? 0),
            }
          : null,
        menu: menu
          ? {
              slot: menu.getAttribute('data-lenso-slot'),
              popup: Boolean(popup),
              surfaceOpacity: surface ? Number(getComputedStyle(surface).opacity) : null,
              contentOpacity: content ? Number(getComputedStyle(content).opacity) : null,
              contentFilter: content ? getComputedStyle(content).filter : null,
              contentTransform: content ? getComputedStyle(content).transform : null,
              itemHeight: Math.round(firstItem?.getBoundingClientRect().height ?? 0),
              itemCount: items.length,
              width: Math.round(menuRect?.width ?? 0),
              height: Math.round(menuRect?.height ?? 0),
            }
          : null,
        fullscreen: [...document.querySelectorAll(menuScope)]
          .filter(visibleFullscreen)
          .map(signature)
          .filter((entry) => !baseline.has(entry)),
      });
      if (!probe.__flashStop) requestAnimationFrame(read);
    };
    requestAnimationFrame(read);
  }, menuSelector);
}

async function readFlashProbe(page: Page): Promise<FlashFrame[]> {
  return page.evaluate(() => {
    const probe = window as unknown as {
      __flashFrames: FlashFrame[];
      __flashStop: boolean;
    };
    probe.__flashStop = true;
    return probe.__flashFrames;
  });
}

function assertNoPageFlash(frames: FlashFrame[]): void {
  expect(frames.length).toBeGreaterThan(10);
  const pageStates = new Set(
    frames.map((frame) =>
      JSON.stringify([
        frame.html.bg,
        frame.html.opacity,
        frame.html.filter,
        frame.html.transform,
        frame.body.bg,
        frame.body.opacity,
        frame.body.filter,
        frame.body.transform,
        frame.root?.bg,
        frame.root?.opacity,
        frame.root?.filter,
        frame.root?.transform,
      ]),
    ),
  );
  expect(pageStates.size, [...pageStates].join('\n')).toBe(1);
  const scrollStates = new Set(
    frames.map((frame) => `${frame.html.scrollWidth}x${frame.html.scrollHeight}@${frame.html.scrollTop}`),
  );
  expect(scrollStates.size, [...scrollStates].join('\n')).toBe(1);
  const rootSizes = new Set(frames.map((frame) => `${frame.root?.width}x${frame.root?.height}`));
  expect(rootSizes.size, [...rootSizes].join('\n')).toBe(1);
  for (const frame of frames) {
    expect(frame.fullscreen, `t=${frame.t}`).toEqual([]);
  }
}

function assertMaterialAndContentTogether(frames: FlashFrame[]): void {
  const menuFrames = frames.filter((frame) => frame.menu);
  expect(menuFrames.length).toBeGreaterThan(3);
  expect(menuFrames.some((frame) => frame.menu?.slot === 'context-menu-layout')).toBe(true);
  const lensoFrames = menuFrames.filter(
    (frame) => frame.menu?.popup === true && frame.menu.surfaceOpacity !== null && frame.menu.contentOpacity !== null,
  );
  expect(lensoFrames.length).toBeGreaterThan(3);
  for (const frame of lensoFrames) {
    const { surfaceOpacity, contentOpacity, itemHeight, itemCount } = frame.menu!;
    if (surfaceOpacity !== null && surfaceOpacity > 0.5) {
      // 修复前 contentOpacity 为 0 而玻璃面已完全可见；两者必须同帧出现。
      expect(contentOpacity ?? 0, `t=${frame.t} surface=${surfaceOpacity}`).toBeGreaterThan(0.5);
      expect(itemHeight, `t=${frame.t}`).toBeGreaterThanOrEqual(24);
      expect(itemCount, `t=${frame.t}`).toBeGreaterThan(0);
    }
  }
}

async function assertMenuInteractive(menu: Locator): Promise<void> {
  await expect(menu).toBeVisible();
  const first = menu.locator('[role="menuitem"]:not([aria-disabled="true"])').first();
  await expect(first).toBeVisible();
  const box = await first.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(24);
}

async function probeRightClick(
  page: Page,
  target: Locator,
  menuSelector: string,
): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  await installFlashProbe(page, menuSelector);
  await target.click({ button: 'right' });
  await page.waitForTimeout(620);
  const frames = await readFlashProbe(page);
  assertNoPageFlash(frames);
  assertMaterialAndContentTogether(frames);
  await assertMenuInteractive(page.locator(menuSelector));
}

test.describe('右键菜单瞬态闪烁', () => {
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

  test('会话行右键：玻璃面与条目同帧出现，页面不闪、滚动不跳', async ({ page }) => {
    await page.goto(`${base}/`);
    const row = page.locator(`#room-list a[data-room-id="${groupId}"]`);
    await expect(row).toBeVisible();

    await probeRightClick(page, row, '#room-row-menu');

    const menu = page.locator('#room-row-menu');
    await expect(page.locator('#room-row-menu-pin')).toBeVisible();
    await page.locator('#room-row-menu-pin').click();
    await expect(menu).toBeHidden();
    await expect(row.locator('.room-pref-label')).toHaveText('置顶');
  });

  test('消息气泡、头像与文件卡右键：逐帧无空白玻璃面', async ({ page }) => {
    await page.goto(`${base}/c/${groupId}`);
    await expect(page.locator('#messages .msg').last()).toBeVisible();

    const bubble = page.locator('.msg:not(.mine) .bubble').last();
    await probeRightClick(page, bubble, '#message-context-menu');
    await page.locator('#message-action-quote').click();
    await expect(page.locator('#message-context-menu')).toBeHidden();
    await expect(page.locator('#composer-reply')).toBeVisible();
    await page.getByRole('button', { name: '取消引用' }).click();

    const avatar = page.locator('.msg:not(.mine) .msg-avatar').last();
    await probeRightClick(page, avatar, '#message-context-menu');
    await page.keyboard.press('Escape');
    await expect(page.locator('#message-context-menu')).toBeHidden();

    expect(fileSent).toBe(true);
    const file = page.locator('.msg-file').last();
    await expect(file).toBeVisible();
    await probeRightClick(page, file, '#message-context-menu');
    await page.keyboard.press('Escape');
    await expect(page.locator('#message-context-menu')).toBeHidden();
  });

  test('群成员头像右键：菜单与内容同步出现并保持可关闭', async ({ page }) => {
    await page.goto(`${base}/c/${groupId}`);
    await expect(page.locator('#messages .msg').last()).toBeVisible();
    await page.locator('#members-button').click();
    const modal = page.locator('#members-modal');
    await expect(modal).toBeVisible();
    const avatar = modal
      .locator('.member-roster-item', { hasText: agentName })
      .locator('.memory-avatar-trigger');
    await expect(avatar).toBeVisible();

    await probeRightClick(page, avatar, '#memory-avatar-menu');
    await page.keyboard.press('Escape');
    await expect(page.locator('#memory-avatar-menu')).toBeHidden();
    await expect(modal).toBeVisible();
  });
});
