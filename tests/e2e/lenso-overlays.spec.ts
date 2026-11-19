import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 全部测试走生产 Vite chunk 与真实工具；故障注入拦截实际 index-*.js，不用 stub。
const manifest = JSON.parse(readFileSync('dist/web/.vite/manifest.json', 'utf8')) as Record<string, { file: string; name?: string; isDynamicEntry?: boolean }>;
const lensoChunk = Object.values(manifest).find((chunk) => chunk.name === 'index' && chunk.isDynamicEntry)!.file;
let base: string;
let token: string;
let group: string;
let direct: string;
let message: string;
let peerName: string;

async function tool<T>(auth: string, name: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name,
      authorization: `Bearer ${auth}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tools/call', params: {
      name, arguments: args, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'n2a-overlays', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    } }),
  });
  const payload = await response.json() as {
    error?: { message: string };
    result?: { isError?: boolean; structuredContent?: T; content?: { text?: string }[] };
  };
  if (payload.error || payload.result?.isError) throw new Error(`工具失败：${name}`);
  return payload.result?.structuredContent ?? JSON.parse(payload.result?.content?.[0]?.text ?? 'null') as T;
}

const request = () => ({ request_id: `n2a_${crypto.randomUUID().replaceAll('-', '')}` });

async function login(page: Page, room = group, ready = true) {
  await page.addInitScript((auth) => localStorage.setItem('agent-network-token', auth), token);
  await page.goto(`${base}/c/${room}`);
  await expect(page.locator('#title')).toBeVisible();
  if (ready) {
    // 使用不参与菜单 lease 的常驻控件确认模块已就绪。
    await expect(page.locator('#message-search-button')).toHaveAttribute('data-lenso-slot', 'button');
  }
}

async function roomMenu(page: Page, action: string) {
  await page.locator('#room-menu-toggle').click();
  await page.locator(`#room-menu-${action}`).click();
}

interface Consumer {
  name: string;
  id: string;
  title: string;
  room?: () => string;
  open: (page: Page) => Promise<void>;
  returnTo: string;
}

const search = { name: 'MessageSearchDialog', id: 'message-search-dialog', title: 'message-search-title',
  returnTo: '#message-search-button', open: async (page: Page) => { await page.locator('#message-search-button').click(); } };
const context = { name: 'MessageContextDialog', id: 'message-context-dialog', title: 'message-context-title',
  returnTo: '.message-search-result', open: async (page: Page) => {
    if (!(await page.locator('#message-search-dialog').isVisible())) await search.open(page);
    await page.locator('#message-search-input').fill('N2a overlay');
    await page.locator('#message-search-form button[type=submit]').click();
    await page.locator('.message-search-result').first().click();
  } };
const consumers: Consumer[] = [
  { name: 'ForwardDialog', id: 'forward-modal', title: 'forward-title', returnTo: '[data-message-id].msg',
    open: async (page) => {
      await page.locator('#body').focus();
      await page.locator(`[data-message-id="${message}"] .bubble`).click({ button: 'right' });
      await page.locator('#message-action-forward').click();
    } },
  { name: 'AgentReissueDialog', id: 'agent-reissue-modal', title: 'agent-reissue-title',
    room: () => direct, returnTo: '#room-menu-toggle', open: async (page) => {
      await roomMenu(page, 'reissue-token');
      await page.locator('#confirm-dialog-ok').click();
    } },
  { name: 'AnnouncementDialog', id: 'announcement-modal', title: 'announcement-modal-title',
    returnTo: '#room-menu-toggle', open: (page) => roomMenu(page, 'announcement') },
  { name: 'GroupCreateDialog', id: 'group-modal', title: 'group-modal-title',
    returnTo: '#new-group', open: async (page) => { await page.locator('#new-group').click(); } },
  { name: 'MeRenameDialog', id: 'me-rename-dialog', title: 'me-rename-title',
    returnTo: '#account-rename', open: async (page) => { await page.locator('#account-rename').click(); } },
  { name: 'NewAgentDialog', id: 'new-agent-modal', title: 'new-agent-title',
    returnTo: '#new-agent', open: async (page) => { await page.locator('#new-agent').click(); } },
  { name: 'RenameAgentDialog', id: 'rename-modal', title: 'rename-modal-title', room: () => direct,
    returnTo: '#rename', open: async (page) => { await page.locator('#rename').click(); } },
  { name: 'RenameRoomDialog', id: 'room-rename-dialog', title: 'room-rename-title',
    returnTo: '#room-menu-toggle', open: (page) => roomMenu(page, 'rename') },
  { name: 'ReportDialog', id: 'report-modal', title: 'report-modal-title', room: () => direct,
    returnTo: '#room-menu-toggle', open: (page) => roomMenu(page, 'report') },
  { name: 'TransferDialog', id: 'transfer-modal', title: 'transfer-title', room: () => direct,
    returnTo: '#room-menu-toggle', open: (page) => roomMenu(page, 'transfer') },
  { name: 'MembersDialog', id: 'members-modal', title: 'members-modal-title',
    returnTo: '#members-button', open: async (page) => { await page.locator('#members-button').click(); } },
  { name: 'ContactRequestsDialog', id: 'contact-modal', title: 'contact-modal-title',
    returnTo: '#contact-requests', open: async (page) => { await page.locator('#contact-requests').click(); } },
  search,
  context,
];

