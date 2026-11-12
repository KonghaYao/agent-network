/**
 * A06 Agent 管理权交接面板。
 *
 * 入口在 direct Agent 会话右键菜单。所有数据通过公开 MCP 工具读取；面板
 * 只展示该 Agent 的管理范围与在途工作，不读取原管理者的私聊或联系人。
 * 接受后新 token 只在本次响应出现一次，关闭面板即从 DOM 清除。
 */
export const CHAT_TRANSFER_SCRIPT = `
const TRANSFER_MODAL_ID = 'transfer-modal';
const TRANSFER_TOKEN_WARNING =
  '新 token 只显示一次；只通过受控渠道配置，勿发群、截图或写日志。旧 token 已立即失效。';
const TRANSFER_PERMISSION_DENIED =
  '只有该 Agent 的管理者、受托人或待确认接任者可以查看交接。';

let transferAgentId = '';
let transferView = null;
let transferContacts = null;
let transferSelected = '';
let transferBusy = false;
let transferOpener = null;

function transferNode(id) {
  return document.getElementById(id);
}

function transferStatus(text, isError) {
  const node = transferNode('transfer-status');
  if (!node) return;
  node.textContent = text || '';
  node.hidden = !text;
  node.classList.toggle('error', Boolean(isError));
}

/** 权限错误只显示可执行的下一步，不把服务端内部文案直接抛给用户。 */
function transferFailureText(error) {
  if (error && error.code === 'PERMISSION_DENIED') return TRANSFER_PERMISSION_DENIED;
  return error && error.message ? error.message : String(error);
}

function transferReset() {
  const body = transferNode('transfer-body');
  if (body) body.hidden = true;
  const loading = transferNode('transfer-loading');
  if (loading) loading.hidden = false;
  const tokenPanel = transferNode('transfer-token-panel');
  if (tokenPanel) tokenPanel.hidden = true;
  const token = transferNode('transfer-token');
  if (token) token.value = '';
  transferStatus('', false);
}

function transferClose() {
  const modal = transferNode(TRANSFER_MODAL_ID);
  if (!modal || !modal.open) return;
  closeNativeDialog(modal);
  // token 只显示一次：关闭时立即从 DOM 清除，不留在隐藏输入框里。
  const token = transferNode('transfer-token');
  if (token) token.value = '';
  transferAgentId = '';
  transferView = null;
  transferContacts = null;
  transferSelected = '';
  transferBusy = false;
  const opener = transferOpener;
  transferOpener = null;
  if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
}

async function transferLoad() {
  const agentId = transferAgentId;
  if (!agentId) return;
  transferReset();
  const view = await callTool('network_agent_management_get', { actor_id: agentId });
  if (agentId !== transferAgentId) return;
  transferView = view;
  transferRender();
}

function transferRender() {
  const view = transferView;
  if (!view) return;
  transferNode('transfer-loading').hidden = true;
  transferNode('transfer-body').hidden = false;
  const managerName = view.management ? view.management.manager_name : '未知';
  const roleText =
    view.my_role === 'manager'
      ? '你是当前管理者'
      : view.my_role === 'successor'
        ? '你是待确认的接任者'
        : view.my_role === 'delegate'
          ? '你是受托管理人'
          : '你是该 Agent 本人';
  const summary = transferNode('transfer-summary');
  if (summary) {
    summary.textContent =
      view.name + ' · ' + roleText + ' · 当前管理者：' + managerName +
      (view.management ? ' · 权限版本 ' + view.management.permission_version : '');
  }
  transferRenderPropose(view);
  transferRenderPending(view);
  transferRenderWork(view);
}

function transferRenderPropose(view) {
  const section = transferNode('transfer-propose-section');
  if (!section) return;
  section.hidden = !view.can_transfer;
  if (!view.can_transfer) return;
  if (!transferContacts) {
    transferContacts = callTool('network_contacts_list', { limit: 50 })
      .then(function (page) {
        return (page.items || []).filter(function (item) {
          return item && item.kind === 'human' && item.actor_id !== identity.actor_id;
        });
      })
      .catch(function (error) {
        transferStatus('读取好友列表失败：' + error.message, true);
        return [];
      });
  }
  transferContacts.then(function (items) {
    if (!view.can_transfer) return;
    transferRenderSuccessors(items);
  });
}

function transferRenderSuccessors(items) {
  const list = transferNode('transfer-successors');
  const empty = transferNode('transfer-successors-empty');
  const search = transferNode('transfer-successor-search');
  if (!list || !empty || !search) return;
  const query = search.value.trim();
  const matched = items.filter(function (item) {
    return query === '' || item.name.indexOf(query) >= 0 || item.actor_id === transferSelected;
  });
  list.textContent = '';
  for (const item of matched) {
    const row = document.createElement('li');
    const label = document.createElement('label');
    label.className = 'transfer-successor';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'transfer-successor';
    radio.value = item.actor_id;
    radio.checked = item.actor_id === transferSelected;
    radio.addEventListener('change', function () {
      transferSelected = item.actor_id;
      transferUpdateProposeButton();
    });
    const name = document.createElement('span');
    name.textContent = item.name;
    label.appendChild(radio);
    label.appendChild(name);
    row.appendChild(label);
    list.appendChild(row);
  }
  empty.hidden = matched.length > 0;
  empty.textContent = items.length === 0 ? '没有可交接的好友' : '没有匹配的好友';
  transferUpdateProposeButton();
}

function transferUpdateProposeButton() {
  const button = transferNode('transfer-propose');
  if (!button) return;
  button.disabled = transferBusy || !transferSelected;
  button.textContent = transferBusy ? '正在发起…' : '发起交接';
}

function transferRenderPending(view) {
  const section = transferNode('transfer-pending');
  if (!section) return;
  const pending = view.pending_transfer;
  section.hidden = !pending;
  if (!pending) return;
  const text = transferNode('transfer-pending-text');
  if (text) {
    text.textContent =
      '状态：' + pending.status + '；发起人：' + pending.from_manager_name +
      '；接任者：' + pending.to_manager_name;
  }
  const note = transferNode('transfer-pending-note');
  if (note) {
    const snapshot = pending.context && pending.context.snapshot ? pending.context.snapshot : {};
    note.textContent =
      '在途快照：群 ' + (snapshot.room_count || 0) + ' 个、待处理投递 ' +
      (snapshot.pending_deliveries || 0) + ' 条。接受前管理权不变。';
  }
  const accept = transferNode('transfer-accept');
  const reject = transferNode('transfer-reject');
  const cancel = transferNode('transfer-cancel');
  if (accept) accept.hidden = !pending.can_accept;
  if (reject) reject.hidden = !pending.can_reject;
  if (cancel) cancel.hidden = !pending.can_cancel;
}

function transferRenderWork(view) {
  const summary = transferNode('transfer-work-summary');
  if (summary) {
    summary.textContent =
      '待处理投递 ' + view.in_flight_deliveries.pending + ' 条（已领取 ' +
      view.in_flight_deliveries.claimed + ' 条）';
  }
  const deliveryList = transferNode('transfer-work-deliveries');
  if (deliveryList) {
    deliveryList.textContent = '';
    for (const delivery of view.in_flight_deliveries.items || []) {
      const item = document.createElement('li');
      item.textContent =
        delivery.state + ' · 房间 ' + delivery.room_id + ' · 尝试 ' + delivery.attempt;
      deliveryList.appendChild(item);
    }
  }
}

async function transferPropose() {
  if (transferBusy || !transferView || !transferSelected) return;
  transferBusy = true;
  transferUpdateProposeButton();
  transferStatus('', false);
  try {
    const transfer = await callTool('network_agent_transfer_propose', {
      request_id: 'web_transfer_' + crypto.randomUUID().replaceAll('-', ''),
      actor_id: transferAgentId,
      to_manager_id: transferSelected
    });
    transferSelected = '';
    await transferLoad();
    transferStatus('已发起交接，等待 ' + transfer.to_manager_name + ' 确认。', false);
  } catch (error) {
    transferStatus('发起交接失败：' + transferFailureText(error), true);
  } finally {
    transferBusy = false;
    transferUpdateProposeButton();
  }
}

async function transferRespond(decision) {
  if (transferBusy || !transferView || !transferView.pending_transfer) return;
  transferBusy = true;
  const accept = transferNode('transfer-accept');
  const reject = transferNode('transfer-reject');
  if (accept) accept.disabled = true;
  if (reject) reject.disabled = true;
  transferStatus('', false);
  try {
    const result = await callTool('network_agent_transfer_respond', {
      request_id: 'web_transfer_' + crypto.randomUUID().replaceAll('-', ''),
      transfer_id: transferView.pending_transfer.transfer_id,
      decision: decision
    });
    await transferLoad();
    if (decision === 'accept') {
      // transferLoad 会清空一次性面板；必须在重新渲染后再展示 token。
      transferShowToken(result);
      transferStatus('已接受管理权交接。原管理者的管理权限与旧运行凭据已失效。', false);
      // 接任者把新 MCP URL 存到自己的本地注册表；这是受控的本机渠道。
      if (result.token && result.mcp_url) {
        transferSaveRegistry(result);
      }
    } else {
      transferStatus('已拒绝交接，管理权保持不变。', false);
    }
  } catch (error) {
    transferStatus((decision === 'accept' ? '接受' : '拒绝') + '交接失败：' +
      transferFailureText(error), true);
  } finally {
    transferBusy = false;
    if (accept) accept.disabled = false;
    if (reject) reject.disabled = false;
  }
}

function transferShowToken(result) {
  const panel = transferNode('transfer-token-panel');
  const input = transferNode('transfer-token');
  const warning = transferNode('transfer-token-warning');
  if (!panel || !input) return;
  input.value = result.mcp_url || result.token || '';
  if (warning) warning.textContent = TRANSFER_TOKEN_WARNING;
  panel.hidden = false;
}

function transferSaveRegistry(result) {
  try {
    const read = agentRegistryItems(identity.actor_id);
    const next = read.items.filter(function (item) {
      return item.actor_id !== result.agent_id;
    });
    next.unshift({
      owner_actor_id: identity.actor_id,
      actor_id: result.agent_id,
      name: transferView && transferView.name ? transferView.name : result.agent_id,
      agent_session_id: null,
      created_at: String(Date.now()),
      mcp_url: result.mcp_url
    });
    agentRegistryWrite(identity.actor_id, next);
  } catch (error) {
    // 注册表失败不回滚已提交的交接；token 仍在一次性面板中。
  }
}

async function transferCancel() {
  if (transferBusy || !transferView || !transferView.pending_transfer) return;
  transferBusy = true;
  const button = transferNode('transfer-cancel');
  if (button) button.disabled = true;
  try {
    await callTool('network_agent_transfer_cancel', {
      request_id: 'web_transfer_' + crypto.randomUUID().replaceAll('-', ''),
      transfer_id: transferView.pending_transfer.transfer_id
    });
    await transferLoad();
    transferStatus('已取消交接，管理权保持不变。', false);
  } catch (error) {
    transferStatus('取消交接失败：' + transferFailureText(error), true);
  } finally {
    transferBusy = false;
    if (button) button.disabled = false;
  }
}

async function transferCopyToken() {
  const input = transferNode('transfer-token');
  if (!input || !input.value) return;
  try {
    await navigator.clipboard.writeText(input.value);
    transferStatus('已复制 MCP URL；只发给目标 Agent 的受控宿主。', false);
  } catch (error) {
    transferStatus('复制失败，请手动选择文本；不要截图或发群。', true);
  }
}

function openTransferDialog(agentId, opener) {
  if (!agentId) return;
  const modal = transferNode(TRANSFER_MODAL_ID);
  if (!modal) return;
  transferOpener = opener || document.activeElement;
  transferAgentId = agentId;
  transferView = null;
  transferContacts = null;
  transferSelected = '';
  transferBusy = false;
  openNativeDialog(modal, transferClose);
  const search = transferNode('transfer-successor-search');
  if (search) search.value = '';
  transferLoad().catch(function (error) {
    transferStatus('读取管理关系失败：' + transferFailureText(error), true);
    const loading = transferNode('transfer-loading');
    if (loading) loading.hidden = true;
  });
}

const transferButton = document.getElementById('room-menu-transfer');
if (transferButton) {
  transferButton.addEventListener('click', function () {
    const agentId = roomMenuTarget ? roomMenuTarget.peer_actor_id : '';
    const opener = roomMenuAnchor;
    closeRoomMenu();
    openTransferDialog(agentId, opener);
  });
}
const transferCloseButton = document.getElementById('transfer-close');
if (transferCloseButton) transferCloseButton.addEventListener('click', transferClose);
const transferProposeButton = document.getElementById('transfer-propose');
if (transferProposeButton) {
  transferProposeButton.addEventListener('click', function () {
    transferPropose().catch(function () {});
  });
}
const transferAcceptButton = document.getElementById('transfer-accept');
if (transferAcceptButton) {
  transferAcceptButton.addEventListener('click', async function () {
    if (!(await confirmDialog('接受后你将获得该 Agent 的管理权；原管理者立即失权，旧运行 token 失效。确定继续？',
      { title: '接受交接', danger: true, confirmText: '接受' }))) return;
    transferRespond('accept').catch(function () {});
  });
}
const transferRejectButton = document.getElementById('transfer-reject');
if (transferRejectButton) {
  transferRejectButton.addEventListener('click', function () {
    transferRespond('reject').catch(function () {});
  });
}
const transferCancelButton = document.getElementById('transfer-cancel');
if (transferCancelButton) {
  transferCancelButton.addEventListener('click', function () {
    transferCancel().catch(function () {});
  });
}
const transferCopyButton = document.getElementById('transfer-token-copy');
if (transferCopyButton) transferCopyButton.addEventListener('click', function () {
  transferCopyToken().catch(function () {});
});
const transferSearchInput = document.getElementById('transfer-successor-search');
if (transferSearchInput) {
  transferSearchInput.addEventListener('input', function () {
    if (!transferContacts) return;
    transferContacts.then(transferRenderSuccessors);
  });
}
`;
