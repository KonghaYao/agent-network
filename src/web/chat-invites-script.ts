/**
 * G02 邀请链接 / 二维码 / 入群审批片段。
 *
 * 邀请码只是加入能力，不是身份凭据：明文 key 由创建响应返回一次，页面只
 * 保存在内存中，服务端只存 SHA-256 摘要，因此刷新或关闭后无法恢复旧链接。
 * 列表只展示状态、次数与有效期；撤销后所有设备上的旧二维码同时失效。
 * 审批入口按服务端 `approve_joins` 能力显示，批准与容量判定仍在工具事务内。
 */
export const CHAT_INVITES_SCRIPT = `
const invitesSection = document.getElementById('members-invites');
const invitesListElement = document.getElementById('members-invites-list');
const invitesCountElement = document.getElementById('members-invites-count');
const inviteDaysElement = document.getElementById('members-invite-days');
const inviteUsesElement = document.getElementById('members-invite-uses');
const inviteCreateButton = document.getElementById('members-invite-create');
const inviteShareElement = document.getElementById('members-invite-share');
const inviteUrlElement = document.getElementById('members-invite-url');
const inviteCopyButton = document.getElementById('members-invite-copy');
const inviteQrButton = document.getElementById('members-invite-qr');
const inviteDismissButton = document.getElementById('members-invite-dismiss');
const inviteQrWrapElement = document.getElementById('members-invite-qr-wrap');
const inviteQrCanvas = document.getElementById('members-invite-qr-canvas');
const requestsSection = document.getElementById('members-requests');
const requestsListElement = document.getElementById('members-requests-list');
const requestsCountElement = document.getElementById('members-requests-count');
const requestsEmptyElement = document.getElementById('members-requests-empty');
let inviteLinks = [];
let inviteShare = null;
let inviteBusy = false;

function canApproveJoins() {
  return Boolean(room && room.kind === 'group') && roomCapability('approve_joins');
}

function inviteRemaining(expiresAt) {
  const at = Number(expiresAt);
  if (!Number.isFinite(at)) return '';
  if (at <= Date.now()) return '已过期';
  const hours = Math.ceil((at - Date.now()) / 3600000);
  if (hours >= 48) return '剩余 ' + Math.ceil(hours / 24) + ' 天';
  if (hours >= 1) return '剩余 ' + hours + ' 小时';
  return '剩余不到 1 小时';
}

function inviteStatusLabel(item) {
  if (item.status === 'pending') return '有效 · ' + item.used_count + '/' + item.max_uses + ' 次';
  if (item.status === 'exhausted') return '次数已用尽';
  if (item.status === 'revoked') return '已撤销';
  if (item.status === 'expired') return '已过期';
  return item.status;
}

function clearInviteShare() {
  inviteShare = null;
  if (!inviteShareElement) return;
  inviteShareElement.hidden = true;
  if (inviteQrWrapElement) inviteQrWrapElement.hidden = true;
  if (inviteUrlElement) inviteUrlElement.textContent = '';
}

function showInviteShare(url) {
  inviteShare = { url: url };
  if (inviteUrlElement) inviteUrlElement.textContent = url;
  if (inviteShareElement) inviteShareElement.hidden = false;
  if (inviteQrWrapElement) inviteQrWrapElement.hidden = true;
}

function renderInviteLinks() {
  if (!invitesListElement) return;
  invitesListElement.replaceChildren();
  for (const item of inviteLinks) {
    const row = document.createElement('li');
    row.className = 'member-roster-item member-invite-item';
    const name = document.createElement('span');
    name.className = 'member-roster-name';
    name.textContent = inviteStatusLabel(item) + ' · ' + inviteRemaining(item.expires_at);
    const meta = document.createElement('span');
    meta.className = 'member-roster-role';
    meta.textContent = '由 ' + (item.inviter_name || '成员') + ' 创建 · ' +
      new Date(Number(item.expires_at)).toLocaleString() + ' 到期';
    row.append(name, meta);
    if (item.status === 'pending') {
      const tools = document.createElement('span');
      tools.className = 'member-roster-actions';
      tools.append(memberActionButton('撤销', true, function () {
        return submitInviteRevoke(item.invitation_id, '邀请链接', item.revision);
      }));
      row.append(tools);
    }
    invitesListElement.append(row);
  }
  if (invitesCountElement) invitesCountElement.textContent = String(inviteLinks.length);
}

function renderJoinRequests(items) {
  if (!requestsListElement) return;
  requestsListElement.replaceChildren();
  for (const item of items) {
    const row = document.createElement('li');
    row.className = 'member-roster-item member-request-item';
    row.append(avatarElement(
      item.applicant.name,
      item.applicant.kind === 'agent' ? 'agent' : null,
      'avatar member-avatar'
    ));
    const name = document.createElement('span');
    name.className = 'member-roster-name';
    name.textContent = item.applicant.name +
      (item.invitation_kind === 'link' ? ' · 链接申请' : ' · 定向邀请');
    const meta = document.createElement('span');
    meta.className = 'member-roster-role';
    meta.textContent = (item.message || '申请加入群聊') + ' · ' +
      new Date(Number(item.created_at)).toLocaleString();
    row.append(name, meta);
    if (item.can_approve || item.can_reject) {
      const tools = document.createElement('span');
      tools.className = 'member-roster-actions';
      if (item.can_approve) {
        tools.append(memberActionButton('批准', false, function () {
          return submitJoinRequest(item, 'approve');
        }));
      }
      if (item.can_reject) {
        tools.append(memberActionButton('拒绝', true, function () {
          return submitJoinRequest(item, 'reject');
        }));
      }
      row.append(tools);
    }
    requestsListElement.append(row);
  }
  if (requestsCountElement) requestsCountElement.textContent = String(items.length);
  if (requestsEmptyElement) requestsEmptyElement.hidden = items.length > 0;
}

function invitePanelError(prefix, error) {
  const code = error && error.code;
  if (code === 'PERMISSION_DENIED' || code === 'NOT_MEMBER') {
    return '当前群角色没有邀请或审批权限。';
  }
  if (code === 'QUOTA_EXCEEDED') return '有效邀请链接数量已达上限，请先撤销旧链接。';
  if (code === 'CONFLICT' || code === 'VERSION_CONFLICT') return '邀请或申请状态已变化，请刷新后重试。';
  if (code === 'ROOM_FULL') {
    return '群成员已达上限（' + GROUP_MEMBERS_MAX + ' 人），无法批准。';
  }
  const message = error && error.message ? String(error.message) : String(error);
  return prefix + message;
}

/** 打开成员弹窗时按能力加载；任何失败都只影响本区块，不阻塞成员选择。 */
async function loadInvitePanel(roomId, epoch) {
  const formGeneration = membersLoadToken;
  if (!invitesSection || !requestsSection) return;
  const showInvites = canInviteMembers();
  const showRequests = canApproveJoins();
  invitesSection.hidden = !showInvites;
  requestsSection.hidden = !showRequests;
  if (!showInvites && !showRequests) return;
  if (showInvites) {
    try {
      const page = await callTool('network_room_invite_get', {
        room_id: roomId,
        status: 'pending',
        limit: 50
      });
      if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken || !membersModal.open) return;
      inviteLinks = Array.isArray(page.items) ? page.items : [];
      renderInviteLinks();
    } catch (error) {
      if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken || !membersModal.open) return;
      inviteLinks = [];
      renderInviteLinks();
      setMembersError(invitePanelError('读取邀请链接失败：', error));
    }
  }
  if (showRequests) {
    try {
      const page = await callTool('network_room_join_request_list', {
        room_id: roomId,
        status: 'pending',
        limit: 50
      });
      if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken || !membersModal.open) return;
      renderJoinRequests(Array.isArray(page.items) ? page.items : []);
    } catch (error) {
      if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken || !membersModal.open) return;
      renderJoinRequests([]);
      setMembersError(invitePanelError('读取入群申请失败：', error));
    }
  }
}

async function submitInviteCreate() {
  if (!room || room.kind !== 'group' || inviteBusy || !canInviteMembers()) return;
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const formGeneration = membersLoadToken;
  if (!roomId) return;
  const days = Number(inviteDaysElement ? inviteDaysElement.value : 7);
  const uses = Number(inviteUsesElement ? inviteUsesElement.value : 20);
  if (!Number.isFinite(days) || days < 1 || days > 30) {
    setMembersError('有效天数需在 1 到 30 之间。');
    return;
  }
  if (!Number.isFinite(uses) || uses < 1 || uses > 100) {
    setMembersError('可加入次数需在 1 到 100 之间。');
    return;
  }
  inviteBusy = true;
  setMembersError('');
  if (inviteCreateButton) inviteCreateButton.disabled = true;
  try {
    const result = await callTool('network_room_invite_create', {
      request_id: requestId('invite-link'),
      room_id: roomId,
      max_uses: Math.round(uses),
      expires_in_ms: Math.round(days * 86400000)
    });
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken || !membersModal.open) return;
    if (result.share_url) showInviteShare(result.share_url);
    await loadInvitePanel(roomId, epoch);
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    statusElement.textContent = '已创建邀请链接，明文只显示这一次';
  } catch (error) {
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken || !membersModal.open) return;
    setMembersError(invitePanelError('创建邀请链接失败：', error));
  } finally {
    if (formGeneration === membersLoadToken) inviteBusy = false;
    if (isActiveRoom(roomId, epoch) && formGeneration === membersLoadToken && inviteCreateButton) inviteCreateButton.disabled = false;
  }
}

async function submitInviteRevoke(invitationId, label, revision) {
  if (!room || room.kind !== 'group' || inviteBusy || !invitationId) return;
  if (!(await confirmDialog('撤销' + label + '？撤销后所有设备上的旧链接和二维码立即失效。',
    { title: '撤销邀请', danger: true, confirmText: '撤销' }))) return;
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const formGeneration = membersLoadToken;
  if (!roomId) return;
  inviteBusy = true;
  setMembersError('');
  try {
    await callTool('network_room_invite_revoke', {
      request_id: requestId('invite-revoke'),
      invitation_id: invitationId,
      expected_revision: revision
    });
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken || !membersModal.open) return;
    if (inviteShare && inviteLinks.some(function (item) {
      return item.invitation_id === invitationId;
    })) {
      clearInviteShare();
    }
    await loadInvitePanel(roomId, epoch);
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    statusElement.textContent = '已撤销' + label;
  } catch (error) {
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken || !membersModal.open) return;
    setMembersError(invitePanelError('撤销失败：', error));
  } finally {
    if (formGeneration === membersLoadToken) inviteBusy = false;
  }
}

async function submitJoinRequest(item, action) {
  if (!room || room.kind !== 'group' || inviteBusy || !item) return;
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const formGeneration = membersLoadToken;
  if (!roomId) return;
  if (action === 'reject' && !(await confirmDialog('拒绝「' + item.applicant.name + '」的入群申请？',
    { title: '拒绝申请', confirmText: '拒绝' }))) return;
  inviteBusy = true;
  setMembersError('');
  try {
    await callTool('network_room_join_request_respond', {
      request_id: requestId('join-respond'),
      join_request_id: item.join_request_id,
      action: action,
      expected_revision: item.revision
    });
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken || !membersModal.open) return;
    await loadInvitePanel(roomId, epoch);
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    statusElement.textContent = action === 'approve'
      ? '已批准 ' + item.applicant.name + ' 入群'
      : '已拒绝 ' + item.applicant.name + ' 的申请';
    refresh(false).catch(function (error) {
      if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken || !membersModal.open) return;
      statusElement.textContent = '申请已处理，但刷新会话失败：' +
        (error && error.message ? error.message : error);
    });
  } catch (error) {
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken || !membersModal.open) return;
    setMembersError(invitePanelError(action === 'approve' ? '批准失败：' : '拒绝失败：', error));
  } finally {
    if (formGeneration === membersLoadToken) inviteBusy = false;
  }
}

function copyInviteShare() {
  if (!inviteShare) return;
  const url = inviteShare.url;
  const done = function () { statusElement.textContent = '已复制邀请链接'; };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done, function () {
      setMembersError('复制失败，请手动选择链接复制。');
    });
    return;
  }
  const area = document.createElement('textarea');
  area.value = url;
  // 成员弹窗是原生模态 dialog，背景节点 inert；临时输入框必须挂进弹窗内。
  const host = document.querySelector('dialog[open]') || document.body;
  host.append(area);
  area.focus();
  area.select();
  try {
    document.execCommand('copy');
    done();
  } catch (error) {
    setMembersError('复制失败，请手动选择链接复制。');
  } finally {
    area.remove();
  }
}

function drawInviteQr() {
  if (!inviteShare || !inviteQrCanvas || !window.agentNetworkQr) return;
  try {
    window.agentNetworkQr.draw(inviteQrCanvas, inviteShare.url);
    if (inviteQrWrapElement) inviteQrWrapElement.hidden = false;
  } catch (error) {
    setMembersError('二维码生成失败：链接过长或浏览器不支持。');
  }
}

if (inviteCreateButton) inviteCreateButton.addEventListener('click', submitInviteCreate);
if (inviteCopyButton) inviteCopyButton.addEventListener('click', copyInviteShare);
if (inviteQrButton) inviteQrButton.addEventListener('click', drawInviteQr);
if (inviteDismissButton) inviteDismissButton.addEventListener('click', clearInviteShare);
if (membersCloseButton) membersCloseButton.addEventListener('click', clearInviteShare);
if (membersCancelButton) membersCancelButton.addEventListener('click', clearInviteShare);
if (membersModal) {
  membersModal.addEventListener('click', function (event) {
    if (event.target === membersModal) clearInviteShare();
  });
}
`;
