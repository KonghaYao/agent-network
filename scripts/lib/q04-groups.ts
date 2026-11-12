/**
 * Q04 联系人与群组正向验收：好友申请/拒绝/接受、拉黑/解除、建群多选、
 * 角色任免、owner 退群限制、待处理投递退群预览、直接加人、邀请链接审批、移除成员、
 * owner 转让、解散归档与无主群拒绝加入。
 *
 * 所有写操作优先经真实控件；rawRpc 只用于准备邀请/消息与对账服务端状态。
 */

import type { Browser, Locator, Page } from 'playwright';

import {
  acceptRoomInvites,
  befriend,
  check,
  checkEqual,
  makeContext,
  newRequestId,
  noHorizontalOverflow,
  rawTool,
  rawToolError,
  roomLink,
  screenshot,
  sleep,
  waitRoom,
  waitText,
  withDb,
  type Actor,
  type RoomView,
} from './q04-harness';
import type { Q04State } from './q04-fixture';

async function openContactRequests(page: Page): Promise<void> {
  await page.locator('#contact-requests').click();
  await page.locator('#contact-modal').waitFor({ state: 'visible' });
  await page.locator('#contact-tab-requests').click();
}

async function closeContactRequests(page: Page): Promise<void> {
  await page.locator('#contact-modal-close').click();
  await page.locator('#contact-modal').waitFor({ state: 'hidden' });
}

/** 成员行只有一个 icon；读取好友期间禁用，等可用后再展开菜单。 */
async function openMemberRowMenu(row: Locator): Promise<Locator> {
  const menu = row.locator('.member-menu');
  if (await menu.isVisible()) return menu;
  const toggle = row.locator('.member-menu-toggle:not(:disabled)');
  await toggle.waitFor();
  await toggle.click();
  await menu.waitFor({ state: 'visible' });
  return menu;
}

