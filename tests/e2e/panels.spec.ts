import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { semanticColor } from './fixtures/semantic-colors';

/**
 * 4B-5 右侧面板与剩余入口：文件、网页监控、画板、Memory、新建 Agent、
 * 管理权交接与群主转让。
 */

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

interface RoomList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface RoomDetail {
  room: {
    room_id: string;
    kind: string;
    my_role: string;
    owner_transfer: { transfer_id: string; version: number } | null;
  };
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

async function login(page: Page, base: string, token: string): Promise<void> {
  await page.addInitScript((value) => {
    try {
      localStorage.setItem('agent-network-token', value);
      localStorage.removeItem('agent-network-logged-out');
    } catch {
      // 浏览器禁用存储时由页面错误态兜底。
    }
  }, token);
  await page.goto(base);
}

test.describe('SPA 右栏与剩余入口', () => {

  let base = '';
  let tokenA = '';
  let tokenB = '';
  let nameA = '';
  let nameB = '';
  let roomId = '';
  let groupId = '';
  let agentId = '';
  let agentToken = '';
  let agentName = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    tokenB = crypto.randomUUID();
    nameA = `Panel A ${suffix}`;
    nameB = `Panel B ${suffix}`;
    agentName = `Panel Agent ${suffix}`;

    const a = await callTool<Registered>(base, tokenA, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: nameA,
      device_id: `e2e-panel-${suffix}-a`,
    });
    const b = await callTool<Registered>(base, tokenB, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: nameB,
      device_id: `e2e-panel-${suffix}-b`,
    });
    const contact = await callTool<ContactRequestResult>(base, tokenA, 'network_contact_request', {
      request_id: requestId('e2e_contact'),
      actor_id: b.actor_id,
    });
    const contactRequestId = contact.request?.contact_request_id;
    if (!contactRequestId) throw new Error('好友申请未创建');
    await callTool(base, tokenB, 'network_contact_request_respond', {
      request_id: requestId('e2e_contact'),
      contact_request_id: contactRequestId,
      action: 'accept',
    });

    const rooms = await callTool<RoomList>(base, tokenA, 'network_rooms_list', { limit: 50 });
    const direct = rooms.items.find(
      (room) => room.kind === 'direct' && room.peer?.actor_id === b.actor_id,
    );
    if (!direct) throw new Error('好友通过后未生成 direct 会话');
    roomId = direct.room_id;

    const group = await callTool<{ room: { room_id: string } }>(base, tokenA, 'network_room_create', {
      request_id: requestId('e2e_group'),
      kind: 'group',
      members: [b.actor_id, a.actor_id],
      title: `Panel Group ${suffix}`,
    });
    groupId = group.room.room_id;

