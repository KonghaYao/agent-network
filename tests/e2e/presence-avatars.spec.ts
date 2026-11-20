import { expect, test, type Page } from '@playwright/test';

import { isOfflineAgent } from '../../src/web/lib/presence';
import { baseUrl, callTool, requestId } from './fixtures/components';
import { semanticColor } from './fixtures/semantic-colors';

/**
 * Agent 离线头像验收。
 *
 * 数据来自真实 MCP：直聊 `peer.online` 与 `room_get.members[].online`。
 * 未触碰任何工具的 Agent 明确离线；调用过一次工具（`PRESENCE.touch`）的
 * Agent 在线。人类与未知状态不置灰，未读点、状态点也不受头像滤镜影响。
 */

interface AgentCreated {
  actor_id: string;
  token: string;
}

let base = '';
let tokenA = '';
let tokenB = '';
let actorA = '';
let actorB = '';
let nameA = '';
let nameB = '';
let agentOffline = '';
let agentOfflineName = '';
let directOffline = '';
let directOnline = '';
let directHuman = '';
let groupId = '';
let groupTitle = '';
let imageAgentName = '';
let textAgentName = '';

async function loginWithFilter(page: Page, token: string, filter: string) {
  await page.addInitScript(({ credential, roomFilter }) => {
    localStorage.setItem('agent-network-token', credential);
    localStorage.removeItem('agent-network-logged-out');
    localStorage.setItem('agent-network-room-filter', roomFilter);
  }, { credential: token, roomFilter: filter });
}

test.beforeAll(async () => {
  base = await baseUrl();
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  nameA = `验收 A ${suffix}`;
  nameB = `验收 B ${suffix}`;
  agentOfflineName = `离线 Agent ${suffix}`;
  const agentOnlineName = `在线 Agent ${suffix}`;
  imageAgentName = `Claude 头像 ${suffix}`;
  textAgentName = `首字头像 ${suffix}`;
  groupTitle = `Presence 群 ${suffix}`;

  tokenA = crypto.randomUUID();
  tokenB = crypto.randomUUID();
  ({ actor_id: actorA } = await callTool<{ actor_id: string }>(base, tokenA, 'network_register', {
    request_id: requestId('presence_reg'), kind: 'human', name: nameA,
    device_id: `presence-${suffix}-a`,
  }));
  ({ actor_id: actorB } = await callTool<{ actor_id: string }>(base, tokenB, 'network_register', {
    request_id: requestId('presence_reg'), kind: 'human', name: nameB,
    device_id: `presence-${suffix}-b`,
  }));
  const requested = await callTool<{ request: { contact_request_id: string } }>(
    base, tokenA, 'network_contact_request', {
      request_id: requestId('presence_contact'), actor_id: actorB,
    },
  );
  await callTool(base, tokenB, 'network_contact_request_respond', {
    request_id: requestId('presence_contact'),
    contact_request_id: requested.request.contact_request_id, action: 'accept',
  });

  const offline = await callTool<AgentCreated>(base, tokenA, 'network_agent_create', {
    request_id: requestId('presence_agent'), name: agentOfflineName,
  });
  agentOffline = offline.actor_id;
  const online = await callTool<AgentCreated>(base, tokenA, 'network_agent_create', {
    request_id: requestId('presence_agent'), name: agentOnlineName,
  });
  const imageAgent = await callTool<AgentCreated>(base, tokenA, 'network_agent_create', {
    request_id: requestId('presence_agent'), name: imageAgentName,
  });
  const textAgent = await callTool<AgentCreated>(base, tokenA, 'network_agent_create', {
    request_id: requestId('presence_agent'), name: textAgentName,
  });
  // 任意已认证 Agent 请求都会把持久化 presence 置为 online；不发消息、不建流。
  await callTool(base, online.token, 'network_rooms_list', { limit: 1 });

  const offlineRoom = await callTool<{ room: { room_id: string } }>(base, tokenA, 'network_room_create', {
    request_id: requestId('presence_room'), kind: 'direct', members: [offline.actor_id],
  });
  directOffline = offlineRoom.room.room_id;
  const onlineRoom = await callTool<{ room: { room_id: string } }>(base, tokenA, 'network_room_create', {
    request_id: requestId('presence_room'), kind: 'direct', members: [online.actor_id],
  });
  directOnline = onlineRoom.room.room_id;
  const humanRoom = await callTool<{ room: { room_id: string } }>(base, tokenA, 'network_room_create', {
    request_id: requestId('presence_room'), kind: 'direct', members: [actorB],
  });
  directHuman = humanRoom.room.room_id;
  // 自己发送的消息不会推进 last_read_seq，离线直聊据此保留未读红点。
  await callTool(base, tokenA, 'network_message_send', {
    request_id: requestId('presence_send'), client_message_id: requestId('presence_send'),
    room_id: directOffline, body: '离线会话未读', invoke: [],
  });
  const group = await callTool<{ room: { room_id: string } }>(base, tokenA, 'network_room_create', {
    request_id: requestId('presence_group'), kind: 'group', title: groupTitle,
    members: [
      offline.actor_id,
      online.actor_id,
      imageAgent.actor_id,
      textAgent.actor_id,
    ],
  });
  groupId = group.room.room_id;
});