async function contract(page: Page, item: Consumer): Promise<Locator> {
  const dialog = page.locator(`#${item.id}`);
  await expect(dialog).toHaveAttribute('data-lenso-slot', 'modal-popup');
  await expect(dialog).toHaveAttribute('role', 'dialog');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog).toHaveClass(/modal-card/u);
  await expect(dialog).toHaveClass(/spa-dialog-content/u);
  await expect(dialog.locator(`h2#${item.title}`)).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-labelledby', item.title);
  await expect(dialog.locator('.spa-dialog-close')).toHaveAttribute('aria-label', '关闭');
  expect(await dialog.evaluate((node) => node.matches(':popover-open') || Boolean(node.closest(':popover-open')))).toBe(true);
  return dialog;
}

async function nestedFallback(page: Page, item: Consumer) {
  if (item.name === 'MembersDialog') {
    await page.locator('#members-current-search').fill('');
    const remove = page.getByRole('button', { name: `移除 ${peerName}` });
    await remove.click();
    await expect(page.locator('#confirm-dialog')).toHaveAttribute('data-alert-shell', 'radix');
    await page.locator('#confirm-dialog-cancel').click();
    await expect(remove).toBeFocused();
    const avatar = page.locator('#members-modal .memory-avatar-trigger').first();
    await avatar.click({ button: 'right' });
    await expect(page.locator('#members-modal #memory-avatar-menu')).toBeVisible();
    await expect(page.locator('#members-modal #memory-avatar-menu')).not.toHaveAttribute('data-lenso-slot');
    await page.keyboard.press('Escape');
    await expect(page.locator('#members-modal')).toBeVisible();
    await expect(avatar).toBeFocused();
  } else if (item.name === 'ContactRequestsDialog') {
    await page.locator('#contact-tab-more').click();
    await page.locator('#contact-link-create').click();
    await expect(page.locator('#contact-link-status')).toContainText('链接已生成');
    const revoke = page.locator('#contact-link-list').getByRole('button', { name: /撤销好友链接/ }).first();
    await revoke.click();
    await expect(page.locator('#confirm-dialog')).toHaveAttribute('data-alert-shell', 'radix');
    await page.locator('#confirm-dialog-cancel').click();
    await expect(revoke).toBeFocused();
    await expect(page.locator('#contact-modal')).toBeVisible();
  } else if (item === search) {
    await page.locator('#message-search-input').fill('N2a overlay');
    await page.locator('#message-search-form button[type=submit]').click();
    await page.locator('.message-search-result').first().click();
    await expect(page.locator('#message-context-dialog')).toHaveAttribute('data-modal-shell', 'fallback');
    await expect.poll(() => page.locator('#message-context-dialog').evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#message-search-dialog')).toBeVisible();
    await expect(page.locator('.message-search-result').first()).toBeFocused();
  }
}

test('共享 Modal：14/14 默认 Lenso，TaskTrace 仅保留 Drawer 的 Radix fallback', () => {
  expect(consumers).toHaveLength(14);
  const paths = ['chat/ForwardDialog', 'overlays/AgentReissueDialog', 'overlays/AnnouncementDialog',
    'overlays/ContactRequestsDialog', 'overlays/GroupCreateDialog', 'overlays/MeRenameDialog',
    'overlays/MembersDialog', 'overlays/NewAgentDialog', 'overlays/RenameAgentDialog',
    'overlays/RenameRoomDialog', 'overlays/ReportDialog', 'overlays/TransferDialog', 'tasks/MessageSearchDialog'];
  let instances = 0;
  for (const path of paths) {
    const source = readFileSync(`src/web/features/${path}.tsx`, 'utf8');
    instances += [...source.matchAll(/<Modal\b/g)].length;
    expect(source).not.toContain('shell="radix"');
    expect(source).not.toMatch(/TODO\(N2[b-c]/);
  }
  expect(instances).toBe(14);
  const runtime = readFileSync('src/web/app/lenso-runtime.ts', 'utf8');
  expect(runtime).toContain("import('@lenso/ui')");
});

test.beforeAll(async () => {
  base = process.env.E2E_BASE_URL ?? JSON.parse(readFileSync(resolve('.e2e/server.json'), 'utf8')).base;
  token = crypto.randomUUID();
  const peerToken = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);
  await tool(token, 'network_register', { ...request(), kind: 'human', name: `N2a ${suffix}` });
  peerName = `Peer ${suffix}`;
  const peer = await tool<{ actor_id: string }>(peerToken, 'network_register', {
    ...request(), kind: 'human', name: peerName,
  });
  const invitation = await tool<{ request?: { contact_request_id: string } }>(token, 'network_contact_request', {
    ...request(), actor_id: peer.actor_id,
  });
  if (invitation.request) await tool(peerToken, 'network_contact_request_respond', {
    ...request(), contact_request_id: invitation.request.contact_request_id, action: 'accept',
  });
  const agent = await tool<{ actor_id: string }>(token, 'network_agent_create', { ...request(), name: `Agent ${suffix}` });
  const created = await tool<{ room: { room_id: string } }>(token, 'network_room_create', {
    ...request(), kind: 'group', title: `N2a ${suffix}`, members: [peer.actor_id, agent.actor_id],
  });
  group = created.room.room_id;
  direct = (await tool<{ room: { room_id: string } }>(token, 'network_room_create', {
    ...request(), kind: 'direct', members: [agent.actor_id],
  })).room.room_id;
  message = (await tool<{ message: { message_id: string } }>(token, 'network_message_send', {
    ...request(), client_message_id: crypto.randomUUID(), room_id: group, body: 'N2a overlay task', invoke: [],
  })).message.message_id;
  await tool(token, 'network_task_mark', { ...request(), room_id: group, message_id: message });
});

for (const item of consumers) {
  test(`${item.name}：真实 Lenso DOM、关闭键/Esc/背板与焦点归还`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await login(page, item.room?.() ?? group);
    for (const close of ['button', 'escape', 'backdrop']) {
      await item.open(page);
      const dialog = await contract(page, item);
      const field = ({ ForwardDialog: ['forward-search', '选择转发会话'], AgentReissueDialog: ['room-menu-reissue-text', '新提示词'], MessageSearchDialog: ['message-search-input', '搜索消息内容'] } as Record<string, string[]>)[item.name];
      if (field) {
        await expect(page.locator(`label[for="${field[0]}"]`)).toHaveAttribute('data-lenso-slot', 'label');
        await expect(page.locator(`#${field[0]}`)).toHaveAccessibleName(field[1]!);
      }
      await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      if (close === 'button') await dialog.locator('.spa-dialog-close').click();
      else if (close === 'escape') await page.keyboard.press('Escape');
      else await page.locator('.spa-dialog-overlay').last().click({ position: { x: 5, y: 5 } });
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(item.returnTo)).toBeFocused();
      if (item === context) {
        await expect(page.locator('#message-search-dialog')).toBeVisible();
        await page.keyboard.press('Escape');
      }
      await expect(page.locator('.spa-dialog-overlay')).toHaveCount(0);
    }
  });
}

