/**
 * 好友申请、接收策略与申请徽标。
 *
 * 申请只进入独立收件箱，不创建房间；页面不把单侧收藏当成好友。
 * 片段由 `chatClientScript` 拼进同一个内联 `<script>`，共享作用域。
 */
export const CHAT_CONTACTS_SCRIPT = `
const contactRequestsButton = document.getElementById('contact-requests');
const contactRequestsBadge = document.getElementById('contact-requests-badge');
const contactModal = document.getElementById('contact-modal');
const contactModalClose = document.getElementById('contact-modal-close');
const contactRequestList = document.getElementById('contact-request-list');
const contactRequestStatus = document.getElementById('contact-request-status');
const contactPolicySelect = document.getElementById('contact-policy-select');
const contactPolicyStatus = document.getElementById('contact-policy-status');
const contactLinkCreateButton = document.getElementById('contact-link-create');
const contactLinkCopyButton = document.getElementById('contact-link-copy');
const contactLinkStatus = document.getElementById('contact-link-status');
const contactLinkList = document.getElementById('contact-link-list');
const contactFriendList = document.getElementById('contact-friend-list');
let contactRequestBusy = false;
let contactLinkBusy = false;
// 链接明文只在本次页面会话的内存里；不写 DOM、localStorage、console 或日志。
let contactLinkPlaintext = null;
let contactLinkLinkId = null;

function contactActorLabel(actor) {
  if (!actor || typeof actor.name !== 'string') return '未知身份';
  return actor.name + (actor.kind === 'agent' ? ' · Agent' : ' · 人');
}

function setContactStatus(message, isError) {
  if (!contactRequestStatus) return;
  contactRequestStatus.textContent = message || '';
  if (isError) contactRequestStatus.dataset.error = '1';
  else delete contactRequestStatus.dataset.error;
}

function contactButton(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', handler);
  return button;
}

function renderContactRequests(items) {
  if (!contactRequestList) return;
  contactRequestList.replaceChildren();
  const pending = (items || []).filter(function (item) {
    return item && item.status === 'pending';
  });
  if (pending.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'contact-request-empty';
    empty.textContent = '没有待处理的好友申请。';
    contactRequestList.append(empty);
    return;
  }
  for (const item of pending) {
    const row = document.createElement('li');
    row.className = 'contact-request-item';
    const main = document.createElement('div');
    main.className = 'contact-request-main';
    const title = document.createElement('p');
    title.className = 'contact-request-title';
    const forManagedAgent = item.direction === 'incoming' &&
      item.to_actor && identity && item.to_actor.actor_id !== identity.actor_id;
    title.textContent = item.direction === 'incoming'
      ? contactActorLabel(item.from_actor) +
        (forManagedAgent
          ? ' 请求添加 ' + contactActorLabel(item.to_actor) + ' 为好友'
          : ' 请求添加你为好友')
      : '你向 ' + contactActorLabel(item.to_actor) + ' 发送了好友申请';
    main.append(title);
    if (item.message) {
      const message = document.createElement('p');
      message.className = 'contact-request-message';
      message.textContent = item.message;
      main.append(message);
    }
    const meta = document.createElement('p');
    meta.className = 'contact-request-meta';
    meta.textContent = item.auto_accepted ? '已自动建立' : '等待确认';
    main.append(meta);
    row.append(main);

    const actions = document.createElement('div');
    actions.className = 'contact-request-actions';
    if (item.direction === 'incoming' && item.can_respond) {
      actions.append(contactButton('接受', 'primary', function () {
        respondContactRequest(item.contact_request_id, 'accept');
      }));
      actions.append(contactButton('拒绝', '', function () {
        respondContactRequest(item.contact_request_id, 'reject');
      }));
    }
    if (item.can_cancel) {
      actions.append(contactButton('撤销申请', '', function () {
        cancelContactRequest(item.contact_request_id);
      }));
    }
    row.append(actions);
    contactRequestList.append(row);
  }
}

async function refreshContactBadge() {
  if (!identity || !contactRequestsButton) return;
  try {
    const result = await callTool('network_contact_requests_list', {
      direction: 'incoming',
      status: 'pending',
      limit: 50
    });
    const count = (result.items || []).length;
    if (contactRequestsBadge) {
      contactRequestsBadge.textContent = String(count);
      contactRequestsBadge.hidden = count === 0;
    }
    contactRequestsButton.title = count > 0 ? '好友申请（' + count + '）' : '好友申请';
  } catch (error) {
    if (contactRequestsBadge) contactRequestsBadge.hidden = true;
  }
}

async function loadContactRequests() {
  if (!contactRequestList) return;
  try {
    const result = await callTool('network_contact_requests_list', {
      direction: 'all',
      status: 'pending',
      limit: 50
    });
    renderContactRequests(result.items || []);
  } catch (error) {
    renderContactRequests([]);
    setContactStatus('读取好友申请失败：' + (error && error.message ? error.message : String(error)), true);
  }
}

async function loadContactPolicy() {
  if (!contactPolicySelect) return;
  try {
    const policy = await callTool('network_contact_policy_get', {});
    contactPolicySelect.value = policy && policy.policy === 'auto_accept'
      ? 'auto_accept'
      : 'self_approval';
    if (contactPolicyStatus) {
      contactPolicyStatus.textContent = policy && policy.policy === 'auto_accept'
        ? '自动接受所有好友申请（包括陌生 Agent）。'
        : '好友申请需要你本人确认。';
    }
  } catch (error) {
    if (contactPolicyStatus) contactPolicyStatus.textContent = '读取接收策略失败。';
  }
}

async function respondContactRequest(contactRequestId, action) {
  if (contactRequestBusy) return;
  contactRequestBusy = true;
  setContactStatus(action === 'accept' ? '正在接受…' : '正在拒绝…');
  try {
    await callTool('network_contact_request_respond', {
      request_id: requestId('web_contact_respond'),
      contact_request_id: contactRequestId,
      action: action
    });
    setContactStatus(action === 'accept' ? '已接受好友申请。' : '已拒绝好友申请。');
    await loadContactRequests();
    await refreshContactBadge();
    scheduleRoomListRefresh(true);
  } catch (error) {
    setContactStatus('处理失败：' + (error && error.message ? error.message : String(error)), true);
  } finally {
    contactRequestBusy = false;
  }
}

async function cancelContactRequest(contactRequestId) {
  if (contactRequestBusy) return;
  contactRequestBusy = true;
  setContactStatus('正在撤销…');
  try {
    await callTool('network_contact_request_cancel', {
      request_id: requestId('web_contact_cancel'),
      contact_request_id: contactRequestId
    });
    setContactStatus('已撤销好友申请。');
    await loadContactRequests();
    await refreshContactBadge();
  } catch (error) {
    setContactStatus('撤销失败：' + (error && error.message ? error.message : String(error)), true);
  } finally {
    contactRequestBusy = false;
  }
}

async function saveContactPolicy() {
  if (!contactPolicySelect || !identity) return;
  try {
    await callTool('network_contact_policy_set', {
      request_id: requestId('web_contact_policy'),
      policy: contactPolicySelect.value
    });
    await loadContactPolicy();
  } catch (error) {
    if (contactPolicyStatus) {
      contactPolicyStatus.textContent = '保存失败：' +
        (error && error.message ? error.message : String(error));
    }
  }
}

function contactLinkTime(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return '';
  try {
    return date.toLocaleString();
  } catch (error) {
    return date.toISOString();
  }
}

function setContactLinkStatus(message, kind) {
  if (!contactLinkStatus) return;
  contactLinkStatus.textContent = message || '';
  if (kind === 'error') contactLinkStatus.dataset.error = '1';
  else delete contactLinkStatus.dataset.error;
  if (kind === 'success') contactLinkStatus.dataset.success = '1';
  else delete contactLinkStatus.dataset.success;
}

function showContactLinkBanner(message, isError) {
  const banner = document.getElementById('contact-link-banner');
  if (!banner) return;
  banner.textContent = message || '';
  banner.hidden = !message;
  if (isError) banner.dataset.error = '1';
  else delete banner.dataset.error;
}

function contactLinkReasonMessage(reason) {
  if (reason === 'expired') return '好友链接已过期，请让对方重新生成。';
  if (reason === 'used') return '好友链接已被使用，每个链接只能添加一次好友。';
  if (reason === 'revoked') return '好友链接已被撤销，请让对方重新生成。';
  return '好友链接无效或不存在。';
}

/** 未登录页面在没有身份时用临时 token 预览；不写 localStorage，也不注册。 */
async function previewContactLinkToken(token) {
  const candidate = crypto.randomUUID();
  return callTool('network_contact_link_preview', { token: token }, candidate);
}

function contactLinkStatusText(link) {
  if (!link) return '';
  if (link.status === 'used') {
    const usedBy = link.used_by && link.used_by.name ? ' · ' + link.used_by.name : '';
    return '已使用' + usedBy;
  }
  if (link.status === 'revoked') return '已撤销';
  if (link.status === 'expired') return '已过期';
  return '待使用 · 有效至 ' + contactLinkTime(link.expires_at);
}

function renderContactLinks(items) {
  if (!contactLinkList) return;
  contactLinkList.replaceChildren();
  const links = items || [];
  if (links.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'contact-request-empty';
    empty.textContent = '还没有生成好友链接。';
    contactLinkList.append(empty);
    return;
  }
  for (const link of links) {
    const row = document.createElement('li');
    row.className = 'contact-link-item';
    const meta = document.createElement('span');
    meta.className = 'contact-link-meta';
    meta.textContent = contactLinkStatusText(link);
    row.append(meta);
    if (link.can_revoke) {
      row.append(contactButton('撤销', '', function () {
        revokeContactLink(link.link_id);
      }));
    }
    contactLinkList.append(row);
  }
}

async function loadContactLinks() {
  if (!contactLinkList || !identity) return;
  try {
    const result = await callTool('network_contact_link_list', { limit: 50 });
    renderContactLinks(result.items || []);
  } catch (error) {
    renderContactLinks([]);
    setContactLinkStatus(
      '读取好友链接失败：' + (error && error.message ? error.message : String(error)),
      'error'
    );
  }
}

function renderContactFriends(items) {
  if (!contactFriendList) return;
  contactFriendList.replaceChildren();
  const friends = (items || []).filter(function (item) {
    return item && item.relation === 'active';
  });
  if (friends.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'contact-request-empty';
    empty.textContent = '还没有好友。';
    contactFriendList.append(empty);
    return;
  }
  for (const friend of friends) {
    const row = document.createElement('li');
    row.className = 'contact-request-item';
    const main = document.createElement('div');
    main.className = 'contact-request-main';
    const title = document.createElement('p');
    title.className = 'contact-request-title';
    title.textContent = contactActorLabel(friend);
    main.append(title);
    row.append(main);
    addDirectChatAction(row, friend);
    contactFriendList.append(row);
  }
}

async function loadContactFriends() {
  if (!contactFriendList || !identity) return;
  try {
    const result = await callTool('network_contacts_list', { limit: 100 });
    renderContactFriends(result.items || []);
  } catch (error) {
    renderContactFriends([]);
  }
}

async function createContactLink() {
  if (contactLinkBusy) return;
  contactLinkBusy = true;
  setContactLinkStatus('正在生成好友链接…');
  try {
    const result = await callTool('network_contact_link_create', {
      request_id: requestId('web_contact_link')
    });
    if (!result || typeof result.share_url !== 'string' || !result.share_url) {
      throw new Error('服务端未返回可复制的链接');
    }
    contactLinkPlaintext = result.share_url;
    contactLinkLinkId = result.link ? result.link.link_id : null;
    if (contactLinkCopyButton) contactLinkCopyButton.hidden = false;
    setContactLinkStatus(
      '链接已生成，24 小时内有效、只能使用一次。点击“复制链接”发给对方。',
      'success'
    );
    await loadContactLinks();
  } catch (error) {
    setContactLinkStatus(
      '生成失败：' + (error && error.message ? error.message : String(error)),
      'error'
    );
  } finally {
    contactLinkBusy = false;
  }
}

function copyContactLink() {
  if (!contactLinkPlaintext) {
    setContactLinkStatus('链接明文只保留在本次页面会话；请重新生成后再复制。', 'error');
    return;
  }
  pairingCopyText(contactLinkPlaintext, function () {
    setContactLinkStatus('已复制。链接只能使用一次，请通过可信渠道发送。', 'success');
  }, function (error) {
    setContactLinkStatus(
      '复制失败：' + (error && error.message ? error.message : '浏览器拒绝了复制操作'),
      'error'
    );
  });
}

async function revokeContactLink(linkId) {
  if (contactLinkBusy) return;
  contactLinkBusy = true;
  setContactLinkStatus('正在撤销…');
  try {
    const result = await callTool('network_contact_link_revoke', {
      request_id: requestId('web_contact_link_revoke'),
      link_id: linkId
    });
    if (contactLinkLinkId === linkId) {
      contactLinkPlaintext = null;
      contactLinkLinkId = null;
      if (contactLinkCopyButton) contactLinkCopyButton.hidden = true;
    }
    setContactLinkStatus(
      result && result.already_revoked ? '该链接已经撤销。' : '已撤销好友链接。',
      'success'
    );
    await loadContactLinks();
  } catch (error) {
    setContactLinkStatus(
      '撤销失败：' + (error && error.message ? error.message : String(error)),
      'error'
    );
  } finally {
    contactLinkBusy = false;
  }
}

/**
 * 身份就绪后兑换好友链接：直接建立双向关系，不创建申请。
 *
 * 失败只显示可读提示，不重试、不自动换身份；token 不写入 DOM 或日志。
 */
async function redeemContactLinkToken(token) {
  if (!token) return;
  window.__agentNetworkAllowRegister = false;
  try {
    const result = await callTool('network_contact_link_redeem', {
      request_id: requestId('web_contact_link_redeem'),
      token: token
    });
    const ownerName = result && result.owner && result.owner.name ? result.owner.name : '对方';
    showContactLinkBanner(
      (result && result.already_friends ? '已是好友：' : '已添加好友：') + ownerName,
      false
    );
    await Promise.allSettled([
      loadRooms(),
      loadContactFriends(),
      loadContactLinks(),
      refreshContactBadge()
    ]);
    scheduleRoomListRefresh(true);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    showContactLinkBanner('添加好友失败：' + message, true);
  }
}

/**
 * 无效/过期链接的首页：不创建身份，只提供显式“创建新身份并继续”。
 *
 * 复用退出登录首页的按钮与无障碍结构，但不声称是退出登录。
 */
function showContactLinkBlockedHome(message) {
  showLoggedOutHome();
  const detail = '好友链接不可用：' + message + ' 本机没有自动创建替代身份。';
  setEmptyListMessage(detail + ' 如仍需使用，请点击“创建新身份并继续”。');
  const emptyTitle = document.getElementById('empty-title');
  if (emptyTitle) emptyTitle.textContent = '好友链接不可用';
  const emptyHint = document.getElementById('empty-hint');
  if (emptyHint) {
    emptyHint.textContent = message + ' 创建新身份不会使用该链接。';
  }
  showContactLinkBanner(detail, true);
}

/** 已退出登录：先预览，有效时在显式创建身份后自动兑换。 */
async function prepareContactLinkOnLoggedOut(token) {
  let preview = null;
  try {
    preview = await previewContactLinkToken(token);
  } catch (error) {
    preview = null;
  }
  if (!preview || !preview.valid) {
    showContactLinkBlockedHome(contactLinkReasonMessage(preview ? preview.reason : 'invalid'));
    return;
  }
  const ownerName = preview.owner && preview.owner.name ? preview.owner.name : '对方';
  showContactLinkBanner(
    '好友链接有效：在本次页面创建或登录身份后会自动添加 ' + ownerName + ' 为好友。',
    false
  );
}

async function openContactModal() {
  if (!contactModal) return;
  contactModal.hidden = false;
  setContactStatus('');
  setContactLinkStatus('');
  const directStatus = document.getElementById('direct-chat-status');
  if (directStatus) directStatus.textContent = '';
  renderContactRequests([]);
  if (contactLinkPlaintext) {
    setContactLinkStatus('链接明文只保留在本次页面会话，可继续复制或撤销。', 'success');
  }
  await Promise.allSettled([
    loadContactRequests(),
    loadContactPolicy(),
    loadContactLinks(),
    loadContactFriends()
  ]);
  if (contactModalClose) contactModalClose.focus();
}

function closeContactModal() {
  if (!contactModal) return;
  contactModal.hidden = true;
  if (contactRequestsButton) contactRequestsButton.focus();
}

if (contactRequestsButton) {
  contactRequestsButton.addEventListener('click', openContactModal);
}
if (contactModalClose) {
  contactModalClose.addEventListener('click', closeContactModal);
}
if (contactModal) {
  contactModal.addEventListener('click', function (event) {
    if (event.target === contactModal) closeContactModal();
  });
}
if (contactPolicySelect) {
  contactPolicySelect.addEventListener('change', saveContactPolicy);
}
if (contactLinkCreateButton) {
  contactLinkCreateButton.addEventListener('click', createContactLink);
}
if (contactLinkCopyButton) {
  contactLinkCopyButton.addEventListener('click', copyContactLink);
}
`;
