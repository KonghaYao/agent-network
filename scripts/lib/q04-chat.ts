/**
 * Q04 聊天与文件：真实发送、@ 选择器/显式 invoke、同名 Agent 消歧、
 * 附件上传/预览/下载、失败重试、未读与断线补读、投递回执。
 */

import type { Browser, Page } from 'playwright';

import {
  check,
  checkEqual,
  makeContext,
  newRequestId,
  noHorizontalOverflow,
  PNG_BYTES,
  rawTool,
  roomLink,
  screenshot,
  sendMessage,
  sleep,
  waitMessageText,
  waitRoom,
  waitStreamConnected,
  waitText,
  type RoomView,
} from './q04-harness';
import type { Q04State } from './q04-fixture';

interface HistoryPage {
  items: {
    message_id: string;
    preview: string;
    created_seq: string;
    delivery_states?: Record<string, number>;
  }[];
}

async function historyFor(state: Q04State, roomId: string): Promise<HistoryPage['items']> {
  const page = await rawTool<HistoryPage>(state.tokens.u1, 'network_history_list', {
    room_id: roomId,
    limit: 100,
  });
  return page.items;
}

async function sendViaComposer(page: Page, text: string): Promise<void> {
  await page.fill('#body', text);
  await page.locator('#send').click();
  await waitMessageText(page, text);
  await waitOutboxClear(page);
}

async function waitOutboxClear(page: Page): Promise<void> {
  await page.waitForFunction(`document.querySelectorAll('#messages .msg-outbox').length === 0`, undefined, {
    timeout: 15_000,
  });
  await sleep(120);
}

async function pendingDelivery(token: string, messageId: string): Promise<{ delivery_id: string } | null> {
  const inbox = await rawTool<{ items: { delivery_id: string; message_id: string }[] }>(
    token,
    'network_inbox_list',
    { state: 'pending', limit: 50 },
  );
  return inbox.items.find((item) => item.message_id === messageId) ?? null;
}