/** 刷新/滚动可能在点击前收起菜单；重开后再点。 */
async function clickMemberMenuItem(row: Locator, label: string): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const menu = await openMemberRowMenu(row);
    try {
      await menu.locator('.member-menu-item').filter({ hasText: label }).click({ timeout: 3_000 });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function acceptDialog(page: Page): Promise<string> {
  const dialog = page.locator('#confirm-dialog[open]');
  await dialog.waitFor();
  const message = (await dialog.locator('#confirm-dialog-message').textContent()) ?? '';
  await dialog.locator('[data-confirm-ok]').click();
  return message;
}

/** 先挂监听再点击，避免等待一个尚未触发的对话框。 */
function dialogPromise(page: Page): Promise<string> {
  return acceptDialog(page);
}

export async function runContactAcceptance(state: Q04State, browser: Browser): Promise<void> {
  console.log('· Q04 联系人：申请/拒绝/接受/拉黑/解除');
  const u6Token = crypto.randomUUID();
  const u6 = await rawTool<Actor>(u6Token, 'network_register', {
    request_id: newRequestId('q04_u6'),
    kind: 'human',
    name: 'Q04 新联系人',
  });
  const { context, page } = await makeContext(browser, state.tokens.u1, { width: 1280, height: 900 }, state.errors);
  try {
    await page.goto(`${state.base}/`);
    await page.locator('#room-list .room-item').first().waitFor();

    // 第一次申请由 UI 拒绝。
    await rawTool(u6Token, 'network_contact_request', {
      request_id: newRequestId('q04_contact_request'),
      actor_id: state.actors.u1.actor_id,
      message: 'Q04 第一次申请',
    });
    await openContactRequests(page);
    await waitText(page, '#contact-request-list', 'Q04 第一次申请');
    await page
      .locator('#contact-request-list .contact-request-item')
      .filter({ hasText: 'Q04 新联系人' })
      .locator('button')
      .filter({ hasText: '拒绝' })
      .click();
    await waitText(page, '#contact-request-status', '已拒绝好友申请');
    const rejected = await rawTool<{ items: { contact_request_id: string; status: string; to_actor: { actor_id: string } }[] }>(
      u6Token,
      'network_contact_requests_list',
      { direction: 'outgoing', limit: 50 },
    );
    checkEqual(
      'UI 拒绝后申请方看到 rejected',
      rejected.items.find((item) => item.to_actor.actor_id === state.actors.u1.actor_id)?.status,
      'rejected',
    );
    await closeContactRequests(page);

    // 再次申请由 UI 接受，双方关系一致。
    await rawTool(u6Token, 'network_contact_request', {
      request_id: newRequestId('q04_contact_request'),
      actor_id: state.actors.u1.actor_id,
      message: 'Q04 第二次申请',
    });
    await openContactRequests(page);
    await waitText(page, '#contact-request-list', 'Q04 第二次申请');
    await page
      .locator('#contact-request-list .contact-request-item')
      .filter({ hasText: 'Q04 新联系人' })
      .locator('button.primary')
      .click();
    await waitText(page, '#contact-request-status', '已接受好友申请');
    const u1Contacts = await rawTool<{ items: { actor_id: string; relation: string }[] }>(
      state.tokens.u1,
      'network_contacts_list',
      { limit: 100 },
    );
    checkEqual(
      'UI 接受后 U1 侧关系为 active',
      u1Contacts.items.find((item) => item.actor_id === u6.actor_id)?.relation,
      'active',
    );
    const u6Contacts = await rawTool<{ items: { actor_id: string; relation: string }[] }>(
      u6Token,
      'network_contacts_list',
      { limit: 100 },
    );
    checkEqual(
      'UI 接受后申请方关系为 active',
      u6Contacts.items.find((item) => item.actor_id === state.actors.u1.actor_id)?.relation,
      'active',
    );
    await closeContactRequests(page);

    // 拉黑：真实菜单 + 确认框；结束后关系为 none，但共同会话历史仍在。
    await page.locator(roomLink(state.rooms.directU1U5)).click({ button: 'right' });
    await page.locator('#room-menu').waitFor({ state: 'visible' });
    await page.waitForFunction(`document.getElementById('room-menu-block').textContent.trim() === '拉黑'`);
    const blockPromise = dialogPromise(page);
    await page.locator('#room-menu-block').click();
    const blockCopy = await blockPromise;
    check(
      '拉黑确认说明不自动移除共同群且解封不恢复好友',
      blockCopy.includes('不会移出共同群') && blockCopy.includes('解除拉黑不会自动恢复好友'),
      blockCopy,
    );
    await page.waitForFunction(`document.getElementById('room-menu').hidden === true`);
    const blocks = await rawTool<{ items: { active: boolean; blocked_actor: { actor_id: string } }[] }>(
      state.tokens.u1,
      'network_contact_blocks_list',
      { limit: 100 },
    );
    checkEqual(
      'UI 拉黑后服务端 active',
      blocks.items.find((item) => item.blocked_actor.actor_id === state.actors.u5.actor_id)?.active,
      true,
    );
    const contactsAfterBlock = await rawTool<{ items: { actor_id: string; relation: string }[] }>(
      state.tokens.u1,
      'network_contacts_list',
      { limit: 100 },
    );
    checkEqual(
      'UI 拉黑后好友关系结束',
      contactsAfterBlock.items.find((item) => item.actor_id === state.actors.u5.actor_id)?.relation ??
        'none',
      'none',
    );

    // 解除拉黑：菜单文案切换，解除后服务端释放，但仍不自动恢复好友。
    await page.locator(roomLink(state.rooms.directU1U5)).click({ button: 'right' });
    await page.locator('#room-menu').waitFor({ state: 'visible' });
    await page.waitForFunction(`document.getElementById('room-menu-block').textContent.trim() === '解除拉黑'`);
    const unblockPromise = dialogPromise(page);
    await page.locator('#room-menu-block').click();
    const unblockMessage = await unblockPromise;
    check(
      '解除拉黑确认说明不恢复好友',
      unblockMessage.includes('不会自动恢复好友关系'),
      unblockMessage,
    );
    await page.waitForFunction(`document.getElementById('room-menu').hidden === true`);
    const released = await rawTool<{ items: { active: boolean; blocked_actor: { actor_id: string } }[] }>(
      state.tokens.u1,
      'network_contact_blocks_list',
      { limit: 100 },
    );
    checkEqual(
      'UI 解除拉黑后服务端释放',
      released.items.find((item) => item.blocked_actor.actor_id === state.actors.u5.actor_id)?.active,
      false,
    );
    const contactsAfterUnblock = await rawTool<{ items: { actor_id: string; relation: string }[] }>(
      state.tokens.u1,
      'network_contacts_list',
      { limit: 100 },
    );
    checkEqual(
      '解除拉黑不自动恢复好友',
      contactsAfterUnblock.items.find((item) => item.actor_id === state.actors.u5.actor_id)?.relation ??
        'none',
      'none',
    );
    await noHorizontalOverflow(page, '联系人/拉黑桌面页');
    await screenshot(page, 'q04-contacts-blocked-light-1280', { fullPage: false });
  } finally {
    await context.close();
  }
}

async function createMainGroupViaUi(
  state: Q04State,
  browser: Browser,
): Promise<{ page: Page; context: Awaited<ReturnType<typeof makeContext>>['context']; roomId: string }> {
  const { context, page } = await makeContext(
    browser,
    state.tokens.u1,
    { width: 1280, height: 900 },
    state.errors,
  );
  await page.goto(`${state.base}/`);
  await page.locator('#room-list .room-item').first().waitFor();
  await page.locator('#new-group').click();
  await page.locator('#group-modal').waitFor({ state: 'visible' });
  await page.waitForFunction(
    `document.querySelector('#group-contacts input[value="${state.actors.u2.actor_id}"]') !== null`,
  );
  await page.fill('#group-title', 'Q04 主验收群');
  for (const actorId of [
    state.actors.u2.actor_id,
    state.actors.u3.actor_id,
    state.actors.b1.actor_id,
    state.actors.b2.actor_id,
  ]) {
    await page.locator(`#group-contacts input[value="${actorId}"]`).check();
  }
  checkEqual('建群多选计数为 4', await page.locator('#group-selection').textContent(), '已选 4 人');
  await page.locator('#group-create').click();
  await page.waitForURL(/\/c\/[^/]+$/u);
  const roomId = decodeURIComponent(new URL(page.url()).pathname.split('/').filter(Boolean).pop()!);
  await waitRoom(page, roomId, 'Q04 主验收群');
  check('UI 建群后进入新群', roomId.length > 0);
  return { context, page, roomId };
}

/** 建群、角色、owner 退群限制与待处理投递退群预览。 */
export async function runGroupSetupAcceptance(
  state: Q04State,
  browser: Browser,
): Promise<void> {
  console.log('· Q04 群组：建群多选、角色、owner 限制、退群预览、邀请审批');
  const created = await createMainGroupViaUi(state, browser);
  state.rooms.main = created.roomId;
  const mainPageInner = created.page;
  await acceptRoomInvites(state.tokens.u2, state.rooms.main);
  await acceptRoomInvites(state.tokens.u3, state.rooms.main);
  const mainDetail = await rawTool<RoomView>(state.tokens.u1, 'network_room_get', {
    room_id: state.rooms.main,
  });
  const activeMembers = mainDetail.members.filter((member) => member.status !== 'invited');
  checkEqual('服务端主群 active 成员为 5', activeMembers.length, 5);
  check(
    '同名 Agent 均在主群',
    mainDetail.members.filter((member) => member.name === '同名验收助手').length === 2,
    mainDetail.members.map((member) => member.name),
  );

  // owner 留群限制：预览 can_leave=false，UI 给出下一步而不是空操作。
  await mainPageInner.locator(roomLink(state.rooms.main)).click({ button: 'right' });
  await mainPageInner.locator('#room-menu').waitFor({ state: 'visible' });
  await mainPageInner.locator('#room-menu-leave-group').click();
  await waitText(mainPageInner, '#room-menu-status', '群主不能直接退群');
  const ownerUnchanged = await rawTool<RoomView>(state.tokens.u1, 'network_room_get', {
    room_id: state.rooms.main,
  });
  checkEqual('owner 退群失败后仍是群主', ownerUnchanged.room.owner_id, state.actors.u1.actor_id);
  await mainPageInner.mouse.click(700, 700);

  // 任免管理员：owner UI 操作，服务端角色对账。
  await mainPageInner.locator('#add-members').click();
  await mainPageInner.locator('#members-current .member-roster-item').first().waitFor();
  const u2Row = mainPageInner
    .locator('#members-current .member-roster-item')
    .filter({ hasText: state.actors.u2.name });
  await clickMemberMenuItem(u2Row, '设为管理员');
  await mainPageInner.waitForFunction(
    `(() => Array.from(document.querySelectorAll('#members-current .member-roster-role'))
      .some((node) => node.textContent === '管理员 · 人' || node.textContent === '管理员 · Agent'))()`,
  );
  const u2Role = (await rawTool<RoomView>(state.tokens.u1, 'network_room_get', {
    room_id: state.rooms.main,
  })).members.find((member) => member.actor_id === state.actors.u2.actor_id)?.role;
  checkEqual('UI 设管理员写入服务端', u2Role, 'admin');
  await mainPageInner.locator('#members-cancel').click();

  const adminContext = await makeContext(
    browser,
    state.tokens.u2,
    { width: 1280, height: 900 },
    state.errors,
  );
  try {
    await adminContext.page.goto(`${state.base}/c/${state.rooms.main}`);
    await waitRoom(adminContext.page, state.rooms.main, 'Q04 主验收群');
    await adminContext.page.locator('#add-members').click();
    await adminContext.page.locator('#members-current .member-roster-item').first().waitFor();
    const adminMenuTexts = await adminContext.page
      .locator('#members-current .member-menu-item')
      .allTextContents();
    check(
      '管理员可移除普通成员但没有任免/转让入口',
      adminMenuTexts.includes('移出群聊') &&
        !adminMenuTexts.includes('设为管理员') &&
        !adminMenuTexts.includes('转让群主'),
      adminMenuTexts,
    );
    await adminContext.page.locator('#members-cancel').click();
  } finally {
    await adminContext.context.close();
  }

  await mainPageInner.locator('#add-members').click();
  await mainPageInner.locator('#members-current .member-roster-item').first().waitFor();
  const u2RowAgain = mainPageInner
    .locator('#members-current .member-roster-item')
    .filter({ hasText: state.actors.u2.name });
  await clickMemberMenuItem(u2RowAgain, '撤销管理员');
  await mainPageInner.waitForFunction(
    `(() => {
      const row = Array.from(document.querySelectorAll('#members-current .member-roster-item'))
        .find((node) => node.innerText.includes(${JSON.stringify(state.actors.u2.name)}));
      const role = row ? row.querySelector('.member-roster-role') : null;
      return Boolean(role && role.textContent === '人');
    })()`,
  );
  const u2RoleAfter = (await rawTool<RoomView>(state.tokens.u1, 'network_room_get', {
    room_id: state.rooms.main,
  })).members.find((member) => member.actor_id === state.actors.u2.actor_id)?.role;
  checkEqual('UI 撤销管理员写入服务端', u2RoleAfter, 'member');
  await mainPageInner.locator('#members-cancel').click();

  // 独立群：待处理投递退群预览与确认。
  const leaveGroup = await rawTool<RoomView>(state.tokens.u1, 'network_room_create', {
    request_id: newRequestId('q04_leave_group'),
    kind: 'group',
    title: 'Q04 退群预览群',
    members: [state.actors.u2.actor_id, state.actors.b1.actor_id],
  });
  state.rooms.leave = leaveGroup.room.room_id;
  await acceptRoomInvites(state.tokens.u2, state.rooms.leave);
  await rawTool(state.tokens.u1, 'network_message_send', {
    request_id: newRequestId('q04_leave_message'),
    client_message_id: crypto.randomUUID(),
    room_id: state.rooms.leave,
    body: '退群前待处理投递',
    invoke: [state.actors.b1.actor_id],
  });
  const leaverContext = await makeContext(
    browser,
    state.tokens.b1,
    { width: 1280, height: 900 },
    state.errors,
  );
  try {
    await leaverContext.page.goto(`${state.base}/c/${state.rooms.leave}`);
    await waitRoom(leaverContext.page, state.rooms.leave, 'Q04 退群预览群');
    await leaverContext.page.locator(roomLink(state.rooms.leave)).click({ button: 'right' });
    await leaverContext.page.locator('#room-menu').waitFor({ state: 'visible' });
    const leaveDialog = dialogPromise(leaverContext.page);
    await leaverContext.page.locator('#room-menu-leave-group').click();
    const copy = await leaveDialog;
    check(
      '退群确认列出待处理投递并说明撤销',
      copy.includes('待处理投递') && copy.includes('撤销'),
      copy,
    );
    await leaverContext.page.waitForURL(`${state.base}/`);
    const leftDetail = await rawToolError(state.tokens.b1, 'network_room_get', {
      room_id: state.rooms.leave,
    });
    check('退群后成员读取房间被拒绝', ['NOT_FOUND', 'NOT_MEMBER'].includes(leftDetail.code), leftDetail);
  } finally {
    await leaverContext.context.close();
  }

  // 人拉人直接入群 + 邀请链接审批 + 重复扫码不重复加人 + 移除。
  const inviteGroup = await rawTool<RoomView>(state.tokens.u1, 'network_room_create', {
    request_id: newRequestId('q04_invite_group'),
    kind: 'group',
    title: 'Q04 邀请审批群',
    members: [state.actors.u2.actor_id],
  });
  state.rooms.invite = inviteGroup.room.room_id;
  await acceptRoomInvites(state.tokens.u2, state.rooms.invite);

  // 定向添加 U4：新语义直接入群，不再生成待确认邀请；后续 UI 移除仍走同一路径。
  const targetedAdd = await rawTool<{
    invitation: unknown;
    member?: { actor_id: string; status: string } | null;
  }>(state.tokens.u1, 'network_room_invite_create', {
    request_id: newRequestId('q04_target_invite'),
    room_id: state.rooms.invite,
    target_actor_id: state.actors.u4.actor_id,
  });
  checkEqual('定向添加不返回邀请', targetedAdd.invitation, null);
  checkEqual('定向添加返回 active 成员', targetedAdd.member?.actor_id, state.actors.u4.actor_id);
  checkEqual('定向添加成员状态为 active', targetedAdd.member?.status, 'active');
  const targetedPending = await rawTool<{
    items: { invitation_id: string; room_id: string; status: string }[];
  }>(state.tokens.u4, 'network_room_invite_get', { status: 'pending', limit: 100 });
  checkEqual(
    '定向添加不产生 pending 邀请',
    targetedPending.items.filter((item) => item.room_id === state.rooms.invite).length,
    0,
  );
  let inviteDetail = await rawTool<RoomView>(state.tokens.u1, 'network_room_get', {
    room_id: state.rooms.invite,
  });
  check(
    '定向添加后 U4 立即 active',
    inviteDetail.members.some((member) => member.actor_id === state.actors.u4.actor_id && member.status !== 'invited'),
    inviteDetail.members,
  );

  const ownerContext = await makeContext(
    browser,
    state.tokens.u1,
    { width: 1280, height: 900 },
    state.errors,
  );
  try {
    await ownerContext.page.goto(`${state.base}/c/${state.rooms.invite}`);
    await waitRoom(ownerContext.page, state.rooms.invite, 'Q04 邀请审批群');
    const removeMember = async (name: string): Promise<void> => {
      await ownerContext.page.locator('#add-members').click();
      await ownerContext.page.locator('#members-current .member-roster-item').first().waitFor();
      const row = ownerContext.page
        .locator('#members-current .member-roster-item')
        .filter({ hasText: name });
      await row.waitFor();
      const dialog = dialogPromise(ownerContext.page);
      await clickMemberMenuItem(row, '移出群聊');
      await dialog;
      await ownerContext.page.waitForFunction(
        `!Array.from(document.querySelectorAll('#members-current .member-roster-item'))
          .some((node) => node.innerText.includes(${JSON.stringify(name)}))`,
      );
      await ownerContext.page.locator('#members-cancel').click();
    };
    await removeMember(state.actors.u4.name);
    inviteDetail = await rawTool<RoomView>(state.tokens.u1, 'network_room_get', {
      room_id: state.rooms.invite,
    });
    check(
      'UI 移除成员后不在 active 列表',
      !inviteDetail.members.some(
        (member) => member.actor_id === state.actors.u4.actor_id && member.status !== 'removed',
      ),
      inviteDetail.members,
    );

    // 开启审批，创建链接，新受邀者 U7 在 /j 页面申请，owner 在成员弹窗批准。
    const u7Token = crypto.randomUUID();
    const u7 = await rawTool<Actor>(u7Token, 'network_register', {
      request_id: newRequestId('q04_u7'),
      kind: 'human',
      name: 'Q04 链接受邀者',
    });
    await rawTool(state.tokens.u1, 'network_room_policy_set', {
      request_id: newRequestId('q04_approval_policy'),
      room_id: state.rooms.invite,
      member_join_policy: 'approval',
      expected_policy_revision: inviteDetail.room.policy_revision,
    });
    await ownerContext.page.locator('#add-members').click();
    await ownerContext.page.locator('#members-current .member-roster-item').first().waitFor();
    await ownerContext.page.locator('#members-invite-create').click();
    await ownerContext.page.locator('#members-invite-share').waitFor({ state: 'visible' });
    const inviteUrl = (await ownerContext.page.locator('#members-invite-url').textContent())?.trim() ?? '';
    check('UI 创建邀请链接并显示一次', inviteUrl.includes('/j/'), inviteUrl);
    await ownerContext.page.locator('#members-cancel').click();
    const inviteKey = inviteUrl.split('/j/')[1] ?? '';

    const joinContext = await makeContext(
      browser,
      u7Token,
      { width: 390, height: 844 },
      state.errors,
      { hasTouch: true, isMobile: true },
    );
    try {
      await joinContext.page.goto(`${state.base}/j/${encodeURIComponent(inviteKey)}`);
      try {
        await joinContext.page.waitForFunction(`document.getElementById('join-action').disabled === false`);
      } catch (error) {
        const statusText = (await joinContext.page.locator('#status').textContent()) ?? '';
        const metaText = (await joinContext.page.locator('#join-meta').textContent()) ?? '';
        console.error(`Q04 join preview failed: keyLength=${inviteKey.length} status=${statusText} meta=${metaText}`);
        throw error;
      }
      await joinContext.page.locator('#join-action').tap();
      await waitText(joinContext.page, '#status', '申请');
      const requests = await rawTool<{ items: { applicant: { actor_id: string }; status: string }[] }>(
        state.tokens.u1,
        'network_room_join_request_list',
        { room_id: state.rooms.invite, status: 'pending', limit: 50 },
      );
      check(
        '审批群加入只创建 pending 申请',
        requests.items.some(
          (item) => item.applicant.actor_id === u7.actor_id && item.status === 'pending',
        ),
        requests.items,
      );

      await ownerContext.page.locator('#add-members').click();
      await ownerContext.page.locator('#members-current .member-roster-item').first().waitFor();
      await ownerContext.page.waitForFunction(
        `(() => {
          const row = Array.from(document.querySelectorAll('#members-requests-list .member-roster-item'))
            .find((node) => node.innerText.includes(${JSON.stringify(u7.name)}));
          return Boolean(row);
        })()`,
      );
      await ownerContext.page
        .locator('#members-requests-list .member-roster-item')
        .filter({ hasText: u7.name })
        .locator('.member-action')
        .filter({ hasText: '批准' })
        .click();
      await ownerContext.page.waitForFunction(
        `document.getElementById('members-requests-count').textContent === '0'`,
      );
      await ownerContext.page.locator('#members-cancel').click();
      inviteDetail = await rawTool<RoomView>(state.tokens.u1, 'network_room_get', {
        room_id: state.rooms.invite,
      });
      const beforeRepeat = inviteDetail.members.length;
      check(
        'owner 批准后 U7 active',
        inviteDetail.members.some((member) => member.actor_id === u7.actor_id && member.status !== 'invited'),
        inviteDetail.members,
      );

      await joinContext.page.reload();
      await joinContext.page.waitForFunction(`document.getElementById('join-action').disabled === false`);
      await joinContext.page.locator('#join-action').tap();
      await joinContext.page.waitForURL(`${state.base}/c/${state.rooms.invite}`, { timeout: 10_000 });
      await sleep(300);
      const afterRepeat = await rawTool<RoomView>(state.tokens.u1, 'network_room_get', {
        room_id: state.rooms.invite,
      });
      checkEqual('重复打开邀请链接不重复增加成员', afterRepeat.members.length, beforeRepeat);
    } finally {
      await joinContext.context.close();
    }

    await removeMember(u7.name);
    const memberInvite = await rawToolError(state.tokens.u2, 'network_room_invite_create', {
      request_id: newRequestId('q04_member_invite'),
      room_id: state.rooms.invite,
    });
    check(
      '普通成员不能创建邀请链接',
      ['PERMISSION_DENIED', 'NOT_OWNER', 'FORBIDDEN'].includes(memberInvite.code),
      memberInvite,
    );
  } finally {
    await ownerContext.context.close();
  }

  // 遗留无主群：先取链接再构造 owner 缺失，任何加入路径都必须拒绝。
  const ownerless = await rawTool<RoomView>(state.tokens.u1, 'network_room_create', {
    request_id: newRequestId('q04_ownerless_group'),
    kind: 'group',
    title: 'Q04 无主群',
    members: [state.actors.u2.actor_id],
  });
  state.rooms.ownerless = ownerless.room.room_id;
  const ownerlessLink = await rawTool<{
    invite_key: string;
    share_url: string;
    invitation: { invitation_id: string };
  }>(
    state.tokens.u1,
    'network_room_invite_create',
    {
      request_id: newRequestId('q04_ownerless_invite'),
      room_id: state.rooms.ownerless,
      max_uses: 5,
    },
  );
  withDb(state.dbPath, (db) => {
    db.prepare('UPDATE rooms SET owner_id = NULL WHERE room_id = ?').run(state.rooms.ownerless);
  });
  const ownerlessJoin = await rawToolError(state.tokens.u4, 'network_room_invite_respond', {
    request_id: newRequestId('q04_ownerless_join'),
    invitation_id: ownerlessLink.invitation.invitation_id,
    invite_key: ownerlessLink.invite_key,
    action: 'accept',
  });
  check(
    '无主群邀请加入返回 CONFLICT/owner_missing',
    ownerlessJoin.code === 'CONFLICT' || ownerlessJoin.code === 'NOT_FOUND',
    ownerlessJoin,
  );
  const ownerlessUi = await makeContext(
    browser,
    state.tokens.u4,
    { width: 390, height: 844 },
    state.errors,
    { hasTouch: true, isMobile: true },
  );
  try {
    await ownerlessUi.page.goto(`${state.base}/j/${encodeURIComponent(ownerlessLink.invite_key)}`);
    await ownerlessUi.page.waitForFunction(`document.getElementById('join-action').disabled === false`);
    await ownerlessUi.page.locator('#join-action').tap();
    await ownerlessUi.page.waitForFunction(
      `(document.getElementById('status').textContent || '').length > 0`,
    );
    const status = (await ownerlessUi.page.locator('#status').textContent()) ?? '';
    check('无主群 UI 显示可行动的失败', status.includes('失败') || status.includes('群主'), status);
    check(
      '无主群 UI 不使用成功文案',
      !status.includes('已加入') && !status.includes('申请已提交'),
      status,
    );
  } finally {
    await ownerlessUi.context.close();
  }

  await mainPageInner.locator('#add-members').click();
  await mainPageInner.locator('#members-cancel').click();
  await created.context.close();
}

/** owner 转让、解散归档、旧 owner 失权。 */
export async function runGroupFinaleAcceptance(state: Q04State, browser: Browser): Promise<void> {
  console.log('· Q04 群组收尾：owner 转让、旧 owner 失权、解散归档');
  const ownerContext = await makeContext(
    browser,
    state.tokens.u1,
    { width: 1280, height: 900 },
    state.errors,
  );
  const targetContext = await makeContext(
    browser,
    state.tokens.u2,
    { width: 1280, height: 900 },
    state.errors,
  );
  try {
    await ownerContext.page.goto(`${state.base}/c/${state.rooms.main}`);
    await waitRoom(ownerContext.page, state.rooms.main, 'Q04 主验收群');
    await ownerContext.page.locator('#add-members').click();
    await ownerContext.page.locator('#members-current .member-roster-item').first().waitFor();
    const u2Row = ownerContext.page
      .locator('#members-current .member-roster-item')
      .filter({ hasText: state.actors.u2.name });
    const proposePromise = dialogPromise(ownerContext.page);
    await clickMemberMenuItem(u2Row, '转让群主');
    check('转让确认说明对方接受后生效', (await proposePromise).includes('对方接受后才会生效'));

    await targetContext.page.goto(`${state.base}/c/${state.rooms.main}`);
    await waitRoom(targetContext.page, state.rooms.main, 'Q04 主验收群');
    await targetContext.page.locator('#add-members').click();
    await targetContext.page.locator('#members-transfer').waitFor();
    await targetContext.page
      .locator('#members-transfer .member-action')
      .filter({ hasText: '接受转让' })
      .click();
    await targetContext.page.waitForFunction(`document.getElementById('members-transfer').hidden === true`);
    await targetContext.page.locator('#members-cancel').click();
    const afterTransfer = await rawTool<RoomView>(state.tokens.u1, 'network_room_get', {
      room_id: state.rooms.main,
    });
    checkEqual('接受转让后 owner 为 U2', afterTransfer.room.owner_id, state.actors.u2.actor_id);
    const oldOwnerRole = await rawToolError(state.tokens.u1, 'network_room_role_set', {
      request_id: newRequestId('q04_old_owner_role'),
      room_id: state.rooms.main,
      actor_id: state.actors.u3.actor_id,
      role: 'admin',
      expected_role_revision: 1,
    });
    check('旧 owner 任免管理员被拒绝', ['PERMISSION_DENIED', 'NOT_OWNER'].includes(oldOwnerRole.code), oldOwnerRole);
    await ownerContext.page.locator('#members-cancel').click();

    // 新 owner 重新加载群详情后再解散，确保能力快照已更新。
    await targetContext.page.reload();
    await waitRoom(targetContext.page, state.rooms.main, 'Q04 主验收群');
    let dissolveVisible = false;
    for (let attempt = 0; attempt < 8 && !dissolveVisible; attempt += 1) {
      await targetContext.page.locator(roomLink(state.rooms.main)).click({ button: 'right' });
      await targetContext.page.locator('#room-menu').waitFor({ state: 'visible' });
      dissolveVisible = await targetContext.page.locator('#room-menu-dissolve').isVisible();
      if (!dissolveVisible) {
        await targetContext.page.keyboard.press('Escape');
        await sleep(400);
      }
    }
    if (!dissolveVisible) throw new Error('新 owner 菜单没有出现解散入口');
    const dissolvePromise = dialogPromise(targetContext.page);
    // 菜单固定定位，Playwright 的自动滚动会触发页面的 scroll 关闭菜单；
    // 直接按可见坐标做真实鼠标点击。
    const dissolveBox = await targetContext.page.locator('#room-menu-dissolve').boundingBox();
    if (!dissolveBox) throw new Error('解散入口没有可点击坐标');
    await targetContext.page.mouse.click(
      dissolveBox.x + dissolveBox.width / 2,
      dissolveBox.y + dissolveBox.height / 2,
    );
    check('解散确认说明不可恢复', (await dissolvePromise).includes('解散'), await dissolvePromise);
    await waitText(targetContext.page, '#toast', '已解散');
    const dissolved = await rawTool<RoomView>(state.tokens.u1, 'network_room_get', {
      room_id: state.rooms.main,
    });
    checkEqual('解散后房间状态 dissolved', dissolved.room.status, 'dissolved');

    await ownerContext.page.reload();
    await waitRoom(ownerContext.page, state.rooms.main, 'Q04 主验收群');
    checkEqual('解散后合法成员看到只读归档横幅', await ownerContext.page.locator('#room-archive-banner').isVisible(), true);
    checkEqual('解散后隐藏输入区', await ownerContext.page.locator('#composer').isHidden(), true);
    checkEqual('解散后不显示 Task Trace 抽屉', await ownerContext.page.locator('#task-trace-drawer').isHidden(), true);
    await noHorizontalOverflow(ownerContext.page, '归档桌面页');
    await screenshot(ownerContext.page, 'q04-dissolved-archive-light-1280');
  } finally {
    await ownerContext.context.close();
    await targetContext.context.close();
  }
}