test('Members + confirm 取消只关子层，AgentAvatarMenu → AgentMemory 保留既有流程', async ({ page }) => {
  await login(page);
  await page.locator('#members-button').click();
  const members = page.locator('#members-modal');
  await expect(members).toHaveAttribute('data-lenso-slot', 'modal-popup');
  const remove = page.getByRole('button', { name: `移除 ${peerName}` });
  await remove.click();
  await expect(page.locator('#confirm-dialog')).toHaveAttribute('data-alert-shell', 'lenso');
  await page.locator('#confirm-dialog-cancel').click();
  await expect(members).toBeVisible();
  await expect(remove).toBeFocused();
  const avatar = members.locator('.memory-avatar-trigger').first();
  for (const mode of ['escape', 'outside', 'keyboard']) {
    await avatar.focus();
    if (mode === 'keyboard') await page.keyboard.press('Shift+F10');
    else await avatar.click({ button: 'right' });
    const menu = page.locator('#members-modal #memory-avatar-menu');
    await expect(menu).toHaveAttribute('data-lenso-slot', 'context-menu-layout');
    if (mode === 'outside') await members.locator('h2').click();
    else await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(members).toBeVisible();
    await expect(avatar).toBeFocused();
  }
  await avatar.click({ button: 'right' });
  await page.locator('#memory-avatar-open').click();
  // 现有业务主动关闭 Members 后打开 AgentMemory，本次不改这个时序。
  await expect(members).toHaveCount(0);
  await expect(page.locator('#agent-memory-dialog')).toHaveAttribute('data-agent-memory-shell', 'lenso');
  await page.keyboard.press('Escape');
  await expect(page.locator('#agent-memory-dialog')).toHaveCount(0);
  await expect(page.locator('#members-button')).toBeFocused();
});

