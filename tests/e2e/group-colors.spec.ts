import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { groupColorFor } from '../../src/web/lib/group-colors';

/**
 * 群聊专属色 e2e：真实 MCP 身份/房间，验证列表 2×2 头像与聊天头部色标。
 *
 * 两个群的颜色由 room_id 稳定派生；为保证断言“两个群不同色”不依赖
 * 哈希运气，创建群时持续到出现两个不同调色板下标为止。
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
}

function hexToRgb(hex: string): string {
  const value = hex.replace('#', '');
  return `rgb(${Number.parseInt(value.slice(0, 2), 16)}, ${Number.parseInt(
    value.slice(2, 4),
    16,
  )}, ${Number.parseInt(value.slice(4, 6), 16)})`;
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

function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test.describe('群聊专属色', () => {
  let base = '';
  let tokenA = '';
  let actorB = '';
  let directRoomId = '';
  let groupA: GroupFixture = { roomId: '', title: '' };
  let groupB: GroupFixture = { roomId: '', title: '' };

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

    // 10 色下连续创建仍撞色的概率极低；循环上限只是防御性写法。
    for (let index = 0; index < 12; index += 1) {
      const created = await callTool<{ room: { room_id: string } }>(
        base,
        tokenA,
        'network_room_create',
        {
          request_id: requestId('e2e_color_group'),
          kind: 'group',
          members: [actorB],
          title: `配色群 ${suffix}-${index}`,
        },
      );
      const candidate = {
        roomId: created.room.room_id,
        title: `配色群 ${suffix}-${index}`,
      };
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

  test('列表与头部使用稳定且不同的群色，直聊保持原样', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(`${base}/`);
    await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
    await expect(page.locator('#room-list')).toBeVisible();

    const directRow = page.locator(`#room-list a[data-room-id="${directRoomId}"]`);
    await expect(directRow).toBeVisible();
    await expect(directRow.locator('.avatar-grid')).toHaveCount(0);
    await expect(directRow.locator('.avatar')).toHaveCount(1);

    await page.locator('#room-filter-group').click();
    const rowA = page.locator(`#room-list a[data-room-id="${groupA.roomId}"]`);
    const rowB = page.locator(`#room-list a[data-room-id="${groupB.roomId}"]`);
    await expect(rowA).toBeVisible();
    await expect(rowB).toBeVisible();
    await expect(rowA.locator('.avatar-cell')).toHaveCount(4);
    await expect(rowB.locator('.avatar-cell')).toHaveCount(4);

    const readRow = async (roomId: string) =>
      page.locator(`#room-list a[data-room-id="${roomId}"]`).evaluate((row) => {
        const grid = row.querySelector<HTMLElement>('.avatar-grid');
        return {
          index: grid?.getAttribute('data-group-color') ?? null,
          colors: Array.from(row.querySelectorAll<HTMLElement>('.avatar-cell')).map(
            (cell) => getComputedStyle(cell).backgroundColor,
          ),
        };
      });

    const firstA = await readRow(groupA.roomId);
    const firstB = await readRow(groupB.roomId);
    const colorA = hexToRgb(groupColorFor(groupA.roomId).hex);
    const colorB = hexToRgb(groupColorFor(groupB.roomId).hex);

    expect(firstA.colors).toEqual([colorA, colorA, colorA, colorA]);
    expect(firstB.colors).toEqual([colorB, colorB, colorB, colorB]);
    expect(firstA.colors[0]).not.toBe(firstB.colors[0]);
    expect(firstA.index).toBe(String(groupColorFor(groupA.roomId).index));
    expect(firstB.index).toBe(String(groupColorFor(groupB.roomId).index));

    await page.locator(`#room-list a[href="/c/${groupA.roomId}"]`).click();
    await expect(page).toHaveURL(`${base}/c/${groupA.roomId}`);
    await expect(page.locator('#title')).toHaveText(groupA.title);
    const dotA = page.locator('.group-color-dot');
    await expect(dotA).toHaveCount(1);
    await expect(dotA).toHaveAttribute('data-group-color', String(groupColorFor(groupA.roomId).index));
    expect(await dotA.evaluate((dot) => getComputedStyle(dot).backgroundColor)).toBe(colorA);

    await page.reload();
    await expect(page.locator('#title')).toHaveText(groupA.title);
    await page.locator('#room-filter-group').click();
    await expect(rowA).toBeVisible();
    const reloaded = await readRow(groupA.roomId);
    expect(reloaded.colors).toEqual(firstA.colors);
    expect(await dotA.evaluate((dot) => getComputedStyle(dot).backgroundColor)).toBe(colorA);

    await page.goto(`${base}/c/${groupB.roomId}`);
    await expect(page.locator('#title')).toHaveText(groupB.title);
    await expect(page.locator('.group-color-dot')).toHaveCount(1);
    expect(
      await page
        .locator('.group-color-dot')
        .evaluate((dot) => getComputedStyle(dot).backgroundColor),
    ).toBe(colorB);

    await page.goto(`${base}/c/${directRoomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await expect(page.locator('.group-color-dot')).toHaveCount(0);

    expect(errors).toEqual([]);
  });

  test('暗色模式下群色与头部背景、白色首字保持可读对比', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${base}/c/${groupA.roomId}`);
    await expect(page.locator('#title')).toHaveText(groupA.title);
    await expect(page.locator('.group-color-dot')).toBeVisible();
    await page.locator('#room-filter-group').click();
    await expect(
      page.locator(`#room-list a[data-room-id="${groupA.roomId}"] .avatar-cell`).first(),
    ).toBeVisible();

    const sample = await page.evaluate((roomId) => {
      const dot = document.querySelector<HTMLElement>('.group-color-dot');
      const head = document.querySelector<HTMLElement>('.chat-head');
      const cell = document.querySelector<HTMLElement>(
        `#room-list a[data-room-id="${roomId}"] .avatar-cell`,
      );
      if (!dot || !head || !cell) return null;
      return {
        dot: getComputedStyle(dot).backgroundColor,
        head: getComputedStyle(head).backgroundColor,
        cell: getComputedStyle(cell).backgroundColor,
        cellText: getComputedStyle(cell).color,
      };
    }, groupA.roomId);
    expect(sample).not.toBeNull();
    if (!sample) return;

    expect(sample.head).toBe('rgb(43, 43, 43)');
    expect(sample.dot).toBe(hexToRgb(groupColorFor(groupA.roomId).hex));
    expect(sample.cell).toBe(hexToRgb(groupColorFor(groupA.roomId).hex));
    expect(contrastRatio(sample.dot, sample.head)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(sample.cellText, sample.cell)).toBeGreaterThanOrEqual(4.5);
  });
});
