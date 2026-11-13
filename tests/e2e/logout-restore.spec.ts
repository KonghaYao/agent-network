import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 退出登录后的身份恢复入口。
 *
 * 退出只清本机 token 并写入 `agent-network-logged-out`；首页必须提供显式
 * 的“创建新身份并继续”，点击后才注册新身份。这里用真实浏览器与真实
 * MCP 服务验证成功、刷新、双击与失败重试路径。
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
    error?: { message?: string; data?: { code?: string } };
    result?: ToolEnvelope;
  };
  if (payload.error) throw new Error(payload.error.message ?? 'MCP 调用失败');
  const result = payload.result;
  if (!result) throw new Error('MCP 响应缺少 result');
  if (result.isError === true) {
    throw new Error(result.content?.find((item) => item.type === 'text')?.text ?? '工具调用失败');
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
  items: unknown[];
}

test.describe('退出后的身份恢复', () => {
  let base = '';
  let ownerToken = '';
  let owner: Registered;

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    ownerToken = crypto.randomUUID();
    owner = await callTool<Registered>(base, ownerToken, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: `E2E 退出恢复 ${suffix}`,
      device_id: `e2e-logout-${suffix}`,
    });
  });

  test('退出后入口创建新身份，双击与刷新不重复注册', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    // 只 seed 一次：退出会清理 `agent-network-*` sessionStorage，但不会碰这个键。
    await page.addInitScript((token) => {
      try {
        if (sessionStorage.getItem('__e2eLogoutSeeded') === '1') return;
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
        sessionStorage.setItem('__e2eLogoutSeeded', '1');
      } catch {
        // 存储不可用时由页面错误态兜底。
      }
    }, ownerToken);

    await page.goto(`${base}/`);
    await expect(page.locator('#account-name')).toBeVisible();
    await expect(page.locator('#account-name')).not.toHaveText('未登录');

    await page.locator('#logout').click();
    await expect(page.locator('#logout-modal')).toBeVisible();
    await page.locator('#logout-confirm').click();
    await page.waitForURL(`${base}/`);
    await expect(page.locator('#logged-out-start')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('agent-network-token'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('agent-network-logged-out'))).toBe('1');

    // 入口不是一次性：刷新退出页仍然存在。
    await page.reload();
    await expect(page.locator('#logged-out-start')).toBeVisible();

    const registrations: string[] = [];
    page.on('request', (request) => {
      if (request.headers()['mcp-name'] === 'network_register') {
        registrations.push(request.url());
      }
    });

    // 同一帧内连续点击两次，只允许注册一个新身份。
    await page.evaluate(() => {
      const button = document.getElementById('logged-out-start');
      if (!(button instanceof HTMLButtonElement)) throw new Error('缺少恢复入口');
      button.click();
      button.click();
    });
    await expect(page.locator('#logged-out-start')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('#account-name')).toContainText('网页访客');

    const restoredToken = await page.evaluate(() =>
      localStorage.getItem('agent-network-token'),
    );
    if (!restoredToken) throw new Error('恢复后缺少本机 token');
    expect(restoredToken === ownerToken).toBe(false);
    expect(await page.evaluate(() => localStorage.getItem('agent-network-logged-out'))).toBeNull();
    expect(registrations).toHaveLength(1);

    const restored = await callTool<Registered>(
      base,
      restoredToken,
      'network_me',
      {},
    );
    expect(restored.actor_id).not.toBe(owner.actor_id);
    const rooms = await callTool<RoomList>(base, restoredToken, 'network_rooms_list', {
      limit: 50,
    });
    expect(Array.isArray(rooms.items)).toBe(true);
    await expect(page.locator('#room-list-status')).toContainText('还没有好友会话。');

    // 恢复后刷新沿用同一身份，不再次注册。
    const beforeReload = registrations.length;
    await page.reload();
    await expect(page.locator('#account-name')).toContainText('网页访客');
    const afterReloadToken = await page.evaluate(() =>
      localStorage.getItem('agent-network-token'),
    );
    expect(afterReloadToken === restoredToken).toBe(true);
    expect(registrations).toHaveLength(beforeReload);

    expect(errors).toEqual([]);
  });

  test('注册失败显示错误并保留可重试入口', async ({ page }) => {
    await page.addInitScript(() => {
      try {
        localStorage.setItem('agent-network-logged-out', '1');
        localStorage.removeItem('agent-network-token');
      } catch {
        // 忽略。
      }
    });

    let failRegister = true;
    await page.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-name'] !== 'network_register' || !failRegister) {
        await route.continue();
        return;
      }
      failRegister = false;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: '模拟注册失败', data: { code: 'INTERNAL' } },
        }),
      });
    });

    await page.goto(`${base}/`);
    const start = page.locator('#logged-out-start');
    await expect(start).toBeVisible();
    await start.click();
    await expect(page.locator('#logged-out-error')).toContainText('模拟注册失败');
    await expect(start).toBeEnabled();
    expect(await page.evaluate(() => localStorage.getItem('agent-network-token'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('agent-network-logged-out'))).toBe('1');

    await start.click();
    await expect(start).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('#account-name')).toContainText('网页访客');
    expect(await page.evaluate(() => localStorage.getItem('agent-network-logged-out'))).toBeNull();
  });
});
