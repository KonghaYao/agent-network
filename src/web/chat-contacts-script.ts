import { LIMITS } from '../contracts/limits';

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
const contactSegments = document.getElementById('contact-segments');
const contactTabs = contactSegments
  ? Array.prototype.slice.call(contactSegments.querySelectorAll('[data-contact-tab]'))
  : [];
const contactPanels = {
  search: document.getElementById('contact-panel-search'),
  requests: document.getElementById('contact-panel-requests'),
  more: document.getElementById('contact-panel-more')
};
const contactRequestList = document.getElementById('contact-request-list');
const contactRequestCount = document.getElementById('contact-request-count');
const contactRequestMore = document.getElementById('contact-request-more');
const contactRequestStatus = document.getElementById('contact-request-status');
const contactSearchForm = document.getElementById('contact-search-form');
const contactSearchInput = document.getElementById('contact-search-input');
const contactSearchSubmit = document.getElementById('contact-search-submit');
const contactSearchStatus = document.getElementById('contact-search-status');
const contactSearchResults = document.getElementById('contact-search-results');
const contactSearchConfirm = document.getElementById('contact-search-confirm');
const contactSearchConfirmName = document.getElementById('contact-search-confirm-name');
const contactSearchConfirmId = document.getElementById('contact-search-confirm-id');
const contactSearchMessage = document.getElementById('contact-search-message');
const contactSearchCancel = document.getElementById('contact-search-cancel');
const contactSearchSend = document.getElementById('contact-search-send');
const contactPolicySelect = document.getElementById('contact-policy-select');
const contactPolicyStatus = document.getElementById('contact-policy-status');
const contactLinkCreateButton = document.getElementById('contact-link-create');
const contactLinkCopyButton = document.getElementById('contact-link-copy');
const contactLinkStatus = document.getElementById('contact-link-status');
const contactLinkList = document.getElementById('contact-link-list');
let contactRequestBusy = false;
let contactRequestItems = [];
let contactRequestCursor = null;
let contactRequestLoading = false;
let contactRequestGeneration = 0;
let contactSearchBusy = false;
let contactSearchAbort = null;
let contactSearchGeneration = 0;
let contactSearchSelection = null;
let contactSearchLastQuery = '';
let contactLinkBusy = false;
let contactBadgePromise = null;
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

function setContactCount(element, count) {
  if (!element) return;
  element.textContent = String(count);
  element.hidden = count === 0;
}

/**
 * 分段切换只改变可见性，不移除 DOM：搜索输入、结果与申请列表在切换后
 * 原样保留，返回分段时不需要重新请求。
 */
function setContactTab(name) {
  if (name !== 'search' && name !== 'requests' && name !== 'more') return;
  for (const tab of contactTabs) {
    const active = tab.dataset.contactTab === name;
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
    tab.tabIndex = active ? 0 : -1;
  }
  Object.keys(contactPanels).forEach(function (key) {
    const panel = contactPanels[key];
    if (panel) panel.hidden = key !== name;
  });
}

function contactButton(label, className, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', handler);
  return button;
}

function setContactSearchStatus(message, kind) {
  if (!contactSearchStatus) return;
  contactSearchStatus.textContent = message || '';
  if (kind === 'error') contactSearchStatus.dataset.error = '1';
  else delete contactSearchStatus.dataset.error;
  if (kind === 'success') contactSearchStatus.dataset.success = '1';
  else delete contactSearchStatus.dataset.success;
}

function resetContactSearchSelection() {
  contactSearchSelection = null;
  if (contactSearchConfirm) contactSearchConfirm.hidden = true;
  if (contactSearchConfirmName) contactSearchConfirmName.textContent = '';
  if (contactSearchConfirmId) contactSearchConfirmId.textContent = '';
  if (contactSearchMessage) contactSearchMessage.value = '';
}

function selectContactSearchItem(item) {
  if (!item || !item.actor || !item.actor.actor_id) return;
  contactSearchSelection = {
    actor_id: item.actor.actor_id,
    name: item.actor.name || '未命名用户'
  };
  if (contactSearchConfirmName) contactSearchConfirmName.textContent = contactSearchSelection.name;
  if (contactSearchConfirmId) contactSearchConfirmId.textContent = contactSearchSelection.actor_id;
  if (contactSearchConfirm) contactSearchConfirm.hidden = false;
  if (contactSearchMessage) contactSearchMessage.focus();
}

function contactSearchStateText(item) {
  if (item && item.relation === 'active') return '已是好友';
  if (item && item.pending_request) {
    return item.pending_request.direction === 'incoming' ? '待你接受' : '邀请已发送';
  }
  return '';
}

