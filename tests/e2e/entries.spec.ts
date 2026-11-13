import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 4B-5b 剩余入口：好友申请、设备配对与已归档 Agents。
 * 需要 `WEB_SPA_ROUTES=all E2E_SPA=1 bun run test:e2e`。
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

interface RegisteredHuman extends Registered {
  token: string;
}

interface AgentCreated {
  actor_id: string;
  name: string;
}

interface ContactRequestResult {
  request: { contact_request_id: string } | null;
}

interface ContactRequestPage {
  items: { contact_request_id: string; status: string }[];
}

interface DevicePairingCreated {
  pairing_id: string;
  challenge: string;
  pair_url: string;
}

interface DevicePairingPage {
  items: { pairing_id: string; status: string; confirm_code: string | null }[];
}

interface AgentGetPage {
  items: { actor_id: string; archived: boolean }[];
}

const ROUTES = (process.env.WEB_SPA_ROUTES ?? '')
  .split(',')
  .map((value) => value.trim());
const SPA_ENABLED =
  process.env.E2E_SPA === '1' &&
  (ROUTES.includes('all') ||
    ['home', 'room', 'share', 'join', 'pair'].every((route) => ROUTES.includes(route)));

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

async function registerHuman(base: string, name: string): Promise<RegisteredHuman> {
  const token = crypto.randomUUID();
  const actor = await callTool<Registered>(base, token, 'network_register', {
    request_id: requestId('e2e_reg'),
    kind: 'human',
    name,
  });
  return { ...actor, token };
}

async function seriousViolations(page: Page, selector: string): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .include(selector)
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const serious = results.violations.filter(
    (item) => item.impact === 'critical' || item.impact === 'serious',
  );
  if (serious.length > 0) {
    console.log(
      'AXE',
      selector,
      JSON.stringify(
        serious.map((item) => ({
          id: item.id,
          nodes: item.nodes.map((node) => ({
            target: node.target,
            html: node.html,
            summary: node.failureSummary,
          })),
        })),
      ),
    );
  }
  return serious.map((item) => `${item.id}(${item.impact})`);
}

async function openAccountMenu(page: Page): Promise<void> {
  await page.locator('#account-menu-toggle').click();
  await expect(page.locator('#account-menu')).toBeVisible();
}

