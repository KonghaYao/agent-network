import { expect, test, type Page, type Route } from '@playwright/test';

import { baseUrl, callTool, createComponentRoom, login, requestId } from './fixtures/components';

/**
 * PWA 阶段 4：前台恢复、历史补洞、已读水位、撤权栅栏、双标签 outbox。
 *
 * 默认不随 `test:e2e` 运行；需要先 `bun run build:web`，再
 * `E2E_PWA_RECOVERY=1 playwright test tests/e2e/pwa-recovery.spec.ts`。
 */

const ENABLED = process.env.E2E_PWA_RECOVERY === '1';
test.skip(!ENABLED, '设置 E2E_PWA_RECOVERY=1 运行恢复套件');

test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

interface RpcBody {
  id?: string | number;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function rpcResult(id: string | number | undefined, structuredContent: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent } });
}

function rpcError(id: string | number | undefined, message: string, code: string): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { message, data: { code } },
  });
}

function syntheticMessage(roomId: string, seq: number, preview: string) {
  return {
    kind: 'message',
    message_id: `probe-${seq}`,
    room_id: roomId,
    sender_id: 'probe-sender',
    sender_kind: 'human',
    created_seq: String(seq),
    preview,
    body_bytes: 4,
    created_at: String(1_700_000_000_000 + seq),
    reply_to: null,
    root_id: null,
    task_root_id: null,
    hop: 0,
    delivery_states: {},
    mentions: [],
    delivery_claimed_at: null,
    delivery_updated_at: null,
  };
}

const AUTHORIZATION = {
  policy_revision: 0,
  history_from_seq: '0',
  member_generation: '1',
};

async function postJson(
  route: Route,
  body: RpcBody,
  structured: unknown,
): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: rpcResult(body.id, structured),
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openRoom(page: Page, base: string, token: string, roomId: string, title: string) {
  await page.goto(`${base}/c/${roomId}`);
  await expect(page.locator('body[data-spa-route="room"]')).toBeVisible();
  await expect(page.locator('#title')).toHaveText(title);
  await expect(page.locator('#composer')).toBeVisible();
}

async function registerHuman(
  base: string,
  name: string,
): Promise<{ token: string; actorId: string; name: string }> {
  const token = crypto.randomUUID();
  const { actor_id } = await callTool<{ actor_id: string }>(base, token, 'network_register', {
    request_id: requestId('e2e_reg'),
    kind: 'human',
    name,
    device_id: `e2e-${crypto.randomUUID()}`,
  });
  return { token, actorId: actor_id, name };
}

async function addFriend(base: string, ownerToken: string, peerToken: string, peerActorId: string) {
  const requested = await callTool<{ request: { contact_request_id: string } }>(
    base,
    ownerToken,
    'network_contact_request',
    { request_id: requestId('e2e_contact'), actor_id: peerActorId },
  );
  await callTool(base, peerToken, 'network_contact_request_respond', {
    request_id: requestId('e2e_contact'),
    contact_request_id: requested.request.contact_request_id,
    action: 'accept',
  });
}

interface LateTaskFixture {
  owner: { token: string; actorId: string; name: string };
  b: { token: string; actorId: string; name: string };
  c: { token: string; actorId: string; name: string };
  roomId: string;
  roomTitle: string;
  rootId: string;
  messageCount: number;
}

/** 同一房间里的 B/C 与一条 open Task；replies 用于制造 Trace 分页。 */
async function createLateTaskRoom(base: string, replies: number): Promise<LateTaskFixture> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const owner = await registerHuman(base, `晚到 Owner ${suffix}`);
  const b = await registerHuman(base, `晚到 B ${suffix}`);
  const c = await registerHuman(base, `晚到 C ${suffix}`);
  await addFriend(base, owner.token, b.token, b.actorId);
  await addFriend(base, owner.token, c.token, c.actorId);

  const roomTitle = `晚到群 ${suffix}`;
  const created = await callTool<{ room: { room_id: string } }>(
    base,
    owner.token,
    'network_room_create',
    {
      request_id: requestId('e2e_late_group'),
      kind: 'group',
      title: roomTitle,
      members: [b.actorId, c.actorId],
    },
  );
  const roomId = created.room.room_id;
  const sent = await callTool<{ message: { message_id: string } }>(
    base,
    owner.token,
    'network_message_send',
    {
      request_id: requestId('e2e_late_root'),
      client_message_id: requestId('e2e_late_root_client'),
      room_id: roomId,
      body: `晚到任务 ${suffix}`,
      invoke: [],
    },
  );
  const rootId = sent.message.message_id;
  await callTool(base, owner.token, 'network_task_mark', {
    request_id: requestId('e2e_late_mark'),
    room_id: roomId,
    message_id: rootId,
  });
  for (let index = 0; index < replies; index += 1) {
    await callTool(base, owner.token, 'network_message_send', {
      request_id: requestId('e2e_late_reply'),
      client_message_id: requestId('e2e_late_reply_client'),
      room_id: roomId,
      body: `处理记录 ${index + 1}`,
      invoke: [],
      task_root_id: rootId,
    });
  }
  return {
    owner,
    b,
    c,
    roomId,
    roomTitle,
    rootId,
    messageCount: replies + 1,
  };
}

async function expandTaskDock(page: Page) {
  await expect(page.locator('#task-dock')).toBeVisible({ timeout: 15_000 });
  if ((await page.locator('#task-dock').getAttribute('data-state')) !== 'expanded') {
    await page.locator('#task-dock-toggle').click();
  }
  await expect(page.locator('#task-dock')).toHaveAttribute('data-state', 'expanded');
}

function taskItem(page: Page, rootId: string) {
  return page.locator(`#task-dock .task-dock-item[data-task-root="${rootId}"]`);
}

async function openTaskTrace(page: Page, rootId: string) {
  await taskItem(page, rootId).locator('.task-dock-item-trigger').click();
  const popover = page.locator(`#task-preview-${rootId}`);
  await expect(popover).toBeVisible();
  await popover.getByRole('button', { name: /查看全部 \d+ 条消息/ }).click();
  await expect(page.locator('#task-trace-drawer')).toBeVisible({ timeout: 15_000 });
}

/**
 * 同一页内切号并让身份遮罩保持可见：调用方先让 C 的 network_me 失败，
 * 这能确保遮罩真正绘制、旧组件卸载；随后由 `finishIdentitySwitch` 放行。
 */
async function switchIdentityUnderMask(page: Page, token: string) {
  await page.evaluate((value) => {
    localStorage.setItem('agent-network-token', value);
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'agent-network-token', newValue: value }),
    );
  }, token);
  await expect(page.locator('#recovery-mask')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#recovery-retry')).toBeVisible({ timeout: 20_000 });
}

/** 放行新身份并等待恢复轮确认。 */
async function finishIdentitySwitch(page: Page, name: string) {
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#recovery-mask')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator('#account-name')).toHaveText(name, { timeout: 20_000 });
}

interface MaskSession {
  startedAt: number;
  durationMs: number;
  frames: number;
  text: string;
}

interface EntryProbeState {
  masks: { at: number; text: string }[];
  maskSessions: MaskSession[];
  /** 遮罩可见期间 rAF 采样到的帧数；0 表示从未绘制。 */
  maskFrames: number;
  /** 遮罩累计可见时长（毫秒），按相邻采样差值累加。 */
  maskedMs: number;
  /** 当前是否仍被遮罩；读取时会把进行中的会话补进 maskSessions。 */
  maskVisible: boolean;
  maskStartedAt: number;
  maskSessionFrames: number;
  maskText: string;
  catchups: { at: number; text: string; active: string | null; rebuilt: string | null }[];
}

/**
 * 进房前安装 DOM 记录器：遮罩一闪而过也要留下证据。
 *
 * 每次页面加载重置；调用方在导航/刷新后读取。rAF 逐帧统计遮罩帧数与
 * 累计时长，MutationObserver 记录首次出现与文案变化；只记录可见文本与
 * 状态位，不读取消息正文或凭据。
 */