test('ContactRequests 使用 Lenso：撤销链接取消与确认均保留父层及状态', async ({ page }) => {
  await login(page);
  await page.locator('#contact-requests').click();
  const dialog = page.locator('#contact-modal');
  await expect(dialog).toHaveAttribute('data-lenso-slot', 'modal-popup');
  await page.locator('#contact-tab-more').click();
  await page.locator('#contact-link-create').click();
  await expect(page.locator('#contact-link-status')).toContainText('链接已生成');
  const revoke = page.locator('#contact-link-list .contact-link-item').first()
    .getByRole('button', { name: /撤销好友链接/ });
  await revoke.click();
  await expect(page.locator('#confirm-dialog')).toHaveAttribute('data-alert-shell', 'lenso');
  await page.locator('#confirm-dialog-cancel').click();
  await expect(dialog).toBeVisible();
  await expect(revoke).toBeFocused();
  await expect(page.locator('#contact-link-status')).toContainText('链接已生成');
  await revoke.click();
  await expect(page.locator('#confirm-dialog')).toHaveAttribute('data-alert-shell', 'lenso');
  await page.locator('#confirm-dialog-ok').click();
  await expect(page.locator('#confirm-dialog')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(page.locator('#contact-link-status')).toContainText('已撤销好友链接');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('#contact-requests')).toBeFocused();
});

test('MessageSearch 双实例与 TaskTrace 使用 Lenso，关闭子层不关闭搜索', async ({ page }) => {
  await login(page);
  await page.locator('#message-search-button').click();
  await expect(page.locator('#message-search-dialog')).toHaveAttribute('data-lenso-slot', 'modal-popup');
  await page.locator('#message-search-input').fill('N2a overlay');
  await page.locator('#message-search-form button[type=submit]').click();
  await page.locator('.message-search-result').first().click();
  await expect(page.locator('#message-context-dialog')).toHaveAttribute('data-lenso-slot', 'modal-popup');
  await page.locator('#message-context-close').click();
  await expect(page.locator('#message-context-dialog')).toHaveCount(0);
  await expect(page.locator('#message-search-dialog')).toBeVisible();
  await page.getByRole('checkbox', { name: '只看任务' }).check();
  await page.locator('#message-search-form button[type=submit]').click();
  await page.locator('.task-search-result').first().click();
  await expect(page.locator('#task-trace-drawer')).toHaveAttribute('data-task-trace-shell', 'lenso');
  await page.keyboard.press('Escape');
  await expect(page.locator('#task-trace-drawer')).toHaveCount(0);
  // Task 分支既有行为是先关闭搜索再打开 Trace。
  await expect(page.locator('#message-search-dialog')).toHaveCount(0);
});