test.describe('SPA 剩余入口', () => {
  test.skip(!SPA_ENABLED, '需要 WEB_SPA_ROUTES=all E2E_SPA=1');

  test('好友申请可列出、接受、拒绝与撤销，并同步角标和会话列表', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const a = await registerHuman(base, `Entry A ${suffix}`);
    const b = await registerHuman(base, `Entry B ${suffix}`);
    const c = await registerHuman(base, `Entry C ${suffix}`);
    const d = await registerHuman(base, `Entry D ${suffix}`);

    const incoming = await callTool<ContactRequestResult>(
      base,
      b.token,
      'network_contact_request',
      { request_id: requestId('e2e_contact'), actor_id: a.actor_id, message: 'B 的申请' },
    );
    const incomingId = incoming.request?.contact_request_id;
    if (!incomingId) throw new Error('B 的好友申请未创建');
    const incomingReject = await callTool<ContactRequestResult>(
      base,
      d.token,
      'network_contact_request',
      { request_id: requestId('e2e_contact'), actor_id: a.actor_id, message: 'D 的申请' },
    );
    const rejectId = incomingReject.request?.contact_request_id;
    if (!rejectId) throw new Error('D 的好友申请未创建');
    const outgoing = await callTool<ContactRequestResult>(
      base,
      a.token,
      'network_contact_request',
      { request_id: requestId('e2e_contact'), actor_id: c.actor_id },
    );
    const outgoingId = outgoing.request?.contact_request_id;
    if (!outgoingId) throw new Error('A 发出的好友申请未创建');

    await login(page, base, a.token);
    await expect(page.locator('#contact-requests-badge')).toHaveText('2');
    await page.locator('#contact-requests').click();
    await expect(page.locator('#contact-modal')).toBeVisible();
    await expect(page.locator('#contact-modal-title')).toHaveText('好友申请');

    const items = page.locator('#contact-request-list .contact-request-item');
    await expect(items).toHaveCount(3);

    const acceptRow = items.filter({ hasText: b.name });
    await acceptRow.getByRole('button', { name: '接受' }).click();
    await expect(page.locator('#contact-request-status')).toContainText('已接受好友申请。');
    await expect(items).toHaveCount(2);
    await expect(page.locator('#room-list')).toContainText(b.name);

    const rejectRow = items.filter({ hasText: d.name });
    await rejectRow.getByRole('button', { name: '拒绝' }).click();
    await expect(page.locator('#contact-request-status')).toContainText('已拒绝好友申请。');
    await expect(items).toHaveCount(1);

    const outgoingRow = items.filter({ hasText: c.name });
    await outgoingRow.getByRole('button', { name: '撤销申请' }).click();
    await expect(page.locator('#contact-request-status')).toContainText('已撤销好友申请。');
    await expect(items).toHaveCount(0);
    await expect(page.locator('#contact-request-list')).toContainText('暂无待处理申请。');
    await expect(page.locator('#contact-requests-badge')).toBeHidden();

    const all = await callTool<ContactRequestPage>(base, a.token, 'network_contact_requests_list', {
      direction: 'all',
      limit: 50,
    });
    const statusOf = (id: string) =>
      all.items.find((item) => item.contact_request_id === id)?.status ?? 'missing';
    expect(statusOf(incomingId)).toBe('accepted');
    expect(statusOf(rejectId)).toBe('rejected');
    expect(statusOf(outgoingId)).toBe('cancelled');

    await page.keyboard.press('Escape');
    await expect(page.locator('#contact-modal')).toBeHidden();
    await expect(page.locator('#contact-requests')).toBeFocused();
  });

  test('设备配对生成一次性二维码、确认新设备并在 /pair 立即清除 fragment', async ({
    page,
    browser,
  }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Pair Owner ${suffix}`);

    // 模拟新设备扫码后 join：挑战来自页面打开前创建的独立 challenge。
    const joined = await callTool<DevicePairingCreated>(
      base,
      owner.token,
      'network_device_pairing_create',
      { request_id: requestId('e2e_pair'), device_label: 'E2E 新设备', platform: 'Playwright' },
    );
    const newDeviceToken = crypto.randomUUID();
    await callTool(base, newDeviceToken, 'network_device_pairing_join', {
      request_id: requestId('e2e_pair_join'),
      challenge: joined.challenge,
      device_id: `e2e-pair-${suffix}`,
      device_label: 'E2E 新设备',
      platform: 'Playwright',
    });

    await login(page, base, owner.token);
    await openAccountMenu(page);
    await page.locator('#device-handoff').click();
    await expect(page.locator('#handoff-modal')).toBeVisible();
    await expect(page.locator('#pairing-qr-wrap')).toBeVisible();
    await expect(page.locator('#pairing-code')).toHaveText(
      /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/u,
    );
    expect(await page.locator('#handoff-qr').evaluate((node) => (node as HTMLCanvasElement).width))
      .toBeGreaterThan(0);
    await expect(page.locator('.handoff-warning')).toContainText('请勿截图或分享');

    const firstCode = (await page.locator('#pairing-code').textContent()) ?? '';
    await page.locator('#pairing-create').click();
    await expect(page.locator('#pairing-create')).toBeEnabled();
    await expect(page.locator('#pairing-code')).not.toHaveText(firstCode);

    const deviceRow = page.locator('.pairing-item').filter({ hasText: 'E2E 新设备' });
    await expect(deviceRow).toBeVisible();
    await deviceRow.getByRole('button', { name: '确认新设备' }).click();
    await expect(page.locator('#pairing-status')).toContainText('已确认');

    const pairingPage = await callTool<DevicePairingPage>(
      base,
      owner.token,
      'network_device_pairing_list',
      { limit: 50 },
    );
    expect(
      pairingPage.items.some(
        (item) => item.pairing_id === joined.pairing_id && item.status === 'approved',
      ),
    ).toBe(true);

    await page.locator('#handoff-close').click();
    await expect(page.locator('#handoff-modal')).toBeHidden();
    await expect(page.locator('#account-menu-toggle')).toBeFocused();

    const fragment = await callTool<DevicePairingCreated>(
      base,
      owner.token,
      'network_device_pairing_create',
      { request_id: requestId('e2e_pair_fragment') },
    );
    const context = await browser.newContext();
    const other = await context.newPage();
    try {
      await other.goto(`${base}/pair#c=${encodeURIComponent(fragment.challenge)}`);
      await expect(other.locator('#pair-challenge')).toHaveValue(
        fragment.challenge.toUpperCase(),
      );
      expect(await other.evaluate(() => window.location.hash)).toBe('');
    } finally {
      await context.close();
    }
  });

  test('聊天菜单归档 Agent，已归档浮层确认恢复并回到会话列表', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Archive Owner ${suffix}`);
    const agent = await callTool<AgentCreated>(base, owner.token, 'network_agent_create', {
      request_id: requestId('e2e_agent'),
      name: `Archive Agent ${suffix}`,
    });
    const createdRoom = await callTool<{ room: { room_id: string } }>(
      base,
      owner.token,
      'network_room_create',
      { request_id: requestId('e2e_agent_room'), kind: 'direct', members: [agent.actor_id] },
    );
    const rooms = await callTool<{
      items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
    }>(base, owner.token, 'network_rooms_list', { limit: 50 });
    const room = rooms.items.find(
      (item) =>
        item.room_id === createdRoom.room.room_id &&
        item.kind === 'direct' &&
        item.peer?.actor_id === agent.actor_id,
    );
    if (!room) throw new Error('Agent 未生成 direct 会话');

    await login(page, base, owner.token);
    await page.goto(`${base}/c/${room.room_id}`);
    await expect(page.locator('#title')).toHaveText(agent.name);
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-archive').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#confirm-dialog-ok').click();
    await expect(page.locator('#status')).toContainText('已归档');

    const archivedLookup = await callTool<AgentGetPage>(
      base,
      owner.token,
      'network_agents_get',
      { actor_ids: [agent.actor_id] },
    );
    expect(archivedLookup.items[0]?.archived).toBe(true);

    await page.goto(base);
    await page.locator('#room-filter-agent').click();
    await expect(page.locator(`#room-list a[href="/c/${room.room_id}"]`)).toHaveCount(0);

    await openAccountMenu(page);
    await page.locator('#archived-agents').click();
    await expect(page.locator('#archive-popover')).toBeVisible();
    const row = page.locator(
      `#archive-popover-list .archive-item[data-actor-id="${agent.actor_id}"]`,
    );
    await expect(row).toBeVisible();
    await expect(row).toContainText(agent.name);
    await page.waitForTimeout(220);
    expect(await seriousViolations(page, '#archive-popover')).toEqual([]);

    await row.getByRole('button', { name: `恢复 ${agent.name}` }).click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#confirm-dialog-ok').click();
    await expect(page.locator('#archive-popover-status')).toContainText('已恢复');
    await expect(row).toHaveCount(0);
    await page.locator('#archive-popover-close').click();
    await expect(page.locator('#archive-popover')).toBeHidden();
    await expect(page.locator(`#room-list a[href="/c/${room.room_id}"]`)).toHaveCount(1, {
      timeout: 10_000,
    });

    const restored = await callTool<AgentGetPage>(
      base,
      owner.token,
      'network_agents_get',
      { actor_ids: [agent.actor_id] },
    );
    expect(restored.items[0]?.archived).toBe(false);
  });

  test.describe('mobile', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('好友申请与设备配对是全屏单栏且无横向溢出', async ({ page }) => {
      const base = await baseUrl();
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
      const owner = await registerHuman(base, `Mobile Owner ${suffix}`);
      const peer = await registerHuman(base, `Mobile Peer ${suffix}`);
      await callTool(base, peer.token, 'network_contact_request', {
        request_id: requestId('e2e_contact'),
        actor_id: owner.actor_id,
      });

      await login(page, base, owner.token);
      await page.locator('#contact-requests').click();
      await expect(page.locator('#contact-modal')).toBeVisible();
      await page.waitForTimeout(220);
      const contactBox = await page.locator('#contact-modal').boundingBox();
      expect(contactBox?.width ?? 0).toBeGreaterThanOrEqual(390);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
      expect(await seriousViolations(page, '#contact-modal')).toEqual([]);
      await page.keyboard.press('Escape');

      await openAccountMenu(page);
      await page.locator('#device-handoff').click();
      await expect(page.locator('#handoff-modal')).toBeVisible();
      await expect(page.locator('#pairing-qr-wrap')).toBeVisible();
      await page.waitForTimeout(220);
      const handoffBox = await page.locator('#handoff-modal').boundingBox();
      expect(handoffBox?.width ?? 0).toBeGreaterThanOrEqual(390);
      expect(handoffBox?.height ?? 0).toBeGreaterThanOrEqual(800);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
      ).toBe(true);
      expect(await seriousViolations(page, '#handoff-modal')).toEqual([]);
    });
  });

  test.describe('dark mode', () => {
    test.use({ colorScheme: 'dark' });

    test('好友申请弹窗使用暗色面板并通过 axe', async ({ page }) => {
      const base = await baseUrl();
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
      const owner = await registerHuman(base, `Dark Owner ${suffix}`);
      const peer = await registerHuman(base, `Dark Peer ${suffix}`);
      await callTool(base, peer.token, 'network_contact_request', {
        request_id: requestId('e2e_contact'),
        actor_id: owner.actor_id,
      });

      await login(page, base, owner.token);
      await page.locator('#contact-requests').click();
      await expect(page.locator('#contact-modal')).toBeVisible();
      const background = await page
        .locator('#contact-modal')
        .evaluate((node) => getComputedStyle(node).backgroundColor);
      const channels = background.match(/\d+/gu)?.slice(0, 3).map(Number) ?? [];
      expect(channels).toHaveLength(3);
      expect(channels.every((value) => value < 120)).toBe(true);
      await page.waitForTimeout(220);
      expect(await seriousViolations(page, '#contact-modal')).toEqual([]);
    });
  });
});
