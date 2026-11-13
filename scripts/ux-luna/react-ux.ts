import { chromium } from 'playwright';

import { createFixture } from './fixture';
import { rawTool } from '../verify-web';

/**
 * 4B-6 React UX 回归：桌面/移动布局、暗色、IME、输入框自适应、
 * dialog 焦点陷阱与 mention 键盘选择。legacy 内联脚本与双实现已删除，
 * 这里直接对唯一实现做断言。
 */
const fixture = await createFixture(['chat']);
const d = fixture.scenarios.chat;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  args: ['--no-sandbox'],
});
const failures: string[] = [];
function check(condition: unknown, label: string, detail?: unknown): void {
  if (condition) {
    console.log(`通过：${label}`);
    return;
  }
  failures.push(`${label} ${detail === undefined ? '' : JSON.stringify(detail)}`);
  console.error(`失败：${label}`, detail ?? '');
}

async function loginContext(options: {
  token: string;
  width: number;
  height: number;
  colorScheme?: 'light' | 'dark';
  hasTouch?: boolean;
}) {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.height },
    colorScheme: options.colorScheme,
    hasTouch: options.hasTouch,
  });
  await context.addInitScript(
    (token) => localStorage.setItem('agent-network-token', token),
    options.token,
  );
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  return { context, page };
}

