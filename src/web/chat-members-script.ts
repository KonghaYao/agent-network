/**
 * 群聊成员管理片段：左右双栏的“已在群 / 未在群”选择器与好友分页。
 *
 * 服务端 `network_room_members_update` 只允许群 owner 调用，页面据此在
 * 非 owner 打开时给出明确提示，而不是静默失败。片段与其它脚本拼进同一个
 * 内联 `<script>` 共享作用域；不改变工具契约或既有 DOM id/class。
 */
export const CHAT_MEMBERS_SCRIPT = `
const membersButton = document.getElementById('add-members');
const membersModal = document.getElementById('members-modal');
const membersForm = document.getElementById('members-form');
const membersCloseButton = document.getElementById('members-close');
const membersCurrentElement = document.getElementById('members-current');
const membersCurrentCountElement = document.getElementById('members-current-count');
const membersCurrentEmptyElement = document.getElementById('members-current-empty');
const membersContactsElement = document.getElementById('members-contacts');
const membersContactsCountElement = document.getElementById('members-contacts-count');
const membersSelectionElement = document.getElementById('members-selection');
const membersErrorElement = document.getElementById('members-error');
const membersAddButton = document.getElementById('members-add');
const membersCancelButton = document.getElementById('members-cancel');
let membersLoadToken = 0;
let membersContactsCache = [];
let membersContactNote = '';
let membersBusy = false;
let membersOpener = null;

function isGroupOwner() {
  return Boolean(room && room.kind === 'group' && room.my_role === 'owner');
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
  const selected = [];
  if (!membersContactsElement) return selected;
  for (const input of membersContactsElement.querySelectorAll('input[type=checkbox]:checked')) {
    selected.push(input.value);
  }
  return selected;
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
    membersAddButton.disabled = membersBusy || !isGroupOwner() || selected.length === 0;
  }
}

function setMembersBusy(busy, label) {
  membersBusy = busy;
  if (membersAddButton) {
    membersAddButton.textContent = busy ? (label || '正在添加…') : '添加';
  }
  if (membersForm) membersForm.setAttribute('aria-busy', busy ? 'true' : 'false');
  updateMembersSelection();
}

function renderCurrentMembers() {
  if (!membersCurrentElement) return;
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
    role.textContent = (member.role === 'owner' ? '群主 · ' : '') +
      (member.kind === 'agent' ? 'Agent' : '人');
    item.append(name, role);
    membersCurrentElement.append(item);
  }
  if (membersCurrentCountElement) {
    membersCurrentCountElement.textContent = String(members.size);
  }
  if (membersCurrentEmptyElement) membersCurrentEmptyElement.hidden = members.size > 0;
}

function renderMembersEmpty(message) {
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
  const checked = new Set(selectedMemberIds());
  membersContactsElement.replaceChildren();
  if (membersContactsCountElement) {
    membersContactsCountElement.textContent = String(isGroupOwner() ? contacts.length : 0);
  }
  if (!isGroupOwner()) {
    renderMembersEmpty('只有群 owner 可以添加成员');
    return;
  }
  if (contacts.length === 0) {
    renderMembersEmpty(note || '没有可添加的好友：好友都已在群里。');
    return;
  }
  for (const contact of contacts) {
    const label = document.createElement('label');
    label.className = 'contact-choice';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = contact.actor_id;
    if (checked.has(contact.actor_id)) {
      input.checked = true;
      label.classList.add('selected');
    }
    const avatar = avatarElement(
      contact.name,
      contact.kind === 'agent' ? 'agent' : null,
      'avatar contact-avatar'
    );
    const name = document.createElement('span');
    name.textContent = contact.name;
    const kind = document.createElement('span');
    kind.className = 'contact-kind';
    kind.textContent = contact.kind === 'agent' ? 'Agent' : '人';
    label.append(input, avatar, name, kind);
    membersContactsElement.append(label);
  }
  if (note) {
    const hint = document.createElement('p');
    hint.className = 'members-empty';
    hint.textContent = note;
    membersContactsElement.append(hint);
  }
  updateMembersSelection();
}

function closeMembersModal() {
  membersLoadToken += 1;
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
  if (identity) excluded.add(identity.actor_id);
  const seen = new Set();
  return contacts.filter(function (contact) {
    if (!contact || typeof contact.actor_id !== 'string') return false;
    if (excluded.has(contact.actor_id) || seen.has(contact.actor_id)) return false;
    seen.add(contact.actor_id);
    return true;
  });
}

async function openMembersModal() {
  if (!membersModal || !room || room.kind !== 'group') return;
  membersOpener = document.activeElement;
  membersModal.hidden = false;
  setMembersError('');
  membersContactsCache = [];
  membersContactNote = '';
  renderCurrentMembers();
  setMembersBusy(false);
  if (membersCloseButton) membersCloseButton.focus();
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const loadToken = ++membersLoadToken;
  if (!isGroupOwner()) {
    renderMembersEmpty('只有群 owner 可以添加成员');
    setMembersError('只有群 owner 可以添加成员。');
    return;
  }
  renderMembersEmpty('正在读取好友…');
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
    setMembersBusy(false);
    const ownerActorId = identity ? identity.actor_id : '';
    if (agentContactGaps(ownerActorId, contacts).length === 0) return;
    membersContactNote = '正在同步本机创建的 Agent…';
    renderMembersContacts(membersCandidates(contacts), membersContactNote);
    const synced = await addOwnedAgentContacts(ownerActorId, contacts);
    if (
      loadToken !== membersLoadToken ||
      !isActiveRoom(roomId, epoch) ||
      !membersModal ||
      membersModal.hidden
    ) {
      return;
    }
    membersContactsCache = synced.contacts;
    membersContactNote = agentContactSyncError(synced.failed) || '';
    renderMembersContacts(membersCandidates(synced.contacts), membersContactNote);
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
  if (code === 'NOT_OWNER') return '只有群 owner 可以添加成员。';
  if (code === 'FRIEND_REQUIRED') return '只能添加好友；请先把对方添加为好友。';
  if (code === 'ROOM_FULL') {
    return '群成员已达上限（' + GROUP_MEMBERS_MAX + ' 人），无法继续添加。';
  }
  if (code === 'NOT_FOUND') return '房间不存在或已失效。';
  if (code === 'NOT_MEMBER') return '你已不在该群中，无法添加成员。';
  const message = error && error.message ? String(error.message) : String(error);
  return '添加成员失败：' + message;
}

async function submitMembersForm(event) {
  event.preventDefault();
  const roomId = activeRoomId;
  if (!roomId || !room || room.kind !== 'group' || !membersModal || membersModal.hidden) return;
  if (membersBusy) return;
  const epoch = roomEpoch;
  if (!isGroupOwner()) {
    setMembersError('只有群 owner 可以添加成员。');
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
  try {
    const result = await callTool('network_room_members_update', {
      request_id: requestId('members'),
      room_id: roomId,
      add: selected
    });
    if (!isActiveRoom(roomId, epoch)) return;
    const before = new Set(members.keys());
    const afterMembers = result && Array.isArray(result.members) ? result.members : [];
    const added = afterMembers.filter(function (member) {
      return !before.has(member.actor_id);
    });
    if (added.length === 0) {
      setMembersError('所选好友已在群里，成员没有变化。');
      renderMembersContacts(membersCandidates(membersContactsCache), membersContactNote);
      return;
    }
    applyRoomDetail(result);
    // 新成员从右侧候选消失、出现在左侧；弹窗保持打开，便于连续添加。
    renderCurrentMembers();
    renderMembersContacts(membersCandidates(membersContactsCache), membersContactNote);
    setMembersError('');
    statusElement.textContent = '已添加 ' + added.length + ' 名成员';
    // 更新响应已立即刷新头部与成员；后台再读一次 room_get 校准侧栏。
    refresh(false).catch(function (error) {
      if (!isActiveRoom(roomId, epoch)) return;
      statusElement.textContent = '成员已添加，但刷新会话失败：' +
        (error && error.message ? error.message : error);
    });
  } catch (error) {
    if (!isActiveRoom(roomId, epoch)) return;
    // 失败保留已选候选，用户可直接重试。
    setMembersError(membersUpdateError(error));
  } finally {
    if (isActiveRoom(roomId, epoch)) setMembersBusy(false);
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
  event.preventDefault();
  closeMembersModal();
});
if (membersForm) membersForm.addEventListener('submit', submitMembersForm);
`;
