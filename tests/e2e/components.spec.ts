import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * 4B-4 组件验收：Radix dialog/menu/popover、Ariakit Combobox、dropzone、
 * resizable panels、RHF 表单与 zustand 持久化。
 *
 * 组与好友在 beforeAll 用真实
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

/** 在页面内真实构造 DataTransfer 并派发拖拽事件；返回默认行为是否被阻止。 */
async function dragFile(
  page: Page,
  selector: string,
  type: 'dragenter' | 'dragover' | 'drop',
  name: string,
): Promise<boolean> {
  return page.evaluate(
    ({ selector: targetSelector, type: eventType, name: fileName }) => {
      const target = document.querySelector(targetSelector);
      if (!target) throw new Error(`拖拽目标不存在: ${targetSelector}`);
      const transfer = new DataTransfer();
      transfer.items.add(new File([`dropzone ${fileName}`], fileName, { type: 'text/plain' }));
      const event = new DragEvent(eventType, {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      });
      return !target.dispatchEvent(event);
    },
    { selector, type, name },
  );
}

test.describe.serial('SPA 组件库与状态管理', () => {

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
    await expect(page.locator('#room-filter [data-lenso-slot="segmented-control"]')).toBeVisible();
    await expect(page.locator('#room-filter-group').locator('xpath=ancestor::button')).toHaveAttribute('aria-checked', 'true');
    await page.locator('#room-filter-friend').click();
    await page.locator('#room-filter-friend').locator('xpath=ancestor::button').press('ArrowRight');
    await expect(page.locator('#room-filter-agent').locator('xpath=ancestor::button')).toHaveAttribute('aria-checked', 'true');
    await page.locator('#room-filter-group').click();
    // legacy 兼容：筛选仍是纯字符串，不是 zustand 的 JSON。
    expect(await page.evaluate(() => localStorage.getItem('agent-network-room-filter'))).toBe(
      'group',
    );
    // Lenso SegmentedControl 在指针释放后会排一帧聚焦选中项；等它结算，
    // 避免随后 focus 分隔条时被这一帧抢走焦点。
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
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
    await expect(page.locator('#group-name-input')).toHaveAttribute('data-lenso-slot', 'input');

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
    // 首载静态输入区不可交互，必须等真实 composer 接管后再触发 drop。
    await expect(page.locator('#body')).toBeEnabled();
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

  test('聊天区拖拽上传：单一 dropzone 覆盖消息区、阻止默认并生成 chip', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await expect(page.locator('#body')).toBeEnabled();
    const name = `chat-drop-${Date.now()}.txt`;
    const before = page.url();

    expect(await dragFile(page, '#messages', 'dragenter', name)).toBe(true);
    const overlay = page.locator('#composer-drop');
    await expect(overlay).toBeVisible();
    const overlayBox = await overlay.boundingBox();
    const bodyBox = await page.locator('#chat-body').boundingBox();
    expect(overlayBox && bodyBox).toBeTruthy();
    if (overlayBox && bodyBox) {
      // 提示层的视觉范围必须接近整个聊天区，和实际命中范围一致。
      expect(overlayBox.width).toBeGreaterThan(bodyBox.width * 0.9);
      expect(overlayBox.height).toBeGreaterThan(bodyBox.height * 0.9);
    }
    expect(await dragFile(page, '#messages', 'dragover', name)).toBe(true);
    expect(await dragFile(page, '#messages', 'drop', name)).toBe(true);

    await expect(overlay).toBeHidden();
    expect(page.url()).toBe(before);
    const chip = page.locator('#composer-files .composer-file');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveAttribute('data-file-id', /.+/, { timeout: 15_000 });
    await expect(chip.locator('.composer-file-meta')).not.toContainText('上传中');
  });

  test('输入区按钮保持视觉尺寸并用 ::after 扩到 44px 命中区', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await expect(page.locator('#body')).toBeEnabled();
    await page.fill('#body', '命中区探针');
    await page.locator('#composer-file-input').setInputFiles({
      name: 'hit-area.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await expect(page.locator('#composer-files .composer-file')).toHaveCount(1);
    await expect(page.locator('#composer-files .composer-file-meta')).not.toContainText('上传中', {
      timeout: 15_000,
    });
    const chipThumb = page.locator('#composer-files .composer-file-thumb');
    await expect(chipThumb).toBeVisible({ timeout: 15_000 });
    expect(await chipThumb.boundingBox()).toMatchObject({ width: 48, height: 48 });

    const surfaces = await page.evaluate(() => {
      const read = (selector: string) => {
        const element = document.querySelector(selector);
        if (!(element instanceof HTMLElement)) return null;
        const box = element.getBoundingClientRect();
        const cx = box.left + box.width / 2;
        const cy = box.top + box.height / 2;
        const hit = (dx: number, dy: number) => {
          const target = document.elementFromPoint(cx + dx, cy + dy);
          return target instanceof Element && target.closest(selector) === element;
        };
        return {
          width: Math.round(box.width),
          height: Math.round(box.height),
          up: hit(0, -21),
          down: hit(0, 21),
          left: hit(-21, 0),
          right: hit(21, 0),
        };
      };
      return {
        attach: read('#attach-file'),
        send: read('#send'),
        remove: read('.composer-file-remove'),
        search: read('#message-search-button'),
      };
    });

    // 视觉盒保持原尺寸：38px 附件/发送、22px 移除。
    expect(surfaces.attach).toMatchObject({
      width: 38,
      height: 38,
      up: true,
      down: true,
      left: true,
      right: true,
    });
    expect(surfaces.send).toMatchObject({
      height: 38,
      up: true,
      down: true,
      left: true,
      right: true,
    });
    expect(surfaces.remove).toMatchObject({
      width: 22,
      height: 22,
      up: true,
      down: true,
      left: true,
      right: true,
    });
    // 头部文字按钮只用 ::after 纵向扩到 44px，不把 56px 头撑高。
    expect(surfaces.search).toMatchObject({ up: true, down: true });
    const header = await page.evaluate(() => {
      const node = document.querySelector('.chat-head');
      const actions = document.querySelector('.chat-head-actions');
      if (!(node instanceof HTMLElement) || !(actions instanceof HTMLElement)) return null;
      return {
        height: node.getBoundingClientRect().height,
        actionsHeight: actions.getBoundingClientRect().height,
      };
    });
    expect(header).not.toBeNull();
    expect(header!.height).toBeLessThan(59);
    expect(header!.actionsHeight).toBeLessThan(44);
  });

  test('只读归档房间不显示输入区，聊天区拖拽不上传且不导航', async ({ page }) => {
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
    const created = await callTool<{ room: { room_id: string } }>(
      base,
      tokenA,
      'network_room_create',
      {
        request_id: requestId('e2e_readonly'),
        kind: 'group',
        title: `只读群 ${suffix}`,
        members: [actorB],
      },
    );
    const readOnlyRoom = created.room.room_id;
    await callTool(base, tokenA, 'network_room_dissolve', {
      request_id: requestId('e2e_dissolve'),
      room_id: readOnlyRoom,
    });

    const uploads: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/mcp-upload')) uploads.push(request.url());
    });

    await page.goto(`${base}/c/${readOnlyRoom}`);
    await expect(page.locator('#room-archive-banner')).toBeVisible();
    await expect(page.locator('#composer')).toHaveCount(0);
    await expect(page.locator('#composer-drop')).toHaveCount(0);
    const before = page.url();

    await dragFile(page, '#chat-body', 'dragenter', 'readonly-drop.txt');
    await expect(page.locator('#composer-drop')).toHaveCount(0);
    expect(await dragFile(page, '#chat-body', 'dragover', 'readonly-drop.txt')).toBe(true);
    expect(await dragFile(page, '#chat-body', 'drop', 'readonly-drop.txt')).toBe(true);
    await page.waitForTimeout(500);

    expect(page.url()).toBe(before);
    expect(uploads).toEqual([]);
    await expect(page.locator('#composer-files .composer-file')).toHaveCount(0);
  });

  test('成员/公告/改名弹窗与确认框：Esc、背板、焦点与提交', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#title')).toHaveText(roomTitle);

    // 群成员入口已常驻在搜索右侧，会话菜单不再重复。
    await page.locator('#room-menu-toggle').click();
    await expect(page.locator('#room-menu')).toBeVisible();
    await expect(page.locator('#room-menu-members')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.locator('#room-menu')).toBeHidden();
    await page.locator('#members-button').click();
    const members = page.locator('#members-modal');
    await expect(members).toBeVisible();
    await expect(members).toContainText(nameB);
    await expect(page.locator('#members-search')).toHaveAttribute(
      'data-lenso-slot',
      'search-field-input',
    );
    await expect(page.locator('#members-invite-days')).toHaveAttribute(
      'data-lenso-slot',
      'number-field-input',
    );
    await page.fill('#members-invite-days', '5');
    await expect(page.locator('#members-invite-days')).toHaveValue('5');
    await page.keyboard.press('Escape');
    await expect(members).toBeHidden();

    // 移除成员走 confirmDialog：取消不应改动成员。
    await page.locator('#members-button').click();
    await page.getByRole('button', { name: `移除 ${nameB}` }).click();
    const confirm = page.locator('#confirm-dialog');
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(nameB);
    const danger = page.locator('#confirm-dialog-ok');
    await expect(danger).toHaveAttribute('data-lenso-slot', 'button');
    await expect(danger).toHaveAttribute('data-destructive', '');
    const dangerBackground = await danger.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    const [red = 0, green = 0, blue = 0] = (dangerBackground.match(/\d+/gu) ?? []).map(Number);
    expect(red).toBeGreaterThan(green + 40);
    expect(red).toBeGreaterThan(blue + 40);
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
      .locator('#members-contacts .contact-choice')
      .filter({ hasText: nameB });
    await expect(addOption).toBeVisible();
    await addOption.locator('input[type=checkbox]').check();
    await expect(page.locator('#members-selection')).toHaveText('已选 1 人');
    await page.locator('#members-add').click();
    await expect(page.locator('#members-current')).toContainText(nameB);
    await expect(page.locator('#members-error')).toHaveCount(0);

    // 公告：保存后头部 popover 可见。
    await page.keyboard.press('Escape');
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-announcement').click();
    await expect(page.locator('#announcement-input')).toHaveAttribute('data-lenso-slot', 'textarea');
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
    await expect(page.locator('#room-rename-input')).toHaveAttribute('data-lenso-slot', 'input');
    await expect(page.locator('#room-rename-save')).toHaveAttribute('data-variant', 'prominent');
    await expect(page.locator('#room-rename-save')).not.toHaveAttribute('data-destructive');
    await page.fill('#room-rename-input', `${roomTitle} 改名`);
    await page.locator('#room-rename-save').click();
    await expect(page.locator('#room-rename-dialog')).toBeHidden();
    await expect(page.locator('#title')).toHaveText(`${roomTitle} 改名`);
  });

  test('群成员入口位于搜索右侧并仍打开成员面板', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    const search = page.locator('#message-search-button');
    const members = page.locator('#members-button');
    await expect(members).toBeVisible();
    await expect(members).toHaveText('群成员');

    // 同一操作容器内，DOM 顺序紧随搜索按钮。
    const relation = await page.evaluate(() => {
      const searchButton = document.getElementById('message-search-button');
      const membersButton = document.getElementById('members-button');
      if (!searchButton || !membersButton) return null;
      return {
        sameParent: searchButton.parentElement === membersButton.parentElement,
        searchBeforeMembers: Boolean(
          searchButton.compareDocumentPosition(membersButton) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      };
    });
    expect(relation).toEqual({ sameParent: true, searchBeforeMembers: true });

    // 几何：左边缘在搜索右侧，垂直中心同一行。
    const searchBox = await search.boundingBox();
    const membersBox = await members.boundingBox();
    expect(searchBox).not.toBeNull();
    expect(membersBox).not.toBeNull();
    expect(membersBox!.x).toBeGreaterThanOrEqual(searchBox!.x + searchBox!.width - 1);
    expect(
      Math.abs(
        membersBox!.y + membersBox!.height / 2 - (searchBox!.y + searchBox!.height / 2),
      ),
    ).toBeLessThanOrEqual(1);

    await members.click();
    await expect(page.locator('#members-modal')).toBeVisible();
    await expect(page.locator('#members-modal')).toContainText(nameB);
    await page.keyboard.press('Escape');
    await expect(page.locator('#members-modal')).toBeHidden();
    await expect(members).toBeFocused();
  });

  test('390 下群成员入口在搜索右侧且无横向溢出', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/c/${roomId}`);
    const members = page.locator('#members-button');
    await expect(page.locator('#message-search-button')).toBeVisible();
    await expect(members).toBeVisible();
    await expect(page.locator('#back')).toBeVisible();

    const layout = await page.evaluate(() => {
      const search = document.getElementById('message-search-button')!.getBoundingClientRect();
      const membersButton = document.getElementById('members-button')!.getBoundingClientRect();
      return {
        searchRight: search.right,
        membersLeft: membersButton.left,
        membersRight: membersButton.right,
        viewport: window.innerWidth,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(layout.membersLeft).toBeGreaterThanOrEqual(layout.searchRight - 1);
    expect(layout.membersRight).toBeLessThanOrEqual(layout.viewport + 1);

    await members.click();
    await expect(page.locator('#members-modal')).toBeVisible();
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
    await page.keyboard.press('Escape');
    await expect(page.locator('#room-menu')).toBeHidden();
    await page.locator('#members-button').click();
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