export async function runChatAcceptance(state: Q04State, browser: Browser): Promise<void> {
  console.log('· Q04 聊天：文本、@ 选择器、同名消歧、文件、重试、补读、回执');
  const { context, page } = await makeContext(
    browser,
    state.tokens.u1,
    { width: 1280, height: 900 },
    state.errors,
  );
  try {
    await page.goto(`${state.base}/c/${state.rooms.main}`);
    await waitRoom(page, state.rooms.main, 'Q04 主验收群');
    await waitStreamConnected(page);

    // 普通文本经真实输入框与发送按钮。
    const plain = `Q04 普通消息 ${Date.now()}`;
    await sendViaComposer(page, plain);
    const plainHistory = await historyFor(state, state.rooms.main);
    check(
      'UI 文本消息写入服务端历史',
      plainHistory.some((item) => item.preview === plain),
      plainHistory.map((item) => item.preview).slice(-3),
    );

    // 同名 Agent 选择器：两个同名条目，发送只带一个稳定 actor_id。
    const typed = '@同名验收助手';
    await page.fill('#body', typed);
    await page.locator('#mention-picker').waitFor({ state: 'visible' });
    const pickerNames = await page.locator('#mention-picker .mention-item').allInnerTexts();
    check(
      '同名 Agent 在 @ 选择器中并列显示两人',
      pickerNames.filter((name) => name.includes('同名验收助手')).length === 2,
      pickerNames,
    );
    await page.locator('#mention-picker .mention-item').first().click();
    await page.locator('#send').click();
    await waitMessageText(page, '@同名验收助手');
    await waitOutboxClear(page);
    const mentionHistory = await historyFor(state, state.rooms.main);
    const mentionMessage = mentionHistory.find((item) => item.preview.includes('@同名验收助手'));
    if (!mentionMessage) throw new Error('未找到显式 invoke 消息');
    // 同名消歧的权威依据是服务端只给选中的稳定 actor 生成投递。
    const b1Delivery = await pendingDelivery(state.tokens.b1, mentionMessage.message_id);
    const b2Delivery = await pendingDelivery(state.tokens.b2, mentionMessage.message_id);
    checkEqual(
      '同名选择只给一个 Agent 生成 delivery',
      Number(Boolean(b1Delivery)) + Number(Boolean(b2Delivery)),
      1,
    );
    check(
      '同名选择目标仍是有效 Agent',
      Boolean(b1Delivery) || Boolean(b2Delivery),
      { b1: Boolean(b1Delivery), b2: Boolean(b2Delivery) },
    );
    const chosenToken = b1Delivery ? state.tokens.b1 : state.tokens.b2;
    const delivery = b1Delivery ?? b2Delivery;
    if (!delivery) throw new Error('显式 invoke 没有生成 delivery');
    const claim = await rawTool<{ delivery_id: string; attempt: number; claim_id: string }>(
      chosenToken,
      'network_delivery_claim',
      { request_id: newRequestId('q04_delivery_claim'), delivery_id: delivery.delivery_id },
    );
    await rawTool(chosenToken, 'network_delivery_complete', {
      request_id: newRequestId('q04_delivery_complete'),
      delivery_id: claim.delivery_id,
      attempt: claim.attempt,
      claim_id: claim.claim_id,
    });
    await page.waitForFunction(
      `(() => {
        const receipt = document.querySelector('#messages li.msg-receipt[data-receipt-for="${mentionMessage.message_id}"]');
        return Boolean(receipt && receipt.innerText.includes('已处理'));
      })()`,
    );
    check('投递完成后页面显示已处理回执', true);

    // 人类 @ 只进入 mentions，不创建 delivery。
    const humanMentionText = '@Q04 成员 请查看';
    await page.fill('#body', '@Q04');
    await page.locator('#mention-picker').waitFor({ state: 'visible' });
    await page
      .locator('#mention-picker .mention-item')
      .filter({ hasText: 'Q04 成员' })
      .first()
      .click();
    await page.fill('#body', humanMentionText);
    await page.locator('#send').click();
    await waitMessageText(page, '请查看');
    await waitOutboxClear(page);
    const humanHistory = await historyFor(state, state.rooms.main);
    const humanMessage = humanHistory.find((item) => item.preview.includes('@Q04 成员 请查看'));
    if (humanMessage) {
      const b1Human = await pendingDelivery(state.tokens.b1, humanMessage.message_id);
      const b2Human = await pendingDelivery(state.tokens.b2, humanMessage.message_id);
      checkEqual('人类 @ 不产生 Agent delivery', Boolean(b1Human) || Boolean(b2Human), false);
    } else {
      check('人类 @ 消息写入历史', false);
    }

    // 附件：真实 setInputFiles → chip → 发送 → 消息文件卡片 → 预览/下载。
    await page.locator('#composer-file-input').setInputFiles({
      name: 'Q04 附件.png',
      mimeType: 'image/png',
      buffer: PNG_BYTES,
    });
    await page.waitForFunction(
      `(() => {
        const chip = document.querySelector('#composer-files .composer-file');
        return Boolean(chip && chip.dataset.fileId && chip.dataset.fileId.length > 0);
      })()`,
    );
    const fileId = (await page.locator('#composer-files .composer-file').first().getAttribute('data-file-id')) ?? '';
    await page.fill('#body', 'Q04 附件消息');
    await page.locator('#send').click();
    await waitMessageText(page, 'Q04 附件消息');
    const fileCard = page.locator(`.msg-file[data-file-id="${fileId}"]`).first();
    await fileCard.waitFor();
    const previewEntry = fileCard.locator('.msg-file-preview, .msg-file-thumb').first();
    await previewEntry.waitFor();
    await previewEntry.click();
    await page.locator('#file-preview').waitFor({ state: 'visible' });
    await page.waitForFunction(
      `(() => {
        const img = document.querySelector('#file-preview-body img');
        return Boolean(img && img.complete && img.naturalWidth > 0);
      })()`,
    );
    const downloadHref = (await page.locator('#file-preview-download').getAttribute('href')) ?? '';
    check('附件预览显示真实图片', true);
    check('附件下载链接指向 /f/', downloadHref.includes('/f/'), downloadHref);
    await page.locator('#file-preview-close').click();
    await page.locator('#file-preview').waitFor({ state: 'hidden' });
    const roomFiles = await rawTool<{ items: { file_id: string; name: string }[] }>(
      state.tokens.u1,
      'network_room_file_list',
      { room_id: state.rooms.main, limit: 100 },
    );
    check(
      '上传附件已绑定到房间文件',
      roomFiles.items.some((item) => item.file_id === fileId),
      roomFiles.items,
    );

    // 失败重试：首个 network_message_send 请求直接断开；UI 显示可重试状态，重试后只产生一条消息。
    let failedOnce = false;
    await page.route('**/mcp', async (route) => {
      const request = route.request();
      if (request.headers()['mcp-name'] !== 'network_message_send' || failedOnce) {
        await route.continue();
        return;
      }
      failedOnce = true;
      await route.abort('failed');
    });
    const retryText = `Q04 失败重试 ${Date.now()}`;
    await page.fill('#body', retryText);
    await page.locator('#send').click();
    await page.waitForFunction(
      `(() => Array.from(document.querySelectorAll('#messages .msg-outbox'))
        .some((node) => node.innerText.includes('发送失败，可重试')))()`,
    );
    check('发送失败显示可重试状态而非成功假象', true);
    await page.locator('#messages .msg-outbox .outbox-retry').first().click();
    await waitMessageText(page, retryText, 15_000);
    await page.waitForFunction(
      `document.querySelectorAll('#messages .msg-outbox').length === 0`,
    );
    const retryHistory = await historyFor(state, state.rooms.main);
    checkEqual(
      '重试后只有一条业务消息',
      retryHistory.filter((item) => item.preview === retryText).length,
      1,
    );
    await page.unroute('**/mcp');
    await noHorizontalOverflow(page, '聊天桌面页');
    await screenshot(page, 'q04-chat-main-light-1280');
  } finally {
    await context.close();
  }

  // 未读与断线补读：U1 在首页，U2 发送；打开会话后已读；断线期间的消息重连后补拉。
  const reconnectContext = await makeContext(
    browser,
    state.tokens.u1,
    { width: 1280, height: 900 },
    state.errors,
  );
  try {
    const reconnectPage = reconnectContext.page;
    await reconnectPage.goto(`${state.base}/`);
    await reconnectPage.locator('#room-list .room-item').first().waitFor();
    await waitStreamConnected(reconnectPage);
    const unreadText = `Q04 未读消息 ${Date.now()}`;
    await sendMessage(state.tokens.u2, state.rooms.directU1U2, unreadText);
    await reconnectPage.waitForFunction(
      `(() => {
        const item = document.querySelector(${JSON.stringify(roomLink(state.rooms.directU1U2))});
        return Boolean(item && item.querySelector('.unread'));
      })()`,
    );
    check('非当前会话显示未读红点', true);
    await reconnectPage.locator(roomLink(state.rooms.directU1U2)).click();
    await waitRoom(reconnectPage, state.rooms.directU1U2, state.actors.u2.name);
    await waitMessageText(reconnectPage, unreadText);
    await reconnectPage.waitForFunction(
      `(() => {
        const item = document.querySelector(${JSON.stringify(roomLink(state.rooms.directU1U2))});
        return Boolean(item && !item.querySelector('.unread'));
      })()`,
    );
    const readState = await rawTool<RoomView>(state.tokens.u1, 'network_room_get', {
      room_id: state.rooms.directU1U2,
    });
    checkEqual('打开会话后已读进度追上 head', readState.room.my_last_read_seq, readState.room.head_seq);

    const aborted = (await reconnectPage.evaluate(
      `(() => { window.__failStreams = true; return window.__abortStream(); })()`,
    )) as boolean;
    check('测试成功中止当前 stream', aborted);
    const offlineOne = `Q04 断线消息 1 ${Date.now()}`;
    const offlineTwo = `Q04 断线消息 2 ${Date.now()}`;
    await sendMessage(state.tokens.u2, state.rooms.directU1U2, offlineOne);
    await sendMessage(state.tokens.u2, state.rooms.directU1U2, offlineTwo);
    await sleep(400);
    await reconnectPage.evaluate(
      `window.__failStreams = false; window.dispatchEvent(new Event('online'));`,
    );
    await reconnectPage.waitForFunction(
      `(window.__mcpCalls || []).filter(function (call) {
        return call.method === 'subscriptions/listen' && call.stream === true;
      }).length >= 2`,
      undefined,
      { timeout: 10_000 },
    );
    await waitMessageText(reconnectPage, offlineOne, 15_000);
    await waitMessageText(reconnectPage, offlineTwo, 15_000);
    check('断线重连后补拉两条消息', true);
    await noHorizontalOverflow(reconnectPage, '断线重连桌面页');
  } finally {
    await reconnectContext.context.close();
  }
}