async function installEntryProbe(page: Page) {
  await page.addInitScript(() => {
    const state: EntryProbeState = {
      masks: [],
      maskSessions: [],
      maskFrames: 0,
      maskedMs: 0,
      maskVisible: false,
      maskStartedAt: 0,
      maskSessionFrames: 0,
      maskText: '',
      catchups: [],
    };
    (window as unknown as { __entryProbe: EntryProbeState }).__entryProbe = state;
    let lastMask = '';
    let lastCatchup = '';
    let lastSampleAt = 0;
    const readMaskText = (mask: Element | null): string =>
      mask
        ? (document.getElementById('recovery-mask-text')?.textContent ?? '')
            .replace(/\s+/g, ' ')
            .trim()
        : '';
    const startSession = (now: number, text: string) => {
      state.maskVisible = true;
      state.maskStartedAt = now;
      state.maskSessionFrames = 0;
      state.maskText = text;
      state.masks.push({ at: Math.round(now), text });
      lastMask = text;
    };
    const endSession = (now: number) => {
      state.maskSessions.push({
        startedAt: Math.round(state.maskStartedAt),
        durationMs: Math.round(now - state.maskStartedAt),
        frames: state.maskSessionFrames,
        text: state.maskText,
      });
      state.maskVisible = false;
    };
    /**
     * `countFrame` 只由 rAF 路径置真：MutationObserver 只补充首次出现与
     * 文案变化，不重复累加帧数/时长。
     */
    const record = (countFrame: boolean) => {
      const now = performance.now();
      const delta = lastSampleAt ? now - lastSampleAt : 0;
      if (countFrame) lastSampleAt = now;
      const mask = document.getElementById('recovery-mask');
      if (mask) {
        if (countFrame) {
          state.maskFrames += 1;
          if (state.maskVisible) state.maskedMs += delta;
        }
        const text = readMaskText(mask);
        if (!state.maskVisible) {
          startSession(now, text);
        } else if (countFrame) {
          state.maskSessionFrames += 1;
        }
        if (text !== lastMask) {
          state.maskText = text;
          state.masks.push({ at: Math.round(now), text });
          lastMask = text;
        }
      } else if (state.maskVisible) {
        endSession(now);
        lastMask = '';
      }
      const catchup = document.getElementById('history-catchup');
      if (catchup instanceof HTMLElement && !catchup.hidden) {
        const text = (catchup.textContent ?? '').replace(/\s+/g, ' ').trim();
        const signature = `${text}|${catchup.dataset.catchupActive ?? ''}|${catchup.dataset.catchupRebuilt ?? ''}`;
        if (signature !== lastCatchup) {
          state.catchups.push({
            at: Math.round(now),
            text,
            active: catchup.dataset.catchupActive ?? null,
            rebuilt: catchup.dataset.catchupRebuilt ?? null,
          });
          lastCatchup = signature;
        }
      } else {
        lastCatchup = '';
      }
    };
    const start = () => {
      record(true);
      new MutationObserver(() => record(false)).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['hidden'],
      });
      const frame = () => {
        record(true);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  });
}

async function readEntryProbe(page: Page): Promise<EntryProbeState> {
  return page.evaluate(() => {
    const state = (window as unknown as { __entryProbe?: EntryProbeState }).__entryProbe;
    if (!state) {
      return {
        masks: [],
        maskSessions: [],
        maskFrames: 0,
        maskedMs: 0,
        maskVisible: false,
        maskStartedAt: 0,
        maskSessionFrames: 0,
        maskText: '',
        catchups: [],
      } satisfies EntryProbeState;
    }
    if (!state.maskVisible) return state;
    // 遮罩仍在：把进行中的会话补进快照，便于粘性遮罩断言时长/帧数。
    return {
      ...state,
      maskSessions: [
        ...state.maskSessions,
        {
          startedAt: Math.round(state.maskStartedAt),
          durationMs: Math.round(performance.now() - state.maskStartedAt),
          frames: state.maskSessionFrames,
          text: state.maskText,
        },
      ],
    };
  });
}

const RECOVERY_COPY = /恢复|离线|重新验证|核对身份/;

/**
 * 遮罩统计必须为 0：既查 DOM 快照，也查 rAF 帧数与累计时长，避免只读
 * `visible` 漏掉一闪而过的遮罩。
 */
function expectNoMaskActivity(probe: EntryProbeState, stage: string): void {
  expect(probe.masks, `${stage} 出现恢复遮罩：${JSON.stringify(probe.masks)}`).toEqual([]);
  expect(
    probe.maskSessions,
    `${stage} 出现遮罩会话：${JSON.stringify(probe.maskSessions)}`,
  ).toEqual([]);
  expect(probe.maskFrames, `${stage} 遮罩帧数`).toBe(0);
  expect(probe.maskedMs, `${stage} 遮罩时长`).toBe(0);
  const recoveryBars = probe.catchups.filter((item) => RECOVERY_COPY.test(item.text));
  expect(
    recoveryBars,
    `${stage} 出现恢复文案：${JSON.stringify(recoveryBars)}`,
  ).toEqual([]);
}

/** 输入后发送按钮启用，证明输入框没有被遮罩/骨架/只读状态阻断。 */
async function expectComposerUsable(page: Page): Promise<void> {
  const body = page.locator('#body');
  await expect(body).toBeEditable();
  await body.fill('进房可用性探针');
  await expect(page.locator('#send')).toBeEnabled();
  await body.fill('');
}

/** 遮罩期间输入框不可操作：不存在、被 disabled 或位于 inert 根节点内。 */
async function composerUsable(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const body = document.getElementById('body') as HTMLTextAreaElement | null;
    if (!body) return false;
    const rect = body.getBoundingClientRect();
    const style = getComputedStyle(body);
    return (
      !body.disabled &&
      body.closest('[inert]') === null &&
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    );
  });
}

/**
 * 正常进房：聊天立即可用，观察窗内不允许出现遮罩或恢复文案。
 * 默认观察 3 秒，覆盖慢网络下延迟到达的恢复触发。
 */
