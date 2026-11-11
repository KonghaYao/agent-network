/** Focused browser acceptance for username search → ID confirmation → request → accept. */
import assert from 'node:assert/strict';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

import { makeContext, rawTool, startServer } from './verify-web';

interface Actor {
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
}

interface ContactRequestPage {
  items: {
    contact_request_id: string;
    from_actor: Actor;
    to_actor: Actor;
    message: string;
    status: string;
  }[];
}

interface ContactPage {
  items: { actor_id: string; relation: 'active' | 'none' }[];
}

interface AgentCreateResult {
  actor_id: string;
  name: string;
  token: string;
}

interface RoomCreateResult {
  room: { room_id: string };
}

const id = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
let passed = 0;
function pass(label: string): void {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function waitIdentity(page: Page, actorId: string): Promise<void> {
  await page.waitForFunction(
    `(function () { return Boolean(identity && identity.actor_id === ${JSON.stringify(actorId)}); })()`,
  );
}

const server = await startServer();
process.env.AGENTNET_URL = server.base;
let browser: Browser | null = null;
const contexts: BrowserContext[] = [];
const browserErrors: string[] = [];

try {
  const senderToken = crypto.randomUUID();
  const targetAToken = crypto.randomUUID();
  const targetBToken = crypto.randomUUID();
  const sender = await rawTool<Actor>(senderToken, 'network_register', {
    request_id: id('sender'),
    kind: 'human',
    name: '搜索邀请发起者',
  });
  const sameName = '同名好友搜索专项';
  const targetA = await rawTool<Actor>(targetAToken, 'network_register', {
    request_id: id('target_a'),
    kind: 'human',
    name: sameName,
  });
  const targetB = await rawTool<Actor>(targetBToken, 'network_register', {
    request_id: id('target_b'),
    kind: 'human',
    name: sameName,
  });

  // 搜索归一化：名称包含空格与拉丁字母，用于验证全角/半角与空白折叠。
  const normalizedToken = crypto.randomUUID();
  const normalizedName = '搜索 归一化 AB12';
  const normalizedTarget = await rawTool<Actor>(normalizedToken, 'network_register', {
    request_id: id('normalized'),
    kind: 'human',
    name: normalizedName,
  });

  // 全角名称：名称侧不做 NFKC，同形全角查询词必须保持修复前的命中行为。
  const fullWidthToken = crypto.randomUUID();
  const fullWidthName = '全角同形搜索 ＡＢＣ１２３';
  const fullWidthTarget = await rawTool<Actor>(fullWidthToken, 'network_register', {
    request_id: id('fullwidth'),
    kind: 'human',
    name: fullWidthName,
  });

  // Agent 可见性：独立 Agent 未认领、未共享房间时不可搜；加入同一群后可见。
  const independentAgentToken = crypto.randomUUID();
  const independentAgentName = '共享房间可见 Agent';
  const independentAgent = await rawTool<Actor>(independentAgentToken, 'network_register', {
    request_id: id('independent_agent'),
    kind: 'agent',
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
    name: independentAgentName,
  });

  // 由发送者管理的 Agent 无需共享房间即可被搜索；归档后必须消失。
  const managedAgentName = '管理可见 Agent';
  const managedAgent = await rawTool<AgentCreateResult>(senderToken, 'network_agent_create', {
    request_id: id('managed_agent'),
    name: managedAgentName,
  });

  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  });

  const senderView = await makeContext(
    browser,
    senderToken,
    { width: 1280, height: 800 },
    browserErrors,
  );
  contexts.push(senderView.context);
  await senderView.page.goto(server.base);
  await waitIdentity(senderView.page, sender.actor_id);
  await senderView.page.locator('#contact-requests').click();
  await senderView.page.locator('#contact-modal').waitFor({ state: 'visible' });
  assert.equal(await senderView.page.locator('#contact-modal-title').textContent(), '添加好友');
  pass('添加好友入口以用户名搜索为主路径');

  assert.equal(await senderView.page.locator('#contact-segments').getAttribute('role'), 'tablist');
  assert.equal(await senderView.page.locator('#contact-tab-search').getAttribute('aria-selected'), 'true');
  assert.equal(await senderView.page.locator('#contact-tab-requests').getAttribute('aria-selected'), 'false');
  assert.equal(await senderView.page.locator('#contact-tab-more').getAttribute('aria-selected'), 'false');
  assert.equal(await senderView.page.locator('#contact-panel-search').isVisible(), true);
  assert.equal(await senderView.page.locator('#contact-panel-requests').isVisible(), false);
  assert.equal(await senderView.page.locator('#contact-panel-more').isVisible(), false);
  assert.equal(await senderView.page.locator('#contact-modal .contact-columns').count(), 0);
  pass('添加好友默认展示搜索分段，申请与链接分段隐藏');

  await senderView.page.locator('#contact-tab-requests').click();
  assert.equal(await senderView.page.locator('#contact-tab-requests').getAttribute('aria-selected'), 'true');
  assert.equal(await senderView.page.locator('#contact-panel-requests').isVisible(), true);
  assert.equal(await senderView.page.locator('#contact-panel-search').isVisible(), false);
  await senderView.page.locator('#contact-tab-search').click();
  assert.equal(await senderView.page.locator('#contact-panel-search').isVisible(), true);
  pass('点击分段只显示对应内容');

  await senderView.page.locator('#contact-tab-search').focus();
  await senderView.page.keyboard.press('ArrowRight');
  assert.equal(await senderView.page.locator('#contact-tab-requests').getAttribute('aria-selected'), 'true');
  assert.equal(
    await senderView.page.evaluate(`document.activeElement && document.activeElement.id`),
    'contact-tab-requests',
  );
  await senderView.page.keyboard.press('End');
  assert.equal(await senderView.page.locator('#contact-tab-more').getAttribute('aria-selected'), 'true');
  await senderView.page.keyboard.press('ArrowLeft');
  assert.equal(await senderView.page.locator('#contact-tab-requests').getAttribute('aria-selected'), 'true');
  await senderView.page.keyboard.press('Home');
  assert.equal(await senderView.page.locator('#contact-tab-search').getAttribute('aria-selected'), 'true');
  assert.deepEqual(
    await senderView.page.evaluate(`Array.from(document.querySelectorAll('#contact-segments [data-contact-tab]')).map(function (tab) { return tab.tabIndex; })`),
    [0, -1, -1],
  );
  await senderView.page.locator('#contact-tab-requests').focus();
  await senderView.page.keyboard.press('Enter');
  assert.equal(await senderView.page.locator('#contact-tab-requests').getAttribute('aria-selected'), 'true');
  await senderView.page.locator('#contact-tab-search').click();
  pass('分段支持方向键/Home/End/Enter 与 roving tabindex');

  async function runSearch(query: string): Promise<void> {
    await senderView.page.locator('#contact-search-input').fill(query);
    await senderView.page.locator('#contact-search-submit').click();
  }
  async function waitForSearchId(actorId: string): Promise<void> {
    await senderView.page.waitForFunction(
      `(function () {
        return Array.from(document.querySelectorAll('#contact-search-results .contact-search-item'))
          .some(function (row) { return row.textContent.includes(${JSON.stringify(actorId)}); });
      })()`,
    );
  }
  async function waitForSearchEmpty(): Promise<void> {
    await senderView.page.waitForFunction(
      `document.getElementById('contact-search-status')?.textContent === '没有找到匹配的用户。'`,
    );
  }
  async function countSearchEmptyText(): Promise<number> {
    return senderView.page.evaluate(
      `(function () {
        const panel = document.getElementById('contact-panel-search');
        const text = panel ? panel.textContent || '' : '';
        return text.split('没有找到匹配的用户。').length - 1;
      })()`,
    );
  }

  await runSearch(normalizedName);
  await waitForSearchId(normalizedTarget.actor_id);
  assert.equal(
    await senderView.page.locator('#contact-search-results .contact-search-item').count(),
    1,
  );
  assert.equal(await countSearchEmptyText(), 0);
  pass('能搜到已设置用户名的用户');

  // 全角空格/字母、缺少空格、连续空格与大小写都应命中同一人类。
  await runSearch('搜索　归一化　ＡＢ１２');
  await waitForSearchId(normalizedTarget.actor_id);
  await runSearch('搜索归一化AB12');
  await waitForSearchId(normalizedTarget.actor_id);
  await runSearch('搜索  归一化   AB12');
  await waitForSearchId(normalizedTarget.actor_id);
  await runSearch('ab12');
  await waitForSearchId(normalizedTarget.actor_id);
  pass('搜索折叠全角/半角、空白与 ASCII 大小写');

  // 名称存储为全角时，同形全角查询词必须仍能命中（名称侧没有 NFKC）。
  await runSearch(fullWidthName);
  await waitForSearchId(fullWidthTarget.actor_id);
  assert.equal(
    await senderView.page.locator('#contact-search-results .contact-search-item').count(),
    1,
  );
  await runSearch('ＡＢＣ１２３');
  await waitForSearchId(fullWidthTarget.actor_id);
  assert.equal(
    await senderView.page.locator('#contact-search-results .contact-search-item').count(),
    1,
  );
  pass('全角名称可用同形全角查询词搜到且无重复结果');

  await runSearch('不存在的人-xyz');
  await waitForSearchEmpty();
  assert.equal(
    await senderView.page.locator('#contact-search-status').textContent(),
    '没有找到匹配的用户。',
  );
  assert.equal(await countSearchEmptyText(), 1);
  pass('搜索不到时展示空态且只出现一次');

  await runSearch(managedAgentName);
  await waitForSearchId(managedAgent.actor_id);
  assert.equal(
    await senderView.page.locator('#contact-search-results .contact-search-kind').textContent(),
    'Agent',
  );
  pass('调用者管理的 Agent 可被搜索并标注类型');

  await runSearch(independentAgentName);
  await waitForSearchEmpty();
  const directSearch = await rawTool<{ items: { actor: Actor }[] }>(
    targetBToken,
    'network_contact_search',
    { query: independentAgentName, limit: 20 },
  );
  assert.equal(directSearch.items.length, 0);
  pass('未共享房间且非管理的 Agent 不会被全局枚举');

  const sharedRoom = await rawTool<RoomCreateResult>(senderToken, 'network_room_create', {
    request_id: id('shared_agent_room'),
    kind: 'group',
    title: '搜索可见性群',
    members: [independentAgent.actor_id],
  });
  assert.ok(sharedRoom.room.room_id);
  await runSearch(independentAgentName);
  await waitForSearchId(independentAgent.actor_id);
  pass('共享活跃房间的 Agent 可按名称搜到');

  await rawTool(senderToken, 'network_agent_archive', {
    request_id: id('archive_agent'),
    actor_id: managedAgent.actor_id,
  });
  await runSearch(managedAgentName);
  await waitForSearchEmpty();
  await rawTool(senderToken, 'network_agent_unarchive', {
    request_id: id('unarchive_agent'),
    actor_id: managedAgent.actor_id,
  });
  await runSearch(managedAgentName);
  await waitForSearchId(managedAgent.actor_id);
  pass('归档 Agent 不出现在搜索结果，取消归档后恢复');

  await senderView.page.locator('#contact-search-input').fill('好友搜索专项');
  await senderView.page.locator('#contact-search-submit').click();
  await senderView.page.waitForFunction(
    `(function () { return document.querySelectorAll('#contact-search-results .contact-search-item').length === 2; })()`,
  );
  await senderView.page.locator('#contact-tab-requests').click();
  assert.equal(await senderView.page.locator('#contact-panel-search').isVisible(), false);
  await senderView.page.locator('#contact-tab-search').click();
  assert.equal(
    await senderView.page.locator('#contact-search-input').inputValue(),
    '好友搜索专项',
  );
  assert.equal(
    await senderView.page.locator('#contact-search-results .contact-search-item').count(),
    2,
  );
  pass('切换分段保留搜索输入与结果');
  const rows = senderView.page.locator('#contact-search-results .contact-search-item');
  assert.equal(await rows.count(), 2);
  const resultIds = await rows.locator('.contact-search-id').allTextContents();
  assert.deepEqual(new Set(resultIds), new Set([targetA.actor_id, targetB.actor_id]));
  pass('同名用户名搜索结果展示各自完整 actor_id');

  const selectedRow = rows.filter({ hasText: targetA.actor_id });
  await selectedRow.getByRole('button', { name: '核对 ID' }).click();
  assert.equal(
    await senderView.page.locator('#contact-search-confirm-id').textContent(),
    targetA.actor_id,
  );
  assert.equal(await senderView.page.locator('#contact-search-confirm').isVisible(), true);
  pass('发送前必须在确认区核对目标 ID');

  await senderView.page.locator('#contact-search-message').fill('搜索专项邀请');
  await senderView.page.locator('#contact-search-send').click();
  await senderView.page.waitForFunction(
    `document.getElementById('contact-search-status').textContent.includes('等待对方同意')`,
  );
  const pending = await rawTool<ContactRequestPage>(
    targetAToken,
    'network_contact_requests_list',
    { direction: 'incoming', status: 'pending', limit: 50 },
  );
  const request = pending.items.find((item) => item.from_actor.actor_id === sender.actor_id);
  assert.equal(request?.to_actor.actor_id, targetA.actor_id);
  assert.equal(request?.message, '搜索专项邀请');
  const untouched = await rawTool<ContactRequestPage>(
    targetBToken,
    'network_contact_requests_list',
    { direction: 'incoming', status: 'pending', limit: 50 },
  );
  assert.equal(untouched.items.length, 0);
  pass('邀请只发送给已确认的同名 ID');

  const receiverView = await makeContext(
    browser,
    targetAToken,
    { width: 1000, height: 760 },
    browserErrors,
  );
  contexts.push(receiverView.context);
  await receiverView.page.goto(server.base);
  await waitIdentity(receiverView.page, targetA.actor_id);
  await receiverView.page.waitForFunction(
    `(function () {
      const badge = document.getElementById('contact-requests-badge');
      return Boolean(badge && !badge.hidden && badge.textContent === '1');
    })()`,
  );
  await receiverView.page.locator('#contact-requests').click();
  await receiverView.page.locator('#contact-modal').waitFor({ state: 'visible' });
  await receiverView.page.locator('#contact-tab-requests').click();
  const incomingRow = receiverView.page
    .locator('#contact-request-list .contact-request-item')
    .filter({ hasText: '搜索专项邀请' });
  await incomingRow.getByRole('button', { name: '接受' }).click();
  await receiverView.page.waitForFunction(
    `document.getElementById('contact-request-status').textContent.includes('已接受好友申请')`,
  );
  pass('被邀请方在待处理申请中明确接受');

  await senderView.page.locator('#contact-search-submit').click();
  await senderView.page.waitForFunction(
    `(function () {
      return Array.from(document.querySelectorAll('#contact-search-results .contact-search-item'))
        .some(function (row) {
          const code = row.querySelector('.contact-search-id');
          const state = row.querySelector('.contact-search-state');
          return code && code.textContent === ${JSON.stringify(targetA.actor_id)} &&
            state && state.textContent === '已是好友';
        });
    })()`,
  );
  assert.equal(
    await rows
      .filter({ hasText: targetB.actor_id })
      .getByRole('button', { name: '核对 ID' })
      .isVisible(),
    true,
  );
  const contacts = await rawTool<ContactPage>(senderToken, 'network_contacts_list', { limit: 100 });
  assert.equal(
    contacts.items.find((item) => item.actor_id === targetA.actor_id)?.relation,
    'active',
  );
  assert.equal(contacts.items.some((item) => item.actor_id === targetB.actor_id), false);
  pass('接受后仅选中 ID 完成添加并显示已是好友');

  const mobileView = await makeContext(
    browser,
    senderToken,
    { width: 390, height: 844 },
    browserErrors,
    true,
    false,
    { hasTouch: true },
  );
  contexts.push(mobileView.context);
  await mobileView.page.goto(server.base);
  await waitIdentity(mobileView.page, sender.actor_id);
  await mobileView.page.locator('#contact-requests').click();
  await mobileView.page.locator('#contact-modal').waitFor({ state: 'visible' });
  const mobileLayout = await mobileView.page.evaluate(() => {
    const segments = document.getElementById('contact-segments');
    const tabs = Array.from(document.querySelectorAll('#contact-segments [data-contact-tab]'));
    const panels = ['contact-panel-search', 'contact-panel-requests', 'contact-panel-more'].map(
      (id) => document.getElementById(id),
    );
    const segmentBox = segments?.getBoundingClientRect();
    const tabBoxes = tabs.map((tab) => tab.getBoundingClientRect());
    return {
      fits: document.documentElement.scrollWidth <= window.innerWidth,
      tablistRole: segments?.getAttribute('role'),
      tabCount: tabs.length,
      visiblePanels: panels.filter((panel) => panel && !panel.hidden).length,
      segmentLeft: segmentBox?.left ?? -1,
      segmentRight: segmentBox?.right ?? Number.POSITIVE_INFINITY,
      labels: tabs.map((tab) => tab.firstChild?.textContent?.trim() ?? ''),
      tabsFit: tabBoxes.every(
        (box) => box.left >= -0.5 && box.right <= window.innerWidth + 0.5,
      ),
      tabsOverflow: tabs.some((tab) => tab.scrollWidth > tab.clientWidth + 1),
      width: window.innerWidth,
    };
  });
  assert.equal(mobileLayout.fits, true);
  assert.equal(mobileLayout.tablistRole, 'tablist');
  assert.equal(mobileLayout.tabCount, 3);
  assert.equal(mobileLayout.visiblePanels, 1);
  assert.equal(mobileLayout.segmentLeft >= 0, true);
  assert.equal(mobileLayout.segmentRight <= mobileLayout.width + 1, true);
  assert.equal(mobileLayout.tabsFit, true);
  assert.equal(mobileLayout.tabsOverflow, false);
  assert.deepEqual(mobileLayout.labels, ['搜索添加', '好友申请', '链接与设置']);

  await mobileView.page.locator('#contact-tab-requests').click();
  assert.equal(await mobileView.page.locator('#contact-panel-requests').isVisible(), true);
  assert.equal(await mobileView.page.locator('#contact-panel-search').isVisible(), false);
  await mobileView.page.locator('#contact-tab-more').click();
  assert.equal(await mobileView.page.locator('.contact-link-panel').isVisible(), true);
  assert.equal(await mobileView.page.locator('.contact-policy').isVisible(), true);
  await mobileView.page.locator('#contact-tab-search').click();
  await mobileView.page.locator('#contact-search-input').fill('移动端保留');
  await mobileView.page.locator('#contact-tab-more').click();
  await mobileView.page.locator('#contact-tab-search').click();
  assert.equal(await mobileView.page.locator('#contact-search-input').inputValue(), '移动端保留');
  assert.equal(
    await mobileView.page.evaluate(`document.documentElement.scrollWidth <= window.innerWidth`),
    true,
  );
  pass('390px 顶部分段切换保留状态且不横向溢出');

  const database = new Database(join(server.dataDir, 'agent-network.sqlite'));
  try {
    const createdAt = Date.now();
    database.transaction(() => {
      for (let index = 0; index < 51; index += 1) {
        const actorId = `usr_contact_bulk_${index}`;
        const pair = [actorId, targetA.actor_id].sort().join('|');
        database.prepare(
          `INSERT INTO actors (actor_id, kind, agent_session_id, name, metadata,
                               inbox_head_seq, inbox_min_seq, pending_count, created_at, updated_at)
           VALUES (?, 'human', NULL, ?, '{}', 0, 0, 0, ?, ?)`,
        ).run(actorId, `批量申请 ${index}`, createdAt, createdAt);
        database.prepare(
          `INSERT INTO contact_requests
             (contact_request_id, pair_key, from_actor_id, to_actor_id, message, status,
              auto_accepted, created_at, updated_at, expires_at)
           VALUES (?, ?, ?, ?, '', 'pending', 0, ?, ?, ?)`,
        ).run(`creq_bulk_${index}`, pair, actorId, targetA.actor_id,
          createdAt + index, createdAt + index, createdAt + 60_000);
      }
    })();

    await receiverView.page.reload();
    await waitIdentity(receiverView.page, targetA.actor_id);
    await receiverView.page.waitForFunction(
      `document.getElementById('contact-requests-badge')?.textContent === '50+'`,
    );
    await receiverView.page.locator('#contact-requests').click();
    await receiverView.page.locator('#contact-tab-requests').click();
    await receiverView.page.locator('#contact-request-more').waitFor({ state: 'visible' });
    assert.equal(await receiverView.page.locator('#contact-request-list .contact-request-item').count(), 50);
    await receiverView.page.locator('#contact-request-more').click();
    await receiverView.page.waitForFunction(
      `document.querySelectorAll('#contact-request-list .contact-request-item').length === 51`,
    );
    assert.equal(await receiverView.page.locator('#contact-request-more').isVisible(), false);
    await receiverView.page.locator('#contact-request-list .contact-request-item')
      .filter({ hasText: '批量申请 0' }).getByRole('button', { name: '接受' }).click();
    await receiverView.page.waitForFunction(
      `document.getElementById('contact-request-status')?.textContent?.includes('已接受好友申请')`,
    );
    assert.equal(
      (database.prepare("SELECT status FROM contact_requests WHERE contact_request_id = 'creq_bulk_0'")
        .get() as { status: string }).status,
      'accepted',
    );
    pass('超过 50 条申请可翻页处理，角标显示 50+');
  } finally {
    database.close();
  }

  assert.deepEqual(browserErrors, []);
  pass('专项流程没有未捕获页面错误');
  console.log(`\n好友搜索网页专项通过: ${passed} 项`);
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await server.stop();
}