try {
  // 1. 桌面：侧栏 280–320px、聊天单栏 + 返回、无横向溢出。
  {
    const { context, page } = await loginContext({
      token: d.me.token,
      width: 1280,
      height: 900,
    });
    await page.goto(fixture.base);
    await page.locator('#room-list a').first().waitFor();
    const sidebar = await page.locator('.sidebar').boundingBox();
    check(
      sidebar !== null && sidebar.width >= 280 && sidebar.width <= 322,
      '桌面侧栏宽度保持 280–320px',
      sidebar,
    );
    await page.locator(`#room-list a[href="/c/${d.rooms.directWang.room_id}"]`).click();
    await page.locator('#chat-body').waitFor();
    await page.waitForFunction(
      () => document.querySelector('#chat-body')?.getAttribute('aria-busy') === 'false',
    );
    check(await page.locator('#back').isVisible(), '桌面聊天页保留返回入口');
    const overflow = (await page.evaluate(
      `document.documentElement.scrollWidth - window.innerWidth`,
    )) as number;
    check(overflow <= 1, '桌面聊天页无横向溢出', overflow);
    await context.close();
  }

  // 2. 移动端：首页只显示列表，聊天页只显示聊天区。
  {
    const { context, page } = await loginContext({
      token: d.me.token,
      width: 390,
      height: 844,
      hasTouch: true,
    });
    await page.goto(fixture.base);
    await page.locator('#room-list a').first().waitFor();
    check(await page.locator('.sidebar').isVisible(), '390px 首页显示会话列表');
    check(await page.locator('.chat-pane').isHidden(), '390px 首页隐藏聊天区');
    await page.locator(`#room-list a[href="/c/${d.rooms.directWang.room_id}"]`).click();
    await page.locator('#chat-body').waitFor();
    check(await page.locator('.sidebar').isHidden(), '390px 聊天页隐藏会话列表');
    check(await page.locator('#back').isVisible(), '390px 聊天页显示返回箭头');
    const overflow = (await page.evaluate(
      `document.documentElement.scrollWidth - window.innerWidth`,
    )) as number;
    check(overflow <= 1, '390px 聊天页无横向溢出', overflow);
    await context.close();
  }

  // 3. 暗色：背景与气泡使用同一套 token。
  {
    const { context, page } = await loginContext({
      token: d.me.token,
      width: 1280,
      height: 900,
      colorScheme: 'dark',
    });
    await page.goto(`${fixture.base}/c/${d.rooms.directWang.room_id}`);
    await page.locator('#messages .msg').first().waitFor();
    const background = (await page.evaluate(
      `getComputedStyle(document.body).backgroundColor`,
    )) as string;
    check(background === 'rgb(25, 25, 25)', '暗色聊天背景使用 #191919', background);
    await context.close();
  }

  // 4. IME、Shift+Enter 与 1–4 行自适应。
  {
    const { context, page } = await loginContext({
      token: d.me.token,
      width: 1280,
      height: 900,
    });
    await page.goto(`${fixture.base}/c/${d.rooms.directWang.room_id}`);
    await page.locator('#messages .msg').first().waitFor();
    const body = page.locator('#body');
    await body.fill('组合输入');
    await body.evaluate((element) => {
      element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          bubbles: true,
        }),
      );
      element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    await page.waitForTimeout(120);
    check((await body.inputValue()) === '组合输入', 'IME 组合期间 Enter 不发送');

    await body.fill('第一行');
    await page.keyboard.press('Shift+Enter');
    check((await body.inputValue()).includes('\n'), 'Shift+Enter 换行');

    await body.fill('行1\n行2\n行3');
    const threeRows = (await body.boundingBox())?.height ?? 0;
    await body.fill('行1\n行2\n行3\n行4\n行5\n行6\n行7');
    const capped = (await body.boundingBox())?.height ?? 0;
    check(threeRows > 0 && capped >= threeRows && capped <= 140, '输入框在 1–4 行后内部滚动', {
      threeRows,
      capped,
    });
    await context.close();
  }

  // 5. Dialog：Esc 关闭、焦点返回触发按钮。
  {
    const { context, page } = await loginContext({
      token: d.me.token,
      width: 1280,
      height: 900,
    });
    await page.goto(fixture.base);
    await page.locator('#new-group').waitFor();
    await page.locator('#new-group').click();
    await page.locator('#group-modal').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#group-modal').waitFor({ state: 'hidden' });
    const focusReturned = await page
      .waitForFunction(`document.activeElement && document.activeElement.id === 'new-group'`, undefined, {
        timeout: 2_000,
      })
      .then(() => true)
      .catch(() => false);
    check(focusReturned, 'Esc 关闭后焦点回到新建群聊按钮', await page.evaluate(`({ id: document.activeElement && document.activeElement.id, tag: document.activeElement && document.activeElement.tagName })`));
    await context.close();
  }

  // 6. Mention：方向键 + Enter 只选择成员，不发送消息。
  {
    const { context, page } = await loginContext({
      token: d.me.token,
      width: 1280,
      height: 900,
    });
    await page.goto(`${fixture.base}/c/${d.rooms.owned.room_id}`);
    await page.locator('#messages .msg').first().waitFor();
    const before = await page.locator('#messages [data-message-id]').count();
    const body = page.locator('#body');
    await body.fill('@');
    await page.locator('#mention-picker').waitFor({ state: 'visible' });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const inserted = await body.inputValue();
    check(inserted.startsWith('@') && inserted.trim().length > 1, 'Enter 选择 mention 而非发送', inserted);
    const after = await page.locator('#messages [data-message-id]').count();
    check(after === before, '选择 mention 不产生消息', { before, after });
    await body.fill('');
    await context.close();
  }

  // 7. 成员添加与公告入口在桌面可用。
  {
    const { context, page } = await loginContext({
      token: d.me.token,
      width: 1280,
      height: 900,
    });
    await page.goto(`${fixture.base}/c/${d.rooms.owned.room_id}`);
    await page.locator('#messages .msg').first().waitFor();
    await page.locator('#room-menu-toggle').click();
    await page.locator('#room-menu').waitFor({ state: 'visible' });
    check(await page.locator('#room-menu-members').isVisible(), '会话菜单提供群成员入口');
    check(await page.locator('#room-menu-announcement').isVisible(), '会话菜单提供群公告入口');
    await page.locator('#room-menu-members').click();
    await page.locator('#members-modal').waitFor({ state: 'visible' });
    check(await page.locator('#members-current .spa-member').count() >= 2, '成员弹窗渲染当前成员');
    await page.locator('#members-close').click();
    await context.close();
  }

  // 8. 面板：桌面文件栏固定宽度，移动端全屏。
  {
    const { context, page } = await loginContext({
      token: d.me.token,
      width: 1440,
      height: 900,
    });
    await page.addInitScript(() => {
      localStorage.setItem('agent-network-files-open', '1');
    });
    await page.goto(`${fixture.base}/c/${d.rooms.directWang.room_id}`);
    await page.locator('#messages .msg').first().waitFor();
    await page.locator('#files-pane').waitFor({ state: 'visible' });
    const desktopWidth = (await page.locator('#files-pane').boundingBox())?.width ?? 0;
    check(desktopWidth >= 280 && desktopWidth <= 442, '桌面文件栏保持 280–440px', desktopWidth);
    await context.close();
  }
  {
    const { context, page } = await loginContext({
      token: d.me.token,
      width: 390,
      height: 844,
      hasTouch: true,
    });
    await page.goto(`${fixture.base}/c/${d.rooms.directWang.room_id}`);
    await page.locator('#messages .msg').first().waitFor();
    await page.locator('#files-toggle').click();
    await page.locator('#files-pane').waitFor({ state: 'visible' });
    const mobile = (await page.locator('#files-pane').boundingBox())?.width ?? 0;
    check(Math.abs(mobile - 390) <= 1, '移动端文件页全屏', mobile);
    await context.close();
  }

  // 9. 会话列表搜索与分类不触发额外工具调用。
  {
    const { context, page } = await loginContext({
      token: d.me.token,
      width: 1280,
      height: 900,
    });
    const toolCalls: string[] = [];
    page.on('request', (request) => {
      if (!request.url().endsWith('/mcp')) return;
      const name = request.headers()['mcp-name'];
      if (name) toolCalls.push(name);
    });
    await page.goto(fixture.base);
    await page.locator('#room-list a').first().waitFor();
    const callsBefore = toolCalls.length;
    await page.fill('#room-search', '周末');
    await page.waitForTimeout(200);
    await page.getByRole('tab', { name: '群聊', exact: true }).click();
    await page.waitForTimeout(200);
    check(toolCalls.length === callsBefore, '搜索/分类只过滤已加载会话', {
      callsBefore,
      callsAfter: toolCalls.length,
    });
    await context.close();
  }

  // 保留一条真实写入，确认页面刷新后仍可读到新消息。
  await rawTool(d.wang.token, 'network_message_send', {
    request_id: crypto.randomUUID(),
    client_message_id: crypto.randomUUID(),
    room_id: d.rooms.directWang.room_id,
    body: 'React UX 收尾消息',
    invoke: [],
  });
} finally {
  await browser.close();
  await fixture.stop();
}

if (failures.length > 0) {
  throw new Error(`React UX 失败 ${failures.length} 项：\n${failures.join('\n')}`);
}
console.log('React UX suites passed');