function renderContactSearchResults(items) {
  if (!contactSearchResults) return;
  contactSearchResults.replaceChildren();
  const matches = Array.isArray(items) ? items : [];
  if (matches.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'contact-search-empty';
    empty.textContent = '没有找到匹配的用户。';
    contactSearchResults.append(empty);
    return;
  }
  for (const item of matches) {
    if (!item || !item.actor) continue;
    const row = document.createElement('li');
    row.className = 'contact-search-item';
    const main = document.createElement('div');
    main.className = 'contact-search-main';
    const heading = document.createElement('div');
    heading.className = 'contact-search-heading';
    const name = document.createElement('strong');
    name.className = 'contact-search-name';
    name.textContent = item.actor.name || '未命名用户';
    heading.append(name);
    if (item.actor.kind === 'agent') {
      const kind = document.createElement('span');
      kind.className = 'contact-search-kind';
      kind.textContent = 'Agent';
      heading.append(kind);
    }
    const id = document.createElement('code');
    id.className = 'contact-search-id';
    id.textContent = item.actor.actor_id || '';
    main.append(heading, id);
    row.append(main);

    const stateText = contactSearchStateText(item);
    if (stateText) {
      const state = document.createElement('span');
      state.className = 'contact-search-state';
      state.textContent = stateText;
      row.append(state);
    } else {
      row.append(contactButton('核对 ID', '', function () {
        selectContactSearchItem(item);
      }));
    }
    contactSearchResults.append(row);
  }
}

async function performContactSearch() {
  if (contactSearchBusy || !contactSearchInput || !identity) return;
  const query = contactSearchInput.value.trim();
  if (!query) {
    renderContactSearchResults([]);
    setContactSearchStatus('请输入用户名。', 'error');
    resetContactSearchSelection();
    return;
  }
  contactSearchBusy = true;
  contactSearchLastQuery = query;
  const generation = contactSearchGeneration;
  const abort = new AbortController();
  contactSearchAbort = abort;
  if (contactSearchSubmit) contactSearchSubmit.disabled = true;
  setContactSearchStatus('正在搜索…');
  resetContactSearchSelection();
  try {
    const result = await callTool(
      'network_contact_search',
      { query: query, limit: ${LIMITS.contactSearchPageDefault} },
      undefined,
      abort.signal
    );
    if (
      generation !== contactSearchGeneration ||
      !contactModal ||
      contactModal.hidden ||
      contactSearchInput.value.trim() !== query
    ) return;
    renderContactSearchResults(result && result.items ? result.items : []);
    if (result && result.truncated) {
      setContactSearchStatus('结果较多，仅显示前 ${LIMITS.contactSearchPageDefault} 条；请补充用户名继续缩小范围。');
    } else {
      const count = result && Array.isArray(result.items) ? result.items.length : 0;
      setContactSearchStatus(count > 0 ? '找到 ' + count + ' 位用户，请核对 ID。' : '没有找到匹配的用户。');
    }
  } catch (error) {
    if (
      generation !== contactSearchGeneration ||
      !contactModal ||
      contactModal.hidden ||
      contactSearchInput.value.trim() !== query
    ) return;
    renderContactSearchResults([]);
    setContactSearchStatus(
      '搜索失败：' + (error && error.message ? error.message : String(error)),
      'error'
    );
  } finally {
    if (contactSearchAbort === abort) {
      contactSearchAbort = null;
      contactSearchBusy = false;
      if (contactSearchSubmit && generation === contactSearchGeneration) {
        contactSearchSubmit.disabled = false;
      }
    }
  }
}

async function sendContactSearchRequest() {
  if (contactRequestBusy || !contactSearchSelection || !identity) return;
  const selected = contactSearchSelection;
  const generation = contactSearchGeneration;
  const message = contactSearchMessage ? contactSearchMessage.value.trim() : '';
  contactRequestBusy = true;
  if (contactSearchSend) contactSearchSend.disabled = true;
  setContactSearchStatus('正在发送好友邀请…');
  try {
    const result = await callTool('network_contact_request', {
      request_id: requestId('web_contact_search_request'),
      actor_id: selected.actor_id,
      ...(message ? { message: message } : {})
    });
    if (generation !== contactSearchGeneration || !contactModal || contactModal.hidden) {
      if (result && (result.already_friends || result.status === 'accepted')) {
        scheduleRoomListRefresh(true);
      }
      return;
    }
    await Promise.allSettled([loadContactRequests(), refreshContactBadge()]);
    if (generation !== contactSearchGeneration || contactModal.hidden) return;
    if (contactSearchInput && contactSearchInput.value.trim() === contactSearchLastQuery) {
      await performContactSearch();
    }
    if (result && (result.already_friends || result.status === 'accepted')) {
      setContactSearchStatus('已完成添加：' + selected.name + '。', 'success');
      scheduleRoomListRefresh(true);
    } else {
      setContactSearchStatus('好友邀请已发送，等待对方同意。', 'success');
    }
  } catch (error) {
    if (generation !== contactSearchGeneration || !contactModal || contactModal.hidden) return;
    setContactSearchStatus(
      '发送失败：' + (error && error.message ? error.message : String(error)),
      'error'
    );
  } finally {
    contactRequestBusy = false;
    if (contactSearchSend && contactModal && !contactModal.hidden) {
      contactSearchSend.disabled = false;
    }
  }
}