for (const width of [1280, 390]) {
  for (const colorScheme of ['light', 'dark'] as const) {
    test(`${width} ${colorScheme}：Members 菜单/confirm、Contact confirm、搜索上下文嵌套`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme });
      await login(page);
      await page.locator('#members-button').click();
      const members = page.locator('#members-modal');
      const remove = page.getByRole('button', { name: `移除 ${peerName}` });
      await remove.click();
      await expect(page.locator('#confirm-dialog')).toHaveAttribute('data-alert-shell', 'lenso');
      await page.keyboard.press('Escape');
      await expect(members).toBeVisible();
      await expect(remove).toBeFocused();
      const avatar = members.locator('.memory-avatar-trigger').first();
      await avatar.click({ button: 'right' });
      await expect(page.locator('#members-modal #memory-avatar-menu')).toHaveAttribute('data-lenso-slot', 'context-menu-layout');
      await page.keyboard.press('Escape');
      await expect(avatar).toBeFocused();
      await page.keyboard.press('Escape');
      await context.open(page);
      const child = await contract(page, context);
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press(i < 3 ? 'Tab' : 'Shift+Tab');
        expect(await child.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('#message-search-dialog')).toBeVisible();
      await expect(page.locator('.message-search-result')).toBeFocused();
      await page.keyboard.press('Escape');
      await page.goto(`${base}/`);
      await expect(page.locator('#contact-requests')).toHaveAttribute('data-lenso-slot', 'button');
      await page.locator('#contact-requests').click();
      await page.locator('#contact-tab-more').click();
      await page.locator('#contact-link-create').click();
      await expect(page.locator('#contact-link-status')).toContainText('链接已生成');
      const revoke = page.locator('#contact-link-list').getByRole('button', { name: /撤销好友链接/ }).first();
      await revoke.click();
      await expect(page.locator('#confirm-dialog')).toHaveAttribute('data-alert-shell', 'lenso');
      await page.keyboard.press('Escape');
      await expect(page.locator('#contact-modal')).toBeVisible();
      await expect(revoke).toBeFocused();
      await expect(page.locator('#contact-link-status')).toContainText('链接已生成');
    });
    test(`${width} ${colorScheme}：几何、焦点围栏、scroll lock 与卸载`, async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width, height: 844 });
      await page.emulateMedia({ colorScheme });
      for (const item of consumers) {
        await login(page, item.room?.() ?? group);
        // 移动端聊天页不挂载侧栏；从实际首页入口打开账号/建群弹窗。
        if (['GroupCreateDialog', 'MeRenameDialog', 'NewAgentDialog', 'ContactRequestsDialog'].includes(item.name)) {
          await page.goto(`${base}/`);
          await expect(page.locator('#new-group')).toHaveAttribute('data-lenso-slot', 'button');
        }
        const scrollBefore = await page.evaluate(() => [document.body, document.documentElement].map((node) => node.style.cssText));
        await item.open(page);
        const dialog = await contract(page, item);
        await expect.poll(async () => Math.round((await dialog.boundingBox())?.width ?? 0)).toBe(width === 390 ? 390 : item.name === 'ContactRequestsDialog' ? 760 : ['MembersDialog', 'MessageSearchDialog', 'MessageContextDialog'].includes(item.name) ? 680 : 440);
        const box = (await dialog.boundingBox())!;
        if (width === 390) expect(box).toMatchObject({ x: 0, y: 0, height: 844 });
        else expect(Math.abs(box.x + box.width / 2 - 640)).toBeLessThan(1);
        const colors = await dialog.evaluate((node) => getComputedStyle(node).backgroundColor);
        const channels = colors.match(/\d+/gu)!.slice(0, 3).map(Number);
        expect(channels.every((channel) => colorScheme === 'dark' ? channel < 120 : channel > 200)).toBe(true);
        for (let i = 0; i < 12; i++) {
          await page.keyboard.press(i < 6 ? 'Tab' : 'Shift+Tab');
          expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
        }
        expect(await page.evaluate(() => [document.body, document.documentElement].some((node) => getComputedStyle(node).overflowY === 'hidden'))).toBe(true);
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        if (item === context) await page.keyboard.press('Escape');
        await expect.poll(() => page.evaluate(() => [document.body, document.documentElement].map((node) => node.style.cssText))).toEqual(scrollBefore);
      }
      await login(page);
      await page.locator('#message-search-button').click();
      await page.locator('#message-search-input').fill('N2a overlay');
      await page.getByRole('checkbox', { name: '只看任务' }).check();
      await page.locator('#message-search-form button[type=submit]').click();
      await page.locator('.task-search-result').first().click();
      const trace = page.locator('#task-trace-drawer');
      await expect(trace).toHaveAttribute('data-task-trace-shell', 'lenso');
      await expect.poll(async () => Math.round((await trace.boundingBox())?.width ?? 0)).toBe(width === 390 ? 390 : 560);
      // Radix 保留既有入场动画；宽度不随动画变化，需等待完整几何而非只等宽度。
      await expect.poll(async () => {
        const box = await trace.boundingBox();
        return box && { x: Math.round(box.x), y: Math.round(box.y), height: Math.round(box.height) };
      }).toEqual({ x: width === 390 ? 0 : 720, y: 0, height: 844 });
      await page.keyboard.press('Escape');
      await expect(trace).toHaveCount(0);
    });
  }
}