async function expectCleanEntry(page: Page, stage: string, settleMs = 3_000) {
  await expect(page.locator('#composer')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#body')).toBeEnabled();
  await expect(page.locator('#messages')).toContainText('组件验收初始消息');
  await page.waitForTimeout(settleMs);
  await expectComposerUsable(page);
  const probe = await readEntryProbe(page);
  expectNoMaskActivity(probe, stage);
  return probe;
}

test('正常进房（直链/首页点击/刷新）不出现恢复遮罩，聊天立即可用', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  await installEntryProbe(page);
  await login(page, base, fixture.tokenA);

  const stageProbe = async (stage: string) => {
    const probe = await expectCleanEntry(page, stage);
    const after = await readEntryProbe(page);
    expectNoMaskActivity(after, `${stage} 观察窗后`);
    console.log(JSON.stringify({
      probe: 'clean-entry',
      stage,
      masks: after.masks.length,
      maskSessions: after.maskSessions.length,
      maskFrames: after.maskFrames,
      maskedMs: after.maskedMs,
      catchups: after.catchups.length,
      initialMasks: probe.masks.length,
      inputEditable: true,
    }));
  };

  await page.goto(`${base}/c/${fixture.roomId}`);
  await expect(page.locator('#title')).toHaveText(fixture.roomTitle);
  await stageProbe('direct');

  await page.evaluate(() => {
    window.history.pushState(null, '', '/');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await page.locator(`[data-room-id="${fixture.roomId}"]`).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(400);
  await page.locator(`[data-room-id="${fixture.roomId}"]`).click();
  await expect(page.locator('#title')).toHaveText(fixture.roomTitle);
  await stageProbe('home-click');

  await page.reload();
  await expect(page.locator('#title')).toHaveText(fixture.roomTitle);
  await stageProbe('reload');
});

test('慢网络进房（me/room_get/history 各 1s）不出现恢复遮罩', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  const delayed = ['network_me', 'network_room_get', 'network_history_list'];
  await page.route('**/mcp', async (route) => {
    const name = route.request().headers()['mcp-name'];
    if (name && delayed.includes(name)) await delay(1_000);
    await route.continue();
  });
  await installEntryProbe(page);
  await login(page, base, fixture.tokenA);

  await page.goto(`${base}/c/${fixture.roomId}`);
  const probe = await expectCleanEntry(page, 'slow-network');
  const after = await readEntryProbe(page);
  expectNoMaskActivity(after, 'slow-network 观察窗后');
  console.log(JSON.stringify({
    probe: 'slow-entry',
    delaysMs: 1_000,
    masks: after.masks.length,
    maskSessions: after.maskSessions.length,
    maskFrames: after.maskFrames,
    maskedMs: after.maskedMs,
    catchups: after.catchups.map((item) => item.text),
    initialMasks: probe.masks.length,
    inputEditable: true,
  }));
});

test('informational 成员/房间事件只原地刷新，不触发恢复遮罩', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  await installEntryProbe(page);
  await login(page, base, fixture.tokenA);
  await openRoom(page, base, fixture.tokenA, fixture.roomId, fixture.roomTitle);
  await page.waitForTimeout(600);

  const toolCalls: string[] = [];
  page.on('request', (request) => {
    const name = request.headers()['mcp-name'];
    if (name) toolCalls.push(name);
  });
  const calls = (name: string) => toolCalls.filter((item) => item === name).length;

  const newTitle = `组件改名 ${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
  await callTool(base, fixture.tokenA, 'network_room_rename', {
    request_id: requestId('e2e_rename'),
    room_id: fixture.roomId,
    title: newTitle,
    expected_title: fixture.roomTitle,
  });
  await expect(page.locator('#title')).toHaveText(newTitle, { timeout: 15_000 });

  const newcomer = await registerHuman(base, `组件新成员 ${crypto.randomUUID().slice(0, 4)}`);
  await addFriend(base, fixture.tokenA, newcomer.token, newcomer.actorId);
  await callTool(base, fixture.tokenA, 'network_room_members_update', {
    request_id: requestId('e2e_add_member'),
    room_id: fixture.roomId,
    add: [newcomer.actorId],
  });
  await expect(page.locator('#subtitle')).toContainText('3 人', { timeout: 15_000 });
  // 移除其他成员对旁观者是 informational：只刷新成员视图，不遮罩自己。
  await callTool(base, fixture.tokenA, 'network_room_members_update', {
    request_id: requestId('e2e_remove_other'),
    room_id: fixture.roomId,
    remove: [newcomer.actorId],
  });
  await expect(page.locator('#subtitle')).toContainText('2 人', { timeout: 15_000 });

  // room.created 属于其他房间：只刷新会话列表，当前房间保持原地可用。
  const roomsBefore = calls('network_rooms_list');
  await callTool(base, fixture.tokenA, 'network_room_create', {
    request_id: requestId('e2e_new_group'),
    kind: 'group',
    title: `组件旁路群 ${crypto.randomUUID().slice(0, 4)}`,
    members: [fixture.actorB],
  });
  await expect
    .poll(() => calls('network_rooms_list'), { timeout: 15_000 })
    .toBeGreaterThan(roomsBefore);

  await page.waitForTimeout(3_000);
  const probe = await readEntryProbe(page);
  expectNoMaskActivity(probe, 'informational-membership');
  await expect(page.locator('#recovery-mask')).toHaveCount(0);
  await expect(page.locator('#title')).toHaveText(newTitle);
  await expect(page.locator('#messages')).toContainText('组件验收初始消息');
  await expectComposerUsable(page);
  console.log(JSON.stringify({
    probe: 'informational-membership',
    events: ['room_profile_updated', 'members_changed(add)', 'members_changed(remove-other)', 'room.created'],
    masks: probe.masks.length,
    maskSessions: probe.maskSessions.length,
    maskFrames: probe.maskFrames,
    maskedMs: probe.maskedMs,
    roomGetCalls: calls('network_room_get'),
    historyCalls: calls('network_history_list'),
    roomsListCalls: calls('network_rooms_list'),
    title: await page.locator('#title').textContent(),
    subtitle: await page.locator('#subtitle').textContent(),
    inputEditable: true,
  }));
});

test('撤销管理员（action_required role_changed）不遮罩，仍可发送', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  await installEntryProbe(page);
  await login(page, base, fixture.tokenB);
  await openRoom(page, base, fixture.tokenB, fixture.roomId, fixture.roomTitle);
  await page.waitForTimeout(600);

  const toolCalls: string[] = [];
  page.on('request', (request) => {
    const name = request.headers()['mcp-name'];
    if (name) toolCalls.push(name);
  });
  const calls = (name: string) => toolCalls.filter((item) => item === name).length;

  type Detail = { members: { actor_id: string; role_revision: number }[] };
  const initial = await callTool<Detail>(base, fixture.tokenA, 'network_room_get', {
    room_id: fixture.roomId,
  });
  const target = initial.members.find((member) => member.actor_id === fixture.actorB);
  if (!target) throw new Error('缺少测试成员');

  const appointedAt = calls('network_room_get');
  const appointed = await callTool<Detail>(base, fixture.tokenA, 'network_room_role_set', {
    request_id: requestId('e2e_role_admin'),
    room_id: fixture.roomId,
    actor_id: fixture.actorB,
    role: 'admin',
    expected_role_revision: target.role_revision,
  });
  const admin = appointed.members.find((member) => member.actor_id === fixture.actorB);
  if (!admin) throw new Error('任命后缺少测试成员');
  // 被任命为 admin 对本人是 informational；页面应刷新详情。
  await expect
    .poll(() => calls('network_room_get'), { timeout: 15_000 })
    .toBeGreaterThan(appointedAt);

  const demotedAt = calls('network_room_get');
  await callTool<Detail>(base, fixture.tokenA, 'network_room_role_set', {
    request_id: requestId('e2e_role_member'),
    room_id: fixture.roomId,
    actor_id: fixture.actorB,
    role: 'member',
    expected_role_revision: admin.role_revision,
  });
  // 被撤销管理员本人收到 action_required + change=role_changed：
  // 管理能力失效，但成员仍在群内，读边界不变，只原地刷新。
  await expect.poll(() => calls('network_room_get'), { timeout: 15_000 }).toBeGreaterThan(demotedAt);

  await page.waitForTimeout(3_000);
  const probe = await readEntryProbe(page);
  expectNoMaskActivity(probe, 'role-demotion');
  await expect(page.locator('#recovery-mask')).toHaveCount(0);
  await expect(page.locator('#title')).toHaveText(fixture.roomTitle);
  await expect(page.locator('#messages')).toContainText('组件验收初始消息');
  await expectComposerUsable(page);

  await page.locator('#body').fill('撤销管理员后仍可发送');
  await page.locator('#send').click();
  await expect(page.locator('#messages')).toContainText('撤销管理员后仍可发送', {
    timeout: 15_000,
  });

  console.log(JSON.stringify({
    probe: 'role-demotion',
    event: 'room_role_changed action_required new_role=member',
    masks: probe.masks.length,
    maskSessions: probe.maskSessions.length,
    maskFrames: probe.maskFrames,
    maskedMs: probe.maskedMs,
    roomGetCalls: calls('network_room_get'),
    inputEditable: true,
    sentAfterDemotion: true,
  }));
});

test('被移出会话时出现粘性恢复遮罩，旧正文与输入框不可用', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  await installEntryProbe(page);
  await login(page, base, fixture.tokenB);
  await openRoom(page, base, fixture.tokenB, fixture.roomId, fixture.roomTitle);
  await expect(page.locator('#messages')).toContainText('组件验收初始消息');
  await expectComposerUsable(page);

  const removedAt = Date.now();
  await callTool(base, fixture.tokenA, 'network_room_members_update', {
    request_id: requestId('e2e_remove_member'),
    room_id: fixture.roomId,
    remove: [fixture.actorB],
  });

  await expect(page.locator('#recovery-mask')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#recovery-mask-text')).toContainText(/不在该会话|权限/);
  await expect(page.locator('#messages')).toBeHidden();
  await expect(page.locator('#body')).not.toBeVisible();
  // 粘性遮罩清掉私有缓存后，旧正文不能再留在 DOM 里。
  await expect(page.getByText('组件验收初始消息')).toHaveCount(0);
  expect(await composerUsable(page), '撤权后输入框仍可用').toBe(false);

  const snapshot = await page.evaluate(
    () =>
      (
        window as unknown as {
          __agentNetworkRecovery?: {
            snapshot: () => { phase: string; masked: boolean; sticky: boolean; lastReasons: string[] };
          };
        }
      ).__agentNetworkRecovery?.snapshot() ?? null,
  );
  expect(snapshot?.phase).toBe('blocked');
  expect(snapshot?.masked).toBe(true);
  expect(snapshot?.sticky).toBe(true);
  expect(snapshot?.lastReasons).toContain('membership');

  const probe = await readEntryProbe(page);
  expect(probe.masks.length, '遮罩应至少出现一次').toBeGreaterThan(0);
  expect(probe.maskSessions.length, '应记录遮罩会话').toBeGreaterThan(0);
  expect(probe.maskFrames, '遮罩帧数').toBeGreaterThan(0);
  expect(probe.maskedMs, '遮罩时长').toBeGreaterThan(0);
  expect(probe.maskSessions.at(-1)?.durationMs ?? 0).toBeGreaterThan(0);
  console.log(JSON.stringify({
    probe: 'membership-revoke',
    masked: true,
    phase: snapshot?.phase,
    reasons: snapshot?.lastReasons,
    masks: probe.masks.length,
    maskSessions: probe.maskSessions.length,
    maskFrames: probe.maskFrames,
    maskedMs: probe.maskedMs,
    maskDurationMs: probe.maskSessions.at(-1)?.durationMs ?? 0,
    sinceRemovalMs: Date.now() - removedAt,
    oldBodyCount: await page.getByText('组件验收初始消息').count(),
    inputUsable: await composerUsable(page),
  }));
});

test('合并 online/visibility/ACK 为单轮恢复，并在离线时只标离线', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  await login(page, base, fixture.tokenA);
  await openRoom(page, base, fixture.tokenA, fixture.roomId, fixture.roomTitle);

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
    (
      window as unknown as {
        __agentNetworkRecovery?: { trigger: (reason: string) => void };
      }
    ).__agentNetworkRecovery?.trigger('stream-ack');
  });

  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __agentNetworkRecovery?: {
                snapshot: () => { rounds: number; phase: string; lastReasons: string[] };
              };
            }
          ).__agentNetworkRecovery?.snapshot() ?? null,
      ),
    )
    .toMatchObject({ phase: 'ready', rounds: 1 });
  const state = await page.evaluate(
    () =>
      (
        window as unknown as {
          __agentNetworkRecovery?: {
            snapshot: () => { rounds: number; lastReasons: string[] };
          };
        }
      ).__agentNetworkRecovery?.snapshot(),
  );
  expect(state?.lastReasons.sort()).toEqual(['online', 'stream-ack', 'visibility']);
  console.log(JSON.stringify({
    probe: 'recovery-merge',
    rounds: state?.rounds,
    reasons: state?.lastReasons,
  }));

  await page.context().setOffline(true);
  await expect(page.locator('#offline-banner')).toBeVisible();
  await expect(page.locator('#messages')).toBeVisible();
  await page.context().setOffline(false);
  await expect(page.locator('#offline-banner')).toBeHidden({ timeout: 10_000 });
  console.log(JSON.stringify({ probe: 'offline-conversation', bannerWhileOffline: true }));
});

test('同身份重连 ACK 先清空 Task 与 Trace，再重读回填', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
  const sent = await callTool<{ message: { message_id: string } }>(
    base,
    fixture.tokenA,
    'network_message_send',
    {
      request_id: requestId('e2e_ack_task'),
      client_message_id: requestId('e2e_ack_task_client'),
      room_id: fixture.roomId,
      body: `重连前后都可见的 Task ${suffix}`,
      invoke: [],
    },
  );
  const rootId = sent.message.message_id;
  await callTool(base, fixture.tokenA, 'network_task_mark', {
    request_id: requestId('e2e_ack_mark'),
    room_id: fixture.roomId,
    message_id: rootId,
  });

  let holdReads = false;
  let heldLists = 0;
  let heldTraces = 0;
  const releases: (() => void)[] = [];
  await page.route('**/mcp', async (route) => {
    const name = route.request().headers()['mcp-name'];
    if (!holdReads || (name !== 'network_task_list' && name !== 'network_task_trace')) {
      await route.continue();
      return;
    }
    if (name === 'network_task_list') heldLists += 1;
    else heldTraces += 1;
    await new Promise<void>((release) => releases.push(release));
    await route.continue();
  });

  await login(page, base, fixture.tokenA);
  await openRoom(page, base, fixture.tokenA, fixture.roomId, fixture.roomTitle);
  await expandTaskDock(page);
  await expect(taskItem(page, rootId)).toHaveCount(1, { timeout: 15_000 });
  await openTaskTrace(page, rootId);
  await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(1, {
    timeout: 15_000,
  });

  holdReads = true;
  await page.evaluate(() => {
    (
      window as unknown as { __agentNetworkRecovery?: { trigger: (reason: string) => void } }
    ).__agentNetworkRecovery?.trigger('stream-ack');
  });
  await expect.poll(() => heldLists, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => heldTraces, { timeout: 15_000 }).toBeGreaterThan(0);

  // 重读尚未返回：旧条目必须已被丢弃，而不是 invalidate 后继续显示。
  await expect(page.locator('#task-dock-count')).toHaveText('…');
  await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(0);
  await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(0);
  const itemsWhileHeld = await page.locator('#task-dock .task-dock-item').count();

  holdReads = false;
  const held = releases.splice(0);
  for (const release of held) release();
  await expect(taskItem(page, rootId)).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator('#task-dock-count')).toHaveText('1');
  await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(1, {
    timeout: 15_000,
  });
  console.log(JSON.stringify({
    probe: 'ack-task-reset',
    heldLists,
    heldTraces,
    itemsWhileHeld,
    reloadedItems: await page.locator('#task-dock .task-dock-item').count(),
  }));
});

test('21 页缺口分批追平并显示进度，已读不超过展示水位', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  await login(page, base, fixture.tokenA);
  await openRoom(page, base, fixture.tokenA, fixture.roomId, fixture.roomTitle);

  let afterRequests = 0;
  const markReadSeqs: string[] = [];
  await page.route('**/mcp', async (route) => {
    const request = route.request();
    let body: RpcBody;
    try {
      body = JSON.parse(request.postData() ?? '{}') as RpcBody;
    } catch {
      await route.continue();
      return;
    }
    const name = body.params?.name;
    if (name === 'network_room_mark_read') {
      const seq = body.params?.arguments?.through_seq;
      if (typeof seq === 'string') markReadSeqs.push(seq);
      await route.continue();
      return;
    }
    if (name !== 'network_history_list') {
      await route.continue();
      return;
    }
    const args = body.params?.arguments ?? {};
    if (args.direction === 'after') {
      afterRequests += 1;
      await delay(100);
      const index = afterRequests;
      const start = (index - 1) * 100 + 1;
      const end = index * 100;
      const items = Array.from({ length: 100 }, (_, offset) =>
        syntheticMessage(fixture.roomId, start + offset, `合成 ${start + offset}`),
      );
      await postJson(route, body, {
        items: [],
        next_cursor: null,
        has_more: false,
        snapshot: '2100',
        head_seq: '2100',
        view: 'timeline',
        timeline_items: items,
        timeline_next_cursor: index < 21 ? `probe-after-${index}` : null,
        timeline_has_more: index < 21,
        timeline_snapshot: '2100',
        timeline_resume_cursor: `probe-resume-${index}`,
        authorization: AUTHORIZATION,
      });
      return;
    }
    if (args.anchor_message_id) {
      await route.continue();
      return;
    }
    // 最新页：制造与旧游标之间的缺口。
    await postJson(route, body, {
      items: [],
      next_cursor: null,
      has_more: false,
      snapshot: '2100',
      head_seq: '2100',
      view: 'timeline',
      timeline_items: [syntheticMessage(fixture.roomId, 2100, '合成最新')],
      timeline_next_cursor: null,
      timeline_has_more: false,
      timeline_snapshot: '2100',
      timeline_resume_cursor: 'probe-latest',
      authorization: AUTHORIZATION,
    });
  });

  await page.evaluate(() => {
    const samples: { pages: string; active: string; text: string }[] = [];
    (window as unknown as { __catchupSamples: typeof samples }).__catchupSamples = samples;
    const read = () => {
      const element = document.getElementById('history-catchup');
      if (!element || element.hidden) return;
      samples.push({
        pages: element.dataset.catchupPages ?? '',
        active: element.dataset.catchupActive ?? '',
        text: element.textContent ?? '',
      });
    };
    new MutationObserver(read).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'data-catchup-pages'],
    });
  });
  await page.evaluate(() =>
    (
      window as unknown as { __agentNetworkRecovery?: { trigger: (reason: string) => void } }
    ).__agentNetworkRecovery?.trigger('visibility'),
  );

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __catchupSamples: unknown[] }).__catchupSamples.length), {
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
  const samples = await page.evaluate(
    () => (window as unknown as { __catchupSamples: { pages: string }[] }).__catchupSamples,
  );
  expect(samples.some((sample) => sample.pages === '20')).toBe(true);
  await expect
    .poll(() => afterRequests, { timeout: 20_000 })
    .toBe(21);
  await expect(page.locator('#history-catchup')).toBeHidden({ timeout: 10_000 });
  await expect(page.locator('#messages')).toContainText('合成 2100', { timeout: 10_000 });
  await expect
    .poll(() => markReadSeqs.at(-1), { timeout: 10_000 })
    .toBe('2100');
  expect(markReadSeqs).toContain('2100');
  expect(markReadSeqs.every((seq) => Number(seq) <= 2100)).toBe(true);
  const finalPages = await page.locator('#history-catchup').getAttribute('data-catchup-pages');
  console.log(JSON.stringify({
    probe: 'history-catchup',
    afterRequests,
    progressPages: samples.at(-1)?.pages,
    finalPages,
    markReadSeq: markReadSeqs.at(-1),
  }));
});

test('中途失败保留最后成功游标，下一轮从该位置续读', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  await login(page, base, fixture.tokenA);
  await openRoom(page, base, fixture.tokenA, fixture.roomId, fixture.roomTitle);

  let failOnce = true;
  const cursors: string[] = [];
  await page.route('**/mcp', async (route) => {
    const request = route.request();
    let body: RpcBody;
    try {
      body = JSON.parse(request.postData() ?? '{}') as RpcBody;
    } catch {
      await route.continue();
      return;
    }
    if (body.params?.name !== 'network_history_list') {
      await route.continue();
      return;
    }
    const args = body.params?.arguments ?? {};
    if (args.direction === 'after') {
      const cursor = String(args.cursor ?? '');
      cursors.push(cursor);
      const index = cursors.length;
      if (failOnce && index === 6) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: rpcError(body.id, 'probe failure', 'INTERNAL'),
        });
        return;
      }
      const start = (index - 1) * 100 + 1;
      const items = Array.from({ length: 100 }, (_, offset) =>
        syntheticMessage(fixture.roomId, start + offset, `续读 ${start + offset}`),
      );
      await postJson(route, body, {
        items: [],
        next_cursor: null,
        has_more: false,
        snapshot: '2100',
        head_seq: '2100',
        view: 'timeline',
        timeline_items: items,
        timeline_next_cursor: index < 21 ? `probe-after-${index}` : null,
        timeline_has_more: index < 21,
        timeline_snapshot: '2100',
        timeline_resume_cursor: `probe-resume-${index}`,
        authorization: AUTHORIZATION,
      });
      return;
    }
    if (args.anchor_message_id) {
      await route.continue();
      return;
    }
    await postJson(route, body, {
      items: [],
      next_cursor: null,
      has_more: false,
      snapshot: '2100',
      head_seq: '2100',
      view: 'timeline',
      timeline_items: [syntheticMessage(fixture.roomId, 2100, '失败后续读')],
      timeline_next_cursor: null,
      timeline_has_more: false,
      timeline_snapshot: '2100',
      timeline_resume_cursor: 'probe-latest',
      authorization: AUTHORIZATION,
    });
  });

  await page.evaluate(() =>
    (
      window as unknown as { __agentNetworkRecovery?: { trigger: (reason: string) => void } }
    ).__agentNetworkRecovery?.trigger('visibility'),
  );
  await expect(page.locator('#history-catchup')).toContainText('补读中断', { timeout: 15_000 });
  await expect(page.locator('#history-catchup')).toHaveAttribute('data-catchup-active', '1');
  expect(cursors[5]).toBeTruthy();

  failOnce = false;
  const beforeResume = cursors.length;
  await page.evaluate(() =>
    (
      window as unknown as { __agentNetworkRecovery?: { trigger: (reason: string) => void } }
    ).__agentNetworkRecovery?.trigger('manual'),
  );
  await expect
    .poll(() => cursors.length, { timeout: 20_000 })
    .toBeGreaterThan(beforeResume);
  expect(cursors[beforeResume]).toBe('probe-after-5');
  await expect(page.locator('#history-catchup')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#messages')).toContainText('续读 2100', { timeout: 10_000 });
  console.log(JSON.stringify({
    probe: 'catchup-resume',
    failedBatchCursors: beforeResume,
    resumeCursor: cursors[beforeResume],
    caughtUp: true,
  }));
});

test('撤回已显示消息时重读可见窗口并显示墓碑', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  const history = await callTool<{
    timeline_items?: { message_id: string; preview: string }[];
  }>(base, fixture.tokenA, 'network_history_list', {
    room_id: fixture.roomId,
    view: 'timeline',
    limit: 20,
  });
  const target = (history.timeline_items ?? []).find(
    (item) => item.preview === '组件验收初始消息',
  );
  expect(target).toBeTruthy();

  // 3a6593b 起撤回不再按 anchor 重读单条，而是重读已渲染窗口；
  // 断言请求确实发生，并用墓碑文本验证权威结果已回填。
  const historyReads: { anchor: string | null }[] = [];
  page.on('request', (request) => {
    if (!request.url().endsWith('/mcp') || request.method() !== 'POST') return;
    try {
      const body = JSON.parse(request.postData() ?? '{}') as RpcBody;
      if (body.params?.name !== 'network_history_list') return;
      const anchor = body.params.arguments?.anchor_message_id;
      historyReads.push({ anchor: typeof anchor === 'string' ? anchor : null });
    } catch {
      // 非 JSON 请求忽略。
    }
  });

  await login(page, base, fixture.tokenA);
  await openRoom(page, base, fixture.tokenA, fixture.roomId, fixture.roomTitle);
  await expect(page.locator('#messages')).toContainText('组件验收初始消息');
  await page.waitForTimeout(300);
  const readsBefore = historyReads.length;

  await callTool(base, fixture.tokenB, 'network_message_recall', {
    request_id: requestId('e2e_recall'),
    message_id: target?.message_id,
  });
  await expect
    .poll(() => historyReads.length - readsBefore, { timeout: 10_000 })
    .toBeGreaterThan(0);
  await expect(page.locator('#messages')).toContainText('此消息已撤回', { timeout: 10_000 });
  console.log(JSON.stringify({
    probe: 'recall-refresh',
    rereads: historyReads.length - readsBefore,
    anchors: historyReads.slice(readsBefore).filter((item) => item.anchor !== null).length,
  }));
});

test('切号后 network_me 失败保持粘性遮罩，恢复网络后才显示新身份', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  const newcomer = await registerHuman(base, `切号 ${crypto.randomUUID().slice(0, 6)}`);
  await addFriend(base, fixture.tokenA, newcomer.token, newcomer.actorId);
  await callTool(base, fixture.tokenA, 'network_room_members_update', {
    request_id: requestId('e2e_add'),
    room_id: fixture.roomId,
    add: [newcomer.actorId],
  });

  await login(page, base, fixture.tokenB);
  await openRoom(page, base, fixture.tokenB, fixture.roomId, fixture.roomTitle);
  await expect(page.locator('#messages')).toContainText('组件验收初始消息');

  let failIdentity = true;
  let identityCalls = 0;
  await page.route('**/mcp', async (route) => {
    const request = route.request();
    let body: RpcBody;
    try {
      body = JSON.parse(request.postData() ?? '{}') as RpcBody;
    } catch {
      await route.continue();
      return;
    }
    if (
      body.params?.name === 'network_me' &&
      request.headers()['authorization'] === `Bearer ${newcomer.token}`
    ) {
      identityCalls += 1;
      if (failIdentity) {
        await route.abort('failed');
        return;
      }
    }
    await route.continue();
  });

  // 同一页内切号：新凭据已写入 localStorage，但服务端身份尚未确认。
  await page.evaluate((token) => {
    localStorage.setItem('agent-network-token', token);
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'agent-network-token', newValue: token }),
    );
  }, newcomer.token);

  await expect(page.locator('#recovery-mask')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#recovery-retry')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#root')).toHaveAttribute('inert', '');
  await expect(page.locator('#root')).toHaveAttribute('aria-hidden', 'true');
  expect(await page.locator('#messages').count()).toBe(0);
  expect(await page.getByText('组件验收初始消息').count()).toBe(0);
  const masked = await page.evaluate(
    () =>
      (
        window as unknown as {
          __agentNetworkRecoveryHost?: {
            snapshot: () => { masked: boolean; sticky: boolean; phase: string };
          };
        }
      ).__agentNetworkRecoveryHost?.snapshot() ?? null,
  );
  expect(masked).toMatchObject({ masked: true, sticky: true });
  expect(identityCalls).toBeGreaterThan(0);

  failIdentity = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('#recovery-mask')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('#messages')).toContainText('组件验收初始消息', { timeout: 15_000 });
  await expect(page.locator('#root')).not.toHaveAttribute('inert', '');
  const callsAfterRecovery = identityCalls;
  await page.waitForTimeout(2_000);
  expect(identityCalls).toBe(callsAfterRecovery);
  console.log(JSON.stringify({
    probe: 'sticky-identity-mask',
    masked: true,
    sticky: true,
    oldBodyCount: 0,
    identityCalls: callsAfterRecovery,
    retriedAfterRecovery: identityCalls - callsAfterRecovery,
  }));
});

test('旧身份晚到的 mark_read 不清理新身份未读', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  const newcomer = await registerHuman(base, `已读 C ${crypto.randomUUID().slice(0, 6)}`);
  await addFriend(base, fixture.tokenA, newcomer.token, newcomer.actorId);
  await callTool(base, fixture.tokenA, 'network_room_members_update', {
    request_id: requestId('e2e_add'),
    room_id: fixture.roomId,
    add: [newcomer.actorId],
  });

  let nextSeq = 1;
  for (let index = 0; index < 10; index += 1) {
    await callTool(base, fixture.tokenA, 'network_message_send', {
      request_id: requestId('e2e_seq'),
      client_message_id: requestId('e2e_seq_client'),
      room_id: fixture.roomId,
      body: `已读准备 ${nextSeq}`,
      invoke: [],
    });
    nextSeq += 1;
  }
  // 以真实 head 作为 B/C 的权威已读水位；随后 6 条新消息制造未读。
  const baselineDetail = await callTool<{ room: { head_seq: string } }>(
    base,
    fixture.tokenA,
    'network_room_get',
    { room_id: fixture.roomId },
  );
  const baselineRead = baselineDetail.room.head_seq;
  expect(Number(baselineRead)).toBeGreaterThan(0);
  await callTool(base, fixture.tokenB, 'network_room_mark_read', {
    room_id: fixture.roomId,
    through_seq: baselineRead,
  });
  await callTool(base, newcomer.token, 'network_room_mark_read', {
    room_id: fixture.roomId,
    through_seq: baselineRead,
  });

  await login(page, base, fixture.tokenB);
  await openRoom(page, base, fixture.tokenB, fixture.roomId, fixture.roomTitle);
  await expect(page.locator('#messages')).toContainText('已读准备 10');

  let holdBReads = false;
  let failNewcomerReads = false;
  const heldBReads: (() => void)[] = [];
  let heldBReadCount = 0;
  let newcomerReadFailures = 0;
  await page.route('**/mcp', async (route) => {
    const request = route.request();
    let body: RpcBody;
    try {
      body = JSON.parse(request.postData() ?? '{}') as RpcBody;
    } catch {
      await route.continue();
      return;
    }
    if (body.params?.name !== 'network_room_mark_read') {
      await route.continue();
      return;
    }
    const authorization = request.headers()['authorization'] ?? '';
    if (authorization === `Bearer ${fixture.tokenB}` && holdBReads) {
      heldBReadCount += 1;
      await new Promise<void>((resolve) => heldBReads.push(resolve));
      await route.continue();
      return;
    }
    if (authorization === `Bearer ${newcomer.token}` && failNewcomerReads) {
      newcomerReadFailures += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: rpcError(body.id, 'probe mark read failure', 'INTERNAL'),
      });
      return;
    }
    await route.continue();
  });

  holdBReads = true;
  for (let index = 0; index < 6; index += 1) {
    await callTool(base, fixture.tokenA, 'network_message_send', {
      request_id: requestId('e2e_seq'),
      client_message_id: requestId('e2e_seq_client'),
      room_id: fixture.roomId,
      body: `已读准备 ${nextSeq}`,
      invoke: [],
    });
    nextSeq += 1;
  }
  await expect(page.locator('#messages')).toContainText('已读准备 16', { timeout: 15_000 });
  // 先离开底部再回到底部，确保刷新后 pinned 状态重新触发已读。
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('#messages');
    if (!list) return;
    list.scrollTop = 0;
    list.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('#messages');
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    list.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => heldBReadCount, { timeout: 15_000 }).toBeGreaterThan(0);

  // 切到 C：B 的 mark_read 仍被扣住，C 自己的 mark_read 失败。
  failNewcomerReads = true;
  await page.evaluate((token) => {
    localStorage.setItem('agent-network-token', token);
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'agent-network-token', newValue: token }),
    );
  }, newcomer.token);
  await expect(page.locator('#recovery-mask')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('#messages')).toContainText('已读准备 16', { timeout: 15_000 });
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('#messages');
    if (!list) return;
    list.scrollTop = 0;
    list.dispatchEvent(new Event('scroll'));
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('#messages');
    if (!list) return;
    list.scrollTop = list.scrollHeight;
    list.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => newcomerReadFailures, { timeout: 15_000 }).toBeGreaterThan(0);

  const readBeforeRelease = await page.evaluate(
    (roomId) =>
      (
        window as unknown as {
          __agentNetworkRecoveryHost?: { roomRead: (id: string) => string | null };
        }
      ).__agentNetworkRecoveryHost?.roomRead(roomId) ?? null,
    fixture.roomId,
  );
  expect(readBeforeRelease).toBe(baselineRead);
  await expect(
    page.locator(`[data-room-id="${fixture.roomId}"] .unread`),
  ).toBeVisible();

  // 释放 B 的迟到成功响应：它属于切换前的身份代次，必须被丢弃。
  const lateResponse = page.waitForResponse(
    (response) =>
      response.request().headers()['authorization'] === `Bearer ${fixture.tokenB}` &&
      response.request().headers()['mcp-name'] === 'network_room_mark_read',
    { timeout: 15_000 },
  );
  for (const release of heldBReads.splice(0)) release();
  await lateResponse;
  await page.waitForTimeout(800);

  const readAfterRelease = await page.evaluate(
    (roomId) =>
      (
        window as unknown as {
          __agentNetworkRecoveryHost?: { roomRead: (id: string) => string | null };
        }
      ).__agentNetworkRecoveryHost?.roomRead(roomId) ?? null,
    fixture.roomId,
  );
  expect(readAfterRelease).toBe(baselineRead);
  await expect(
    page.locator(`[data-room-id="${fixture.roomId}"] .unread`),
  ).toBeVisible();
  const serverDetail = await callTool<{ room: { my_last_read_seq: string; head_seq: string } }>(
    base,
    newcomer.token,
    'network_room_get',
    { room_id: fixture.roomId },
  );
  expect(serverDetail.room.my_last_read_seq).toBe(baselineRead);
  expect(Number(serverDetail.room.head_seq)).toBeGreaterThan(Number(baselineRead));
  console.log(JSON.stringify({
    probe: 'late-mark-read',
    baselineRead,
    localRead: readAfterRelease,
    serverRead: serverDetail.room.my_last_read_seq,
    headSeq: serverDetail.room.head_seq,
    heldBReads: heldBReadCount,
    newcomerReadFailures,
    unreadVisible: true,
  }));
});

test('切号后释放旧身份的 task_complete 不闪掉新身份的 dock', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createLateTaskRoom(base, 0);
  await login(page, base, fixture.b.token);
  await openRoom(page, base, fixture.b.token, fixture.roomId, fixture.roomTitle);
  await expandTaskDock(page);
  await expect(taskItem(page, fixture.rootId)).toHaveCount(1, { timeout: 15_000 });

  let releaseComplete: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releaseComplete = resolve;
  });
  let completeHeld = 0;
  let failIdentity = true;
  let identityCalls = 0;
  // 旧回执若真的触发重建，会发 `network_task_list`；延迟它让 0 状态可被采样。
  let delayTaskList = false;
  await page.route('**/mcp', async (route) => {
    const request = route.request();
    const name = request.headers()['mcp-name'];
    if (name === 'network_me' && request.headers()['authorization'] === `Bearer ${fixture.c.token}`) {
      identityCalls += 1;
      if (failIdentity) {
        await route.abort('failed');
        return;
      }
      await route.continue();
      return;
    }
    if (
      name === 'network_task_list' &&
      delayTaskList &&
      request.headers()['authorization'] === `Bearer ${fixture.c.token}`
    ) {
      await delay(400);
      await route.continue();
      return;
    }
    if (name !== 'network_task_complete') {
      await route.continue();
      return;
    }
    completeHeld += 1;
    await held;
    const body = JSON.parse(request.postData() ?? '{}') as RpcBody;
    await postJson(route, body, {
      room_id: fixture.roomId,
      root_message_id: fixture.rootId,
      status: 'completed',
      completed_at: String(Date.now()),
      completed_by: fixture.b.actorId,
    });
  });

  await page.locator('#task-dock .task-dock-complete').click();
  await page.locator('#task-complete-confirm').click();
  await expect.poll(() => completeHeld, { timeout: 15_000 }).toBeGreaterThan(0);

  // 先让 C 的 network_me 失败，确保遮罩真正绘制并卸载 RoomTaskDock；
  // 旧实例的 ref 冻结在 B，只有模块级代次能拦住晚到回写。
  await switchIdentityUnderMask(page, fixture.c.token);
  expect(identityCalls).toBeGreaterThan(0);
  failIdentity = false;
  await finishIdentitySwitch(page, fixture.c.name);
  await expandTaskDock(page);
  await expect(taskItem(page, fixture.rootId)).toHaveCount(1, { timeout: 15_000 });
  await page.waitForTimeout(300);

  const sampling = page.evaluate(async ({ rootId }) => {
    const read = () => {
      const item = document.querySelector(
        `#task-dock .task-dock-item[data-task-root="${rootId}"]`,
      );
      const count = document.querySelector('#task-dock-count')?.textContent?.trim() ?? '';
      const dock = document.querySelector('#task-dock');
      return { item: item ? 1 : 0, count, dock: dock ? 1 : 0 };
    };
    const samples: { item: number; count: string; dock: number }[] = [];
    for (let index = 0; index < 70; index += 1) {
      samples.push(read());
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    return samples;
  }, { rootId: fixture.rootId });

  const lateResponse = page.waitForResponse(
    (response) =>
      response.request().headers()['authorization'] === `Bearer ${fixture.b.token}` &&
      response.request().headers()['mcp-name'] === 'network_task_complete',
    { timeout: 15_000 },
  );
  await page.waitForTimeout(120);
  delayTaskList = true;
  releaseComplete();
  await lateResponse;
  const samples = await sampling;
  const badSamples = samples.filter(
    (sample) => sample.dock !== 1 || sample.item !== 1 || sample.count.startsWith('0'),
  );
  expect(badSamples, JSON.stringify(samples)).toEqual([]);
  await page.waitForTimeout(300);
  await expect(taskItem(page, fixture.rootId)).toHaveCount(1);

  const serverList = await callTool<{
    total_count: number;
    items: { root_message_id: string }[];
  }>(base, fixture.c.token, 'network_task_list', {
    room_id: fixture.roomId,
    status: 'open',
    limit: 10,
  });
  expect(serverList.total_count).toBe(1);
  expect(serverList.items.map((item) => item.root_message_id)).toContain(fixture.rootId);
  console.log(JSON.stringify({
    probe: 'late-task-complete',
    samples: samples.length,
    badSamples: badSamples.length,
    serverTotal: serverList.total_count,
    serverOpen: true,
  }));
});

