import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 4B-3 Share / Join / Pair e2e。
 *
 * 需要 `WEB_SPA_ROUTES` 同时包含 share/join/pair，并显式 `E2E_SPA=1`。
 * 分享页验证 SSR/OG 与好友申请；邀请页验证预览不读群消息、确认后进入群聊；
 * 配对页验证 fragment 一次性挑战、已登录设备批准与显式切换身份。
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
  agent_session_id: string | null;
}

interface RoomResult {
  room: { room_id: string };
}

interface InviteResult {
  invite_key: string | null;
  share_url: string | null;
}

interface PairingCreated {
  challenge: string;
  pairing_id: string;
}

interface PairingList {
  items: { pairing_id: string; confirm_code: string | null; status: string }[];
}

const ROUTES = (process.env.WEB_SPA_ROUTES ?? '')
  .split(',')
  .map((value) => value.trim());
const ENABLED =
  process.env.E2E_SPA === '1' &&
  ['share', 'join', 'pair'].every((route) => ROUTES.includes(route));

test.describe('SPA Share / Join / Pair', () => {
  test.skip(!ENABLED, '需要 WEB_SPA_ROUTES=home,room,share,join,pair E2E_SPA=1');

  let base = '';
  let ownerToken = '';
  let ownerName = '';
  let agentSession = '';
  let agentId = '';
  let roomId = '';
  let roomTitle = '';
  let inviteKey = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    ownerToken = crypto.randomUUID();
    ownerName = `E2E 配对主人 ${suffix}`;
    roomTitle = `E2E 邀请群 ${suffix}`;
    agentSession = `sess_e2e_share_${suffix}`;

    const owner = await callTool<Registered>(base, ownerToken, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: ownerName,
      device_id: `e2e-owner-${suffix}`,
    });
    expect(owner.actor_id).toBeTruthy();

    const agent = await callTool<Registered>(base, crypto.randomUUID(), 'network_register', {
      request_id: requestId('e2e_reg_agent'),
      kind: 'agent',
      name: `E2E 分享 Agent ${suffix}`,
      agent_session_id: agentSession,
    });
    agentId = agent.actor_id;
    expect(agentSession).toBeTruthy();

    const room = await callTool<RoomResult>(base, ownerToken, 'network_room_create', {
      request_id: requestId('e2e_room'),
      kind: 'group',
      title: roomTitle,
      members: [agentId],
    });
    roomId = room.room.room_id;

    const invite = await callTool<InviteResult>(base, ownerToken, 'network_room_invite_create', {
      request_id: requestId('e2e_invite'),
      room_id: roomId,
    });
    inviteKey = invite.invite_key ?? '';
    expect(inviteKey.length).toBeGreaterThanOrEqual(16);
  });

  test('share page is crawlable, token-free and sends a pending request', async ({ browser }) => {
    const url = `${base}/a/${encodeURIComponent(agentSession)}`;
    const response = await fetch(url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<title>添加 E2E 分享 Agent');
    expect(html).toContain('property="og:title"');
    expect(html).toContain('property="og:description"');
    expect(html).toContain('发送好友申请');
    expect(html).toContain('E2E 分享 Agent');
    expect(html).not.toContain('agent-network-token=');
    expect(html).not.toContain(ownerToken);

    const noJs = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    try {
      const page = await noJs.newPage();
      await page.goto(url);
      await expect(page.locator('h1')).toContainText('E2E 分享 Agent');
      await expect(page.locator('#add')).toBeVisible();
    } finally {
      await noJs.close();
    }

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      await page.goto(url);
      await expect(page.locator('body[data-spa-route="share"]')).toBeVisible();
      await expect(page.locator('#add')).toBeEnabled();
      await page.locator('#add').click();
      await expect(page.locator('#status')).toContainText('好友申请已发送');
      await expect(page.locator('#add')).toHaveText('好友申请待确认');
      await expect(page.locator('#add')).toBeDisabled();
      expect(errors.filter((text) => /hydration|did not match/iu.test(text))).toEqual([]);

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
      );
      expect(overflow).toBe(false);
    } finally {
      await context.close();
    }

    const dark = await browser.newContext({
      colorScheme: 'dark',
      viewport: { width: 390, height: 844 },
    });
    try {
      const page = await dark.newPage();
      await page.goto(url);
      await expect(page.locator('body[data-spa-route="share"]')).toBeVisible();
      const background = await page.evaluate(
        () => getComputedStyle(document.body).backgroundColor,
      );
      expect(background).toBe('rgb(25, 25, 25)');
    } finally {
      await dark.close();
    }
  });

  test('join page previews without reading messages, then joins the group', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    try {
      const page = await context.newPage();
      await page.addInitScript(() => {
        const target = window as unknown as { __joinCalls?: string[]; fetch: typeof fetch };
        target.__joinCalls = [];
        const original = target.fetch.bind(window);
        target.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const headers = init?.headers as Record<string, string> | undefined;
          const name = headers?.['mcp-name'];
          if (name) target.__joinCalls?.push(name);
          return original(input, init);
        }) as typeof fetch;
      });
      await page.goto(`${base}/j/${inviteKey}`);
      await expect(page.locator('body[data-spa-route="join"]')).toBeVisible();
      await expect(page.locator('#join-action')).toBeEnabled({ timeout: 10_000 });
      await expect(page.locator('#join-title')).toHaveText(roomTitle);
      await expect(page.locator('#join-members')).toContainText('人');
      await expect(page.locator('#join-inviter')).toContainText(ownerName);

      const calls = await page.evaluate(
        () => (window as unknown as { __joinCalls?: string[] }).__joinCalls ?? [],
      );
      expect(calls).toContain('network_room_invite_get');
      expect(calls).not.toContain('network_history_list');
      expect(calls).not.toContain('network_message_send');

      await page.locator('#join-action').click();
      await page.waitForURL(`${base}/c/${roomId}`);
      await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
      await expect(page.locator('#title')).toHaveText(roomTitle);
      await expect(page.locator('#composer')).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test('pair page consumes the fragment, waits for approval, then switches identity', async ({
    browser,
  }) => {
    const created = await callTool<PairingCreated>(
      base,
      ownerToken,
      'network_device_pairing_create',
      { request_id: requestId('e2e_pair'), device_label: 'E2E 已登录设备' },
    );
    expect(created.challenge).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/u);

    const context: BrowserContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    });
    try {
      const page: Page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${base}/pair#c=${created.challenge}`);
      await page.waitForFunction(() => window.location.hash === '');
      await expect(page.locator('body[data-spa-route="pair"]')).toBeVisible();
      await expect(page.locator('#pair-challenge')).toHaveValue(created.challenge);
      await expect(page.locator('#pair-original')).toContainText('未登录');

      await page.locator('#pair-start').click();
      await expect(page.locator('#pair-target')).toContainText(ownerName, { timeout: 10_000 });
      const confirm = (await page.locator('#pair-confirm').textContent()) ?? '';
      expect(confirm).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/u);
      await expect(page.locator('#status')).not.toContainText(created.challenge);

      const listed = await callTool<PairingList>(
        base,
        ownerToken,
        'network_device_pairing_list',
        { limit: 10 },
      );
      const item = listed.items.find((entry) => entry.confirm_code === confirm);
      expect(item).toBeTruthy();
      if (!item) throw new Error('未找到待确认配对');
      await callTool(base, ownerToken, 'network_device_pairing_approve', {
        request_id: requestId('e2e_approve'),
        pairing_id: item.pairing_id,
      });

      await expect(page.locator('#pair-switch')).toBeVisible({ timeout: 15_000 });
      await page.locator('#pair-switch').click();
      await page.waitForURL(`${base}/`);
      await expect(page.locator('body[data-spa-route="home"]')).toBeVisible();
      await expect(page.locator('#account-name')).toHaveText(ownerName);
      const pairedToken = await page.evaluate(() =>
        window.localStorage.getItem('agent-network-token'),
      );
      expect(pairedToken).toBeTruthy();
      expect(pairedToken).not.toBe(ownerToken);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