test('未知与人类在线态不会被当成离线', () => {
  expect(isOfflineAgent('agent', false)).toBe(true);
  expect(isOfflineAgent('agent', true)).toBe(false);
  expect(isOfflineAgent('agent', null)).toBe(false);
  expect(isOfflineAgent('agent', undefined)).toBe(false);
  expect(isOfflineAgent('human', false)).toBe(false);
  expect(isOfflineAgent(null, false)).toBe(false);
  expect(isOfflineAgent(undefined, false)).toBe(false);
});

test('直聊离线 Agent 只灰头像，未读点与状态点不受影响', async ({ page }) => {
  await loginWithFilter(page, tokenA, 'agent');
  await page.goto(base);

  const offlineRow = page.locator(`#room-list a[data-room-id="${directOffline}"]`);
  await expect(offlineRow).toBeVisible();
  const avatar = offlineRow.locator('.avatar');
  await expect(avatar).toHaveAttribute('data-presence', 'offline');
  expect(await avatar.evaluate((element) => getComputedStyle(element).filter)).toContain(
    'grayscale',
  );
  await expect(offlineRow.locator('.avatar-wrap')).not.toHaveAttribute('data-presence', 'offline');
  await expect(offlineRow.locator('.presence-dot.offline')).toHaveAttribute(
    'aria-label',
    'Agent 离线',
  );
  await expect(offlineRow.locator('.presence-dot')).toHaveCSS('filter', 'none');

  const unread = offlineRow.locator('.unread');
  await expect(unread).toBeVisible();
  await expect(unread).toHaveCSS('filter', 'none');
  await expect(unread).toHaveCSS('background-color', await semanticColor(page, '--wx-unread'));

  const onlineRow = page.locator(`#room-list a[data-room-id="${directOnline}"]`);
  await expect(onlineRow).toBeVisible();
  await expect(onlineRow.locator('.avatar')).not.toHaveAttribute('data-presence', 'offline');
  await expect(onlineRow.locator('.presence-dot')).toHaveCount(0);

  await page.locator('#room-filter-friend').click();
  const humanRow = page.locator(`#room-list a[data-room-id="${directHuman}"]`);
  await expect(humanRow).toBeVisible();
  await expect(humanRow.locator('.avatar')).not.toHaveAttribute('data-presence', 'offline');
  await expect(humanRow.locator('.presence-dot')).toHaveCount(0);
  await expect(humanRow).not.toContainText('离线');
});

test('390 暗色仍只灰头像自身', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await loginWithFilter(page, tokenA, 'agent');
  await page.goto(base);

  const row = page.locator(`#room-list a[data-room-id="${directOffline}"]`);
  await expect(row).toBeVisible();
  const avatar = row.locator('.avatar');
  await expect(avatar).toHaveAttribute('data-presence', 'offline');
  expect(await avatar.evaluate((element) => getComputedStyle(element).filter)).toContain(
    'grayscale',
  );
  await expect(avatar).toHaveCSS('opacity', '0.55');
  await expect(row.locator('.presence-dot')).toHaveCSS('filter', 'none');
  await expect(page.locator('.sidebar-list')).toBeVisible();
});