test('切号后释放旧身份的 Trace 分页不并入新身份缓存', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createLateTaskRoom(base, 52);
  await login(page, base, fixture.b.token);
  await openRoom(page, base, fixture.b.token, fixture.roomId, fixture.roomTitle);
  await expandTaskDock(page);
  await openTaskTrace(page, fixture.rootId);
  await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(50, {
    timeout: 15_000,
  });
  await expect(page.locator('#task-trace-newer')).toBeVisible();
  await expect(page.locator('#task-trace-newer')).toBeEnabled();

  let releasePage: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    releasePage = resolve;
  });
  let heldPages = 0;
  let failIdentity = true;
  let identityCalls = 0;
  await page.route('**/mcp', async (route) => {
    const request = route.request();
    const name = request.headers()['mcp-name'];
    if (name === 'network_me' && request.headers()['authorization'] === `Bearer ${fixture.c.token}`) {
      identityCalls += 1;
      if (failIdentity) {
        await route.abort('failed');
        return;
      }
      await route.continue();
      return;
    }
    if (name !== 'network_task_trace') {
      await route.continue();
      return;
    }
    let body: RpcBody;
    try {
      body = JSON.parse(request.postData() ?? '{}') as RpcBody;
    } catch {
      await route.continue();
      return;
    }
    const cursor = body.params?.arguments?.cursor;
    if (!cursor || request.headers()['authorization'] !== `Bearer ${fixture.b.token}`) {
      await route.continue();
      return;
    }
    heldPages += 1;
    await held;
    await postJson(route, body, {
      root_message_id: fixture.rootId,
      items: [
        {
          message_id: 'probe-b-only',
          sender_id: fixture.b.actorId,
          sender_name: fixture.b.name,
          sender_kind: 'human',
          created_seq: '999999',
          created_at: String(Date.now()),
          preview: 'B 晚到分页标记',
          body_bytes: 8,
          recalled: false,
          role: 'member',
          reply_to: null,
          referenced_by: null,
          has_unavailable_reference: false,
        },
      ],
      next_cursor: null,
      prev_cursor: 'probe-prev',
      has_more_before: true,
      has_more_after: false,
      message_count: 51,
      focus_message_id: null,
      status: 'open',
      completed_at: null,
      completed_by: null,
      authorization: AUTHORIZATION,
    });
  });

  await page.locator('#task-trace-newer').click();
  await expect.poll(() => heldPages, { timeout: 15_000 }).toBeGreaterThan(0);

  // 强制遮罩可见：ChatDialogsMount 卸载并把 trace tokenRef 冻结在 B。
  await switchIdentityUnderMask(page, fixture.c.token);
  expect(identityCalls).toBeGreaterThan(0);
  failIdentity = false;
  await finishIdentitySwitch(page, fixture.c.name);
  // ChatPage 的 Trace 目标状态跨遮罩保留；恢复后 C 可能已自动重开抽屉。
  if ((await page.locator('#task-trace-drawer').count()) === 0) {
    await expandTaskDock(page);
    await openTaskTrace(page, fixture.rootId);
  }
  await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(50, {
    timeout: 15_000,
  });

  const lateResponse = page.waitForResponse(
    (response) =>
      response.request().headers()['authorization'] === `Bearer ${fixture.b.token}` &&
      response.request().headers()['mcp-name'] === 'network_task_trace',
    { timeout: 15_000 },
  );
  releasePage();
  await lateResponse;
  await page.waitForTimeout(800);

  // Trace 键不含 actor；B 的合成分页不能把 C 的 50 条变成 51 条。
  await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(50);
  await expect(page.locator('#task-trace-items')).not.toContainText('B 晚到分页标记');
  await expect(page.locator('.task-trace-meta').last()).toContainText('50 / 53 条已加载');

  const serverTrace = await callTool<{
    items: { message_id: string }[];
    message_count: number;
  }>(base, fixture.c.token, 'network_task_trace', {
    room_id: fixture.roomId,
    root_message_id: fixture.rootId,
    limit: 50,
  });
  expect(serverTrace.items).toHaveLength(50);
  expect(serverTrace.message_count).toBe(fixture.messageCount);
  expect(serverTrace.items.some((item) => item.message_id === 'probe-b-only')).toBe(false);
  console.log(JSON.stringify({
    probe: 'late-task-trace-page',
    localItems: 50,
    localCount: 53,
    markerPresent: false,
    serverItems: serverTrace.items.length,
    serverMessageCount: serverTrace.message_count,
    heldPages,
  }));
});

