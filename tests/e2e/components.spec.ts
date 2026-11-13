import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 4B-4 组件验收：Radix dialog/menu/popover、Ariakit Combobox、dropzone、
 * resizable panels、RHF 表单与 zustand 持久化。
 *
 * 需要 `WEB_SPA_ROUTES=home,room E2E_SPA=1`。组与好友在 beforeAll 用真实
 * MCP 工具创建，页面断言只走浏览器交互。
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
            name: 'agent-network-e2e-components',
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

const SPA_ENABLED =
  process.env.E2E_SPA === '1' &&
  (process.env.WEB_SPA_ROUTES ?? '')
    .split(',')
    .map((value) => value.trim())
    .some((value) => value === 'room' || value === 'all');

async function login(page: Page, base: string, token: string): Promise<void> {
  await page.addInitScript(
    ({ token, base: origin }) => {
      try {
        localStorage.setItem('agent-network-token', token);
        localStorage.removeItem('agent-network-logged-out');
        localStorage.setItem('agent-network-room-filter', 'group');
        sessionStorage.setItem('__origin', origin);
      } catch {
        // 页面会显示错误态。
      }
    },
    { token, base },
  );
}

test.describe.serial('SPA 组件库与状态管理', () => {
  test.skip(!SPA_ENABLED, '需要 WEB_SPA_ROUTES=home,room E2E_SPA=1 才运行组件用例');

  let base = '';
  let tokenA = '';
  let tokenB = '';
  let actorA = '';
  let actorB = '';
  let nameB = '';
  let roomId = '';
  let roomTitle = '';

  test.beforeAll(async () => {
    base = await baseUrl();
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    tokenA = crypto.randomUUID();
    tokenB = crypto.randomUUID();
    nameB = `组件 B ${suffix}`;
    roomTitle = `组件群 ${suffix}`;

    const a = await callTool<{ actor_id: string }>(base, tokenA, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: `组件 A ${suffix}`,
      device_id: `e2e-components-${suffix}-a`,
    });
    actorA = a.actor_id;
    const b = await callTool<{ actor_id: string }>(base, tokenB, 'network_register', {
      request_id: requestId('e2e_reg'),
      kind: 'human',
      name: nameB,
      device_id: `e2e-components-${suffix}-b`,
    });
    actorB = b.actor_id;
    const request = await callTool<{ request: { contact_request_id: string } | null }>(
      base,
      tokenA,
      'network_contact_request',
      { request_id: requestId('e2e_contact'), actor_id: actorB },
    );
    const contactRequestId = request.request?.contact_request_id;
    if (!contactRequestId) throw new Error('好友申请未创建');
    await callTool(base, tokenB, 'network_contact_request_respond', {
      request_id: requestId('e2e_contact'),
      contact_request_id: contactRequestId,
      action: 'accept',
    });

    const created = await callTool<{ room: { room_id: string; title: string } }>(
      base,
      tokenA,
      'network_room_create',
      {
        request_id: requestId('e2e_group'),
        kind: 'group',
        title: roomTitle,
        members: [actorB],
      },
    );
    roomId = created.room.room_id;
    await callTool(base, tokenB, 'network_message_send', {
      request_id: requestId('e2e_send'),
      client_message_id: requestId('e2e_cm'),
      room_id: roomId,
      body: '组件验收初始消息',
      invoke: [],
    });
  });

  test.beforeEach(async ({ page }) => {
    await login(page, base, tokenA);
  });

  test('home 保留筛选与 zustand 持久化，面板可键盘缩放并双击复位', async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.locator('#room-list .room-item')).toHaveCount(1);
    await expect(page.locator('#room-filter-group')).toHaveAttribute('aria-selected', 'true');
    // legacy 兼容：筛选仍是纯字符串，不是 zustand 的 JSON。
    expect(await page.evaluate(() => localStorage.getItem('agent-network-room-filter'))).toBe(
      'group',
    );

    const handle = page.locator('#sidebar-resizer');
    await expect(handle).toBeVisible();
    const before = await page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().width);
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect
      .poll(async () =>
        page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeGreaterThan(before);

    // 重新加载后从 zustand 恢复用户调整过的比例。
    await page.reload();
    await expect(page.locator('#room-list .room-item')).toHaveCount(1);
    const restored = await page
      .locator('.sidebar')
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(restored).toBeGreaterThan(before);

    await page.locator('#sidebar-resizer').dblclick();
    await expect
      .poll(async () =>
        page.locator('.sidebar').evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeLessThan(restored);
  });

  test('建群弹窗用 RHF + Ariakit 选择成员，并导航到新群', async ({ page }) => {
    await page.goto(`${base}/`);
    await expect(page.locator('#new-group')).toBeVisible();
    await page.locator('#new-group').click();
    const dialog = page.locator('#group-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('role', 'dialog');

    await page.fill('#group-name-input', `弹窗群 ${Date.now()}`);
    await page.locator('#group-search').fill(nameB.slice(0, 4));
    const option = page.locator('#group-contacts .spa-combobox-item').filter({ hasText: nameB });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.locator('#group-selection .spa-chip')).toHaveCount(1);
    await expect(page.locator('#group-contacts-count')).toContainText('已选 1 人');

    await page.locator('#group-create').click();
    await expect(page).toHaveURL(/\/c\/[^/]+$/);
    await expect(page.locator('#composer')).toBeVisible();
    await expect(page.locator('#subtitle')).toContainText('群聊');
  });

  test('群聊提及用 Ariakit Combobox：键盘选择、IME 不误触、Enter 发送', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await page.locator('#body').click();
    await page.keyboard.type('@');
    const picker = page.locator('#mention-picker');
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute('role', 'listbox');
    await expect(picker.locator('[role="option"]').first()).toContainText(nameB);

    await page.keyboard.press('Enter');
    await expect(page.locator('#body')).toHaveValue(new RegExp(`@${nameB} `));

    await page.keyboard.type('组件提及');
    await page.keyboard.press('Enter');
    await expect(page.locator('#messages .msg.mine .bubble').last()).toContainText(nameB, {
      timeout: 10_000,
    });
    await expect(page.locator('#messages .msg.mine .bubble').last()).toContainText('组件提及');

    // 组合输入期间打开候选不应吞掉 IME 的 Enter。
    const before = await page.locator('#messages .msg.mine').count();
    await page.locator('#body').click();
    await page.evaluate(() => {
      document
        .getElementById('body')
        ?.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await page.keyboard.type('@组合');
    expect(await page.locator('#mention-picker').isVisible()).toBe(false);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    expect(await page.locator('#messages .msg.mine').count()).toBe(before);

    // 点击外部关闭候选，不留下一个被 hidden 强制显示的浮层。
    await page.evaluate(() => {
      document
        .getElementById('body')
        ?.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await page.fill('#body', '');
    await page.locator('#body').click();
    await page.keyboard.type('@');
    await expect(page.locator('#mention-picker')).toBeVisible();
    await page.locator('#messages').click();
    await expect(page.locator('#mention-picker')).toBeHidden();
  });

  test('附件菜单、消息右键/长按与焦点返回', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();

    await page.locator('#attach-file').click();
    await expect(page.locator('#attach-menu')).toBeVisible();
    await expect(page.locator('#attach-menu-file')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#attach-menu')).toBeHidden();
    await expect(page.locator('#attach-file')).toBeFocused();

    const message = page.locator('#messages .msg').first();
    await message.click({ button: 'right' });
    await expect(page.locator('#message-context-menu')).toBeVisible();
    await expect(page.locator('#message-context-menu')).toContainText('复制');
    await page.keyboard.press('Escape');
    await expect(page.locator('#message-context-menu')).toBeHidden();

    // 移动端长按：pointer 计时后合成 contextmenu。
    await message.evaluate((element) => {
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          pointerType: 'touch',
          clientX: 40,
          clientY: 120,
        }),
      );
    });
    await page.waitForTimeout(650);
    await expect(page.locator('#message-context-menu')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('拖放上传走 dropzone，仍保留 XHR 进度与文件 chip', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await page.evaluate(() => {
      const form = document.getElementById('composer');
      if (!form) return;
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([new Blob(['dropzone attachment'])], 'drop-note.txt', { type: 'text/plain' }),
      );
      form.dispatchEvent(
        new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    });
    await expect(page.locator('#composer-files .composer-file')).toHaveCount(1);
    await expect(page.locator('#composer-files .composer-file-meta')).not.toContainText('上传中', {
      timeout: 15_000,
    });
  });

  test('成员/公告/改名弹窗与确认框：Esc、背板、焦点与提交', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#title')).toHaveText(roomTitle);

    await page.locator('#room-menu-toggle').click();
    await expect(page.locator('#room-menu')).toBeVisible();
    await page.locator('#room-menu-members').click();
    const members = page.locator('#members-modal');
    await expect(members).toBeVisible();
    await expect(members).toContainText(nameB);
    await page.keyboard.press('Escape');
    await expect(members).toBeHidden();

    // 移除成员走 confirmDialog：取消不应改动成员。
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-members').click();
    await page.getByRole('button', { name: `移除 ${nameB}` }).click();
    const confirm = page.locator('#confirm-dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(nameB);
    await page.locator('#confirm-dialog-cancel').click();
    await expect(confirm).toBeHidden();
    await expect(page.locator('#members-modal')).toContainText(nameB);
    await expect(page.getByRole('button', { name: `移除 ${nameB}` })).toBeFocused();

    // 确认移除后再从好友里加回来，覆盖 add/remove 两条路径。
    await page.getByRole('button', { name: `移除 ${nameB}` }).click();
    await page.locator('#confirm-dialog-ok').click();
    await expect(page.locator('#members-current')).not.toContainText(nameB);
    await page.fill('#members-search', nameB.slice(0, 4));
    const addOption = page
      .locator('#members-contacts .spa-combobox-item')
      .filter({ hasText: nameB });
    await expect(addOption).toBeVisible();
    await addOption.click();
    await expect(page.locator('#members-current')).toContainText(nameB);
    await expect(page.locator('#members-error')).toHaveCount(0);

    // 公告：保存后头部 popover 可见。
    await page.keyboard.press('Escape');
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-announcement').click();
    await page.fill('#announcement-input', '组件验收公告');
    await page.locator('#announcement-save').click();
    await expect(page.locator('#announcement-modal')).toBeHidden();
    await expect(page.locator('#room-announcement')).toContainText('组件验收公告');
    await page.locator('#room-announcement-info').click();
    await expect(page.locator('#room-announcement-popover')).toContainText('组件验收公告');
    await page.keyboard.press('Escape');

    // 群改名。
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-rename').click();
    await page.fill('#room-rename-input', `${roomTitle} 改名`);
    await page.locator('#room-rename-save').click();
    await expect(page.locator('#room-rename-dialog')).toBeHidden();
    await expect(page.locator('#title')).toHaveText(`${roomTitle} 改名`);
  });

  test('dialog/menu/combobox/resizer 无 critical/serious axe 违规', async ({ page }) => {
    page.on('console', (message) => {
      if (message.text().startsWith('AXE')) console.log(message.text());
    });
    async function violations(selector: string): Promise<string[]> {
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
            serious.map((item) => ({ id: item.id, nodes: item.nodes.map((node) => node.target) })),
          ),
        );
      }
      return serious.map((item) => `${item.id}(${item.impact})`);
    }

    await page.goto(`${base}/`);
    await expect(page.locator('#room-list .room-item').first()).toBeVisible();
    expect(await violations('#sidebar-resizer')).toEqual([]);

    await page.locator('#new-group').click();
    await expect(page.locator('#group-modal')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#group-modal')).toEqual([]);
    await page.keyboard.press('Escape');

    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await page.locator('#room-menu-toggle').click();
    await expect(page.locator('#room-menu')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#room-menu')).toEqual([]);
    await page.locator('#room-menu-members').click();
    await expect(page.locator('#members-modal')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#members-modal')).toEqual([]);
    await page.getByRole('button', { name: `移除 ${nameB}` }).click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#confirm-dialog')).toEqual([]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await page.locator('#body').click();
    await page.keyboard.type('@');
    await expect(page.locator('#mention-picker')).toBeVisible();
    await page.waitForTimeout(220);
    expect(await violations('#mention-picker')).toEqual([]);
  });

  test('移动端 <760 单栏、弹窗不横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/`);
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('#sidebar-resizer')).toHaveCount(0);
    await page.locator('#new-group').click();
    await expect(page.locator('#group-modal')).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('#group-modal')).toBeHidden();
  });
});
