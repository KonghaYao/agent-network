/** Focused browser acceptance for username search → ID confirmation → request → accept. */
import assert from 'node:assert/strict';
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

  await senderView.page.locator('#contact-search-input').fill('好友搜索专项');
  await senderView.page.locator('#contact-search-submit').click();
  await senderView.page.waitForFunction(
    `(function () { return document.querySelectorAll('#contact-search-results .contact-search-item').length === 2; })()`,
  );
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
    const selectors = [
      '.contact-search-panel',
      '.contact-requests-panel',
      '.contact-link-panel',
      '.contact-policy',
    ];
    const boxes = selectors.map((selector) =>
      document.querySelector(selector)?.getBoundingClientRect(),
    );
    return {
      fits: document.documentElement.scrollWidth <= window.innerWidth,
      tops: boxes.map((box) => box?.top ?? -1),
      lefts: boxes.map((box) => box?.left ?? -1),
      rights: boxes.map((box) => box?.right ?? Number.POSITIVE_INFINITY),
      width: window.innerWidth,
    };
  });
  assert.equal(mobileLayout.fits, true);
  assert.equal(mobileLayout.tops.every((top, index, all) => index === 0 || top > all[index - 1]!), true);
  assert.equal(mobileLayout.lefts.every((left) => left >= 0), true);
  assert.equal(mobileLayout.rights.every((right) => right <= mobileLayout.width + 1), true);
  pass('390px 按搜索/申请/链接/策略单列排列且不溢出');

  assert.deepEqual(browserErrors, []);
  pass('专项流程没有未捕获页面错误');
  console.log(`\n好友搜索网页专项通过: ${passed} 项`);
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await server.stop();
}