test('撤权后遮住旧视图、关闭预览并释放 object URL；晚到历史响应不复活', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  const taskBody = `REVOKE-PRIVATE-TASK ${crypto.randomUUID().slice(0, 8)}`;
  const taskSent = await callTool<{ message: { message_id: string } }>(
    base,
    fixture.tokenB,
    'network_message_send',
    {
      request_id: requestId('e2e_revoke_task'),
      client_message_id: requestId('e2e_revoke_task_client'),
      room_id: fixture.roomId,
      body: taskBody,
      invoke: [],
    },
  );
  const taskRootId = taskSent.message.message_id;
  await callTool(base, fixture.tokenB, 'network_task_mark', {
    request_id: requestId('e2e_revoke_mark'),
    room_id: fixture.roomId,
    message_id: taskRootId,
  });
  const outsiderToken = crypto.randomUUID();
  await callTool(base, outsiderToken, 'network_register', {
    request_id: requestId('e2e_reg'),
    kind: 'human',
    name: `旁观者 ${crypto.randomUUID().slice(0, 4)}`,
    device_id: `e2e-outsider-${crypto.randomUUID()}`,
  });

  let streamOpens = 0;
  let streamAborts = 0;
  page.on('request', (request) => {
    try {
      const body = JSON.parse(request.postData() ?? '{}') as { method?: string };
      if (body.method === 'subscriptions/listen') streamOpens += 1;
    } catch {
      // 非 JSON 请求忽略。
    }
  });
  page.on('requestfailed', (request) => {
    try {
      const body = JSON.parse(request.postData() ?? '{}') as { method?: string };
      if (body.method === 'subscriptions/listen') streamAborts += 1;
    } catch {
      // 同上。
    }
  });
  await page.route('**/mcp', async (route) => {
    const request = route.request();
    let body: RpcBody;
    try {
      body = JSON.parse(request.postData() ?? '{}') as RpcBody;
    } catch {
      await route.continue();
      return;
    }
    if (body.params?.name === 'network_room_file_list') {
      await postJson(route, body, {
        items: [
          {
            room_file_id: 'probe-file',
            file_id: 'probe-file',
            name: 'probe.txt',
            mime_type: 'text/plain',
            preview_kind: 'text',
            size: 12,
            preview_url: '/f/probe-file',
            download_url: '/f/probe-file',
            created_at: 1_700_000_000_000,
          },
        ],
        next_cursor: null,
        has_more: false,
      });
      return;
    }
    if (body.params?.name === 'network_history_list') {
      await delay(1_500);
      await postJson(route, body, {
        items: [],
        next_cursor: null,
        has_more: false,
        snapshot: '999',
        head_seq: '999',
        view: 'timeline',
        timeline_items: [syntheticMessage(fixture.roomId, 999, 'LATE-PRIVATE-CONTENT')],
        timeline_next_cursor: null,
        timeline_has_more: false,
        timeline_snapshot: '999',
        timeline_resume_cursor: 'late',
        authorization: AUTHORIZATION,
      });
      return;
    }
    await route.continue();
  });
  await page.route('**/f/probe-file', async (route) => {
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'preview secret' });
  });

  await login(page, base, fixture.tokenB);
  await openRoom(page, base, fixture.tokenB, fixture.roomId, fixture.roomTitle);
  await expect(page.locator('.file-item[data-file-id="probe-file"]')).toBeVisible({
    timeout: 10_000,
  });
  await page.locator('.file-item[data-file-id="probe-file"] .file-action').first().click();
  await expect(page.locator('#file-preview')).toBeVisible();
  await expect(page.locator('#file-preview-body')).toContainText('preview secret');
  // 先关闭预览弹窗，避免它拦截 dock/Trace 的点击；释放 object URL 的探针不受影响。
  await page.locator('#file-preview-close').click();
  await expect(page.locator('#file-preview')).toHaveCount(0);

  // 撤权前先让 Task dock 与 Trace 都持有旧身份的私有条目。
  await expandTaskDock(page);
  await expect(taskItem(page, taskRootId)).toHaveCount(1, { timeout: 15_000 });
  await openTaskTrace(page, taskRootId);
  await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(1, {
    timeout: 15_000,
  });
  await expect(page.locator('#task-trace-items')).toContainText(taskBody);

  const blobUrl = await page.evaluate(() => {
    const original = URL.revokeObjectURL.bind(URL);
    const revoked: string[] = [];
    (window as unknown as { __revokedObjectUrls: string[] }).__revokedObjectUrls = revoked;
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
      original(url);
    };
    const url = URL.createObjectURL(new Blob(['probe object']));
    const image = document.createElement('img');
    image.id = 'probe-object-url';
    image.src = url;
    document.body.append(image);
    return url;
  });

  // 长后台/撤权信号：先遮住旧私有视图，再重新鉴权。
  await page.evaluate((token) => {
    localStorage.setItem('agent-network-token', token);
    window.dispatchEvent(
      new StorageEvent('storage', { key: 'agent-network-token', newValue: token }),
    );
  }, outsiderToken);

  await expect(page.locator('#recovery-mask')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#messages')).toBeHidden();
  await expect(page.locator('#file-preview')).toHaveCount(0);
  // 旧身份的 Task/Trace 不能留在遮罩后的 DOM 或可见文本里。
  await expect(page.locator('#task-dock .task-dock-item')).toHaveCount(0);
  await expect(page.locator('#task-trace-items .task-trace-item')).toHaveCount(0);
  await expect(page.getByText(taskBody)).toHaveCount(0);
  const taskItemsAfterRevoke = await page.locator('#task-dock .task-dock-item').count();
  const traceItemsAfterRevoke = await page
    .locator('#task-trace-items .task-trace-item')
    .count();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { __revokedObjectUrls: string[] }).__revokedObjectUrls),
    )
    .toContain(blobUrl);
  await expect.poll(() => streamAborts, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __agentNetworkRecoveryHost?: {
                  cache: () => {
                    room: number;
                    roomTasks: number;
                    removedRoom: number;
                    removedRoomTasks: number;
                  };
                };
              }
            ).__agentNetworkRecoveryHost?.cache() ?? null,
        ),
      { timeout: 10_000 },
    )
    .toMatchObject({ roomTasks: 0 });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __agentNetworkRecoveryHost?: {
                  cache: () => { removedRoom: number; removedRoomTasks: number };
                };
              }
            ).__agentNetworkRecoveryHost?.cache().removedRoom ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __agentNetworkRecoveryHost?: {
                  cache: () => { removedRoom: number; removedRoomTasks: number };
                };
              }
            ).__agentNetworkRecoveryHost?.cache().removedRoomTasks ?? 0,
        ),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);
  expect(await page.locator('#messages').count()).toBe(0);
  expect(await page.getByText('LATE-PRIVATE-CONTENT').count()).toBe(0);
  const revokedUrls = await page.evaluate(
    () => (window as unknown as { __revokedObjectUrls: string[] }).__revokedObjectUrls,
  );
  console.log(JSON.stringify({
    probe: 'revoke-cleanup',
    masked: true,
    messagesCount: await page.locator('#messages').count(),
    previewCount: await page.locator('#file-preview').count(),
    revokedObjectUrls: revokedUrls.length,
    lateContentCount: await page.getByText('LATE-PRIVATE-CONTENT').count(),
    taskItemsAfterRevoke,
    traceItemsAfterRevoke,
    streamOpens,
    streamAborts,
  }));
});

