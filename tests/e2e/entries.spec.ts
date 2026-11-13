import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 4B-5b 剩余入口：好友申请、设备配对与已归档 Agents。
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

interface ContactLinkCreated {
  link: { link_id: string } | null;
  share_url: string;
}

interface ContactSearchPage {
  items: { actor: { actor_id: string; name: string } }[];
}

interface AgentCreatedDetail {
  actor_id: string;
  name: string;
  token: string;
  mcp_url: string;
}

interface RoomCreated {
  room: { room_id: string };
  invited?: { invitation_id: string; actor_id: string }[];
}

interface RoomDetailView {
  room: { room_id: string; kind: string; status: string; policies?: Record<string, string> };
  members: { actor_id: string; role: string }[];
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

async function registerHuman(base: string, name: string): Promise<RegisteredHuman> {
  const token = crypto.randomUUID();
  const actor = await callTool<Registered>(base, token, 'network_register', {
    request_id: requestId('e2e_reg'),
    kind: 'human',
    name,
  });
  return { ...actor, token };
}

async function befriend(base: string, from: RegisteredHuman, to: RegisteredHuman): Promise<void> {
  const created = await callTool<ContactRequestResult>(
    base,
    from.token,
    'network_contact_request',
    { request_id: requestId('e2e_friend'), actor_id: to.actor_id },
  );
  const requestIdValue = created.request?.contact_request_id;
  if (!requestIdValue) return;
  await callTool(base, to.token, 'network_contact_request_respond', {
    request_id: requestId('e2e_friend_accept'),
    contact_request_id: requestIdValue,
    action: 'accept',
  });
}

async function createDirectRoom(
  base: string,
  owner: RegisteredHuman,
  peer: RegisteredHuman,
): Promise<string> {
  const detail = await callTool<{ room: { room_id: string } }>(
    base,
    owner.token,
    'network_room_create',
    { request_id: requestId('e2e_direct'), kind: 'direct', members: [peer.actor_id] },
  );
  return detail.room.room_id;
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
    await expect(page.locator('#contact-modal-title')).toHaveText('添加好友');
    await page.locator('#contact-tab-requests').click();
    await expect(page.locator('#contact-panel-requests')).toBeVisible();

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

  test('好友搜索、申请、链接管理与接收策略可用，好友链接可直接兑换', async ({
    page,
    browser,
  }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Link Owner ${suffix}`);
    const peer = await registerHuman(base, `Link Peer ${suffix}`);
    const guest = await registerHuman(base, `Link Guest ${suffix}`);

    await login(page, base, owner.token);
    await page.locator('#contact-requests').click();
    await expect(page.locator('#contact-modal')).toBeVisible();
    await expect(page.locator('#contact-tab-search')).toHaveAttribute('aria-selected', 'true');

    await page.locator('#contact-search-input').fill(peer.name);
    await page.locator('#contact-search-submit').click();
    await expect(page.locator('#contact-search-status')).toContainText('找到 1 位用户');
    await page
      .locator('#contact-search-results .contact-search-item')
      .filter({ hasText: peer.name })
      .getByRole('button', { name: '核对 ID' })
      .click();
    await expect(page.locator('#contact-search-confirm-id')).toHaveText(peer.actor_id);
    await page.locator('#contact-search-message').fill('E2E 好友申请');
    await page.locator('#contact-search-send').click();
    await expect(page.locator('#contact-search-status')).toContainText('好友邀请已发送');

    const peerRequests = await callTool<{
      items: { contact_request_id: string }[];
    }>(base, peer.token, 'network_contact_requests_list', {
      direction: 'incoming',
      status: 'pending',
      limit: 50,
    });
    const incomingId = peerRequests.items[0]?.contact_request_id;
    if (!incomingId) throw new Error('搜索添加未创建好友申请');
    await callTool(base, peer.token, 'network_contact_request_respond', {
      request_id: requestId('e2e_link_accept'),
      contact_request_id: incomingId,
      action: 'accept',
    });

    await page.locator('#contact-tab-more').click();
    await expect(page.locator('#contact-panel-more')).toBeVisible();
    await page.locator('#contact-link-create').click();
    await expect(page.locator('#contact-link-status')).toContainText('链接已生成');
    await expect(page.locator('#contact-link-copy')).toBeVisible();
    await page.locator('#contact-link-copy').click();
    await expect(page.locator('#contact-link-status')).toContainText('已复制');
    const linkRow = page.locator('#contact-link-list .contact-link-item').first();
    await expect(linkRow).toBeVisible();
    await linkRow.getByRole('button', { name: /撤销好友链接/ }).click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#confirm-dialog-ok').click();
    await expect(page.locator('#contact-link-status')).toContainText('已撤销好友链接');

    await page.locator('#contact-policy-select').selectOption('auto_accept');
    await expect(page.locator('#contact-policy-status')).toContainText('自动接受');

    const created = await callTool<ContactLinkCreated>(
      base,
      owner.token,
      'network_contact_link_create',
      { request_id: requestId('e2e_link_redeem') },
    );
    const guestContext = await browser.newContext();
    const guestPage = await guestContext.newPage();
    try {
      await guestPage.addInitScript((token) => {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
      }, guest.token);
      await guestPage.goto(created.share_url);
      await expect(guestPage.locator('#contact-link-banner')).toContainText('已添加好友');
      await expect(guestPage.locator('#contact-link-banner')).toBeVisible();
      expect(await guestPage.evaluate(() => window.location.hash)).toBe('');
    } finally {
      await guestContext.close();
    }
  });

  test('置顶、免打扰、拉黑/解除与删除好友写回服务端', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Safety Owner ${suffix}`);
    const blockedPeer = await registerHuman(base, `Safety Blocked ${suffix}`);
    const deletedPeer = await registerHuman(base, `Safety Deleted ${suffix}`);
    await befriend(base, owner, blockedPeer);
    await befriend(base, owner, deletedPeer);
    const blockedRoom = await createDirectRoom(base, owner, blockedPeer);
    const deletedRoom = await createDirectRoom(base, owner, deletedPeer);

    await login(page, base, owner.token);
    await page.goto(`${base}/c/${blockedRoom}`);
    await expect(page.locator('#title')).toHaveText(blockedPeer.name);

    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-pin').click();
    await expect(page.locator('#status')).toContainText('仅在此浏览器生效');
    await page.locator('#room-menu-toggle').click();
    await expect(page.locator('#room-menu-pin')).toHaveText('取消置顶');
    await page.locator('#room-menu-mute').click();
    await page.locator('#room-menu-toggle').click();
    await expect(page.locator('#room-menu-mute')).toHaveText('恢复消息提醒');
    await page.keyboard.press('Escape');

    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-block').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#confirm-dialog-ok').click();
    await expect(page.locator('#status')).toContainText('已拉黑');
    const blocks = await callTool<{
      items: { active: boolean; blocked_actor: { actor_id: string } | null }[];
    }>(base, owner.token, 'network_contact_blocks_list', { limit: 100 });
    expect(
      blocks.items.some(
        (item) => item.active && item.blocked_actor?.actor_id === blockedPeer.actor_id,
      ),
    ).toBe(true);

    await page.locator('#room-menu-toggle').click();
    await expect(page.locator('#room-menu-block')).toHaveText('解除拉黑');
    await page.locator('#room-menu-block').click();
    await page.locator('#confirm-dialog-ok').click();
    await expect(page.locator('#status')).toContainText('已解除拉黑');
    const unblocked = await callTool<{
      items: { active: boolean; blocked_actor: { actor_id: string } | null }[];
    }>(base, owner.token, 'network_contact_blocks_list', { limit: 100 });
    expect(
      unblocked.items.some(
        (item) => item.active && item.blocked_actor?.actor_id === blockedPeer.actor_id,
      ),
    ).toBe(false);

    await page.goto(`${base}/c/${deletedRoom}`);
    await expect(page.locator('#title')).toHaveText(deletedPeer.name);
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-delete-friend').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#confirm-dialog-ok').click();
    await expect(page).toHaveURL(`${base}/`);
    await expect(page.locator(`#room-list a[href="/c/${deletedRoom}"]`)).toHaveCount(0);
  });

  test('Agent 停用/启用、重置 token 与全局改名分隔重置和复制', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Agent Owner ${suffix}`);
    const agent = await callTool<AgentCreatedDetail>(
      base,
      owner.token,
      'network_agent_create',
      { request_id: requestId('e2e_agent_manage'), name: `Managed ${suffix}` },
    );
    const room = await createDirectRoom(base, owner, {
      ...agent,
      token: owner.token,
    });

    await login(page, base, owner.token);
    await page.goto(`${base}/c/${room}`);
    await expect(page.locator('#title')).toHaveText(agent.name);

    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-toggle-disabled').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#confirm-dialog-ok').click();
    await expect(page.locator('#status')).toContainText('已停用');
    let management = await callTool<{ disabled: boolean }>(
      base,
      owner.token,
      'network_agent_management_get',
      { actor_id: agent.actor_id },
    );
    expect(management.disabled).toBe(true);

    await page.locator('#room-menu-toggle').click();
    await expect(page.locator('#room-menu-toggle-disabled')).toHaveText('启用 Agent');
    await page.locator('#room-menu-toggle-disabled').click();
    await expect(page.locator('#status')).toContainText('已启用');
    management = await callTool<{ disabled: boolean }>(
      base,
      owner.token,
      'network_agent_management_get',
      { actor_id: agent.actor_id },
    );
    expect(management.disabled).toBe(false);

    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-reissue-token').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#confirm-dialog-ok').click();
    await expect(page.locator('#agent-reissue-modal')).toBeVisible();
    const prompt = await page.locator('#room-menu-reissue-text').inputValue();
    expect(prompt).toContain('AGENTNET_TOKEN');
    expect(prompt).not.toContain(agent.token);
    await expect(page.locator('#room-menu-reissue-copy-prompt')).toBeVisible();
    await page.locator('#agent-reissue-close').click();
    await expect(page.locator('#agent-reissue-modal')).toBeHidden();

    let oldTokenRejected = false;
    try {
      await callTool(base, agent.token, 'network_me', {});
    } catch {
      oldTokenRejected = true;
    }
    expect(oldTokenRejected).toBe(true);

    const renamed = `Renamed ${suffix}`;
    await page.locator('#rename').click();
    await page.locator('#rename-input').fill(renamed);
    await page.locator('#rename-save').click();
    await expect(page.locator('#title')).toHaveText(renamed);
  });

  test('群角色、邀请、策略、Task 搜索/Trace 与解散可用', async ({ page }) => {
    const base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const owner = await registerHuman(base, `Group Owner ${suffix}`);
    const member = await registerHuman(base, `Group Member ${suffix}`);
    await befriend(base, owner, member);
    const targetRoom = await createDirectRoom(base, owner, member);
    const created = await callTool<RoomCreated>(base, owner.token, 'network_room_create', {
      request_id: requestId('e2e_group'),
      kind: 'group',
      title: `Parity Group ${suffix}`,
      members: [member.actor_id],
    });
    const invitation = created.invited?.find((entry) => entry.actor_id === member.actor_id);
    if (invitation) {
      await callTool(base, member.token, 'network_room_invite_respond', {
        request_id: requestId('e2e_group_accept'),
        invitation_id: invitation.invitation_id,
        action: 'accept',
      });
    }
    const groupId = created.room.room_id;
    const sent = await callTool<{ message: { message_id: string } }>(
      base,
      owner.token,
      'network_message_send',
      {
        request_id: requestId('e2e_group_msg'),
        client_message_id: requestId('e2e_group_client'),
        room_id: groupId,
        body: '青柠里程碑：交付评审在本周五。',
        invoke: [],
      },
    );
    const rootId = sent.message.message_id;

    await login(page, base, owner.token);
    await page.goto(`${base}/c/${groupId}`);
    await expect(page.locator('#title')).toHaveText(`Parity Group ${suffix}`);

    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-members').click();
    await expect(page.locator('#members-modal')).toBeVisible();
    const memberRow = page
      .locator('#members-current .spa-member')
      .filter({ hasText: member.name });
    await memberRow.getByRole('button', { name: `设为管理员 ${member.name}` }).click();
    await expect
      .poll(async () => {
        const detail = await callTool<RoomDetailView>(
          base,
          owner.token,
          'network_room_get',
          { room_id: groupId },
        );
        return detail.members.find((entry) => entry.actor_id === member.actor_id)?.role;
      })
      .toBe('admin');
    await page
      .locator('#members-current .spa-member')
      .filter({ hasText: member.name })
      .getByRole('button', { name: `撤销管理员 ${member.name}` })
      .click();
    await expect
      .poll(async () => {
        const detail = await callTool<RoomDetailView>(
          base,
          owner.token,
          'network_room_get',
          { room_id: groupId },
        );
        return detail.members.find((entry) => entry.actor_id === member.actor_id)?.role;
      })
      .toBe('member');

    await page.locator('#members-invite-create').click();
    await expect(page.locator('#members-invite-share')).toBeVisible();
    await expect(page.locator('#members-invite-url')).toContainText('/j/');
    await page.locator('#members-invite-copy').click();
    await expect(page.locator('#members-invites-status')).toContainText('已复制邀请链接');

    await page.locator('#group-policy-join').selectOption('approval');
    await page.locator('#group-policy-save').click();
    await expect(page.locator('#group-policy-status')).toContainText('已保存群策略');
    const detail = await callTool<RoomDetailView>(base, owner.token, 'network_room_get', {
      room_id: groupId,
    });
    expect(detail.room.policies?.member_join).toBe('approval');
    await page.locator('#members-close').click();

    const root = page.locator(`#messages [data-message-id="${rootId}"]`);
    await expect(root).toBeVisible();
    await root.getByRole('button', { name: '消息操作' }).click();
    await page.locator('#message-action-task').click();
    await expect(root.locator('.task-bar')).toBeVisible();

    await page.locator('#message-search-button').click();
    await expect(page.locator('#message-search-dialog')).toBeVisible();
    await page.locator('#message-search-input').fill('柠');
    await page.locator('#message-search-form button[type="submit"]').click();
    await expect(page.locator('#message-search-results .message-search-result')).toHaveCount(1);
    await page.locator('[data-task-only]').check();
    await page.locator('#message-search-form button[type="submit"]').click();
    const taskResult = page.locator('#message-search-results .task-search-result').first();
    await expect(taskResult).toBeVisible();
    await taskResult.click();
    await expect(page.locator('#task-trace-drawer')).toBeVisible();
    await expect(page.locator('#task-trace-items .task-trace-item')).not.toHaveCount(0);
    await page.locator('#task-trace-close').click();

    await root.getByRole('button', { name: '消息操作' }).click();
    await page.locator('#message-action-forward').click();
    await expect(page.locator('#forward-modal')).toBeVisible();
    await page
      .locator('#forward-rooms button')
      .filter({ hasText: member.name })
      .click();
    await expect(page.locator('#forward-send')).toBeEnabled();
    await page.locator('#forward-send').click();
    await expect(page.locator('#status')).toContainText('已转发给');
    const forwarded = await callTool<{ items: { preview: string }[] }>(
      base,
      owner.token,
      'network_history_list',
      { room_id: targetRoom, direction: 'before', limit: 20 },
    );
    expect(forwarded.items.some((item) => item.preview.includes('【转发消息】'))).toBe(true);

    await root.getByRole('button', { name: '消息操作' }).click();
    await page.locator('#message-action-recall').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#confirm-dialog-ok').click();
    await expect(page.locator('#messages')).toContainText('此消息已撤回');

    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-dissolve').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.locator('#confirm-dialog-ok').click();
    await expect(page.locator('#room-archive-banner')).toBeVisible();
    const dissolved = await callTool<RoomDetailView>(base, owner.token, 'network_room_get', {
      room_id: groupId,
    });
    expect(dissolved.room.status).toBe('dissolved');
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
