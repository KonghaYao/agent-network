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
let contactRequestBusy = false;

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

async function openContactModal() {
  if (!contactModal) return;
  contactModal.hidden = false;
  setContactStatus('');
  renderContactRequests([]);
  await Promise.allSettled([loadContactRequests(), loadContactPolicy()]);
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
`;
