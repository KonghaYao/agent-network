import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { groupColorFor } from '../../src/web/lib/group-colors';
import { avatarColor } from '../../src/web/lib/rooms';

/**
 * 群聊专属色与单瓦片头像 e2e：真实 MCP 身份/房间，验证会话列表瓦片、
 * 聊天头部色标、文字规则、对比度、暗色与 390px 布局。
 *
 * 两个同字开头群的颜色由 room_id 稳定派生；为保证断言“两个群不同色”
 * 不依赖哈希运气，创建群时持续到出现两个不同调色板下标为止。
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
            name: 'agent-network-e2e-group-colors',
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
}

interface RoomList {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

interface GroupFixture {
  roomId: string;
  title: string;
  label: string;
  length: 1 | 2;
}

function hexToRgb(hex: string): string {
  const value = hex.replace('#', '');
  return `rgb(${Number.parseInt(value.slice(0, 2), 16)}, ${Number.parseInt(
    value.slice(2, 4),
    16,
  )}, ${Number.parseInt(value.slice(4, 6), 16)})`;
}

function relativeLuminance(color: string): number {
  const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/u.exec(color);
  if (!match) throw new Error(`无法解析颜色：${color}`);
  const channel = (value: number): number => {
    const unit = value / 255;
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel(Number(match[1])) +
    0.7152 * channel(Number(match[2])) +
    0.0722 * channel(Number(match[3]))
  );
}

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

interface TileSample {
  text: string;
  width: number;
  height: number;
  radius: string;
  color: string;
  background: string;
  image: string;
  fontSize: string;
  labelLength: string | null;
  script: string | null;
  index: string | null;
}

test.describe('群聊专属色与单瓦片头像', () => {
  let base = '';
  let tokenA = '';
  let actorB = '';
  let directRoomId = '';
  let groupA: GroupFixture = { roomId: '', title: '', label: '配色', length: 2 };
  let groupB: GroupFixture = { roomId: '', title: '', label: '配色', length: 2 };
  let groupLatin: GroupFixture = { roomId: '', title: '', label: 'CO', length: 2 };
  let groupSingle: GroupFixture = { roomId: '', title: '', label: 'Q', length: 1 };

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();

    await callTool<Registered>(base, tokenA, 'network_register', {
      request_id: requestId('e2e_color_reg'),
      kind: 'human',
      name: `配色测试 A ${suffix}`,
      device_id: `e2e-color-${suffix}-a`,
    });
    const b = await callTool<Registered>(base, tokenB, 'network_register', {
      request_id: requestId('e2e_color_reg'),
      kind: 'human',
      name: `配色测试 B ${suffix}`,
      device_id: `e2e-color-${suffix}-b`,
    });
    actorB = b.actor_id;

    const request = await callTool<ContactRequestResult>(
      base,
      tokenA,
      'network_contact_request',
      { request_id: requestId('e2e_color_contact'), actor_id: actorB },
    );
    if (!request.request) throw new Error('好友申请未创建');
    await callTool(base, tokenB, 'network_contact_request_respond', {
      request_id: requestId('e2e_color_contact'),
      contact_request_id: request.request.contact_request_id,
      action: 'accept',
    });

    const rooms = await callTool<RoomList>(base, tokenA, 'network_rooms_list', { limit: 50 });
    const direct = rooms.items.find(
      (room) => room.kind === 'direct' && room.peer?.actor_id === actorB,
    );
    if (!direct) throw new Error('好友通过后未生成 direct 会话');
    directRoomId = direct.room_id;

    const createGroup = async (title: string): Promise<string> => {
      const created = await callTool<{ room: { room_id: string } }>(
        base,
        tokenA,
        'network_room_create',
        {
          request_id: requestId('e2e_color_group'),
          kind: 'group',
          members: [actorB],
          title,
        },
      );
      return created.room.room_id;
    };

    // 10 色下连续创建仍撞色的概率极低；循环上限只是防御性写法。
    for (let index = 0; index < 12; index += 1) {
      const title = `配色群 ${suffix}-${index}`;
      const roomId = await createGroup(title);
      const candidate = { roomId, title, label: '配色', length: 2 as const };
      if (!groupA.roomId) {
        groupA = candidate;
        continue;
      }
      if (groupColorFor(groupA.roomId).index !== groupColorFor(candidate.roomId).index) {
        groupB = candidate;
        break;
      }
    }
    if (!groupA.roomId || !groupB.roomId) throw new Error('未能创建两个不同色的群聊');

    groupLatin = {
      roomId: await createGroup(`Color Team ${suffix}`),
      title: `Color Team ${suffix}`,
      label: 'CO',
      length: 2,
    };
    const singleTitle = `Q${Date.now()}`;
    groupSingle = {
      roomId: await createGroup(singleTitle),
      title: singleTitle,
      label: 'Q',
      length: 1,
    };
  });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript((token) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      } catch {
        // 浏览器禁用存储时由页面错误态兜底。
      }
    }, tokenA);
  });

  const roomRow = (roomId: string) => `#room-list a[data-room-id="${roomId}"]`;

  const readTile = async (page: import('@playwright/test').Page, roomId: string) =>
    page.locator(roomRow(roomId)).evaluate((row) => {
      const tile = row.querySelector<HTMLElement>('.avatar-tile');
      if (!tile) return null;
      const rect = tile.getBoundingClientRect();
      const styles = getComputedStyle(tile);
      return {
        text: tile.textContent ?? '',
        width: rect.width,
        height: rect.height,
        radius: styles.borderRadius,
        color: styles.color,
        background: styles.backgroundColor,
        image: styles.backgroundImage,
        fontSize: styles.fontSize,
        labelLength: tile.getAttribute('data-label-length'),
        script: tile.getAttribute('data-script'),
        index: tile.getAttribute('data-group-color'),
      } satisfies TileSample;
    });

  test('列表与头部使用稳定且不同的群色，瓦片按群名取字', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`${base}/`);
    await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
    await expect(page.locator('#room-list')).toBeVisible();

    const directRow = page.locator(roomRow(directRoomId));
    await expect(directRow).toBeVisible();
    await expect(directRow.locator('.avatar-tile')).toHaveCount(0);
    await expect(directRow.locator('.avatar-grid, .avatar-cell')).toHaveCount(0);
    await expect(directRow.locator('.avatar')).toHaveCount(1);
    expect(await directRow.locator('.avatar').evaluate((avatar) => getComputedStyle(avatar).width)).toBe(
      '40px',
    );

    // 直聊头像仍按名称派生：运行时读取背景色，防止群色重构误改直聊。
    const directName = (await directRow.getAttribute('data-room-name')) ?? '';
    expect(directName).not.toBe('');
    const directBackground = await directRow
      .locator('.avatar')
      .evaluate((avatar) => getComputedStyle(avatar).backgroundColor);
    expect(directBackground).toBe(hexToRgb(avatarColor(directName)));

    await page.locator('#room-filter-group').click();
    await expect(page.locator(roomRow(groupA.roomId))).toBeVisible();
    await expect(page.locator(roomRow(groupB.roomId))).toBeVisible();
    await expect(page.locator(roomRow(groupLatin.roomId))).toBeVisible();
    await expect(page.locator(roomRow(groupSingle.roomId))).toBeVisible();

    for (const group of [groupA, groupB, groupLatin, groupSingle]) {
      const row = page.locator(roomRow(group.roomId));
      await expect(row.locator('.avatar-tile')).toHaveCount(1);
      await expect(row.locator('.avatar-grid, .avatar-cell')).toHaveCount(0);
      await expect(row.locator('.avatar-tile')).toHaveText(group.label);
      await expect(row.locator('.avatar-tile')).toHaveAttribute(
        'data-group-color',
        String(groupColorFor(group.roomId).index),
      );
      await expect(row.locator('.avatar-tile')).toHaveAttribute(
        'data-label-length',
        String(group.length),
      );
    }

    const colorA = groupColorFor(groupA.roomId);
    const colorB = groupColorFor(groupB.roomId);
    const firstA = await readTile(page, groupA.roomId);
    const firstB = await readTile(page, groupB.roomId);
    expect(firstA).not.toBeNull();
    expect(firstB).not.toBeNull();
    if (!firstA || !firstB) return;

    // 单块瓦片：44px、13px 圆角、白色文字、同色系渐变。
    expect(firstA.width).toBe(44);
    expect(firstA.height).toBe(44);
    expect(firstA.radius).toBe('13px');
    expect(firstA.color).toBe('rgb(255, 255, 255)');
    expect(firstA.background).toBe(hexToRgb(colorA.hex));
    expect(firstA.image).toContain(hexToRgb(colorA.hex));
    expect(firstA.image).toContain(hexToRgb(colorA.dark));
    expect(contrastRatio(firstA.color, firstA.background)).toBeGreaterThanOrEqual(3);
    expect(firstA.index).toBe(String(colorA.index));

    // 两个群的基色、渐变与下标都不同。
    expect(firstA.background).not.toBe(firstB.background);
    expect(firstA.image).not.toBe(firstB.image);
    expect(firstA.index).not.toBe(firstB.index);

    // 文字规则：中文 2 字、英文 2 字母大写、单个字母 1 字。
    const hanTile = await readTile(page, groupA.roomId);
    expect(hanTile?.text).toBe('配色');
    expect(hanTile?.fontSize).toBe('16px');
    const latinTile = await readTile(page, groupLatin.roomId);
    expect(latinTile?.text).toBe('CO');
    expect(latinTile?.script).toBe('latin');
    expect(latinTile?.labelLength).toBe('2');
    expect(latinTile?.fontSize).toBe('17px');
    const singleTile = await readTile(page, groupSingle.roomId);
    expect(singleTile?.text).toBe('Q');
    expect(singleTile?.script).toBe('latin');
    expect(singleTile?.labelLength).toBe('1');
    expect(singleTile?.fontSize).toBe('21px');

    await page.locator(roomRow(groupA.roomId)).click();
    await expect(page).toHaveURL(`${base}/c/${groupA.roomId}`);
    await expect(page.locator('#title')).toHaveText(groupA.title);
    const dotA = page.locator('.group-color-dot');
    await expect(dotA).toHaveCount(1);
    await expect(dotA).toHaveAttribute('data-group-color', String(colorA.index));
    expect(await dotA.evaluate((dot) => getComputedStyle(dot).backgroundColor)).toBe(
      hexToRgb(colorA.hex),
    );

    await page.reload();
    await expect(page.locator('#title')).toHaveText(groupA.title);
    await page.locator('#room-filter-group').click();
    await expect(page.locator(roomRow(groupA.roomId))).toBeVisible();
    const reloaded = await readTile(page, groupA.roomId);
    expect(reloaded).toEqual(firstA);
    expect(await dotA.evaluate((dot) => getComputedStyle(dot).backgroundColor)).toBe(
      hexToRgb(colorA.hex),
    );

    await page.goto(`${base}/c/${groupB.roomId}`);
    await expect(page.locator('#title')).toHaveText(groupB.title);
    await expect(page.locator('.group-color-dot')).toHaveCount(1);
    expect(
      await page
        .locator('.group-color-dot')
        .evaluate((dot) => getComputedStyle(dot).backgroundColor),
    ).toBe(hexToRgb(colorB.hex));

    await page.goto(`${base}/c/${directRoomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await expect(page.locator('.group-color-dot')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('暗色模式下瓦片白字与头部色标保持可读', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${base}/c/${groupA.roomId}`);
    await expect(page.locator('#title')).toHaveText(groupA.title);
    await expect(page.locator('.group-color-dot')).toBeVisible();
    await page.locator('#room-filter-group').click();
    await expect(page.locator(roomRow(groupA.roomId)).locator('.avatar-tile')).toBeVisible();

    const color = groupColorFor(groupA.roomId);
    const sample = await page.evaluate((roomId) => {
      const dot = document.querySelector<HTMLElement>('.group-color-dot');
      const head = document.querySelector<HTMLElement>('.chat-head');
      const tile = document.querySelector<HTMLElement>(
        `#room-list a[data-room-id="${roomId}"] .avatar-tile`,
      );
      if (!dot || !head || !tile) return null;
      const styles = getComputedStyle(tile);
      return {
        dot: getComputedStyle(dot).backgroundColor,
        head: getComputedStyle(head).backgroundColor,
        background: styles.backgroundColor,
        color: styles.color,
        image: styles.backgroundImage,
      };
    }, groupA.roomId);
    expect(sample).not.toBeNull();
    if (!sample) return;

    expect(sample.head).toBe('rgb(43, 43, 43)');
    expect(sample.dot).toBe(hexToRgb(color.hex));
    expect(sample.background).toBe(hexToRgb(color.hex));
    expect(sample.color).toBe('rgb(255, 255, 255)');
    expect(sample.image).toContain(hexToRgb(color.dark));
    expect(contrastRatio(sample.dot, sample.head)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(sample.color, sample.background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(sample.background, sample.head)).toBeGreaterThanOrEqual(3);
  });

  test.describe('390px 移动端', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('单瓦片头像不产生横向溢出', async ({ page }) => {
      await page.goto(`${base}/`);
      await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
      await page.locator('#room-filter-group').click();
      const tile = page.locator(roomRow(groupA.roomId)).locator('.avatar-tile');
      await expect(tile).toBeVisible();

      const metrics = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.innerWidth);
      expect(metrics.bodyScrollWidth).toBeLessThanOrEqual(metrics.innerWidth);

      const box = await tile.boundingBox();
      expect(box).not.toBeNull();
      if (!box) return;
      expect(box.width).toBe(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    });
  });
});
