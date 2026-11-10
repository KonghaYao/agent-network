/**
 * 群聊成员管理片段：左右双栏的“已在群 / 未在群”选择器与好友分页。
 *
 * 服务端返回的 `room.capabilities` 与 `member.actions` 是唯一授权来源：
 * 邀请受 `invite_members` 控制，任免管理员受 `manage_admins` 控制，
 * 移除/转让逐成员判定。页面只隐藏入口，服务端仍会阻止直接调用与重放。
 * 片段与其它脚本拼进同一个内联 `<script>` 共享作用域；不改变工具契约。
 */
export const CHAT_MEMBERS_SCRIPT = `
const membersButton = document.getElementById('add-members');
const membersModal = document.getElementById('members-modal');
const membersForm = document.getElementById('members-form');
const membersCloseButton = document.getElementById('members-close');
const membersCurrentElement = document.getElementById('members-current');
const membersCurrentSearch = document.getElementById('members-current-search');
const membersCurrentCountElement = document.getElementById('members-current-count');
const membersCurrentEmptyElement = document.getElementById('members-current-empty');
const membersTransferElement = document.getElementById('members-transfer');
const membersModalTitleElement = document.getElementById('members-modal-title');
const membersContactsElement = document.getElementById('members-contacts');
const membersContactsCountElement = document.getElementById('members-contacts-count');
const membersSearchElement = document.getElementById('members-search');
const membersMoreButton = document.getElementById('members-more');
const membersInvitedWrapElement = document.getElementById('members-invited-wrap');
const membersInvitedElement = document.getElementById('members-invited');
const membersInvitedCountElement = document.getElementById('members-invited-count');
const membersSelectionElement = document.getElementById('members-selection');
const membersErrorElement = document.getElementById('members-error');
const membersAddButton = document.getElementById('members-add');
const membersCancelButton = document.getElementById('members-cancel');
let membersLoadToken = 0;
let membersContactsCache = [];
let membersContactNote = '';
let membersBusy = false;
let membersOpener = null;
let membersPicker = null;
let openMemberMenu = null;

/** 服务端 capabilities 优先；旧快照没有 capabilities 时按 owner 兼容。 */
function roomCapability(name) {
  // 遗留无主群不可再邀请成员；服务端仍会返回 CONFLICT/owner_missing。
  if (name === 'invite_members' && room && room.owner_missing) return false;
  if (room && room.capabilities && typeof room.capabilities === 'object') {
    return Boolean(room.capabilities[name]);
  }
  return Boolean(room && room.kind === 'group' && room.my_role === 'owner');
}

function canInviteMembers() {
  return Boolean(room && room.kind === 'group') && roomCapability('invite_members');
}

function canManageAdmins() {
  return Boolean(room && room.kind === 'group') && roomCapability('manage_admins');
}

/** 添加成员入口只在群聊出现；切到单聊或关闭房间时同时收起弹窗。 */
function updateMembersAffordance() {
  if (!membersButton) return;
  const visible = Boolean(room && room.kind === 'group');
  membersButton.hidden = !visible;
  if (!visible) closeMembersModal();
}

function setMembersError(message) {
  if (membersErrorElement) membersErrorElement.textContent = message || '';
}

function selectedMemberIds() {
  return membersPicker ? membersPicker.selectedIds() : [];
}

/** 添加成员与建群共用选择器；成员弹窗只传入已排除现有成员后的候选。 */
function membersPickerController() {
  if (membersPicker) return membersPicker;
  membersPicker = createMemberPicker({
    root: membersContactsElement,
    search: membersSearchElement,
    more: membersMoreButton,
    count: membersContactsCountElement,
    selection: membersSelectionElement,
    onChange: function () { updateMembersSelection(); },
    empty: '没有可添加的好友：好友都已在群里。'
  });
  return membersPicker;
}

/** 选中态同时驱动勾选背景、底部计数与“添加”按钮可用性。 */
function updateMembersSelection() {
  const selected = selectedMemberIds();
  if (membersSelectionElement) {
    membersSelectionElement.textContent = selected.length
      ? '已选 ' + selected.length + ' 人'
      : '未选择';
  }
  if (membersContactsElement) {
    for (const choice of membersContactsElement.querySelectorAll('.contact-choice')) {
      const input = choice.querySelector('input[type=checkbox]');
      choice.classList.toggle('selected', Boolean(input && input.checked));
    }
  }
  if (membersAddButton) {
    membersAddButton.disabled = membersBusy || !canInviteMembers() || selected.length === 0;
  }
}

function setMembersBusy(busy, label) {
  membersBusy = busy;
  if (membersAddButton) {
    membersAddButton.textContent = busy ? (label || '正在添加…') : '添加';
  }
  if (membersForm) membersForm.setAttribute('aria-busy', busy ? 'true' : 'false');
  if (busy) closeMemberMenu();
  for (const button of document.querySelectorAll(
    '.member-action, .member-menu-toggle, .member-menu-item'
  )) {
    // 转让确认期间入口固定禁用，不能被 busy=false 误重新启用。
    button.disabled = busy || button.dataset.locked === 'true';
  }
  if (membersPicker) membersPicker.setBusy(busy);
  updateMembersSelection();
}

function memberRoleLabel(member) {
  const kind = member.kind === 'agent' ? 'Agent' : '人';
  if (member.role === 'owner') return '群主 · ' + kind;
  if (member.role === 'admin') return '管理员 · ' + kind;
  return kind;
}

function memberActionButton(label, danger, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'member-action' + (danger ? ' danger' : '');
  button.textContent = label;
  button.disabled = membersBusy;
  button.addEventListener('click', function () {
    handler().catch(function (error) {
      setMembersError(error && error.message ? error.message : String(error));
    });
  });
  return button;
}

/** 菜单项沿用与文本动作一致的错误出口；点击后先收菜单再执行。 */
function memberMenuItem(label, danger, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'member-menu-item' + (danger ? ' danger' : '');
  button.setAttribute('role', 'menuitem');
  button.textContent = label;
  button.disabled = membersBusy;
  button.addEventListener('click', function () {
    closeMemberMenu();
    handler().catch(function (error) {
      setMembersError(error && error.message ? error.message : String(error));
    });
  });
  return button;
}

function enabledMenuItems(menu) {
  const items = [];
  for (const item of menu.querySelectorAll('.member-menu-item')) {
    if (!item.disabled) items.push(item);
  }
  return items;
}

/** 收菜单只改本地状态；节点已被重建时静默丢弃。 */
function closeMemberMenu(options) {
  const current = openMemberMenu;
  openMemberMenu = null;
  if (!current) return;
  current.menu.hidden = true;
  current.menu.removeAttribute('style');
  if (current.toggle.isConnected) {
    current.toggle.setAttribute('aria-expanded', 'false');
    if (options && options.focus) current.toggle.focus({ preventScroll: true });
  }
}

/** 固定定位并按视口夹取；空间不足时翻到行上方，390px 也不横向溢出。 */
function positionMemberMenu(toggle, menu) {
  const rect = toggle.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const viewWidth = document.documentElement.clientWidth || window.innerWidth;
  const viewHeight = document.documentElement.clientHeight || window.innerHeight;
  let left = Math.max(margin, Math.min(rect.right - width, viewWidth - width - margin));
  let top = rect.bottom + gap;
  if (top + height > viewHeight - margin && rect.top - height - gap >= margin) {
    top = rect.top - height - gap;
  }
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}

function showMemberMenu(row, toggle, menu) {
  if (membersBusy) return;
  closeMemberMenu();
  menu.hidden = false;
  toggle.setAttribute('aria-expanded', 'true');
  // 先定位再聚焦，避免焦点移动把菜单滚出视口。
  positionMemberMenu(toggle, menu);
  openMemberMenu = { row: row, toggle: toggle, menu: menu, openedAt: Date.now() };
  const items = enabledMenuItems(menu);
  if (items.length > 0) items[0].focus({ preventScroll: true });
}

function toggleMemberMenu(row, toggle, menu) {
  if (openMemberMenu && openMemberMenu.menu === menu) {
    closeMemberMenu({ focus: true });
    return;
  }
  showMemberMenu(row, toggle, menu);
}

function memberMenuToggle(row, menu) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'member-menu-toggle';
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', '成员操作');
  toggle.title = '成员操作';
  toggle.textContent = '⋯';
  toggle.disabled = membersBusy;
  toggle.addEventListener('click', function () {
    toggleMemberMenu(row, toggle, menu);
  });
  toggle.addEventListener('keydown', function (event) {
    if (event.key !== 'ArrowDown') return;
    event.preventDefault();
    if (!openMemberMenu || openMemberMenu.menu !== menu) {
      showMemberMenu(row, toggle, menu);
    }
  });
  return toggle;
}

function memberMenuElement() {
  const menu = document.createElement('div');
  menu.className = 'member-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '成员操作');
  menu.hidden = true;
  menu.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeMemberMenu({ focus: true });
      return;
    }
    if (event.key === 'Tab') {
      closeMemberMenu();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = enabledMenuItems(menu);
    if (items.length === 0) return;
    event.preventDefault();
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'ArrowDown'
      ? items[(index + 1) % items.length]
      : items[(index - 1 + items.length) % items.length];
    next.focus({ preventScroll: true });
  });
  return menu;
}

function membersViewSignature(memberList, invitedList, transfer, capabilities) {
  return JSON.stringify([memberList.map(function (member) {
    return [member.actor_id, member.name, member.kind, member.role, member.role_revision, member.actions];
  }), invitedList, transfer, capabilities]);
}

function filterCurrentMembers() {
  const query = membersCurrentSearch ? membersCurrentSearch.value.trim().toLowerCase() : '';
  let visible = 0;
  for (const node of membersCurrentElement.children) {
    const name = node.querySelector('.member-roster-name');
    node.hidden = Boolean(query && (!name || !name.textContent.toLowerCase().includes(query)));
    if (!node.hidden) visible += 1;
  }
  if (membersCurrentEmptyElement) {
    membersCurrentEmptyElement.hidden = visible > 0;
    membersCurrentEmptyElement.textContent = query ? '没有匹配的群成员' : '群里还没有成员';
  }
}
if (membersCurrentSearch) membersCurrentSearch.addEventListener('input', filterCurrentMembers);

function renderCurrentMembers() {
  if (!membersCurrentElement) return;
  closeMemberMenu();
  membersCurrentElement.replaceChildren();
  for (const member of members.values()) {
    const item = document.createElement('li');
    item.className = 'member-roster-item';
    item.append(avatarElement(
      member.name,
      member.kind === 'agent' ? 'agent' : null,
      'avatar member-avatar'
    ));
    const name = document.createElement('span');
    name.className = 'member-roster-name';
    name.textContent = member.name +
      (identity && member.actor_id === identity.actor_id ? '（我）' : '');
    const role = document.createElement('span');
    role.className = 'member-roster-role';
    role.textContent = memberRoleLabel(member);
    item.append(name, role);
    const actions = member.actions && typeof member.actions === 'object' ? member.actions : {};
    const canStartDirect = Boolean(
      identity && member.actor_id !== identity.actor_id && member.kind === 'human'
    );
    if (canStartDirect || actions.can_remove || actions.can_set_admin || actions.can_revoke_admin || actions.can_transfer_owner) {
      const tools = document.createElement('span');
      tools.className = 'member-roster-actions';
      const menu = memberMenuElement();
      if (canStartDirect) {
        menu.append(memberMenuItem('发起单聊', false, function () {
          return startDirectConversation(member.actor_id, member.name, membersErrorElement);
        }));
      }
      if (actions.can_set_admin) {
        menu.append(memberMenuItem('设为管理员', false, function () {
          return submitMemberRole(member, 'admin');
        }));
      }
      if (actions.can_revoke_admin) {
        menu.append(memberMenuItem('撤销管理员', false, function () {
          return submitMemberRole(member, 'member');
        }));
      }
      if (actions.can_transfer_owner) {
        // 同一群只允许一条有效提议：确认期间所有转让入口都锁定。
        const transferItem = memberMenuItem(
          ownerTransfer ? '转让确认中' : '转让群主',
          false,
          function () { return submitOwnerTransfer(member); }
        );
        if (ownerTransfer) {
          transferItem.dataset.locked = 'true';
          transferItem.disabled = true;
        }
        menu.append(transferItem);
      }
      if (actions.can_remove) {
        menu.append(memberMenuItem('移出群聊', true, function () {
          return submitMemberRemoval(member);
        }));
      }
      // 每行只留一个 icon 入口；菜单项仍按服务端 actions 与固定顺序生成。
      tools.append(memberMenuToggle(item, menu), menu);
      item.append(tools);
    }
    membersCurrentElement.append(item);
  }
  if (membersCurrentCountElement) {
    membersCurrentCountElement.textContent = String(members.size);
  }
  if (membersCurrentEmptyElement) membersCurrentEmptyElement.hidden = members.size > 0;
  filterCurrentMembers();
  renderInvitedMembers();
  renderOwnerTransferPanel();
}

/**
 * 邀请中成员只用于展示，不计入 active 成员数，也不渲染成已加入。
 * 定向邀请可在这里立即撤销；链接邀请在下方“邀请链接”区块管理。
 */
function renderInvitedMembers() {
  if (!membersInvitedElement || !membersInvitedWrapElement) return;
  membersInvitedElement.replaceChildren();
  const invited = invitedMembers ? Array.from(invitedMembers.values()) : [];
  for (const entry of invited) {
    const item = document.createElement('li');
    item.className = 'member-roster-item member-invited-item';
    item.append(avatarElement(
      entry.name,
      entry.kind === 'agent' ? 'agent' : null,
      'avatar member-avatar'
    ));
    const name = document.createElement('span');
    name.className = 'member-roster-name';
    name.textContent = entry.name;
    const role = document.createElement('span');
    role.className = 'member-roster-role';
    role.textContent = '等待确认 · ' + (entry.kind === 'agent' ? 'Agent' : '人');
    item.append(name, role);
    if (entry.invitation_id) {
      const tools = document.createElement('span');
      tools.className = 'member-roster-actions';
      tools.append(memberActionButton('撤销邀请', true, function () {
        return submitInviteRevoke(entry.invitation_id, '定向邀请', undefined);
      }));
      item.append(tools);
    }
    membersInvitedElement.append(item);
  }
  if (membersInvitedCountElement) {
    membersInvitedCountElement.textContent = String(invited.length);
  }
  membersInvitedWrapElement.hidden = invited.length === 0;
}

/** 提议有效期展示只做本地估算；接受/拒绝仍由服务端按 expires_at 判定。 */
function ownerTransferRemaining(expiresAt) {
  const at = Date.parse(expiresAt);
  if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.ceil((at - Date.now()) / 60000));
  if (minutes <= 0) return '已到期';
  if (minutes >= 120) return '剩余 ' + Math.ceil(minutes / 60) + ' 小时';
  return '剩余 ' + minutes + ' 分钟';
}

/**
 * 待确认的转让提议条：接受前责任仍在原 owner，按钮只按服务端
 * can_accept / can_reject / can_cancel 渲染，页面不自行推断权限。
 */
function renderOwnerTransferPanel() {
  if (!membersTransferElement) return;
  membersTransferElement.replaceChildren();
  const transfer = ownerTransfer;
  const visible = Boolean(room && room.kind === 'group' && transfer);
  membersTransferElement.hidden = !visible;
  if (membersModalTitleElement) {
    membersModalTitleElement.textContent = visible &&
      (transfer.can_accept || transfer.can_reject || transfer.can_cancel)
      ? '成员与群主转让'
      : '群组设置';
  }
  if (!visible) return;
  const title = document.createElement('p');
  title.className = 'members-transfer-title';
  title.textContent = '群主转让 · 等待确认';
  const line = document.createElement('p');
  line.className = 'members-transfer-line';
  line.textContent = '「' + transfer.from_owner_name + '」提议把群主转让给「' +
    transfer.to_actor_name + '」';
  const meta = document.createElement('p');
  meta.className = 'members-transfer-meta';
  const remaining = ownerTransferRemaining(transfer.expires_at);
  meta.textContent = '接受前仍由原群主负责群主事务' + (remaining ? ' · ' + remaining : '');
  membersTransferElement.append(title, line, meta);
  const actions = document.createElement('div');
  actions.className = 'members-transfer-actions';
  if (transfer.can_accept) {
    actions.append(memberActionButton('接受转让', false, function () {
      return submitOwnerTransferResponse('accept');
    }));
  }
  if (transfer.can_reject) {
    actions.append(memberActionButton('拒绝转让', false, function () {
      return submitOwnerTransferResponse('reject');
    }));
  }
  if (transfer.can_cancel) {
    actions.append(memberActionButton('取消提议', true, function () {
      return submitOwnerTransferCancel();
    }));
  }
  if (actions.childElementCount > 0) membersTransferElement.append(actions);
}

/** 接受/拒绝按提议 version 提交；成功后房间详情会给出新的 owner 与角色。 */
async function submitOwnerTransferResponse(action) {
  if (!room || room.kind !== 'group' || membersBusy || !ownerTransfer) return;
  const transfer = ownerTransfer;
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const formGeneration = membersLoadToken;
  if (!roomId) return;
  setMembersError('');
  setMembersBusy(true, action === 'accept' ? '正在接受…' : '正在拒绝…');
  try {
    const result = await callTool('network_room_owner_transfer_respond', {
      request_id: requestId('owner-respond'),
      transfer_id: transfer.transfer_id,
      action,
      expected_version: transfer.version
    });
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    applyRoomDetail(result);
    renderCurrentMembers();
    refreshMembersAfterChange(roomId, epoch, action === 'accept' ? '已接受群主转让' : '已拒绝群主转让');
  } catch (error) {
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    setMembersError(membersActionError(error, action === 'accept' ? '接受转让失败：' : '拒绝转让失败：'));
  } finally {
    if (isActiveRoom(roomId, epoch) && formGeneration === membersLoadToken) {
      setMembersBusy(false);
      renderCurrentMembers();
    }
  }
}

async function submitOwnerTransferCancel() {
  if (!room || room.kind !== 'group' || membersBusy || !ownerTransfer) return;
  const transfer = ownerTransfer;
  if (!window.confirm('取消向「' + transfer.to_actor_name + '」的群主转让提议？')) return;
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const formGeneration = membersLoadToken;
  if (!roomId) return;
  setMembersError('');
  setMembersBusy(true, '正在取消…');
  try {
    const result = await callTool('network_room_owner_transfer_cancel', {
      request_id: requestId('owner-cancel'),
      transfer_id: transfer.transfer_id,
      expected_version: transfer.version
    });
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    applyRoomDetail(result);
    renderCurrentMembers();
    refreshMembersAfterChange(roomId, epoch, '已取消群主转让提议');
  } catch (error) {
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    setMembersError(membersActionError(error, '取消转让失败：'));
  } finally {
    if (isActiveRoom(roomId, epoch) && formGeneration === membersLoadToken) {
      setMembersBusy(false);
      renderCurrentMembers();
    }
  }
}

function renderMembersEmpty(message) {
  if (membersPicker) membersPicker.reset();
  if (!membersContactsElement) return;
  membersContactsElement.replaceChildren();
  const empty = document.createElement('p');
  empty.className = 'members-empty';
  empty.textContent = message;
  membersContactsElement.append(empty);
  if (membersContactsCountElement) membersContactsCountElement.textContent = '0';
  updateMembersSelection();
}

function renderMembersContacts(contacts, note) {
  if (!membersContactsElement) return;
  if (!canInviteMembers()) {
    renderMembersEmpty(room && room.read_only
      ? '群已解散，成员列表只读'
      : '当前群设置不允许你邀请成员');
    return;
  }
  const picker = membersPickerController();
  picker.setContacts(contacts);
  picker.setNote(note || '');
}

function closeMembersModal() {
  membersLoadToken += 1;
  closeGroupProfile();
  clearInviteShare();
  inviteBusy = false;
  if (inviteCreateButton) inviteCreateButton.disabled = false;
  closeMemberMenu();
  if (membersModal) membersModal.hidden = true;
  setMembersError('');
  membersContactsCache = [];
  membersContactNote = '';
  if (membersContactsElement) membersContactsElement.replaceChildren();
  if (membersContactsCountElement) membersContactsCountElement.textContent = '0';
  setMembersBusy(false);
  const opener = membersOpener;
  membersOpener = null;
  if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
}

/** 好友 - 当前成员 - 自己；同时去重，避免分页边界重复候选。 */
function membersCandidates(contacts) {
  const excluded = new Set(members.keys());
  // 邀请中不是“未在群”：再次直接添加会绕过对方确认。
  for (const invited of invitedMembers.values()) excluded.add(invited.actor_id);
  if (identity) excluded.add(identity.actor_id);
  const seen = new Set();
  return contacts.filter(function (contact) {
    if (!contact || typeof contact.actor_id !== 'string') return false;
    // 管理列表可能保留已归档/停用 Agent 用于恢复，但不能再出现在“未加群”候选。
    if (contact.archived === true || contact.disabled === true) return false;
    if (excluded.has(contact.actor_id) || seen.has(contact.actor_id)) return false;
    seen.add(contact.actor_id);
    return true;
  });
}

async function openMembersModal() {
  if (!membersModal || !room || room.kind !== 'group') return;
  membersOpener = document.activeElement;
  membersModal.hidden = false;
  if (membersCurrentSearch) membersCurrentSearch.value = '';
  setMembersError('');
  membersContactsCache = [];
  membersContactNote = '';
  const picker = membersPickerController();
  picker.reset();
  renderCurrentMembers();
  openGroupProfile();
  setMembersBusy(false);
  if (membersCloseButton) membersCloseButton.focus();
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const loadToken = ++membersLoadToken;
  // 邀请链接与入群申请独立加载：失败只影响各自区块，不阻塞成员选择。
  loadInvitePanel(roomId, epoch);
  if (!canInviteMembers()) {
    renderMembersEmpty(room && room.read_only
      ? '群已解散，成员列表只读'
      : '当前群设置不允许你邀请成员');
    setMembersError(room && room.read_only
      ? '群已解散，成员列表只读，不能邀请或移除成员。'
      : '当前群设置不允许你邀请成员；仍可查看群资料和成员。');
    return;
  }
  picker.setNote('正在读取好友…');
  setMembersBusy(true, '读取好友…');
  try {
    const contacts = await loadGroupContacts();
    if (
      loadToken !== membersLoadToken ||
      !isActiveRoom(roomId, epoch) ||
      !membersModal ||
      membersModal.hidden
    ) {
      return;
    }
    membersContactsCache = contacts;
    renderMembersContacts(membersCandidates(contacts));
    const ownerActorId = identity ? identity.actor_id : '';
    membersContactNote = '正在读取本机与受管 Agent…';
    renderMembersContacts(membersCandidates(contacts), membersContactNote);
    const merged = await mergeAgentPickerContacts(ownerActorId, contacts);
    if (
      loadToken !== membersLoadToken ||
      !isActiveRoom(roomId, epoch) ||
      !membersModal ||
      membersModal.hidden
    ) {
      return;
    }
    membersContactsCache = merged.contacts;
    membersContactNote = '';
    renderMembersContacts(membersCandidates(merged.contacts));
    setMembersBusy(false);
  } catch (error) {
    if (loadToken !== membersLoadToken || !isActiveRoom(roomId, epoch)) return;
    renderMembersEmpty('读取好友失败，请重试。');
    setMembersError('读取好友失败：' + (error && error.message ? error.message : error));
    setMembersBusy(false);
  }
}

/** 把服务端错误码映射成可读提示；未知错误保留原始 message。 */
function membersUpdateError(error) {
  const code = error && error.code;
  if (code === 'NOT_OWNER') return '只有群 owner 可以执行该操作。';
  if (code === 'PERMISSION_DENIED') return '当前群角色没有该操作权限。';
  if (code === 'VERSION_CONFLICT') return '群成员角色已变化，请刷新后重试。';
  if (code === 'FRIEND_REQUIRED') return '只能添加好友；请先把对方添加为好友。';
  if (code === 'ROOM_FULL') {
    return '群成员已达上限（' + GROUP_MEMBERS_MAX + ' 人），无法继续添加。';
  }
  if (code === 'NOT_FOUND') return '房间不存在或已失效。';
  if (code === 'NOT_MEMBER') return '你已不在该群中，无法添加成员。';
  const message = error && error.message ? String(error.message) : String(error);
  return '添加成员失败：' + message;
}

function membersActionError(error, prefix) {
  const code = error && error.code;
  if (code === 'NOT_OWNER') return '只有群 owner 可以执行该操作。';
  if (code === 'PERMISSION_DENIED') return '当前群角色没有该操作权限。';
  if (code === 'VERSION_CONFLICT') return '群成员角色已变化，请刷新后重试。';
  if (code === 'REQUEST_EXPIRED') return '群主转让提议已过期，请刷新后重试。';
  if (code === 'NOT_FOUND') return '房间不存在或已失效。';
  if (code === 'NOT_MEMBER') return '你已不在该群中。';
  const message = error && error.message ? String(error.message) : String(error);
  return prefix + message;
}

/** 角色/移除/转让成功后统一刷新侧栏；失败不清空当前成员列表。 */
function refreshMembersAfterChange(roomId, epoch, message) {
  statusElement.textContent = message;
  refresh(false).catch(function (error) {
    if (!isActiveRoom(roomId, epoch)) return;
    statusElement.textContent = message + '，但刷新会话失败：' +
      (error && error.message ? error.message : error);
  });
}

async function submitMemberRole(member, role) {
  if (!room || room.kind !== 'group' || membersBusy) return;
  if (!canManageAdmins()) {
    setMembersError('只有群 owner 可以任免管理员。');
    return;
  }
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const formGeneration = membersLoadToken;
  if (!roomId) return;
  setMembersError('');
  setMembersBusy(true, '正在保存…');
  try {
    const result = await callTool('network_room_role_set', {
      request_id: requestId('role'),
      room_id: roomId,
      actor_id: member.actor_id,
      role,
      expected_role_revision: member.role_revision
    });
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    applyRoomDetail(result);
    renderCurrentMembers();
    refreshMembersAfterChange(roomId, epoch, role === 'admin' ? '已设为管理员' : '已撤销管理员');
  } catch (error) {
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    setMembersError(membersActionError(error, role === 'admin' ? '设置管理员失败：' : '撤销管理员失败：'));
  } finally {
    if (isActiveRoom(roomId, epoch) && formGeneration === membersLoadToken) {
      setMembersBusy(false);
      renderCurrentMembers();
    }
  }
}

async function submitOwnerTransfer(member) {
  if (!room || room.kind !== 'group' || membersBusy) return;
  const actions = member.actions && typeof member.actions === 'object' ? member.actions : {};
  if (!actions.can_transfer_owner) {
    setMembersError('只有群 owner 可以转让群主。');
    return;
  }
  if (ownerTransfer) {
    setMembersError('已有待确认的群主转让提议，请先取消或等待对方处理。');
    return;
  }
  if (!window.confirm('向「' + member.name + '」发起群主转让？对方接受后才会生效，确认前你仍负责群主事务。')) return;
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const formGeneration = membersLoadToken;
  if (!roomId) return;
  setMembersError('');
  setMembersBusy(true, '正在发起…');
  try {
    const result = await callTool('network_room_owner_transfer_propose', {
      request_id: requestId('owner'),
      room_id: roomId,
      target_actor_id: member.actor_id,
      expected_role_revision: member.role_revision
    });
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    applyRoomDetail(result);
    renderCurrentMembers();
    refreshMembersAfterChange(roomId, epoch, '已向 ' + member.name + ' 发起群主转让，等待对方确认');
  } catch (error) {
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    setMembersError(membersActionError(error, '发起群主转让失败：'));
  } finally {
    if (isActiveRoom(roomId, epoch) && formGeneration === membersLoadToken) {
      setMembersBusy(false);
      renderCurrentMembers();
    }
  }
}

async function submitMemberRemoval(member) {
  if (!room || room.kind !== 'group' || membersBusy) return;
  const actions = member.actions && typeof member.actions === 'object' ? member.actions : {};
  if (!actions.can_remove) {
    setMembersError('当前群角色不能移除该成员。');
    return;
  }
  if (!window.confirm('将「' + member.name + '」移出群聊？')) return;
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const formGeneration = membersLoadToken;
  if (!roomId) return;
  setMembersError('');
  setMembersBusy(true, '正在移除…');
  try {
    const result = await callTool('network_room_members_update', {
      request_id: requestId('remove'),
      room_id: roomId,
      remove: [member.actor_id],
      expected_role_revision: member.role_revision
    });
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    applyRoomDetail(result);
    renderCurrentMembers();
    renderMembersContacts(membersCandidates(membersContactsCache), membersContactNote);
    refreshMembersAfterChange(roomId, epoch, '已把 ' + member.name + ' 移出群聊');
  } catch (error) {
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    setMembersError(membersActionError(error, '移除成员失败：'));
  } finally {
    if (isActiveRoom(roomId, epoch) && formGeneration === membersLoadToken) {
      setMembersBusy(false);
      renderCurrentMembers();
    }
  }
}

async function submitMembersForm(event) {
  event.preventDefault();
  const roomId = activeRoomId;
  if (!roomId || !room || room.kind !== 'group' || !membersModal || membersModal.hidden) return;
  if (membersBusy) return;
  const epoch = roomEpoch;
  const formGeneration = membersLoadToken;
  if (!canInviteMembers()) {
    setMembersError('只有群 owner 或管理员可以添加成员。');
    return;
  }
  const selected = selectedMemberIds();
  if (selected.length === 0) {
    setMembersError('请至少选择一个好友');
    return;
  }
  if (selected.length > MEMBER_CHANGE_MAX) {
    setMembersError('单次最多添加 ' + MEMBER_CHANGE_MAX + ' 名成员');
    return;
  }
  const existing = [];
  for (const actorId of selected) {
    const member = members.get(actorId);
    if (member) existing.push(member.name || actorId);
  }
  if (existing.length > 0) {
    setMembersError('已在群里：' + existing.join('、'));
    return;
  }
  setMembersError('');
  setMembersBusy(true, '正在添加…');
  const before = new Set(members.keys());
  const previousInvites = new Set(invitedMembers.keys());
  try {
    const result = await callTool('network_room_members_update', {
      request_id: requestId('members'),
      room_id: roomId,
      add: selected
    });
    if (!isActiveRoom(roomId, epoch)) return;
    const afterMembers = result && Array.isArray(result.members) ? result.members : [];
    const added = afterMembers.filter(function (member) {
      return !before.has(member.actor_id);
    });
    const invitations = (result.invited || []).filter(function (entry) {
      return !previousInvites.has(entry.actor_id);
    });
    applyRoomDetail(result);
    if (formGeneration !== membersLoadToken || !membersModal || membersModal.hidden) return;
    if (added.length === 0 && invitations.length === 0) {
      setMembersError('所选好友已在群里，成员没有变化。');
      renderMembersContacts(membersCandidates(membersContactsCache), membersContactNote);
      return;
    }
    if (membersPicker) membersPicker.clearSelection();
    // 新成员从右侧候选消失、出现在左侧；弹窗保持打开，便于连续添加。
    renderCurrentMembers();
    renderMembersContacts(membersCandidates(membersContactsCache), membersContactNote);
    setMembersError('');
    const message = [added.length ? '已添加 ' + added.length + ' 名成员' : '',
      invitations.length ? '已邀请 ' + invitations.length + ' 人，等待对方确认' : ''].filter(Boolean).join('；');
    setMembersError(message);
    statusElement.textContent = message;
    // 更新响应已立即刷新头部与成员；后台再读一次 room_get 校准侧栏。
    refresh(false).catch(function (error) {
      if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
      statusElement.textContent = '成员已添加，但刷新会话失败：' +
        (error && error.message ? error.message : error);
    });
  } catch (error) {
    if (!isActiveRoom(roomId, epoch) || formGeneration !== membersLoadToken) return;
    // 失败保留已选候选，用户可直接重试。
    setMembersError(membersUpdateError(error));
  } finally {
    if (isActiveRoom(roomId, epoch) && formGeneration === membersLoadToken) setMembersBusy(false);
  }
}

if (membersButton) {
  membersButton.addEventListener('click', function () {
    openMembersModal().catch(function (error) {
      if (!membersModal || membersModal.hidden) return;
      setMembersError('读取成员失败：' + (error && error.message ? error.message : error));
      setMembersBusy(false);
    });
  });
}
if (membersCloseButton) membersCloseButton.addEventListener('click', closeMembersModal);
if (membersCancelButton) membersCancelButton.addEventListener('click', closeMembersModal);
if (membersModal) {
  membersModal.addEventListener('click', function (event) {
    // 只关闭遮罩本身；点击卡片内部不会误提交，也不会关闭。
    if (event.target === membersModal) closeMembersModal();
  });
}
if (membersContactsElement) {
  membersContactsElement.addEventListener('change', function (event) {
    const target = event.target;
    if (!target || target.type !== 'checkbox') return;
    updateMembersSelection();
  });
}
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape' || !membersModal || membersModal.hidden) return;
  if (openMemberMenu) {
    event.preventDefault();
    closeMemberMenu({ focus: true });
    return;
  }
  event.preventDefault();
  closeMembersModal();
});
// 点击行外、滚动或视口变化都收起菜单；同一时间只保留一个。
document.addEventListener('click', function (event) {
  if (!openMemberMenu) return;
  if (openMemberMenu.row.contains(event.target)) return;
  closeMemberMenu();
}, true);
document.addEventListener('scroll', function () {
  // 打开瞬间浏览器可能为聚焦/点击滚动一次，避免把这次滚动当成用户滚动。
  if (openMemberMenu && Date.now() - openMemberMenu.openedAt > 150) closeMemberMenu();
}, true);
window.addEventListener('resize', function () {
  if (openMemberMenu) closeMemberMenu();
});
if (membersForm) membersForm.addEventListener('submit', submitMembersForm);
`;