for (const item of consumers) {
  test(`${item.name}：延迟真实 index chunk，本次打开锁 fallback，重开升级`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let intercepted = 0;
    await page.route(`**/${lensoChunk}`, async (route) => {
      intercepted++;
      await gate;
      await route.continue();
    });
    try {
      await login(page, item.room?.() ?? group, false);
      await item.open(page);
      const dialog = page.locator(`#${item.id}`);
      await expect(dialog).toHaveAttribute('data-modal-shell', 'fallback');
      const migratedLabel = ({ ForwardDialog: 'forward-search', AgentReissueDialog: 'room-menu-reissue-text', MessageSearchDialog: 'message-search-input' } as Record<string, string>)[item.name];
      if (migratedLabel) await expect(dialog.locator(`label[for="${migratedLabel}"]`)).toHaveAttribute('data-lenso-slot', 'label-fallback');
      expect(intercepted).toBeGreaterThan(0);
      if (item.name === 'TransferDialog') await expect(page.locator('#transfer-successor-search')).toBeVisible();
      // 真正保存全部控件节点引用，验证模块到达不替换编辑/菜单节点。
      const editable = dialog.locator('input:not([readonly]):not([type=hidden]), textarea').first();
      const readonly = await editable.count() ? await editable.getAttribute('readonly') !== null : false;
      if (await editable.count()) {
        if (!readonly) await editable.fill('保持输入与选区');
        await editable.evaluate((node) => {
          // 提示词可能含凭据：只在浏览器内比较，不进入断言错误输出。
          const input = node as HTMLInputElement & { __n2aValue?: string };
          input.__n2aValue = input.value;
          input.focus();
          input.setSelectionRange(1, 4);
        });
      }
      if (item.name === 'ReportDialog') await page.locator('#report-category').selectOption('spam');
      await dialog.evaluate((node) => {
        const win = window as unknown as { __n2aNodes: Element[]; __n2aFocus: Element | null };
        win.__n2aNodes = [node, ...node.querySelectorAll('input,textarea,select,button,[role=menu]')];
        win.__n2aFocus = document.activeElement;
      });
      release();
      await expect(page.locator('#message-search-button')).toHaveAttribute('data-lenso-slot', 'button');
      await expect(dialog).toHaveAttribute('data-modal-shell', 'fallback');
      expect(await page.evaluate(() => {
        const win = window as unknown as { __n2aNodes: Element[]; __n2aFocus: Element | null };
        return win.__n2aNodes.every((node) => node.isConnected) && win.__n2aFocus === document.activeElement;
      })).toBe(true);
      if (await editable.count()) {
        expect(await editable.evaluate((node) => {
          const input = node as HTMLInputElement & { __n2aValue?: string };
          return input.value === input.__n2aValue;
        })).toBe(true);
        expect(await editable.evaluate((node) => [(node as HTMLInputElement).selectionStart, (node as HTMLInputElement).selectionEnd])).toEqual([1, 4]);
      }
      if (item.name === 'ReportDialog') await expect(page.locator('#report-category')).toHaveValue('spam');
      await nestedFallback(page, item);
      await dialog.locator('.spa-dialog-close').click();
      await expect(dialog).toHaveCount(0);
      if (item === context) await page.keyboard.press('Escape');
      await item.open(page);
      await contract(page, item);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    } finally { release(); }
  });
}

