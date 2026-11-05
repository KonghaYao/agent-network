/**
 * 群聊成员管理片段：群聊头部“添加成员”入口、当前成员只读列表与好友分页选择。
 *
 * 服务端 `network_room_members_update` 只允许群 owner 调用，页面据此在
 * 非 owner 打开时给出明确提示，而不是静默失败。片段与其它脚本拼进同一个
 * 内联 `<script>` 共享作用域；不改变工具契约或既有 DOM id/class。
 */
export const CHAT_MEMBERS_SCRIPT = `
const membersButton = document.getElementById('add-members');
const membersModal = document.getElementById('members-modal');
const membersForm = document.getElementById('members-form');
const membersCurrentElement = document.getElementById('members-current');
const membersContactsElement = document.getElementById('members-contacts');
const membersErrorElement = document.getElementById('members-error');
const membersAddButton = document.getElementById('members-add');
const membersCancelButton = document.getElementById('members-cancel');
let membersLoadToken = 0;

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

function hasMemberChoices() {
  return Boolean(
    membersContactsElement && membersContactsElement.querySelector('input[type=checkbox]')
  );
}

function setMembersBusy(busy, label) {
  if (!membersAddButton) return;
  membersAddButton.disabled = busy || !isGroupOwner() || !hasMemberChoices();
  membersAddButton.textContent = busy ? (label || '正在添加…') : '添加';
}

function renderCurrentMembers() {
  if (!membersCurrentElement) return;
  membersCurrentElement.replaceChildren();
  for (const member of members.values()) {
    const item = document.createElement('li');
    item.className = 'member-roster-item';
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
}

function renderMembersContacts(contacts, note) {
  if (!membersContactsElement) return;
  const checked = new Set();
  for (const input of membersContactsElement.querySelectorAll('input[type=checkbox]:checked')) {
    checked.add(input.value);
  }
  membersContactsElement.replaceChildren();
  if (!isGroupOwner()) {
    membersContactsElement.textContent = '只有群 owner 可以添加成员';
    return;
  }
  if (contacts.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'list-hint';
    empty.textContent = note || '没有可添加的好友：好友都已在群里。';
    membersContactsElement.append(empty);
    return;
  }
  for (const contact of contacts) {
    const label = document.createElement('label');
    label.className = 'contact-choice';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = contact.actor_id;
    if (checked.has(contact.actor_id)) input.checked = true;
    const name = document.createElement('span');
    name.textContent = contact.name;
    const kind = document.createElement('span');
    kind.className = 'contact-kind';
    kind.textContent = contact.kind === 'agent' ? 'Agent' : '人';
    label.append(input, name, kind);
    membersContactsElement.append(label);
  }
  if (note) {
    const hint = document.createElement('p');
    hint.className = 'list-hint';
    hint.textContent = note;
    membersContactsElement.append(hint);
  }
}

function closeMembersModal() {
  membersLoadToken += 1;
  if (membersModal) membersModal.hidden = true;
  setMembersError('');
  if (membersContactsElement) membersContactsElement.replaceChildren();
  if (membersAddButton) {
    membersAddButton.disabled = true;
    membersAddButton.textContent = '添加';
  }
}

function membersCandidates(contacts) {
  const excluded = new Set(members.keys());
  if (identity) excluded.add(identity.actor_id);
  return contacts.filter(function (contact) {
    return !excluded.has(contact.actor_id);
  });
}

async function openMembersModal() {
  if (!membersModal || !room || room.kind !== 'group') return;
  membersModal.hidden = false;
  setMembersError('');
  renderCurrentMembers();
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  const loadToken = ++membersLoadToken;
  if (!isGroupOwner()) {
    if (membersContactsElement) {
      membersContactsElement.textContent = '只有群 owner 可以添加成员';
    }
    setMembersError('只有群 owner 可以添加成员。');
    setMembersBusy(false);
    return;
  }
  if (membersContactsElement) membersContactsElement.textContent = '正在读取好友…';
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
    renderMembersContacts(membersCandidates(contacts));
    setMembersBusy(false);
    const ownerActorId = identity ? identity.actor_id : '';
    if (agentContactGaps(ownerActorId, contacts).length === 0) return;
    renderMembersContacts(
      membersCandidates(contacts),
      '正在同步本机创建的 Agent…'
    );
    const synced = await addOwnedAgentContacts(ownerActorId, contacts);
    if (
      loadToken !== membersLoadToken ||
      !isActiveRoom(roomId, epoch) ||
      !membersModal ||
      membersModal.hidden
    ) {
      return;
    }
    renderMembersContacts(
      membersCandidates(synced.contacts),
      agentContactSyncError(synced.failed)
    );
    setMembersBusy(false);
  } catch (error) {
    if (loadToken !== membersLoadToken || !isActiveRoom(roomId, epoch)) return;
    if (membersContactsElement) membersContactsElement.replaceChildren();
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
  const epoch = roomEpoch;
  if (!isGroupOwner()) {
    setMembersError('只有群 owner 可以添加成员。');
    return;
  }
  const selected = [];
  if (membersContactsElement) {
    for (const input of membersContactsElement.querySelectorAll('input[type=checkbox]:checked')) {
      selected.push(input.value);
    }
  }
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
      setMembersBusy(false);
      return;
    }
    applyRoomDetail(result);
    closeMembersModal();
    statusElement.textContent = '已添加 ' + added.length + ' 名成员';
    // 更新响应已立即刷新头部与成员；后台再读一次 room_get 校准侧栏。
    refresh(false).catch(function (error) {
      if (!isActiveRoom(roomId, epoch)) return;
      statusElement.textContent = '成员已添加，但刷新会话失败：' +
        (error && error.message ? error.message : error);
    });
  } catch (error) {
    if (!isActiveRoom(roomId, epoch)) return;
    setMembersError(membersUpdateError(error));
    setMembersBusy(false);
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
if (membersCancelButton) membersCancelButton.addEventListener('click', closeMembersModal);
if (membersModal) {
  membersModal.addEventListener('click', function (event) {
    if (event.target === membersModal) closeMembersModal();
  });
}
if (membersForm) membersForm.addEventListener('submit', submitMembersForm);
`;