function renderContactRequests(items, hasMore) {
  if (!contactRequestList) return;
  contactRequestList.replaceChildren();
  const pending = (items || []).filter(function (item) {
    return item && item.status === 'pending';
  });
  setContactCount(contactRequestCount, pending.length);
  if (hasMore && contactRequestCount) contactRequestCount.textContent = pending.length + '+';
  if (contactRequestMore) contactRequestMore.hidden = !hasMore;
  if (pending.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'contact-request-empty';
    empty.textContent = '暂无待处理申请。';
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

/**
 * 好友申请角标依赖身份，但不再因调用时机过早而永久错过。
 *
 * 未就绪时等待同一个 ensureIdentity（single-flight）；身份成功后才发
 * 请求。并发调用共享一次请求，失败静默隐藏角标，不阻塞聊天。
 */
function refreshContactBadge() {
  if (!contactRequestsButton) return Promise.resolve();
  if (contactBadgePromise) return contactBadgePromise;
  contactBadgePromise = (async function () {
    if (isLoggedOut()) return;
    try {
      if (!identity) await ensureIdentity();
    } catch (error) {
      return;
    }
    if (!identity || isLoggedOut()) return;
    try {
      const result = await callTool('network_contact_requests_list', {
        direction: 'incoming',
        status: 'pending',
        limit: 50
      });
      const count = (result.items || []).length;
      if (contactRequestsBadge) {
        contactRequestsBadge.textContent = String(count) + (result.has_more ? '+' : '');
        contactRequestsBadge.hidden = count === 0;
      }
      contactRequestsButton.title = count > 0
        ? '添加好友（' + count + (result.has_more ? ' 条以上' : ' 条') + '待处理申请）'
        : '添加好友';
    } catch (error) {
      if (contactRequestsBadge) contactRequestsBadge.hidden = true;
    }
  })().finally(function () {
    contactBadgePromise = null;
  });
  return contactBadgePromise;
}

async function loadContactRequests(more) {
  if (!contactRequestList) return;
  if (more && (!contactRequestCursor || contactRequestLoading)) return;
  const generation = ++contactRequestGeneration;
  const cursor = more ? contactRequestCursor : null;
  contactRequestLoading = true;
  if (contactRequestMore) contactRequestMore.disabled = true;
  try {
    const result = await callTool('network_contact_requests_list', {
      direction: 'all',
      status: 'pending',
      limit: 50,
      ...(cursor ? { cursor: cursor } : {})
    });
    if (generation !== contactRequestGeneration) return;
    contactRequestItems = more ? contactRequestItems.concat(result.items || []) : result.items || [];
    contactRequestCursor = result.next_cursor || null;
    renderContactRequests(contactRequestItems, Boolean(contactRequestCursor));
  } catch (error) {
    if (generation !== contactRequestGeneration) return;
    if (!more) {
      contactRequestItems = [];
      contactRequestCursor = null;
      renderContactRequests([]);
    }
    setContactStatus('读取好友申请失败：' + (error && error.message ? error.message : String(error)), true);
  } finally {
    if (generation === contactRequestGeneration) {
      contactRequestLoading = false;
      if (contactRequestMore) contactRequestMore.disabled = false;
    }
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
    if (contactSearchInput && contactSearchInput.value.trim()) await performContactSearch();
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
    if (contactSearchInput && contactSearchInput.value.trim()) await performContactSearch();
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
  if (link.status === 'used') return '已使用';
  if (link.status === 'revoked') return '已撤销';
  if (link.status === 'expired') return '已过期';
  return '待使用';
}

function contactLinkDetailText(link) {
  if (!link) return '';
  if (link.status === 'used') {
    return link.used_by && link.used_by.name
      ? '由 ' + link.used_by.name + ' 使用'
      : '已被使用';
  }
  if (link.status === 'revoked') return '';
  return '有效至 ' + contactLinkTime(link.expires_at);
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
    const main = document.createElement('div');
    main.className = 'contact-link-main';
    const state = document.createElement('span');
    state.className = 'contact-link-state';
    state.dataset.status = link.status || 'pending';
    state.textContent = contactLinkStatusText(link);
    main.append(state);
    const detail = contactLinkDetailText(link);
    if (detail) {
      const meta = document.createElement('span');
      meta.className = 'contact-link-meta';
      meta.textContent = detail;
      main.append(meta);
    }
    row.append(main);
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
  setContactTab('search');
  contactSearchGeneration += 1;
  const openGeneration = contactSearchGeneration;
  if (contactSearchAbort) contactSearchAbort.abort();
  contactSearchAbort = null;
  contactSearchBusy = false;
  contactSearchLastQuery = '';
  if (contactSearchInput) contactSearchInput.value = '';
  if (contactSearchSubmit) contactSearchSubmit.disabled = false;
  if (contactSearchSend) contactSearchSend.disabled = contactRequestBusy;
  if (contactSearchResults) contactSearchResults.replaceChildren();
  resetContactSearchSelection();
  setContactSearchStatus('');
  contactModal.hidden = false;
  setContactStatus('');
  setContactLinkStatus('');
  contactRequestGeneration += 1;
  contactRequestItems = [];
  contactRequestCursor = null;
  renderContactRequests([]);
  if (contactLinkPlaintext) {
    setContactLinkStatus('链接明文只保留在本次页面会话，可继续复制或撤销。', 'success');
  }
  await Promise.allSettled([
    loadContactRequests(),
    loadContactPolicy(),
    loadContactLinks()
  ]);
  if (openGeneration !== contactSearchGeneration || contactModal.hidden) return;
  if (contactSearchInput && contactPanels.search && !contactPanels.search.hidden) {
    contactSearchInput.focus();
  }
}

function closeContactModal() {
  if (!contactModal) return;
  contactSearchGeneration += 1;
  contactRequestGeneration += 1;
  contactRequestLoading = false;
  if (contactSearchAbort) contactSearchAbort.abort();
  contactSearchAbort = null;
  contactSearchBusy = false;
  contactModal.hidden = true;
  resetContactSearchSelection();
  if (contactRequestsButton) contactRequestsButton.focus();
}

if (contactRequestsButton) {
  contactRequestsButton.addEventListener('click', openContactModal);
}
if (contactRequestMore) {
  contactRequestMore.addEventListener('click', function () { loadContactRequests(true); });
}
if (contactModalClose) {
  contactModalClose.addEventListener('click', closeContactModal);
}
if (contactSegments) {
  contactSegments.addEventListener('click', function (event) {
    const tab = event.target && event.target.closest
      ? event.target.closest('[data-contact-tab]')
      : null;
    if (!tab) return;
    setContactTab(tab.dataset.contactTab);
  });
  contactSegments.addEventListener('keydown', function (event) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) < 0) return;
    event.preventDefault();
    const index = contactTabs.findIndex(function (tab) {
      return tab.getAttribute('aria-selected') === 'true';
    });
    let next = index;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = contactTabs.length - 1;
    else if (event.key === 'ArrowLeft') next = (index - 1 + contactTabs.length) % contactTabs.length;
    else next = (index + 1) % contactTabs.length;
    const target = contactTabs[next];
    if (!target) return;
    setContactTab(target.dataset.contactTab);
    target.focus();
  });
}
if (contactModal) {
  contactModal.addEventListener('click', function (event) {
    if (event.target === contactModal) closeContactModal();
  });
}
if (contactSearchForm) {
  contactSearchForm.addEventListener('submit', function (event) {
    event.preventDefault();
    performContactSearch();
  });
}
if (contactSearchInput) {
  contactSearchInput.addEventListener('input', function () {
    if (contactSearchInput.value.trim() === contactSearchLastQuery) return;
    if (contactSearchAbort) contactSearchAbort.abort();
    contactSearchAbort = null;
    contactSearchBusy = false;
    if (contactSearchSubmit) contactSearchSubmit.disabled = false;
    if (contactSearchResults) contactSearchResults.replaceChildren();
    resetContactSearchSelection();
    setContactSearchStatus('');
  });
}
if (contactSearchCancel) {
  contactSearchCancel.addEventListener('click', function () {
    resetContactSearchSelection();
    if (contactSearchInput) contactSearchInput.focus();
  });
}
if (contactSearchSend) {
  contactSearchSend.addEventListener('click', sendContactSearchRequest);
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