test('同 actor 双标签并发发送不互相覆盖意图', async ({ context }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
  const first = await context.newPage();
  const second = await context.newPage();
  const sendRequests: { clientMessageId: string; requestId: string }[] = [];
  const statusRequests: string[][] = [];
  first.on('request', (request) => {
    if (!request.url().endsWith('/mcp') || request.method() !== 'POST') return;
    let body: RpcBody;
    try {
      body = JSON.parse(request.postData() ?? '{}') as RpcBody;
    } catch {
      return;
    }
    const args = body.params?.arguments ?? {};
    if (body.params?.name === 'network_message_send') {
      if (typeof args.client_message_id === 'string' && typeof args.request_id === 'string') {
        sendRequests.push({
          clientMessageId: args.client_message_id,
          requestId: args.request_id,
        });
      }
      return;
    }
    if (body.params?.name === 'network_message_send_status') {
      const ids = Array.isArray(args.client_message_ids)
        ? args.client_message_ids.filter((id): id is string => typeof id === 'string')
        : [];
      statusRequests.push(ids);
    }
  });
  await login(first, base, fixture.tokenB);
  await login(second, base, fixture.tokenB);
  await openRoom(first, base, fixture.tokenB, fixture.roomId, fixture.roomTitle);
  await openRoom(second, base, fixture.tokenB, fixture.roomId, fixture.roomTitle);

  await context.setOffline(true);
  await first.fill('#body', '双标签 A 离线意图');
  await first.press('#body', 'Enter');
  const rowA = first.locator('.msg-outbox', { hasText: '双标签 A 离线意图' });
  await expect(rowA).toBeVisible();
  const clientA = await rowA.getAttribute('data-client-message-id');
  expect(clientA).toBeTruthy();
  const storedA = await first.evaluate(
    ({ actorId, clientId }) => {
      const prefix = `agent-network-outbox:v1:${actorId}:i:`;
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith(prefix)) continue;
        const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as {
          intent?: { client_message_id?: string; request_id?: string };
        } | null;
        if (parsed?.intent?.client_message_id === clientId) return parsed.intent;
      }
      return null;
    },
    { actorId: fixture.actorB, clientId: clientA },
  );
  expect(storedA?.request_id).toBeTruthy();

  await second.fill('#body', '双标签 B 离线意图');
  await second.press('#body', 'Enter');
  await expect(second.locator('.msg-outbox', { hasText: '双标签 B 离线意图' })).toBeVisible();

  await expect(
    first.locator('.msg-outbox', { hasText: '双标签 B 离线意图' }),
  ).toBeVisible({ timeout: 10_000 });
  const journalCount = await first.evaluate((actorId) => {
    const prefix = `agent-network-outbox:v1:${actorId}:i:`;
    return Object.keys(localStorage).filter((key) => key.startsWith(prefix)).length;
  }, fixture.actorB);
  expect(journalCount).toBe(2);

  await context.setOffline(false);
  // 第一次在线重发返回可重试的 CONFLICT，第二次才成功：两次真实请求必须复用同一意图。
  let failFirstSend = true;
  await first.route('**/mcp', async (route) => {
    const request = route.request();
    let body: RpcBody;
    try {
      body = JSON.parse(request.postData() ?? '{}') as RpcBody;
    } catch {
      await route.continue();
      return;
    }
    const args = body.params?.arguments ?? {};
    if (
      body.params?.name !== 'network_message_send' ||
      args.client_message_id !== clientA
    ) {
      await route.continue();
      return;
    }
    if (failFirstSend) {
      failFirstSend = false;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: rpcError(body.id, 'probe send retryable', 'CONFLICT'),
      });
      return;
    }
    await route.continue();
  });
  await expect(rowA.locator('.outbox-retry')).toBeVisible({ timeout: 15_000 });
  await rowA.locator('.outbox-retry').click();
  await expect
    .poll(() => sendRequests.filter((request) => request.clientMessageId === clientA).length, {
      timeout: 15_000,
    })
    .toBe(1);
  await expect(rowA.locator('.outbox-retry')).toBeVisible({ timeout: 15_000 });
  await rowA.locator('.outbox-retry').click();
  await expect
    .poll(() => sendRequests.filter((request) => request.clientMessageId === clientA).length, {
      timeout: 15_000,
    })
    .toBe(2);
  expect(statusRequests.some((ids) => ids.includes(clientA ?? ''))).toBe(true);
  const attempts = sendRequests.filter((request) => request.clientMessageId === clientA);
  expect(attempts).toHaveLength(2);
  expect(new Set(attempts.map((request) => request.requestId)).size).toBe(1);
  expect(attempts.at(-1)?.requestId).toBe(storedA?.request_id);
  expect(attempts.at(-1)?.clientMessageId).toBe(storedA?.client_message_id);
  const outboxRows = await first.locator('.msg-outbox').count();
  console.log(JSON.stringify({
    probe: 'dual-tab-outbox',
    journalKeys: journalCount,
    outboxRows,
    sendAttempts: attempts.length,
    statusQueries: statusRequests.filter((ids) => ids.includes(clientA ?? '')).length,
    clientMessageIdReused: new Set(attempts.map((request) => request.clientMessageId)).size === 1,
    requestIdReused: new Set(attempts.map((request) => request.requestId)).size === 1,
  }));
});
