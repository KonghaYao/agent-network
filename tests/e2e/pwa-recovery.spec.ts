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

async function registerHuman(base: string, name: string): Promise<{ token: string; actorId: string }> {
  const token = crypto.randomUUID();
  const { actor_id } = await callTool<{ actor_id: string }>(base, token, 'network_register', {
    request_id: requestId('e2e_reg'),
    kind: 'human',
    name,
    device_id: `e2e-${crypto.randomUUID()}`,
  });
  return { token, actorId: actor_id };
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

test('撤回已显示消息时按锚点重读可见窗口', async ({ page }) => {
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

  const anchors: string[] = [];
  page.on('request', (request) => {
    if (!request.url().endsWith('/mcp') || request.method() !== 'POST') return;
    try {
      const body = JSON.parse(request.postData() ?? '{}') as RpcBody;
      if (body.params?.name !== 'network_history_list') return;
      const anchor = body.params.arguments?.anchor_message_id;
      if (typeof anchor === 'string') anchors.push(anchor);
    } catch {
      // 非 JSON 请求忽略。
    }
  });

  await login(page, base, fixture.tokenA);
  await openRoom(page, base, fixture.tokenA, fixture.roomId, fixture.roomTitle);
  await expect(page.locator('#messages')).toContainText('组件验收初始消息');

  await callTool(base, fixture.tokenB, 'network_message_recall', {
    request_id: requestId('e2e_recall'),
    message_id: target?.message_id,
  });
  await expect
    .poll(() => anchors.includes(target?.message_id ?? ''), { timeout: 10_000 })
    .toBe(true);
  await expect(page.locator('#messages')).toContainText('此消息已撤回', { timeout: 10_000 });
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

test('撤权后遮住旧视图、关闭预览并释放 object URL；晚到历史响应不复活', async ({ page }) => {
  const base = await baseUrl();
  const fixture = await createComponentRoom(base);
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
