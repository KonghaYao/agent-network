import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { baseUrl, callTool, createComponentRoom, dragFile, expectAccountMenuClearOfDialog, login, requestId } from './fixtures/components';

import { semanticColor } from './fixtures/semantic-colors';
import { expectNoHorizontalOverflow, LONG_TASK_URL } from './fixtures/task-layout';

// 真实 MCP fixture 与浏览器交互覆盖组件、RHF、持久化及可访问性。

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
    ({ tokenA, tokenB, actorA, actorB, nameB, roomId, roomTitle } = await createComponentRoom(base));
  });

  test.beforeEach(async ({ page }) => {
    await login(page, base, tokenA);
  });

  test('Task Lenso Surface/Card/Badge 保留完成确认动作，390 暗色长内容可换行', async ({ page }) => {
    const sent = await callTool<{ message: { message_id: string } }>(base, tokenA, 'network_message_send', {
      request_id: requestId('task_layout'), client_message_id: requestId('task_layout'),
      room_id: roomId, body: LONG_TASK_URL, invoke: [],
    });
    await callTool(base, tokenA, 'network_task_mark', {
      request_id: requestId('task_mark'), room_id: roomId, message_id: sent.message.message_id,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#task-dock-count [data-lenso-slot="badge"]')).toHaveText('1');
    await expect(page.locator('#task-dock > [data-lenso-slot="surface"]')).toBeVisible();
    await page.locator('#task-dock-toggle').click();
    const status = page.locator('#task-dock-panel [data-task-status="open"]');
    await expect(status).toHaveCSS('color', await semanticColor(page, '--lenso-status-info-text', 'color'));
    await expect(page.locator('.task-dock-meta')).toHaveCount(0);
    await expect(page.locator('.task-dock-preview')).toHaveCSS('-webkit-line-clamp', '2');
    await expect(page.locator('.task-dock-complete')).toHaveCSS('height', '44px');
    await expect(page.locator('.task-dock-complete')).toHaveCSS('border-radius', '8px');
    await expect(page.locator('.task-dock-item [data-lenso-slot="card"]')).toHaveCount(0);
    await expectNoHorizontalOverflow(page.locator('#task-dock-panel'));
    await page.locator('.task-dock-complete').click();
    await expectNoHorizontalOverflow(page.locator('#task-complete-dialog'));
    await expect(page.locator('#task-complete-confirm')).toHaveAttribute('data-lenso-slot', 'button');
    await page.locator('#task-complete-cancel').click();
    await expect(page.locator('.task-dock-complete')).toBeFocused();
    await page.locator('.task-dock-complete').click();
    await page.locator('#task-complete-confirm').click();
    await expect(page.locator('#task-dock-empty')).toBeVisible();
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
    await expect(page.locator('label[for="group-name-input"]')).toBeVisible();
    await expect(page.locator('label[for="group-search"]')).toBeVisible();

    await page.fill('#group-name-input', `弹窗群 ${Date.now()}`);
    await page.locator('#group-search').fill(nameB.slice(0, 4));
    const option = page.locator('#group-contacts .spa-combobox-item').filter({ hasText: nameB });
    await expect(option).toBeVisible();
    await option.click();
    await expect(page.locator('#group-selection .spa-chip')).toHaveCount(1);
    await expect(
      page.locator('#group-selection').getByRole('button', { name: `移除 ${nameB}` }),
    ).toBeVisible();
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
    await expect(page.locator('#attach-file')).toHaveAttribute('data-lenso-slot', 'menu-trigger');

    await page.locator('#attach-file').click();
    await expect(page.locator('#attach-menu')).toBeVisible();
    await expect(page.locator('#attach-menu')).toHaveAttribute('data-lenso-slot', 'menu-popup');
    await expect(page.locator('#attach-menu-file')).toBeVisible();

    await expect(page.locator('#attach-menu-file')).toHaveCSS('min-height', '44px');
    await expect(page.locator('#attach-menu-draw')).toHaveCSS('min-height', '44px');
    await page.waitForTimeout(250);
    const itemHeights = await page
      .locator('#attach-menu [role="menuitem"]')
      .evaluateAll((items) =>
        items.map((item) => Math.round(item.getBoundingClientRect().height)),
      );
    expect(itemHeights).toHaveLength(2);
    expect(itemHeights.every((height) => height >= 44)).toBe(true);

    // 菜单项必须仍在用户激活中同步打开隐藏 file input。
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('#attach-menu-file').click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'attach-menu.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        'base64',
      ),
    });
    await expect(page.locator('#composer-files .composer-file')).toHaveCount(1);
    await expect(page.locator('#attach-menu')).toBeHidden();

    await page.locator('#attach-file').click();
    await expect(page.locator('#attach-menu')).toBeVisible();
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

  test('附件菜单在移动端落在视口内且条目保持 44px', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/c/${roomId}`);
    await expect(page.locator('#composer')).toBeVisible();
    await expect(page.locator('#attach-file')).toHaveAttribute('data-lenso-slot', 'menu-trigger');
    await page.locator('#attach-file').click();
    await expect(page.locator('#attach-menu')).toBeVisible();

    const box = await page.locator('#attach-menu').boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    }
    // Lenso Menu 打开时带 morph 动画，首帧仍在过渡中；等待稳定后再量高度，
    // 避免读到过渡中间值。稳定后条目仍须保持至少 44px。
    await expect
      .poll(
        () =>
          page.locator('#attach-menu [role="menuitem"]').evaluateAll((items) => {
            const heights = items.map((item) =>
              Math.round(item.getBoundingClientRect().height),
            );
            return heights.length === 2 && heights.every((height) => height >= 44);
          }),
        { timeout: 2000 },
      )
      .toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('#attach-menu')).toBeHidden();
    await expect(page.locator('#attach-file')).toBeFocused();
  });

  test('账号菜单使用 Lenso Menu，保留条目、44px、Esc 与外部点击焦点返回', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/c/${roomId}`);
    const toggle = page.locator('#account-menu-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText('···');
    await expect(toggle).toHaveAttribute('data-lenso-slot', 'menu-trigger');

    await toggle.click();
    const menu = page.locator('#account-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('data-lenso-slot', 'menu-popup');
    await expect(menu).toHaveAttribute('aria-label', '账号操作');

    await expect(page.locator('#account-rename')).toHaveText('修改我的名称');
    await expect(page.locator('#new-agent')).toHaveText('新建 Agent');
    await expect(page.locator('#device-handoff')).toHaveText('配对设备');
    await expect(page.locator('#archived-agents')).toHaveText('已归档 Agents');
    await expect(page.locator('#memory-open')).toHaveText('记忆');
    await expect(page.locator('#account-logout')).toHaveText('退出登录');
    await expect(page.locator('#account-menu [role="separator"]')).toHaveCount(1);

    await expect
      .poll(
        () =>
          page.locator('#account-menu [role="menuitem"]').evaluateAll((items) => {
            const heights = items.map((item) =>
              Math.round(item.getBoundingClientRect().height),
            );
            return heights.length === 6 && heights.every((height) => height >= 44);
          }),
        { timeout: 2000 },
      )
      .toBe(true);

    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    }

    // 菜单动作仍打开原对话框；dialog 首帧起菜单就必须不可见且无重叠。
    await page.locator('#account-rename').click();
    await expectAccountMenuClearOfDialog(page, 'me-rename-dialog');
    await expect(page.locator('#me-rename-input')).toBeFocused();
    await page.locator('#me-rename-cancel').click();
    await expect(page.locator('#me-rename-dialog')).toBeHidden();
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await expect(menu).toBeVisible();
    await page.locator('#title').click();
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();
  });

  test('Lenso 不可用时账号菜单 fallback 仍可操作并返回焦点', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // Lenso 的异步入口是共享 index chunk；阻断后适配器留在原生 fallback。
    await page.route('**/assets/index-*.js', (route) => route.abort());
    await page.goto(`${base}/c/${roomId}`);
    const toggle = page.locator('#account-menu-toggle');
    await expect(toggle).toBeVisible();

    await toggle.click();
    const menu = page.locator('#account-menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('data-lenso-slot', 'menu-fallback');
    await expect(page.locator('#account-rename')).toHaveText('修改我的名称');
    await expect(page.locator('#new-agent')).toHaveText('新建 Agent');
    await expect(page.locator('#device-handoff')).toHaveText('配对设备');
    await expect(page.locator('#archived-agents')).toHaveText('已归档 Agents');
    await expect(page.locator('#memory-open')).toHaveText('记忆');
    await expect(page.locator('#account-logout')).toHaveText('退出登录');
    await expect(page.locator('#account-menu [role="separator"]')).toHaveCount(1);
    await expect(page.locator('#account-menu [role="menuitem"]')).toHaveCount(6);
    await expect(page.locator('#account-rename')).toHaveCSS('min-height', '44px');

    const box = await menu.boundingBox();
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);
    }

    await page.locator('#account-rename').click();
    await expectAccountMenuClearOfDialog(page, 'me-rename-dialog');
    await expect(page.locator('#me-rename-input')).toBeFocused();
    await page.locator('#me-rename-cancel').click();
    await expect(page.locator('#me-rename-dialog')).toBeHidden();
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await expect(menu).toBeVisible();
    await page.locator('#title').click();
    await expect(menu).toBeHidden();
    await expect(toggle).toBeFocused();
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
    await expect(page.locator('#room-archive-banner')).toHaveAttribute('role', 'note');
    await expect(page.locator('#room-archive-banner')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#room-archive-banner')).toHaveAttribute(
      'data-lenso-slot',
      'alert-root',
    );
    const archiveDescription = page.locator(
      '#room-archive-banner [data-lenso-slot="alert-description"]',
    );
    expect(
      await archiveDescription.evaluate((node) => getComputedStyle(node).fontSize),
    ).toBe('12px');
    expect(await archiveDescription.evaluate((node) => getComputedStyle(node).color)).toBe(
      await semanticColor(page, '--lenso-status-warning-text', 'color'),
    );
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
    const checkbox = page.getByRole('checkbox', { name: `${nameB} 人`, exact: true });
    await addOption.locator('.contact-name').click();
    await expect(checkbox).toBeChecked();
    await checkbox.press('Space');
    await expect(checkbox).not.toBeChecked();
    await expect(page.locator('#members-selection')).toHaveText('未选择');
    await checkbox.press('Space');
    await expect(checkbox).toBeChecked();
    await expect(page.locator('#members-selection')).toHaveText('已选 1 人');
    await page.locator('#members-add').click();
    await expect(page.locator('#members-current')).toContainText(nameB);
    await expect(page.locator('#members-error')).toHaveCount(0);

    // 公告：保存后默认收起，只通过头部按钮查看。
    await page.keyboard.press('Escape');
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu-announcement').click();
    await expect(page.locator('#announcement-input')).toHaveAttribute('data-lenso-slot', 'textarea');
    await page.fill('#announcement-input', '组件验收公告');
    await page.locator('#announcement-save').click();
    await expect(page.locator('#announcement-modal')).toBeHidden();
    await expect(page.locator('#room-announcement')).toHaveCount(0);
    await expect(page.locator('#room-announcement-popover')).toHaveCount(0);
    await expect(page.locator('#room-announcement-info')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#room-announcement-info').click();
    await expect(page.locator('#room-announcement')).toContainText('组件验收公告');
    await expect(page.locator('#room-announcement')).toHaveAttribute('role', 'note');
    await expect(page.locator('#room-announcement')).toHaveAttribute('aria-live', 'polite');
    await expect(page.locator('#room-announcement')).toHaveAttribute(
      'data-lenso-slot',
      'alert-root',
    );
    const announcementDescription = page.locator(
      '#room-announcement [data-lenso-slot="alert-description"]',
    );
    expect(
      await announcementDescription.evaluate((node) => getComputedStyle(node).fontSize),
    ).toBe('12px');
    expect(await announcementDescription.evaluate((node) => getComputedStyle(node).color)).toBe(
      await semanticColor(page, '--wx-text', 'color'),
    );
    await expect(page.locator('#room-announcement-popover')).toContainText('组件验收公告');
    await page.keyboard.press('Escape');
    await expect(page.locator('#room-announcement-popover')).toHaveCount(0);
    await expect(page.locator('#room-announcement')).toHaveCount(0);
    await expect(page.locator('#room-announcement-info')).toBeFocused();

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

  test('搜索聊天记录：表单/结果/底部动作不重叠且结果独立滚动', async ({ page }) => {
    await page.setViewportSize({ width: 1430, height: 1028 });
    const probe = `searchlayoutprobe${Date.now()}`;
    for (let index = 0; index < 8; index += 1) {
      await callTool(base, tokenA, 'network_message_send', {
        request_id: requestId('e2e_search_layout'),
        client_message_id: requestId('e2e_search_layout_cm'),
        room_id: roomId,
        body: `${probe} 第 ${index + 1} 条：较长的正文用于验证结果项随内容增长，而不是被固定高度裁切后压住下一项。`,
        invoke: [],
      });
    }

    const openSearch = async () => {
      await page.locator('#message-search-button').click();
      await expect(page.locator('#message-search-dialog')).toBeVisible();
      await page.locator('#message-search-input').fill(probe);
      await page.locator('#message-search-form button[type="submit"]').click();
      await expect(page.locator('#message-search-results .message-search-result')).toHaveCount(8);
    };

    await page.goto(`${base}/c/${roomId}`);
    await openSearch();

    const box = async (selector: string) => {
      const value = await page.locator(selector).boundingBox();
      expect(value, selector).not.toBeNull();
      return value!;
    };
    const overlap = (
      a: { x: number; y: number; width: number; height: number },
      b: { x: number; y: number; width: number; height: number },
    ) =>
      a.x < b.x + b.width - 1 &&
      b.x < a.x + a.width - 1 &&
      a.y < b.y + b.height - 1 &&
      b.y < a.y + a.height - 1;

    const form = await box('#message-search-form');
    const results = await box('#message-search-results');
    const footer = await box('#message-search-dialog > .modal-actions');
    const footerClose = await box('#message-search-close');
    const closeIcon = await box('#message-search-dialog .spa-dialog-close');
    const dialog = await box('#message-search-dialog');
    expect(overlap(form, results)).toBe(false);
    expect(overlap(results, footer)).toBe(false);
    expect(overlap(closeIcon, form)).toBe(false);
    expect(overlap(closeIcon, results)).toBe(false);
    expect(overlap(closeIcon, footer)).toBe(false);
    expect(overlap(footerClose, results)).toBe(false);
    expect(footerClose.y).toBeGreaterThanOrEqual(footer.y - 1);
    expect(footerClose.y + footerClose.height).toBeLessThanOrEqual(
      footer.y + footer.height + 1,
    );
    // 结果区占据对话框内部空间，而不是被内容撑出 dialog。
    expect(results.y).toBeGreaterThanOrEqual(form.y + form.height - 1);
    expect(footer.y).toBeGreaterThanOrEqual(results.y + results.height - 1);
    expect(footer.y + footer.height).toBeLessThanOrEqual(dialog.y + dialog.height + 1);

    const surface = await page.evaluate(() => {
      const dialog = document.getElementById('message-search-dialog')!;
      const results = document.getElementById('message-search-results')!;
      const first = results.querySelector<HTMLElement>('.message-search-result')!;
      const second = results.querySelectorAll<HTMLElement>('.message-search-result')[1]!;
      const style = getComputedStyle(dialog);
      return {
        dialogBackground: style.backgroundColor,
        dialogOpacity: Number.parseFloat(style.opacity),
        resultHeight: first.getBoundingClientRect().height,
        resultContentFits: first.scrollHeight <= first.clientHeight + 1,
        rowGap: second.getBoundingClientRect().top - first.getBoundingClientRect().bottom,
        scrollable: results.scrollHeight > results.clientHeight + 20,
      };
    });
    // 实心表面：computed background 必须是不透明色，且 dialog 未被整体降透明。
    expect(surface.dialogBackground).toMatch(/^rgb\(/u);
    expect(surface.dialogBackground).not.toMatch(/rgba\(/u);
    expect(surface.dialogOpacity).toBe(1);
    // 结果项内容不得溢出自身盒子（原缺陷会溢出并覆盖下一项）。
    expect(surface.resultContentFits).toBe(true);
    expect(surface.resultHeight).toBeGreaterThanOrEqual(60);
    expect(surface.rowGap).toBeGreaterThanOrEqual(-1);
    expect(surface.scrollable).toBe(true);

    const hitClose = await page.evaluate(() => {
      const hitTarget = (selector: string) => {
        const target = document.querySelector(selector)!;
        const rect = target.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return Boolean(hit && hit.closest(selector));
      };
      return {
        footer: hitTarget('#message-search-close'),
        icon: hitTarget('#message-search-dialog .spa-dialog-close'),
      };
    });
    expect(hitClose).toEqual({ footer: true, icon: true });

    await page.evaluate(() => {
      document.getElementById('message-search-results')!.scrollTop = 240;
    });
    await expect
      .poll(() =>
        page.evaluate(() => document.getElementById('message-search-results')!.scrollTop),
      )
      .toBeGreaterThan(0);

    // 上下文弹窗复用 message-search-card 的固定头部/滚动正文布局。
    await page
      .locator('#message-search-results .message-search-result')
      .first()
      .locator('[data-search-context]')
      .click();
    await expect(page.locator('#message-context-dialog')).toBeVisible();
    const context = await page.evaluate(() => {
      const dialog = document.getElementById('message-context-dialog')!;
      const items = document.getElementById('message-context-items')!;
      const rect = dialog.getBoundingClientRect();
      return {
        inViewport: rect.top >= -1 && rect.bottom <= window.innerHeight + 1,
        background: getComputedStyle(dialog).backgroundColor,
        itemsOverflow: getComputedStyle(items).overflowY,
      };
    });
    expect(context.inViewport).toBe(true);
    expect(context.background).toMatch(/^rgb\(/u);
    expect(context.itemsOverflow).toBe('auto');
    await page.locator('#message-context-close').click();
    await expect(page.locator('#message-context-dialog')).toBeHidden();

    await page.locator('#message-search-close').click();
    await expect(page.locator('#message-search-dialog')).toBeHidden();

    // 390：全屏单栏，结果仍可滚动且不产生横向溢出。
    await page.setViewportSize({ width: 390, height: 844 });
    await openSearch();
    const mobile = await page.evaluate(() => {
      const dialog = document.getElementById('message-search-dialog')!;
      const results = document.getElementById('message-search-results')!;
      const items = Array.from(
        results.querySelectorAll<HTMLElement>('.message-search-result'),
      ).map((item) => item.getBoundingClientRect());
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        dialogWidth: dialog.getBoundingClientRect().width,
        viewport: window.innerWidth,
        resultsScrollWidth: results.scrollWidth,
        resultsClientWidth: results.clientWidth,
        scrollable: results.scrollHeight > results.clientHeight + 20,
        sameColumn: items.every(
          (item) =>
            Math.abs(item.left - items[0]!.left) <= 1 &&
            Math.abs(item.width - items[0]!.width) <= 1,
        ),
      };
    });
    expect(mobile.overflow).toBeLessThanOrEqual(1);
    expect(mobile.dialogWidth).toBeLessThanOrEqual(mobile.viewport + 1);
    expect(mobile.resultsScrollWidth).toBeLessThanOrEqual(mobile.resultsClientWidth + 1);
    expect(mobile.scrollable).toBe(true);
    expect(mobile.sameColumn).toBe(true);

    const mobileHit = await page.evaluate(() => {
      const hitTarget = (selector: string) => {
        const target = document.querySelector(selector)!;
        const rect = target.getBoundingClientRect();
        const hit = document.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return Boolean(hit && hit.closest(selector));
      };
      return {
        footer: hitTarget('#message-search-close'),
        icon: hitTarget('#message-search-dialog .spa-dialog-close'),
      };
    });
    expect(mobileHit).toEqual({ footer: true, icon: true });
    await page.locator('#message-search-close').click();
    await expect(page.locator('#message-search-dialog')).toBeHidden();
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

  test('危险色降饱和，消息操作按钮默认弱化', async ({ page }) => {
    await page.goto(`${base}/c/${roomId}`);
    const trigger = page.locator('.message-actions-trigger').first();
    await expect(trigger).toBeVisible();

    expect(await semanticColor(page, '--wx-danger')).toBe('rgb(201, 74, 79)');
    expect(await semanticColor(page, '--wx-unread')).toBe('rgb(201, 74, 79)');
    expect(await semanticColor(page, '--wx-danger-text', 'color')).toBe('rgb(168, 50, 54)');
    expect(await semanticColor(page, '--wx-danger')).not.toBe('rgb(255, 56, 60)');

    expect(await trigger.evaluate((node) => getComputedStyle(node).opacity)).toBe('0.55');
    await trigger.hover();
    await expect
      .poll(() => trigger.evaluate((node) => getComputedStyle(node).opacity))
      .toBe('1');
    await page.mouse.move(0, 0);
    await expect
      .poll(() => trigger.evaluate((node) => getComputedStyle(node).opacity))
      .toBe('0.55');

    // 键盘焦点仍恢复完全可见，避免弱化后无法发现操作入口。
    await page.keyboard.press('Tab');
    await trigger.focus();
    await expect
      .poll(() => trigger.evaluate((node) => getComputedStyle(node).opacity))
      .toBe('1');

    await page.emulateMedia({ colorScheme: 'dark' });
    expect(await semanticColor(page, '--wx-danger-text', 'color')).toBe('rgb(224, 127, 131)');
    expect(await semanticColor(page, '--wx-danger')).toBe('rgb(201, 74, 79)');
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
