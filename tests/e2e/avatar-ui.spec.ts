import { expect, test, type Browser, type Page } from '@playwright/test';

import { baseUrl, callTool, requestId } from './fixtures/components';

/**
 * 头像 UI 验收：上传 → 保存 → 六处渲染 → 替换 → 移除，以及坏图、非法类型、
 * 390 布局与焦点返回。所有数据来自真实 MCP 与真实 /mcp-upload。
 */

const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

interface Registered {
  actor_id: string;
  name: string;
}

interface AgentCreated extends Registered {
  token: string;
}

interface RoomCreated {
  room: { room_id: string };
}

interface RoomsPage {
  items: { room_id: string; kind: string; peer?: { actor_id?: string } | null }[];
}

interface UploadedFile {
  fileId: string;
  publicUrl: string;
}

let base = '';
let managerToken = '';
let managerActor = '';
let humanToken = '';
let humanActor = '';
let humanName = '';
let agentToken = '';
let agentActor = '';
let agentName = '';
let groupId = '';
let taskRoot = '';
let firstAvatar = '';
let secondAvatar = '';

async function uploadBinary(
  token: string,
  name: string,
  mimeType: string,
  body: Buffer,
): Promise<UploadedFile> {
  const response = await fetch(`${base}/mcp-upload`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'MCPP-Files-Version': '1',
      'content-type': mimeType,
      'MCPP-File-Name': encodeURIComponent(name),
      'MCPP-File-Size': String(body.length),
    },
    body: body as unknown as BodyInit,
  });
  if (response.status !== 201) throw new Error(`上传失败：HTTP ${response.status}`);
  return (await response.json()) as UploadedFile;
}

async function setAvatarByApi(token: string, fileId: string | null): Promise<string | null> {
  const result = await callTool<{ avatar_url: string | null }>(
    base,
    token,
    'network_profile_update',
    { request_id: requestId('avatar_api'), avatar_file_id: fileId },
  );
  return result.avatar_url;
}

async function currentAvatar(token: string): Promise<string | null> {
  const me = await callTool<{ avatar_url: string | null }>(base, token, 'network_me', {});
  return me.avatar_url;
}

async function loginAs(
  browser: Browser,
  token: string,
  path = '',
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.addInitScript((credential) => {
    localStorage.setItem('agent-network-token', credential);
    localStorage.removeItem('agent-network-logged-out');
  }, token);
  await page.goto(`${base}${path}`);
  return { page, close: () => context.close() };
}

async function avatarSrc(page: Page, selector: string): Promise<string> {
  return page.locator(selector).evaluate((element) => (element as HTMLImageElement).src);
}

function absolute(url: string): string {
  return new URL(url, base).href;
}