    const agent = await callTool<{ actor_id: string; token: string }>(base, tokenA, 'network_agent_create', {
      request_id: requestId('e2e_agent'),
      name: agentName,
    });
    agentId = agent.actor_id;
    agentToken = agent.token;
    const agentRoom = await callTool<{ room: { room_id: string } }>(base, tokenA, 'network_room_create', {
      request_id: requestId('e2e_agent_room'),
      kind: 'direct',
      members: [agentId],
    });
    expect(agentRoom.room.room_id).toBeTruthy();
  });

  test('home-to-room navigation keeps the files pane styled', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, base, tokenA);
    await page.goto(base);
    await page.locator(`#room-list a[data-room-id="${roomId}"]`).click();
    await expect(page.locator('#files-pane')).toBeVisible();
    await expect(page.locator('.files-head')).toHaveCSS('display', 'flex');
    await expect(page.locator('#files-list')).toHaveCSS('list-style-type', 'none');
    await expect(page.locator('#files-pane')).toHaveCSS('display', 'flex');
  });

  test('files pane uploads, previews and deletes a file', async ({ page }) => {
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();
    await expect(page.locator('#title')).toHaveText(nameB);

    const fileName = `panel-${Date.now()}.txt`;
    await page.locator('#files-input').setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from('4B-5 files pane'),
    });
    const item = page.locator('#files-list .file-item').filter({ hasText: fileName });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#files-status')).toContainText('已上传');

    await item.getByRole('button', { name: '预览' }).click();
    await expect(page.locator('#file-preview')).toBeVisible();
    await expect(page.locator('#file-preview-title')).toHaveText(fileName);
    await expect(page.locator('#file-preview-body pre')).toContainText('4B-5 files pane');
    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview')).toBeHidden();

    await item.getByRole('button', { name: '删除' }).click();
    await item.getByRole('button', { name: '确认删除' }).click();
    await expect(item).toHaveCount(0, { timeout: 15_000 });
  });

  test('markdown preview renders, toggles source and sanitizes HTML', async ({ page }) => {
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();

    const fileName = `preview-${Date.now()}.md`;
    const markdown = [
      '# 标题一',
      '',
      '## 标题二',
      '',
      '- 列表项一',
      '- 列表项二',
      '',
      '> 引用内容',
      '',
      '```js',
      'const answer = 42;',
      '```',
      '',
      '<script>window.__mdXss = 1</script>',
      '<img src=x onerror="window.__mdXss = 2">',
      '',
      '[危险链接](javascript:alert(1))',
      '',
      '[安全链接](https://example.com/docs)',
    ].join('\n');
    await page.locator('#files-input').setInputFiles({
      name: fileName,
      mimeType: 'text/markdown',
      buffer: Buffer.from(markdown),
    });
    const item = page.locator('#files-list .file-item').filter({ hasText: fileName });
    await expect(item).toBeVisible({ timeout: 15_000 });

    await item.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#file-preview')).toBeVisible();
    const viewer = page.locator('#file-preview-body .file-preview-md-viewer');
    await expect(viewer.locator('h1')).toHaveText('标题一', { timeout: 15_000 });
    await expect(viewer.locator('h2')).toHaveText('标题二');
    await expect(viewer.locator('li')).toHaveCount(2);
    await expect(viewer.locator('blockquote')).toContainText('引用内容');
    await expect(viewer.locator('pre.md-pre')).toContainText('const answer = 42;');

    // 危险 HTML/协议不可执行，也不生成可点击链接。
    await expect(viewer.locator('script')).toHaveCount(0);
    await expect(viewer.locator('img')).toHaveCount(0);
    await expect(viewer.locator('[onerror]')).toHaveCount(0);
    await expect(viewer.locator('a[href^="javascript:"]')).toHaveCount(0);
    await expect(viewer.locator('a').filter({ hasText: '危险链接' })).toHaveCount(0);
    await expect(viewer).toContainText('危险链接');
    expect(await page.evaluate(() => (window as { __mdXss?: number }).__mdXss)).toBeUndefined();

    const safeLink = viewer.locator('a[href="https://example.com/docs"]');
    await expect(safeLink).toHaveAttribute('rel', 'noopener noreferrer nofollow');
    await expect(safeLink).toHaveAttribute('target', '_blank');

    const toggle = page.locator('#file-preview-body .file-preview-md-toggle');
    await expect(toggle).toHaveText('查看原文');
    await toggle.click();
    const source = page.locator('#file-preview-body .file-preview-md-source');
    await expect(source).toBeVisible();
    await expect(source).toContainText('# 标题一');
    await expect(viewer).toHaveCount(0);
    await expect(toggle).toHaveText('渲染视图');

    await toggle.click();
    await expect(page.locator('#file-preview-body .file-preview-md-viewer h1')).toHaveText(
      '标题一',
      { timeout: 15_000 },
    );
    await expect(toggle).toHaveText('查看原文');
    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview')).toBeHidden();

    // 扩展名兜底不依赖 MIME，且大小写不敏感。
    const extName = `UPPER-${Date.now()}.Markdown`;
    await page.locator('#files-input').setInputFiles({
      name: extName,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from('# 扩展名标题'),
    });
    const extItem = page.locator('#files-list .file-item').filter({ hasText: extName });
    await expect(extItem).toBeVisible({ timeout: 15_000 });
    await expect(extItem.locator('.file-thumb')).toHaveText('MD');
    await extItem.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#file-preview-body .file-preview-md-viewer h1')).toHaveText(
      '扩展名标题',
      { timeout: 15_000 },
    );
    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview')).toBeHidden();
  });

  test('markdown preview falls back to plain text for oversized and failed reads', async ({
    page,
  }) => {
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();

    const bigName = `big-${Date.now()}.md`;
    await page.locator('#files-input').setInputFiles({
      name: bigName,
      mimeType: 'text/markdown',
      buffer: Buffer.from(`# big\n\n${'x'.repeat(300 * 1024)}`),
    });
    const bigItem = page.locator('#files-list .file-item').filter({ hasText: bigName });
    await expect(bigItem).toBeVisible({ timeout: 15_000 });
    await bigItem.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#file-preview-body .file-preview-md-note')).toContainText(
      '文件较大，已显示纯文本前 256 KB。',
    );
    await expect(page.locator('#file-preview-body .file-preview-md-source')).toContainText('# big');
    await expect(page.locator('#file-preview-body .file-preview-md-toggle')).toHaveCount(0);
    await expect(page.locator('#file-preview-body .file-preview-md-viewer')).toHaveCount(0);
    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview')).toBeHidden();

    const failName = `fail-${Date.now()}.md`;
    await page.locator('#files-input').setInputFiles({
      name: failName,
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 读取失败\n\n正文'),
    });
    const failItem = page.locator('#files-list .file-item').filter({ hasText: failName });
    await expect(failItem).toBeVisible({ timeout: 15_000 });
    const fileId = await failItem.getAttribute('data-file-id');
    expect(fileId).toBeTruthy();
    await page.route(`**/f/${fileId}**`, (route) =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' }),
    );
    await failItem.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#file-preview-body pre')).toContainText('读取文本预览失败');
    await expect(page.locator('#file-preview-body .file-preview-md-toggle')).toHaveCount(0);
    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview')).toBeHidden();

    // 渲染器不可用：阻断 Markdown bundle，回退为纯文本而不是空白。
    await page.route('**/assets/chat-markdown.js', (route) => route.abort());
    const fallbackName = `norender-${Date.now()}.md`;
    await page.locator('#files-input').setInputFiles({
      name: fallbackName,
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 回退标题\n\n回退正文'),
    });
    const fallbackItem = page.locator('#files-list .file-item').filter({ hasText: fallbackName });
    await expect(fallbackItem).toBeVisible({ timeout: 15_000 });
    await fallbackItem.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#file-preview-body .md-unavailable')).toContainText(
      'Markdown 渲染不可用，已显示纯文本',
    );
    await expect(page.locator('#file-preview-body .md-fallback')).toContainText('# 回退标题');
    await expect(page.locator('#file-preview-body .file-preview-md-toggle')).toHaveText('查看原文');
    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview')).toBeHidden();
  });

  test('markdown preview stays readable at 390x844 in dark mode', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-toggle')).toBeVisible();
    await page.locator('#files-toggle').click();
    await expect(page.locator('#files-pane')).toBeVisible();

    const fileName = `mobile-${Date.now()}.md`;
    await page.locator('#files-input').setInputFiles({
      name: fileName,
      mimeType: 'text/markdown',
      buffer: Buffer.from('# 移动端\n\n## 二级标题\n\n- 第一项\n- 第二项\n\n> 引用\n\n```\ncode\n```'),
    });
    const item = page.locator('#files-list .file-item').filter({ hasText: fileName });
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByRole('button', { name: '预览', exact: true }).click();
    await expect(page.locator('#file-preview-body .file-preview-md-viewer h1')).toHaveText(
      '移动端',
      { timeout: 15_000 },
    );

    const metrics = await page.evaluate(() => {
      const card = document.querySelector<HTMLElement>('#file-preview-body .file-preview-markdown');
      const viewer = document.querySelector<HTMLElement>('#file-preview-body .file-preview-md-viewer');
      const toggle = document.querySelector<HTMLElement>('#file-preview-body .file-preview-md-toggle');
      if (!card || !viewer || !toggle) return null;
      const cardStyle = getComputedStyle(card);
      const viewerStyle = getComputedStyle(viewer);
      return {
        cardBackground: cardStyle.backgroundColor,
        cardWidth: card.getBoundingClientRect().width,
        viewerColor: viewerStyle.color,
        toggleVisible: toggle.getBoundingClientRect().width > 0,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(metrics).not.toBeNull();
    expect(metrics!.cardBackground).toBe(
      await semanticColor(page, '--lenso-background-secondary'),
    );
    expect(metrics!.viewerColor).toBe(await semanticColor(page, '--lenso-label-primary', 'color'));
    expect(metrics!.cardWidth).toBeLessThanOrEqual(390);
    expect(metrics!.toggleVisible).toBe(true);
    expect(metrics!.overflow).toBeLessThanOrEqual(1);
    await page.locator('#file-preview-close').click();
    await expect(page.locator('#file-preview')).toBeHidden();
  });

  test('monitor URL saves, renders iframe and closes back to files', async ({ page }) => {
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();

    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toBeVisible();
    await expect(page.locator('#files-pane')).toBeHidden();
    await page.fill('#monitor-url', 'https://example.com/4b5');
    await page.locator('#monitor-save').click();
    await expect(page.locator('#monitor-status')).toContainText('已保存');
    await expect(page.locator('#monitor-frame')).toHaveAttribute(
      'src',
      'https://example.com/4b5',
    );

    await page.locator('#monitor-close').click();
    await expect(page.locator('#monitor-pane')).toBeHidden();
    await expect(page.locator('#monitor-toggle')).toBeFocused();

    await page.locator('#files-toggle').click();
    await expect(page.locator('#files-pane')).toBeVisible();
  });

  test('tablet drawer uses backdrop and Escape returns focus', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeHidden();

    await page.locator('#files-toggle').click();
    await expect(page.locator('#files-pane')).toBeVisible();
    await expect(page.locator('#files-backdrop')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/files-drawer-open/u);
    await page.locator('#files-backdrop').click();
    await expect(page.locator('#files-pane')).toBeHidden();

    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#monitor-pane')).toBeHidden();
  });

  test('files pane reserves its width before the lazy chunk loads', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await login(page, base, tokenA);
    // Lenso 控件按需注入；先等首页完成替换，测量窗口只覆盖 FilesPane 懒加载。
    await page.locator('[data-lenso-slot="button"]').first().waitFor();
    let delayedChunks = 0;
    await page.route('**/assets/FilesPane-*.js', async (route) => {
      delayedChunks += 1;
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.continue();
    });
    await page.addInitScript(() => {
      const widths: number[] = [];
      // 只统计聊天区/文件栏内部元素造成的位移；侧栏列表加载不计入。
      const shifts: number[] = [];
      (window as unknown as { __chatWidths: number[] }).__chatWidths = widths;
      (window as unknown as { __layoutShifts: number[] }).__layoutShifts = shifts;
      // Lenso 控件按需 hydrate 时会替换按钮尺寸；只统计其稳定后的位移，
      // 避免把 UI 库加载算成文件栏懒加载造成的位移。宽度仍从首帧持续采样。
      const observeShifts = () => {
        if (!document.querySelector('[data-lenso-slot="button"]')) {
          setTimeout(observeShifts, 16);
          return;
        }
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as {
            hadRecentInput: boolean;
            value: number;
            sources: { node: Node | null }[];
          }[]) {
            if (entry.hadRecentInput) continue;
            if (
              entry.sources.some((source) =>
                (source.node as Element | null)?.closest?.('.chat-pane, .files-pane'),
              )
            ) {
              shifts.push(entry.value);
            }
          }
        }).observe({ type: 'layout-shift', buffered: false });
      };
      observeShifts();
      const tick = () => {
        const chat = document.querySelector('.chat-pane');
        if (chat) widths.push(Math.round(chat.getBoundingClientRect().width));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();
    await expect(page.locator('#files-input')).toBeAttached();
    await expect(page.locator('#composer')).toBeVisible();

    const result = await page.evaluate(() => ({
      widths: (window as unknown as { __chatWidths: number[] }).__chatWidths,
      shifts: (window as unknown as { __layoutShifts: number[] }).__layoutShifts,
      paneCount: document.querySelectorAll('#files-pane').length,
      chatWidth: Math.round(document.querySelector('.chat-pane')!.getBoundingClientRect().width),
      filesWidth: Math.round(document.querySelector('#files-pane')!.getBoundingClientRect().width),
    }));

    // 1280 - 300 侧栏 - 360 文件栏 = 620；文件栏打开期间聊天区不得回到 980。
    expect(delayedChunks).toBe(1);
    expect(result.chatWidth).toBe(620);
    expect(result.filesWidth).toBe(360);
    expect(result.paneCount).toBe(1);
    expect(result.widths.length).toBeGreaterThan(5);
    expect(Math.max(...result.widths) - Math.min(...result.widths)).toBeLessThanOrEqual(1);
    expect(result.shifts.reduce((sum, value) => sum + value, 0)).toBeLessThan(0.001);
  });

  test('closed files pane keeps chat full width and toggles cleanly', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.addInitScript(() => {
      localStorage.setItem('agent-network-files-open', '0');
    });
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await expect(page.locator('.files-pane')).toHaveCount(0);
    expect(
      await page.locator('.chat-pane').evaluate((node) => Math.round(node.getBoundingClientRect().width)),
    ).toBe(980);

    await page.locator('#files-toggle').click();
    await expect(page.locator('#files-pane')).toBeVisible();
    expect(
      await page.locator('.chat-pane').evaluate((node) => Math.round(node.getBoundingClientRect().width)),
    ).toBe(620);

    await page.locator('#files-close').click();
    await expect(page.locator('.files-pane')).toHaveCount(0);
    expect(
      await page.locator('.chat-pane').evaluate((node) => Math.round(node.getBoundingClientRect().width)),
    ).toBe(980);
  });

  test('mobile right panes are single column full-screen pages', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeHidden();

    await page.locator('#files-toggle').click();
    await expect(page.locator('#files-pane')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/files-page-open/u);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await page.locator('#files-close').click();
    await expect(page.locator('#files-pane')).toBeHidden();

    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toBeVisible();
    await expect(page.locator('body')).toHaveClass(/monitor-page-open/u);
    await page.locator('#monitor-close').click();
    await expect(page.locator('#monitor-pane')).toBeHidden();
  });

  test('dark mode keeps right-pane surfaces dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();
    const color = await page.evaluate(
      () => getComputedStyle(document.getElementById('files-pane')!).backgroundColor,
    );
    expect(color).toBe(await semanticColor(page, '--lenso-background-secondary'));
    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toBeVisible();
    const monitorColor = await page.evaluate(
      () => getComputedStyle(document.getElementById('monitor-pane')!).backgroundColor,
    );
    expect(monitorColor).toBe(await semanticColor(page, '--lenso-background-secondary'));
  });

  test('drawboard loads on demand and cancels without uploading', async ({ page }) => {
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await page.locator('#attach-file').click();
    await expect(page.locator('#attach-menu-draw')).toBeVisible();
    await page.locator('#attach-menu-draw').click();
    await expect(page.locator('[data-drawboard-overlay="1"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('#composer-files .composer-file')).toHaveCount(0);
    await page.locator('#db-cancel').click();
    await expect(page.locator('[data-drawboard-overlay="1"]')).toHaveCount(0);
  });

  test('new agent entry creates credentials and memory drawer opens', async ({ page }) => {
    await login(page, base, tokenA);
    await page.locator('#new-agent').click();
    await expect(page.locator('#new-agent-modal')).toBeVisible();
    await page.fill('#new-agent-name', `UI Agent ${Date.now()}`);
    await page.locator('#new-agent-create').click();
    await expect(page.locator('#new-agent-result')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#new-agent-url')).toHaveValue(/\/mcp\?token=/u);
    await expect(page.locator('#new-agent-modal .new-agent-warning')).toContainText(
      '不要截图、发群或写入日志',
    );
    await page.locator('#new-agent-close').click();
    await expect(page.locator('#new-agent-modal')).toBeHidden();

    await page.locator('#memory-open').click();
    await expect(page.locator('#memory-drawer')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('#memory-capability')).toContainText(
      'Memory 内容工具只对 Agent 自身凭据开放',
    );
    await expect(page.locator('#memory-tabs')).toHaveCount(0);
    await page.locator('#memory-close').click({ timeout: 5000 });
    await expect(page.locator('#memory-drawer')).toBeHidden();
  });

  test('agent identity keeps all sidebar account entries enabled', async ({ page }) => {
    await login(page, base, agentToken);
    await expect(page.locator('#account-name')).toHaveText(agentName);
    const entries = page.locator('.account-actions button');
    await expect(entries).toHaveCount(5);
    const states = await entries.evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.id,
        disabled: (node as HTMLButtonElement).disabled,
        opacity: getComputedStyle(node).opacity,
      })),
    );
    expect(states.map((item) => item.id)).toEqual([
      'new-agent',
      'device-handoff',
      'memory-open',
      'archived-agents',
      'logout',
    ]);
    expect(states.every((item) => item.disabled === false)).toBe(true);
    expect(states.every((item) => item.opacity === '1')).toBe(true);

    await page.locator('#new-agent').click();
    await expect(page.locator('#new-agent-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#new-agent-modal')).toBeHidden();
    await expect(page.locator('#new-agent')).toBeFocused();
  });

  test('agent management transfer dialog loads from the room menu', async ({ page }) => {
    await login(page, base, tokenA);
    const rooms = await callTool<RoomList>(base, tokenA, 'network_rooms_list', { limit: 100 });
    const agentRoom = rooms.items.find(
      (room) => room.kind === 'direct' && room.peer?.actor_id === agentId,
    );
    if (!agentRoom) throw new Error('新建 Agent 未生成 direct 会话');
    await page.goto(`${base}/c/${agentRoom.room_id}`);
    await expect(page.locator('#title')).toHaveText(agentName);
    await page.locator('#room-menu-toggle').click();
    await expect(page.locator('#room-menu-transfer')).toBeVisible();
    await page.locator('#room-menu-transfer').click();
    await expect(page.locator('#transfer-modal')).toBeVisible();
    await expect(page.locator('#transfer-summary')).toContainText(agentName);
    await expect(page.locator('#transfer-summary')).toContainText('你是当前管理者');
    await page.locator('#transfer-close').click();
    await expect(page.locator('#transfer-modal')).toBeHidden();
  });

  test('group owner transfer can be proposed from members dialog', async ({ page }) => {
    await login(page, base, tokenA);
    await page.goto(`${base}/c/${groupId}`);
    await page.locator('#members-button').click();
    await expect(page.locator('#members-modal')).toBeVisible();
    await expect(page.locator('#members-transfer')).toBeVisible();
    await page.selectOption('#members-transfer-select', nameB);
    await page.locator('#members-transfer-propose').click();
    await expect(page.locator('#members-transfer')).toContainText('提议把群主转让给');

    const detail = await callTool<RoomDetail>(base, tokenA, 'network_room_get', {
      room_id: groupId,
    });
    expect(detail.room.owner_transfer).not.toBeNull();
  });

  test('right panes and new dialogs have no critical/serious axe violations', async ({ page }) => {
    async function violations(selector: string): Promise<string[]> {
      const results = await new AxeBuilder({ page })
        .include(selector)
        .withTags(['wcag2a', 'wcag2aa'])
        .analyze();
      const serious = results.violations.filter(
        (item) => item.impact === 'critical' || item.impact === 'serious',
      );
      if (serious.length > 0) {
        console.log('AXE', selector, JSON.stringify(serious.map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => node.target),
        }))));
      }
      return serious.map((item) => `${item.id}(${item.impact})`);
    }

    await login(page, base, tokenA);
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#files-pane')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#files-pane')).toEqual([]);

    await page.locator('#monitor-toggle').click();
    await expect(page.locator('#monitor-pane')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#monitor-pane')).toEqual([]);
    await page.locator('#monitor-close').click();

    await page.locator('#new-agent').click();
    await expect(page.locator('#new-agent-modal')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#new-agent-modal')).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.locator('#new-agent-modal')).toBeHidden();

    await page.locator('#memory-open').click();
    await expect(page.locator('#memory-drawer')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(220);
    expect(await violations('#memory-drawer')).toEqual([]);
    await page.locator('#memory-close').click();

    const rooms = await callTool<RoomList>(base, tokenA, 'network_rooms_list', { limit: 100 });
    const agentRoom = rooms.items.find(
      (room) => room.kind === 'direct' && room.peer?.actor_id === agentId,
    );
    if (!agentRoom) throw new Error('新建 Agent 未生成 direct 会话');
    await page.goto(`${base}/c/${agentRoom.room_id}`);
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-transfer').click();
    await expect(page.locator('#transfer-modal')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#transfer-modal')).toEqual([]);
  });
});
