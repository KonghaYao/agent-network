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