async function expectAvatarSrc(page: Page, selector: string, url: string): Promise<void> {
  await expect(page.locator(selector)).toHaveCount(1);
  await expect
    .poll(async () => avatarSrc(page, selector), { timeout: 10_000 })
    .toBe(absolute(url));
  expect(
    await page.locator(selector).evaluate((element) => (element as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
}

test.beforeAll(async () => {
  base = await baseUrl();
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  managerToken = crypto.randomUUID();
  humanToken = crypto.randomUUID();
  humanName = `头像好友 ${suffix}`;
  agentName = `头像 Agent ${suffix}`;

  const manager = await callTool<Registered>(base, managerToken, 'network_register', {
    request_id: requestId('avatar_reg'),
    kind: 'human',
    name: `头像管理员 ${suffix}`,
    device_id: `avatar-${suffix}-manager`,
  });
  managerActor = manager.actor_id;
  const human = await callTool<Registered>(base, humanToken, 'network_register', {
    request_id: requestId('avatar_reg'),
    kind: 'human',
    name: humanName,
    device_id: `avatar-${suffix}-human`,
  });
  humanActor = human.actor_id;

  const contact = await callTool<{
    request: { contact_request_id: string } | null;
    status?: string;
  }>(base, managerToken, 'network_contact_request', {
    request_id: requestId('avatar_contact'),
    actor_id: humanActor,
  });
  if (contact.request) {
    await callTool(base, humanToken, 'network_contact_request_respond', {
      request_id: requestId('avatar_contact'),
      contact_request_id: contact.request.contact_request_id,
      action: 'accept',
    });
  }

  const agent = await callTool<AgentCreated>(base, managerToken, 'network_agent_create', {
    request_id: requestId('avatar_agent'),
    name: agentName,
  });
  agentToken = agent.token;
  agentActor = agent.actor_id;

  // 好友后自动生成 direct 会话；B 与 Agent 都需要出现在同一群里。
  const agentContact = await callTool<{
    request: { contact_request_id: string } | null;
    status?: string;
  }>(base, humanToken, 'network_contact_request', {
    request_id: requestId('avatar_contact'),
    actor_id: agentActor,
  });
  if (agentContact.request) {
    // Agent 默认由管理者审批好友申请；Agent 本人不一定能代替 manager_approval。
    await callTool(base, managerToken, 'network_contact_request_respond', {
      request_id: requestId('avatar_contact'),
      contact_request_id: agentContact.request.contact_request_id,
      action: 'accept',
    });
  }

  const group = await callTool<RoomCreated>(base, managerToken, 'network_room_create', {
    request_id: requestId('avatar_group'),
    kind: 'group',
    title: `头像验收群 ${suffix}`,
    members: [agentActor, humanActor],
  });
  groupId = group.room.room_id;

  const root = await callTool<{ message: { message_id: string } }>(
    base,
    managerToken,
    'network_message_send',
    {
      request_id: requestId('avatar_task'),
      client_message_id: requestId('avatar_task_cm'),
      room_id: groupId,
      body: '头像 Task 起点',
      invoke: [],
    },
  );
  taskRoot = root.message.message_id;
  await callTool(base, managerToken, 'network_task_mark', {
    request_id: requestId('avatar_task_mark'),
    room_id: groupId,
    message_id: taskRoot,
  });
  await callTool(base, agentToken, 'network_message_send', {
    request_id: requestId('avatar_reply'),
    client_message_id: requestId('avatar_reply_cm'),
    room_id: groupId,
    body: 'Agent 任务回复',
    invoke: [],
    task_root_id: taskRoot,
  });
  expect(managerActor).not.toBe('');
});

test.describe.serial('avatar ui', () => {
  test('上传 1×1 PNG、保存并在六处显示同一 avatar_url', async ({ browser }) => {
    const agentPage = await loginAs(browser, agentToken);
    try {
      await expect(agentPage.page.locator('#account-avatar-edit')).toBeVisible();
      await agentPage.page.locator('#account-avatar-edit').click();
      await expect(agentPage.page.locator('#avatar-edit-dialog')).toBeVisible();
      await agentPage.page.locator('#avatar-edit-input').setInputFiles({
        name: 'avatar.png',
        mimeType: 'image/png',
        buffer: PIXEL_PNG,
      });
      await expect(agentPage.page.locator('#avatar-edit-preview')).toBeVisible();
      await expect(agentPage.page.locator('#avatar-edit-status')).toContainText('512×512');
      await agentPage.page.locator('#avatar-edit-save').click();
      await expect(agentPage.page.locator('#avatar-edit-dialog')).toBeHidden();

      await expect.poll(() => currentAvatar(agentToken), { timeout: 10_000 }).not.toBeNull();
      firstAvatar = (await currentAvatar(agentToken))!;
      await expectAvatarSrc(agentPage.page, '#account-avatar img.avatar-img', firstAvatar);
      const size = await agentPage.page
        .locator('#account-avatar img.avatar-img')
        .evaluate((element) => (element as HTMLImageElement).naturalWidth);
      expect(size).toBe(512);

      const humanPage = await loginAs(browser, humanToken, `/c/${groupId}`);
      try {
        // 消息与 Task 摘要
        const reply = humanPage.page.locator('.msg').filter({ hasText: 'Agent 任务回复' });
        await expect(reply).toBeVisible();
        await expectAvatarSrc(
          humanPage.page,
          `.msg:has-text("Agent 任务回复") .msg-avatar img.avatar-img`,
          firstAvatar,
        );
        await expect
          .poll(
            () =>
              humanPage.page
                .locator('.msg-task-bar-slot .task-bar-avatars img.avatar-img')
                .first()
                .evaluate((element) => (element as HTMLImageElement).src)
                .catch(() => ''),
            { timeout: 10_000 },
          )
          .toBe(absolute(firstAvatar));

        // 群成员
        await humanPage.page.locator('#members-button').click();
        await expect(humanPage.page.locator('#members-modal')).toBeVisible();
        const memberAvatar = humanPage.page
          .locator('#members-current .spa-member')
          .filter({ hasText: agentName })
          .locator('.member-avatar');
        await expectAvatarSrc(
          humanPage.page,
          '#members-current .spa-member:has-text("' +
            agentName.replace(/"/gu, '\\"') +
            '") .member-avatar img.avatar-img',
          firstAvatar,
        );
        await expect(memberAvatar.locator('img.avatar-img')).toHaveCount(1);
        await humanPage.page.locator('#members-cancel').click();

        // 会话行 direct peer
        await humanPage.page.goto(base);
        await humanPage.page.locator('#room-filter-agent').click();
        const directRow = humanPage.page
          .locator('#room-list a[data-room-kind="direct"]')
          .filter({ hasText: agentName });
        await expect(directRow).toBeVisible();
        await expectAvatarSrc(
          humanPage.page,
          `#room-list a[data-room-kind="direct"]:has-text("${agentName}") .avatar img.avatar-img`,
          firstAvatar,
        );

        // 联系人搜索
        await humanPage.page.locator('#contact-requests').click();
        await expect(humanPage.page.locator('#contact-modal')).toBeVisible();
        await humanPage.page.fill('#contact-search-input', agentName);
        await humanPage.page.locator('#contact-search-submit').click();
        await expect(humanPage.page.locator('#contact-search-results .contact-search-item')).toHaveCount(1);
        await expectAvatarSrc(
          humanPage.page,
          '.contact-search-item .contact-search-avatar img.avatar-img',
          firstAvatar,
        );
      } finally {
        await humanPage.close();
      }
    } finally {
      await agentPage.close();
    }
  });

  test('替换头像后各入口同步更新', async ({ browser }) => {
    if (!firstAvatar) throw new Error('前置上传未完成');
    const agentPage = await loginAs(browser, agentToken);
    try {
      await agentPage.page.locator('#account-avatar-edit').click();
      await agentPage.page.locator('#avatar-edit-input').setInputFiles({
        name: 'avatar-2.png',
        mimeType: 'image/png',
        buffer: PIXEL_PNG,
      });
      await expect(agentPage.page.locator('#avatar-edit-preview')).toBeVisible();
      await agentPage.page.locator('#avatar-edit-save').click();
      await expect(agentPage.page.locator('#avatar-edit-dialog')).toBeHidden();
      await expect.poll(() => currentAvatar(agentToken), { timeout: 10_000 }).not.toBe(firstAvatar);
      secondAvatar = (await currentAvatar(agentToken))!;
      await expectAvatarSrc(agentPage.page, '#account-avatar img.avatar-img', secondAvatar);

      const humanPage = await loginAs(browser, humanToken, `/c/${groupId}`);
      try {
        await expectAvatarSrc(
          humanPage.page,
          `.msg:has-text("Agent 任务回复") .msg-avatar img.avatar-img`,
          secondAvatar,
        );
        await humanPage.page.locator('#members-button').click();
        await expect(humanPage.page.locator('#members-modal')).toBeVisible();
        await expectAvatarSrc(
          humanPage.page,
          '#members-current .spa-member:has-text("' +
            agentName.replace(/"/gu, '\\"') +
            '") .member-avatar img.avatar-img',
          secondAvatar,
        );
      } finally {
        await humanPage.close();
      }
    } finally {
      await agentPage.close();
    }
  });

  test('移除头像后回退首字', async ({ browser }) => {
    const agentPage = await loginAs(browser, agentToken);
    try {
      await agentPage.page.locator('#account-avatar-edit').click();
      await agentPage.page.locator('#avatar-edit-remove').click();
      await expect(agentPage.page.locator('#avatar-edit-dialog')).toBeHidden();
      await expect.poll(() => currentAvatar(agentToken), { timeout: 10_000 }).toBeNull();
      const account = agentPage.page.locator('#account-avatar');
      await expect(account.locator('img.avatar-img')).toHaveCount(0);
      await expect(account).toContainText(agentName.slice(0, 1));

      const humanPage = await loginAs(browser, humanToken, `/c/${groupId}`);
      try {
        const replyAvatar = humanPage.page.locator(
          '.msg:has-text("Agent 任务回复") .msg-avatar',
        );
        await expect(replyAvatar.locator('img.avatar-img')).toHaveCount(0);
        await expect(replyAvatar).toContainText(agentName.slice(0, 1));
        await humanPage.page.locator('#members-button').click();
        await expect(humanPage.page.locator('#members-modal')).toBeVisible();
        const memberAvatar = humanPage.page
          .locator('#members-current .spa-member')
          .filter({ hasText: agentName })
          .locator('.member-avatar');
        await expect(memberAvatar.locator('img.avatar-img')).toHaveCount(0);
      } finally {
        await humanPage.close();
      }
    } finally {
      await agentPage.close();
    }
  });

  test('头像 404 时回退首字且不出现白块', async ({ browser }) => {
    const uploaded = await uploadBinary(agentToken, 'broken.png', 'image/png', PIXEL_PNG);
    const brokenUrl = await setAvatarByApi(agentToken, uploaded.fileId);
    if (!brokenUrl) throw new Error('设置坏图头像失败');
    const agentPage = await loginAs(browser, agentToken);
    try {
      await agentPage.page.route(
        (url) => url.pathname === new URL(brokenUrl, base).pathname,
        (route) => route.fulfill({ status: 404, body: '' }),
      );
      await agentPage.page.reload();
      const account = agentPage.page.locator('#account-avatar');
      await expect(account.locator('img.avatar-img')).toHaveCount(0);
      await expect(account).toContainText(agentName.slice(0, 1));
      const colors = await account.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, backgroundImage: style.backgroundImage };
      });
      expect(colors.backgroundImage).not.toContain('url(');
      expect(colors.background).not.toBe('rgba(0, 0, 0, 0)');
      expect(colors.background).not.toBe('rgb(255, 255, 255)');
    } finally {
      await agentPage.close();
    }
  });

  test('SVG、非图片与超大文件被拒绝且不发起上传', async ({ browser }) => {
    const agentPage = await loginAs(browser, agentToken);
    try {
      let uploads = 0;
      agentPage.page.on('request', (request) => {
        if (request.url().includes('/mcp-upload')) uploads += 1;
      });
      await agentPage.page.locator('#account-avatar-edit').click();
      const input = agentPage.page.locator('#avatar-edit-input');
      const status = agentPage.page.locator('#avatar-edit-status');

      await input.setInputFiles({
        name: 'avatar.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      });
      await expect(status).toHaveAttribute('data-error', '1');
      await expect(status).toContainText('只支持 PNG、JPEG、WebP 或 GIF');
      await expect(agentPage.page.locator('#avatar-edit-save')).toBeDisabled();

      await input.setInputFiles({
        name: 'avatar.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('not an image'),
      });
      await expect(status).toContainText('只支持 PNG、JPEG、WebP 或 GIF');
      await expect(agentPage.page.locator('#avatar-edit-save')).toBeDisabled();

      await input.setInputFiles({
        name: 'avatar-huge.png',
        mimeType: 'image/png',
        buffer: Buffer.alloc(8 * 1024 * 1024 + 1),
      });
      await expect(status).toContainText('图片不能超过 8 MB');
      await expect(agentPage.page.locator('#avatar-edit-save')).toBeDisabled();
      expect(uploads).toBe(0);
    } finally {
      await agentPage.close();
    }
  });

  test('390 布局、键盘打开与焦点返回；移动端账号菜单提供入口', async ({ browser }) => {
    const agentPage = await loginAs(browser, agentToken);
    try {
      await agentPage.page.setViewportSize({ width: 390, height: 844 });
      const trigger = agentPage.page.locator('#account-avatar-edit');
      await trigger.focus();
      await agentPage.page.keyboard.press('Enter');
      const dialog = agentPage.page.locator('#avatar-edit-dialog');
      await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(390);
        expect(box.y + box.height).toBeLessThanOrEqual(844);
      }
      await expect(agentPage.page.locator('#avatar-edit-choose')).toBeFocused();
      await agentPage.page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();

      const rooms = await callTool<RoomsPage>(base, agentToken, 'network_rooms_list', { limit: 50 });
      const direct = rooms.items.find(
        (room) => room.kind === 'direct' && room.peer?.actor_id === humanActor,
      );
      if (!direct) throw new Error('缺少与好友的 direct 会话');
      await agentPage.page.goto(`${base}/c/${direct.room_id}`);
      const toggle = agentPage.page.locator('#account-menu-toggle');
      await expect(toggle).toBeVisible();
      await toggle.click();
      await expect(agentPage.page.locator('#account-avatar-menu')).toHaveText('修改头像');
      await agentPage.page.locator('#account-avatar-menu').click();
      await expect(agentPage.page.locator('#avatar-edit-dialog')).toBeVisible();
      await agentPage.page.keyboard.press('Escape');
      await expect(agentPage.page.locator('#avatar-edit-dialog')).toBeHidden();
      await expect(toggle).toBeFocused();
    } finally {
      await agentPage.close();
    }
  });
});