for (const item of consumers) {
  test(`${item.name}：永久失败后 fallback 仍可操作、关闭与重开`, async ({ page }) => {
    let aborted = 0;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route(`**/${lensoChunk}`, async (route) => { aborted++; await route.abort('failed'); });
    await login(page, item.room?.() ?? group, false);
    for (let i = 0; i < 2; i++) {
      await item.open(page);
      const dialog = page.locator(`#${item.id}`);
      await expect(dialog).toHaveAttribute('data-modal-shell', 'fallback');
      if (item.name === 'ReportDialog') {
        await page.locator('#report-category').selectOption('spam');
        await page.locator('#report-note').fill('fallback 可编辑');
        await expect(page.locator('#report-note')).toHaveValue('fallback 可编辑');
      }
      await nestedFallback(page, item);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    expect(aborted).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
}

for (const delayed of [true, false]) {
  test(`MessageSearch → TaskTrace：${delayed ? '慢加载保持 fallback、重开升级' : '阻断后同库 fallback'}`, async ({ page }) => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    let intercepted = 0;
    await page.route(`**/${lensoChunk}`, async (route) => {
      intercepted++;
      if (delayed) { await gate; await route.continue(); }
      else await route.abort('failed');
    });
    try {
      await login(page, group, false);
      await search.open(page);
      await expect(page.locator('#message-search-dialog')).toHaveAttribute('data-modal-shell', 'fallback');
      await page.getByRole('checkbox', { name: '只看任务' }).check();
      const openTask = async () => {
        await page.locator('#message-search-input').fill('N2a overlay');
        await page.locator('#message-search-form button[type=submit]').click();
        await page.locator('.task-search-result').first().click();
      };
      await openTask();
      const trace = page.locator('#task-trace-drawer');
      await expect(trace).toHaveAttribute('data-modal-shell', 'radix');
      if (delayed) {
        release();
        await expect(page.locator('#message-search-button')).toHaveAttribute('data-lenso-slot', 'button');
        await expect(trace).toHaveAttribute('data-modal-shell', 'radix');
      }
      await page.keyboard.press('Escape');
      await expect(trace).toHaveCount(0);
      await search.open(page);
      await page.getByRole('checkbox', { name: '只看任务' }).check();
      await openTask();
      await expect(trace).toHaveAttribute(delayed ? 'data-task-trace-shell' : 'data-modal-shell', delayed ? 'lenso' : 'radix');
      expect(intercepted).toBeGreaterThan(0);
    } finally { release(); }
  });
}

test('连续关闭重开：旧 top layer 与动画不遮挡下一个 dialog', async ({ page }) => {
  await login(page);
  await consumers.find((item) => item.name === 'RenameRoomDialog')!.open(page);
  await contract(page, consumers.find((item) => item.name === 'RenameRoomDialog')!);
  await page.locator('#room-rename-dialog .spa-dialog-close').click();
  await consumers[2]!.open(page);
  await contract(page, consumers[2]!);
  expect(await page.evaluate(() => document.querySelectorAll('[data-lenso-slot="modal-popup"]').length)).toBe(1);
  await page.locator('#announcement-input').fill('下一个弹窗可操作');
  await expect(page.locator('#announcement-input')).toBeFocused();
  await page.locator('#announcement-modal .spa-dialog-close').click();
  await expect(page.locator('.spa-dialog-overlay')).toHaveCount(0);
});
