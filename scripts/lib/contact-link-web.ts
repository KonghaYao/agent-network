/**
 * 好友邀请链接浏览器验收。
 *
 * A 在好友申请弹窗生成并复制链接；B 在全新浏览器上下文打开链接，
 * 预览有效后自动注册并兑换；无效链接不注册身份。A 的弹窗必须能看到
 * 新好友与已使用状态。token 只允许出现在剪贴板，不得进入 DOM。
 */

import type { Browser, BrowserContext, Page } from 'playwright';

import { check, checkEqual } from './harness';

interface ContactRow {
  actor_id: string;
  name: string;
  relation: 'active' | 'none';
}

interface ContactPage {
  items: ContactRow[];
}

export interface ContactLinkWebDeps {
  browser: Browser;
  base: string;
  ownerToken: string;
  allErrors: string[];
  rawTool: <T>(token: string, name: string, args: Record<string, unknown>) => Promise<T>;
}

const IGNORED_CONSOLE = ['Failed to load resource', 'net::ERR_'];

function watchPage(page: Page, allErrors: string[]): void {
  page.on('pageerror', (error) => {
    allErrors.push(`contact-link pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (IGNORED_CONSOLE.some((part) => text.includes(part))) return;
    allErrors.push(`contact-link console: ${text}`);
  });
}

async function waitForText(page: Page, selector: string, text: string): Promise<void> {
  await page.waitForFunction(
    ({ selector, text }) => {
      const element = document.querySelector(selector);
      return Boolean(element && (element.textContent ?? '').includes(text));
    },
    { selector, text },
    { timeout: 15_000 },
  );
}

async function makeOwnerContext(
  browser: Browser,
  base: string,
  ownerToken: string,
  allErrors: string[],
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript({
    content: `(() => {
      try { localStorage.setItem('agent-network-token', ${JSON.stringify(ownerToken)}); } catch (error) {}
    })();`,
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  watchPage(page, allErrors);
  return { context, page };
}

async function makeFreshContext(
  browser: Browser,
  allErrors: string[],
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  watchPage(page, allErrors);
  return { context, page };
}

async function activeContacts(
  rawTool: ContactLinkWebDeps['rawTool'],
  token: string,
): Promise<ContactRow[]> {
  const page = await rawTool<ContactPage>(token, 'network_contacts_list', { limit: 100 });
  return page.items.filter((item) => item.relation === 'active');
}

export async function runContactLinkWebAcceptance(deps: ContactLinkWebDeps): Promise<void> {
  const { browser, base, ownerToken, allErrors, rawTool } = deps;
  const owner = await rawTool<{ actor_id: string; name: string }>(ownerToken, 'network_me', {});
  const before = await activeContacts(rawTool, ownerToken);
  const beforeIds = new Set(before.map((item) => item.actor_id));

  const ownerPage = await makeOwnerContext(browser, base, ownerToken, allErrors);
  let friendUrl = '';
  let bToken = '';
  let bName = '';
  try {
    const page = ownerPage.page;
    await page.goto(`${base}/`);
    await page.locator('#contact-requests').waitFor();
    await page.waitForFunction(`(() => {
      const name = document.getElementById('account-name');
      return Boolean(name && name.textContent && name.textContent !== '未登录');
    })()`);
    await page.locator('#contact-requests').click();
    await page.locator('#contact-modal').waitFor({ state: 'visible' });
    await page.locator('#contact-tab-more').click();
    await page.locator('#contact-link-create').click();
    await waitForText(page, '#contact-link-status', '链接已生成');
    checkEqual(
      '好友链接生成后显示复制入口',
      await page.locator('#contact-link-copy').isVisible(),
      true,
    );
    await page.locator('#contact-link-copy').click();
    friendUrl = await page.evaluate<string>(`navigator.clipboard.readText()`);
    check(
      '复制内容为 PUBLIC_ORIGIN 下含 #friend= 的链接',
      typeof friendUrl === 'string' &&
        friendUrl.startsWith(`${base}/#friend=`) &&
        friendUrl.length > `${base}/#friend=`.length,
    );
    const fragmentToken = friendUrl.slice(friendUrl.indexOf('#friend=') + '#friend='.length);
    const domLeak = await page.evaluate<{ body: boolean; values: boolean }>(
      `(() => {
      const TOKEN = ${JSON.stringify(fragmentToken)};
      const body = document.body ? document.body.innerHTML : '';
      const values = Array.from(document.querySelectorAll('input, textarea'))
        .map(function (element) { return element.value || ''; });
      return { body: body.indexOf(TOKEN) >= 0, values: values.some(function (value) {
        return value.indexOf(TOKEN) >= 0;
      }) };
    })()`,
    );
    check('好友链接明文不写入 DOM 或输入框', !domLeak.body && !domLeak.values, domLeak);
    const linkListText = (await page.locator('#contact-link-list').textContent()) ?? '';
    check('好友链接列表显示待使用状态', linkListText.includes('待使用'), linkListText);
    check('好友链接列表不显示明文 token', !linkListText.includes('#friend='), linkListText);
    await page.locator('#contact-modal-close').click();
    await page.locator('#contact-modal').waitFor({ state: 'hidden' });

    // B 在全新无 token 上下文打开链接：预览有效后自动注册并兑换。
    const bContext = await makeFreshContext(browser, allErrors);
    try {
      const bPage = bContext.page;
      await bPage.goto(friendUrl);
      await waitForText(bPage, '#contact-link-banner', '已添加好友：');
      const bannerText = (await bPage.locator('#contact-link-banner').textContent()) ?? '';
      check('B 的提示包含 A 的名称', bannerText.includes(owner.name), bannerText);
      checkEqual('B 的成功提示可见', await bPage.locator('#contact-link-banner').isVisible(), true);
      checkEqual('B 打开后清除 #friend= fragment', new URL(bPage.url()).hash, '');
      bToken =
        (await bPage.evaluate<string | null>(`localStorage.getItem('agent-network-token')`)) ?? '';
      check('B 已获得独立身份', bToken.length > 0);
      const bContacts = await activeContacts(rawTool, bToken);
      check(
        'B 的联系人包含 A 且关系 active',
        bContacts.some((item) => item.actor_id === owner.actor_id),
        bContacts.map((item) => item.actor_id),
      );

      const after = await activeContacts(rawTool, ownerToken);
      const created = after.find((item) => !beforeIds.has(item.actor_id));
      check('兑换后 A 的联系人新增 B', Boolean(created), after.map((item) => item.actor_id));
      bName = created?.name ?? '';

      // A 重新打开弹窗：链接状态要反映兑换结果，弹窗不再重复好友列表。
      await page.locator('#contact-requests').click();
      await page.locator('#contact-modal').waitFor({ state: 'visible' });
      await page.locator('#contact-tab-more').click();
      checkEqual(
        '好友申请弹窗不显示我的好友区块',
        await page.locator('#contact-modal .contact-friends-panel').count(),
        0,
      );
      await waitForText(page, '#contact-link-list', '已使用');
      const usedLinkText = (await page.locator('#contact-link-list').textContent()) ?? '';
      check('A 看到链接已使用并显示兑换者名称', bName.length > 0 && usedLinkText.includes(bName), usedLinkText);
    } finally {
      await bContext.context.close();
    }

    // 撤销 UI：生成第二条链接后从列表撤销，复制入口同步隐藏。
    await page.locator('#contact-link-create').click();
    await waitForText(page, '#contact-link-status', '链接已生成');
    const pendingRow = page
      .locator('#contact-link-list .contact-link-item')
      .filter({ hasText: '待使用' })
      .first();
    await pendingRow.waitFor();
    await pendingRow.locator('button').click();
    await waitForText(page, '#contact-link-status', '已撤销好友链接');
    check(
      '撤销后列表显示已撤销',
      ((await page.locator('#contact-link-list').textContent()) ?? '').includes('已撤销'),
    );
    checkEqual('撤销当前链接后隐藏复制入口', await page.locator('#contact-link-copy').isHidden(), true);
  } finally {
    await ownerPage.context.close();
  }

  // 无效链接：不创建身份、不注册，只显示可读错误。
  const invalidContext = await makeFreshContext(browser, allErrors);
  try {
    const page = invalidContext.page;
    await page.goto(`${base}/#friend=invalid_contact_link_token`);
    await waitForText(page, '#contact-link-banner', '好友链接不可用');
    const bannerText = (await page.locator('#contact-link-banner').textContent()) ?? '';
    check('无效链接显示明确错误', bannerText.includes('无效') || bannerText.includes('不可用'), bannerText);
    checkEqual('无效链接错误提示可见', await page.locator('#contact-link-banner').isVisible(), true);
    const storage = await page.evaluate<{ token: string | null; identities: number }>(`(() => {
      const identityKeys = Object.keys(localStorage).filter(function (key) {
        return key.indexOf('agent-network-identity-v1:') === 0;
      });
      return {
        token: localStorage.getItem('agent-network-token'),
        identities: identityKeys.length
      };
    })()`);
    checkEqual('无效链接不自动注册替代身份', storage.token, null);
    checkEqual('无效链接不写本机身份注册表', storage.identities, 0);
    checkEqual('无效链接也清除 fragment', new URL(page.url()).hash, '');
  } finally {
    await invalidContext.context.close();
  }
}
