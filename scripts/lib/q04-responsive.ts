/**
 * Q04 三档视口/主题、键盘、触摸与中文输入法验收，以及空/加载失败状态。
 *
 * 截图只包含合成测试数据；不使用凭据、真实消息或外部系统。
 */

import type { Browser, Page } from 'playwright';

import {
  check,
  checkEqual,
  makeContext,
  newRequestId,
  noHorizontalOverflow,
  rawTool,
  roomLink,
  screenshot,
  sleep,
  waitMessageText,
  waitRoom,
  type Actor,
} from './q04-harness';
import type { Q04State } from './q04-fixture';

async function openRoomAt(
  browser: Browser,
  state: Q04State,
  viewport: { width: number; height: number },
  colorScheme: 'light' | 'dark',
  options: { hasTouch?: boolean; isMobile?: boolean } = {},
): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await makeContext(browser, state.tokens.u1, viewport, state.errors, {
    colorScheme,
    hasTouch: options.hasTouch,
    isMobile: options.isMobile,
  });
  await ctx.page.goto(`${state.base}/c/${state.rooms.directU1U3}`);
  await waitRoom(ctx.page, state.rooms.directU1U3, state.actors.u3.name);
  return { page: ctx.page, close: () => ctx.context.close() };
}

export async function runResponsiveAcceptance(state: Q04State, browser: Browser): Promise<void> {
  console.log('· Q04 响应式/主题/键盘/触摸/输入法');
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 768, height: 1024 },
    { width: 390, height: 844 },
  ]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const view = await openRoomAt(browser, state, viewport, colorScheme, {
        hasTouch: viewport.width < 760,
        isMobile: viewport.width < 760,
      });
      try {
        await noHorizontalOverflow(
          view.page,
          `${viewport.width}x${viewport.height} ${colorScheme}`,
        );
        const layout = (await view.page.evaluate(`(() => {
          const sidebar = document.querySelector('.sidebar');
          const chat = document.querySelector('.chat-pane:not(.empty-pane)');
          const back = document.getElementById('back');
          const body = document.body;
          const chatStyle = chat ? getComputedStyle(chat) : null;
          return {
            bodyClass: body.className,
            sidebarVisible: Boolean(sidebar && getComputedStyle(sidebar).display !== 'none' && sidebar.getBoundingClientRect().width > 0),
            chatVisible: Boolean(chat && getComputedStyle(chat).display !== 'none' && chat.getBoundingClientRect().width > 0),
            backVisible: Boolean(back && getComputedStyle(back).display !== 'none'),
            chatBg: chatStyle ? chatStyle.backgroundColor : '',
            darkMedia: matchMedia('(prefers-color-scheme: dark)').matches
          };
        })()`)) as {
          bodyClass: string;
          sidebarVisible: boolean;
          chatVisible: boolean;
          backVisible: boolean;
          chatBg: string;
          darkMedia: boolean;
        };
        check(
          `${viewport.width}x${viewport.height} 聊天区可见`,
          layout.chatVisible,
          layout,
        );
        checkEqual(`${viewport.width}x${viewport.height} 暗色媒体查询`, layout.darkMedia, colorScheme === 'dark');
        if (viewport.width < 760) {
          check(`${viewport.width} 单栏隐藏侧栏`, !layout.sidebarVisible, layout);
          check(`${viewport.width} 显示返回箭头`, layout.backVisible, layout);
          checkEqual(`${viewport.width} body 为 page-room`, layout.bodyClass.includes('page-room'), true);
        } else {
          check(`${viewport.width} 桌面/平板双栏`, layout.sidebarVisible && layout.chatVisible, layout);
        }
        if (colorScheme === 'dark') {
          const match = layout.chatBg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/u);
          check(
            `${viewport.width} 暗色聊天背景生效`,
            Boolean(match) && Number(match![1]) + Number(match![2]) + Number(match![3]) < 220,
            layout.chatBg,
          );
        }
        await screenshot(
          view.page,
          `q04-chat-${viewport.width}-${viewport.height}-${colorScheme}`,
        );
      } finally {
        await view.close();
      }
    }
  }

  // 键盘：Tab 可达、Esc 关闭弹窗、Shift+Enter 换行、Enter 发送。
  const keyboard = await openRoomAt(browser, state, { width: 1280, height: 900 }, 'light');
  try {
    const page = keyboard.page;
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Tab');
    const focusedTag = (await page.evaluate(`document.activeElement ? document.activeElement.tagName : ''`)) as string;
    check('Tab 可聚焦交互控件', ['BUTTON', 'A', 'INPUT'].includes(focusedTag), focusedTag);

    await page.locator('#new-group').click();
    await page.locator('#group-modal').waitFor({ state: 'visible' });
    await page.keyboard.press('Escape');
    await page.locator('#group-modal').waitFor({ state: 'hidden' });
    check('Esc 关闭建群弹窗', true);
    await page.locator('#new-group').click();
    await page.locator('#group-modal').waitFor({ state: 'visible' });
    await page.locator('#group-modal').click({ position: { x: 2, y: 2 } });
    await page.locator('#group-modal').waitFor({ state: 'hidden' });
    check('点击遮罩关闭建群弹窗', true);

    await page.locator('#body').focus();
    await page.keyboard.type('Q04 键盘第一行');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Q04 键盘第二行');
    const beforeEnter = await page.locator('#body').inputValue();
    check('Shift+Enter 只换行不发送', beforeEnter.includes('\n'), beforeEnter);
    await page.keyboard.press('Enter');
    await waitMessageText(page, 'Q04 键盘第一行');
    await page.waitForFunction(`document.querySelectorAll('#messages .msg-outbox').length === 0`);
    check('Enter 发送多行消息', true);
  } finally {
    await keyboard.close();
  }

  // 中文输入法：组合期间 Enter 不提交；组合结束后的短暂 Enter 守卫；之后 Enter 才发送。
  const ime = await openRoomAt(browser, state, { width: 1280, height: 900 }, 'light');
  try {
    const page = ime.page;
    const before = (await page.locator('#messages .msg').count()) as number;
    await page.fill('#body', 'Q04 中文输入');
    const sentDuringComposition = (await page.evaluate(`(() => {
      const body = document.getElementById('body');
      body.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const enter = new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true, isComposing: true
      });
      Object.defineProperty(enter, 'keyCode', { get: function () { return 229; } });
      body.dispatchEvent(enter);
      return document.getElementById('body').value;
    })()`)) as string;
    await sleep(300);
    const afterComposition = (await page.locator('#messages .msg').count()) as number;
    checkEqual('组合期间 Enter 不提交', afterComposition, before);
    checkEqual('组合期间输入内容保留', sentDuringComposition, 'Q04 中文输入');
    const guardState = (await page.evaluate(`(() => {
      const body = document.getElementById('body');
      body.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      const enter = new KeyboardEvent('keydown', {
        key: 'Enter', bubbles: true, cancelable: true, isComposing: false
      });
      body.dispatchEvent(enter);
      return document.getElementById('body').value;
    })()`)) as string;
    await sleep(40);
    checkEqual('组合结束后的短暂 Enter 被守卫', guardState, 'Q04 中文输入');
    await sleep(120);
    await page.keyboard.press('Enter');
    await waitMessageText(page, 'Q04 中文输入');
    check('守卫窗口结束后 Enter 正常发送', true);
    await page.waitForFunction(`document.querySelectorAll('#messages .msg-outbox').length === 0`);
  } finally {
    await ime.close();
  }

  // 触摸：390px 移动上下文 tap 会话、tap 发送、tap 关闭弹窗。
  const touch = await openRoomAt(
    browser,
    state,
    { width: 390, height: 844 },
    'light',
    { hasTouch: true, isMobile: true },
  );
  try {
    const page = touch.page;
    await page.locator('#back').tap();
    await page.waitForURL(`${state.base}/`);
    check('触摸返回会话列表', true);
    await page.locator('#new-group').tap();
    await page.locator('#group-modal').waitFor({ state: 'visible' });
    await page.locator('#group-cancel').tap();
    await page.locator('#group-modal').waitFor({ state: 'hidden' });
    check('触摸可打开并关闭建群弹窗', true);
    await page.locator(roomLink(state.rooms.directU1U3)).tap();
    await waitRoom(page, state.rooms.directU1U3, state.actors.u3.name);
    const touchText = `Q04 触摸发送 ${Date.now()}`;
    await page.fill('#body', touchText);
    await page.locator('#send').tap();
    await waitMessageText(page, touchText);
    check('触摸发送消息成功', true);
  } finally {
    await touch.close();
  }

  // 空态：新身份没有会话时给出下一步。
  const emptyToken = crypto.randomUUID();
  await rawTool<Actor>(emptyToken, 'network_register', {
    request_id: newRequestId('q04_empty_identity'),
    kind: 'human',
    name: 'Q04 空会话身份',
  });
  const empty = await makeContext(browser, emptyToken, { width: 390, height: 844 }, state.errors, {
    hasTouch: true,
    isMobile: true,
  });
  try {
    await empty.page.goto(`${state.base}/`);
    await empty.page.waitForFunction(
      `document.getElementById('room-list-status') &&
        document.getElementById('room-list-status').textContent !== '正在读取…'`,
    );
    const emptyText = (await empty.page.locator('#room-list-status').innerText()) ?? '';
    check('空会话列表给出下一步', emptyText.length > 0, emptyText);
    checkEqual('空会话仍可新建群聊', await empty.page.locator('#new-group').isVisible(), true);
  } finally {
    await empty.context.close();
  }

  // 加载失败：显示错误与重试，重试后恢复，不用 toast 掩盖。
  const failContext = await makeContext(
    browser,
    state.tokens.u1,
    { width: 1280, height: 900 },
    state.errors,
  );
  try {
    const page = failContext.page;
    let failed = false;
    await page.route('**/mcp', async (route) => {
      if (route.request().headers()['mcp-name'] !== 'network_rooms_list' || failed) {
        await route.continue();
        return;
      }
      failed = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: (route.request().postDataJSON() as { id?: string } | null)?.id ?? null,
          result: {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({ code: 'INTERNAL', message: 'Q04 模拟列表失败', retryable: true }),
              },
            ],
          },
        }),
      });
    });
    await page.goto(`${state.base}/`);
    await page.waitForFunction(
      `document.getElementById('room-list-status') &&
        document.getElementById('room-list-status').textContent.includes('Q04 模拟列表失败')`,
    );
    check('列表失败显示可读错误', true);
    checkEqual('列表失败显示重试', await page.locator('#room-list-retry').isVisible(), true);
    await page.unroute('**/mcp');
    await page.locator('#room-list-retry').click();
    await page.locator(roomLink(state.rooms.directU1U3)).waitFor();
    check('重试后列表恢复', true);
  } finally {
    await failContext.context.close();
  }

  // P1 缺口：不得伪造通话/媒体/搜索/收藏/置顶/转发/撤回入口。
  const p1 = await openRoomAt(browser, state, { width: 1280, height: 900 }, 'light');
  try {
    const labels = (await p1.page.evaluate(`(() => Array.from(document.querySelectorAll('button, a'))
      .map((node) => (node.textContent || '').trim())
      .filter(Boolean))()`)) as string[];
    for (const forbidden of ['通话', '语音通话', '视频通话', '收藏', '置顶', '转发', '撤回']) {
      check(
        `P1 缺口未伪造入口：${forbidden}`,
        !labels.some((label) => label.includes(forbidden)),
        labels.filter((label) => label.includes(forbidden)),
      );
    }
  } finally {
    await p1.close();
  }
}
