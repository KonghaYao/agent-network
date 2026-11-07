/**
 * 会话菜单里的删除好友、拉黑/解除拉黑、举报与退群入口。
 *
 * 文案必须区分四种动作：删除只结束关系，拉黑额外拒绝私聊/申请/邀请，
 * 举报只进入受控管理流程，退群只离开群且不影响好友关系。所有写操作都
 * 带唯一 request_id；拉黑与举报不会创建 delivery，也不会唤醒 Agent。
 */
export const CHAT_SAFETY_SCRIPT = `
const safetyReportButton = document.getElementById('room-menu-report');
const safetyBlockButton = document.getElementById('room-menu-block');
const safetyDeleteButton = document.getElementById('room-menu-delete-friend');
const safetyLeaveButton = document.getElementById('room-menu-leave-group');
const safetyHint = document.getElementById('room-menu-safety-hint');
const safetyReportModal = document.getElementById('report-modal');
const safetyReportTarget = document.getElementById('report-target');
const safetyReportCategory = document.getElementById('report-category');
const safetyReportNote = document.getElementById('report-note');
const safetyReportStatus = document.getElementById('report-status');
const safetyReportSubmit = document.getElementById('report-submit');
const safetyReportCancel = document.getElementById('report-cancel');
const SAFETY_BLOCK_CONFIRM =
  '拉黑后：\\n' +
  '· 立即结束当前好友关系\\n' +
  '· 拒绝新的私聊、好友申请与 direct 邀请\\n' +
  '· 不会移出共同群，也不会删除历史消息\\n' +
  '· 解除拉黑不会自动恢复好友，需要重新申请\\n\\n' +
  '共同群里来自对方的定向 @ 通知会按你的设置静默。确定拉黑？';
const SAFETY_UNBLOCK_CONFIRM =
  '解除拉黑只恢复“可以重新联系”的状态，不会自动恢复好友关系；' +
  '需要重新建立关系时必须重新申请。确定解除拉黑？';
const SAFETY_DELETE_CONFIRM =
  '删除好友会结束双方好友关系，但保留历史消息与共同群；重新建立关系需要重新申请。\\n' +
  '删除好友不会阻止对方再次申请；如需拒绝私聊与申请，请使用“拉黑”。确定删除好友？';
const SAFETY_LEAVE_CONFIRM =
  '退出群聊只离开当前群，不影响好友关系；历史消息是否仍可读由群策略决定。确定退出？';

let safetyBusy = false;
let safetyReportRoomId = null;

function safetySetStatus(message, isError) {
  const status = document.getElementById('room-menu-status');
  if (!status) return;
  status.textContent = message || '';
  status.hidden = !message;
  if (isError) status.classList.add('error');
  else status.classList.remove('error');
}

function safetyPeerOfDetail(detail) {
  const members = detail && Array.isArray(detail.members) ? detail.members : [];
  const me = identity && identity.actor_id;
  const others = members.filter(function (member) { return member && member.actor_id !== me; });
  return others.length === 1 ? others[0] : null;
}

async function safetyResolvePeer(target) {
  if (target.peer_actor_id) {
    return { actor_id: target.peer_actor_id, kind: target.peer_kind || null, name: target.roomName };
  }
  const detail = await callTool('network_room_get', { room_id: target.roomId });
  return safetyPeerOfDetail(detail);
}

async function safetyIsBlocked(peerId) {
  const page = await callTool('network_contact_blocks_list', { limit: 100 });
  const items = page && Array.isArray(page.items) ? page.items : [];
  return items.some(function (item) {
    return item && item.active && item.blocked_actor && item.blocked_actor.actor_id === peerId;
  });
}

function safetyUpdateBlockLabel(blocked) {
  if (!safetyBlockButton) return;
  safetyBlockButton.dataset.blocked = blocked ? '1' : '0';
  safetyBlockButton.textContent = blocked ? '解除拉黑' : '拉黑';
}

/**
 * 由 chat-room-menu-script 的 openRoomMenu 调用；同步切换入口可见性，
 * 再异步读取拉黑状态。菜单关闭后异步结果直接丢弃。
 */
function prepareRoomMenuSafety(target) {
  if (!target || !safetyReportButton || !safetyBlockButton) return;
  const direct = target.kind === 'direct';
  safetyReportButton.hidden = false;
  safetyBlockButton.hidden = !direct;
  safetyDeleteButton.hidden = !direct;
  safetyLeaveButton.hidden = direct;
  if (safetyHint) safetyHint.hidden = false;
  safetyUpdateBlockLabel(false);
  if (!direct) return;
  safetyResolvePeer(target)
    .then(function (peer) {
      if (!peer || roomMenuTarget !== target) return;
      return safetyIsBlocked(peer.actor_id).then(function (blocked) {
        if (roomMenuTarget === target) safetyUpdateBlockLabel(blocked);
      });
    })
    .catch(function () {
      if (roomMenuTarget === target) safetySetStatus('读取拉黑状态失败。', true);
    });
}

async function safetyToggleBlock() {
  const target = roomMenuTarget;
  if (!target || safetyBusy || target.kind !== 'direct') return;
  const blocked = safetyBlockButton && safetyBlockButton.dataset.blocked === '1';
  if (!window.confirm(blocked ? SAFETY_UNBLOCK_CONFIRM : SAFETY_BLOCK_CONFIRM)) return;
  safetyBusy = true;
  if (safetyBlockButton) safetyBlockButton.disabled = true;
  try {
    const peer = await safetyResolvePeer(target);
    if (!peer) throw new Error('无法确定单聊对方');
    if (blocked) {
      await callTool('network_contact_unblock', {
        request_id: requestId('web_contact_unblock'),
        actor_id: peer.actor_id
      });
      showToast('已解除拉黑；好友关系需要重新申请');
    } else {
      await callTool('network_contact_block', {
        request_id: requestId('web_contact_block'),
        actor_id: peer.actor_id
      });
      showToast('已拉黑；历史保留，共同群不受影响');
    }
    scheduleRoomListRefresh(true);
    closeRoomMenu();
  } catch (error) {
    safetySetStatus('操作失败：' + (error && error.message ? error.message : String(error)), true);
  } finally {
    safetyBusy = false;
    if (safetyBlockButton) safetyBlockButton.disabled = false;
  }
}

async function safetyDeleteFriend() {
  const target = roomMenuTarget;
  if (!target || safetyBusy || target.kind !== 'direct') return;
  if (!window.confirm(SAFETY_DELETE_CONFIRM)) return;
  safetyBusy = true;
  if (safetyDeleteButton) safetyDeleteButton.disabled = true;
  try {
    const peer = await safetyResolvePeer(target);
    if (!peer) throw new Error('无法确定单聊对方');
    await callTool('network_contact_remove', {
      request_id: requestId('web_contact_remove'),
      actor_id: peer.actor_id
    });
    showToast('已删除好友；历史保留，重新建联需要申请');
    scheduleRoomListRefresh(true);
    closeRoomMenu();
  } catch (error) {
    safetySetStatus('删除失败：' + (error && error.message ? error.message : String(error)), true);
  } finally {
    safetyBusy = false;
    if (safetyDeleteButton) safetyDeleteButton.disabled = false;
  }
}

async function safetyLeaveGroup() {
  const target = roomMenuTarget;
  if (!target || safetyBusy || target.kind !== 'group') return;
  if (!window.confirm(SAFETY_LEAVE_CONFIRM)) return;
  safetyBusy = true;
  if (safetyLeaveButton) safetyLeaveButton.disabled = true;
  try {
    await callTool('network_room_leave', {
      request_id: requestId('web_room_leave'),
      room_id: target.roomId
    });
    closeRoomMenu();
    window.location.assign('/');
  } catch (error) {
    safetySetStatus('退出失败：' + (error && error.message ? error.message : String(error)), true);
  } finally {
    safetyBusy = false;
    if (safetyLeaveButton) safetyLeaveButton.disabled = false;
  }
}

async function openSafetyReport() {
  const target = roomMenuTarget;
  if (!target || !safetyReportModal || !safetyReportTarget) return;
  safetyReportRoomId = target.roomId;
  if (safetyReportStatus) safetyReportStatus.textContent = '';
  if (safetyReportNote) safetyReportNote.value = '';
  if (safetyReportCategory) safetyReportCategory.value = 'harassment';
  safetyReportTarget.replaceChildren();
  closeRoomMenu();
  safetyReportModal.hidden = false;
  if (safetyReportSubmit) safetyReportSubmit.disabled = true;
  try {
    const detail = await callTool('network_room_get', { room_id: target.roomId });
    const members = detail && Array.isArray(detail.members) ? detail.members : [];
    const me = identity && identity.actor_id;
    for (const member of members) {
      if (!member || member.actor_id === me) continue;
      const option = document.createElement('option');
      option.value = member.actor_id;
      option.textContent = member.name + (member.kind === 'agent' ? ' · Agent' : ' · 人');
      safetyReportTarget.append(option);
    }
    if (!safetyReportTarget.options.length) {
      throw new Error('当前会话没有可举报的其他成员');
    }
    if (target.peer_actor_id) safetyReportTarget.value = target.peer_actor_id;
    safetyReportModal.hidden = false;
    if (safetyReportSubmit) {
      safetyReportSubmit.disabled = false;
      safetyReportSubmit.focus();
    }
  } catch (error) {
    if (safetyReportStatus) {
      safetyReportStatus.textContent =
        '无法打开举报：' + (error && error.message ? error.message : String(error));
    }
  }
}

function closeSafetyReport() {
  if (safetyReportModal) safetyReportModal.hidden = true;
}

async function submitSafetyReport() {
  if (!safetyReportTarget || !safetyReportSubmit) return;
  const targetId = safetyReportTarget.value;
  if (!targetId) {
    if (safetyReportStatus) safetyReportStatus.textContent = '请选择被举报成员。';
    return;
  }
  safetyReportSubmit.disabled = true;
  if (safetyReportStatus) safetyReportStatus.textContent = '正在提交…';
  try {
    const result = await callTool('network_contact_report', {
      request_id: requestId('web_contact_report'),
      target_actor_id: targetId,
      category: safetyReportCategory ? safetyReportCategory.value : 'other',
      ...(safetyReportNote && safetyReportNote.value.trim()
        ? { note: safetyReportNote.value.trim() }
        : {}),
      ...(safetyReportRoomId ? { room_id: safetyReportRoomId } : {})
    });
    const status = result && result.report ? result.report.status : 'received';
    if (safetyReportStatus) {
      safetyReportStatus.textContent =
        '已提交，接收状态：' + (status === 'received' ? '已接收' : status) +
        '。举报不会自动对外发送。';
    }
    showToast('举报已提交');
  } catch (error) {
    if (safetyReportStatus) {
      safetyReportStatus.textContent =
        '提交失败：' + (error && error.message ? error.message : String(error));
    }
  } finally {
    safetyReportSubmit.disabled = false;
  }
}

if (safetyBlockButton) safetyBlockButton.addEventListener('click', function () {
  safetyToggleBlock().catch(function () {});
});
if (safetyDeleteButton) safetyDeleteButton.addEventListener('click', function () {
  safetyDeleteFriend().catch(function () {});
});
if (safetyLeaveButton) safetyLeaveButton.addEventListener('click', function () {
  safetyLeaveGroup().catch(function () {});
});
if (safetyReportButton) safetyReportButton.addEventListener('click', function () {
  openSafetyReport().catch(function () {});
});
if (safetyReportCancel) safetyReportCancel.addEventListener('click', closeSafetyReport);
if (safetyReportSubmit) safetyReportSubmit.addEventListener('click', function () {
  submitSafetyReport().catch(function () {});
});
if (safetyReportModal) safetyReportModal.addEventListener('click', function (event) {
  if (event.target === safetyReportModal) closeSafetyReport();
});
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape' || !safetyReportModal || safetyReportModal.hidden) return;
  event.preventDefault();
  closeSafetyReport();
});
`;