test('群成员弹窗只灰明确离线的 Agent', async ({ page }) => {
  await loginWithFilter(page, tokenA, 'group');
  await page.goto(`${base}/c/${groupId}`);
  await expect(page.locator('#title')).toHaveText(groupTitle);
  await page.locator('#members-button').click();
  await expect(page.locator('#members-modal')).toBeVisible();

  const current = page.locator('#members-current');
  const offlineRow = current.locator('.spa-member').filter({ hasText: agentOfflineName });
  await expect(offlineRow).toBeVisible();
  const offlineAvatar = offlineRow.locator('.member-avatar');
  await expect(offlineAvatar).toHaveAttribute('data-presence', 'offline');
  expect(await offlineAvatar.evaluate((element) => getComputedStyle(element).filter)).toContain(
    'grayscale',
  );
  await expect(offlineRow.locator('.member-roster-name .visually-hidden')).toHaveText('（离线）');

  const onlineRow = current.locator('.spa-member').filter({ hasText: '在线 Agent' });
  await expect(onlineRow).toBeVisible();
  await expect(onlineRow.locator('.member-avatar')).not.toHaveAttribute(
    'data-presence',
    'offline',
  );
  await expect(onlineRow.locator('.visually-hidden')).toHaveCount(0);

  const meRow = current.locator('.spa-member').filter({ hasText: nameA });
  await expect(meRow).toBeVisible();
  await expect(meRow.locator('.member-avatar')).not.toHaveAttribute('data-presence', 'offline');
  await expect(meRow.locator('.visually-hidden')).toHaveCount(0);

  const candidate = page.locator('#members-contacts .contact-choice').filter({ hasText: nameB });
  await expect(candidate).toBeVisible();
  await expect(candidate.locator('.contact-avatar')).not.toHaveAttribute(
    'data-presence',
    'offline',
  );
  await expect(page.locator('#members-contacts [data-presence="offline"]')).toHaveCount(0);
});

test('群成员图片头像与首字头像尺寸、圆角一致且图片满铺', async ({ page }) => {
  await loginWithFilter(page, tokenA, 'group');
  await page.goto(`${base}/c/${groupId}`);
  await page.locator('#members-button').click();
  await expect(page.locator('#members-modal')).toBeVisible();

  const current = page.locator('#members-current');
  const imageAvatar = current
    .locator('.spa-member')
    .filter({ hasText: imageAgentName })
    .locator('.member-avatar');
  const textAvatar = current
    .locator('.spa-member')
    .filter({ hasText: textAgentName })
    .locator('.member-avatar');
  await expect(imageAvatar).toBeVisible();
  await expect(textAvatar).toBeVisible();
  const image = imageAvatar.locator('img.avatar-img');
  await expect(image).toHaveCount(1);
  await expect.poll(
    () => image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    { timeout: 10_000 },
  ).toBeGreaterThan(0);

  const [imageStyle, textStyle] = await Promise.all([
    imageAvatar.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        padding: style.padding,
      };
    }),
    textAvatar.evaluate((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        radius: style.borderTopLeftRadius,
        background: style.backgroundColor,
      };
    }),
  ]);
  expect(imageStyle.width).toBeGreaterThan(0);
  expect(Math.abs(imageStyle.width - textStyle.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(imageStyle.height - textStyle.height)).toBeLessThanOrEqual(0.5);
  expect(imageStyle.radius).toBe(textStyle.radius);
  // 图片头像不再有浅色托盘：容器透明、无内边距，首字色块只用于回退。
  expect(imageStyle.background).toBe('rgba(0, 0, 0, 0)');
  expect(imageStyle.backgroundImage).toBe('none');
  expect(imageStyle.padding).toBe('0px');

  const imageMetrics = await image.evaluate((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      width: rect.width,
      height: rect.height,
      radius: style.borderTopLeftRadius,
      objectFit: style.objectFit,
      background: style.backgroundColor,
    };
  });
  expect(imageMetrics.objectFit).toBe('cover');
  expect(imageMetrics.radius).toBe(imageStyle.radius);
  expect(imageMetrics.background).toBe('rgba(0, 0, 0, 0)');
  expect(Math.abs(imageMetrics.width - imageStyle.width)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(imageMetrics.height - imageStyle.height)).toBeLessThanOrEqual(0.5);
});

test('群成员图片头像 404 时回退首字且不出现白底', async ({ page }) => {
  await page.route('**/agent-icons/claude-color.svg', (route) =>
    route.fulfill({ status: 404, body: '' }),
  );
  await loginWithFilter(page, tokenA, 'group');
  await page.goto(`${base}/c/${groupId}`);
  await page.locator('#members-button').click();
  await expect(page.locator('#members-modal')).toBeVisible();

  const avatar = page
    .locator('#members-current .spa-member')
    .filter({ hasText: imageAgentName })
    .locator('.member-avatar');
  await expect(avatar).toBeVisible();
  await expect(avatar.locator('img.avatar-img')).toHaveCount(0);
  await expect(avatar).toContainText('C');
  await expect(avatar).not.toHaveClass(/avatar-icon/u);

  const style = await avatar.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { background: computed.backgroundColor, backgroundImage: computed.backgroundImage };
  });
  expect(style.backgroundImage).toBe('none');
  expect(style.background).not.toBe('rgb(255, 255, 255)');
  expect(style.background).not.toBe('rgba(0, 0, 0, 0)');
});
