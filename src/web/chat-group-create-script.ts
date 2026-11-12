/** Group creation owns its form generation and retry identity. */
export const CHAT_GROUP_CREATE_SCRIPT = `
let groupBusy = false;
let groupCreateIntent = null;
function updateGroupCreateState() {
  if (!groupCreateButton) return;
  groupCreateButton.disabled = groupBusy || !groupPicker || groupPicker.selectedIds().length === 0;
  groupCreateButton.textContent = groupBusy ? '正在创建…' : '创建';
}
async function loadGroupContacts() {
  const contacts = [];
  const seen = new Set();
  let cursor = null;
  for (;;) {
    const args = { limit: 100 };
    if (cursor) args.cursor = cursor;
    const result = await callTool('network_contacts_list', args);
    for (const contact of result.items || []) {
      if (!contact || typeof contact.actor_id !== 'string') continue;
      // 单侧收藏/历史不是好友：只有双向 active 关系才能用于建群或加成员。
      if (contact.relation !== 'active') continue;
      if (seen.has(contact.actor_id)) continue;
      seen.add(contact.actor_id);
      contacts.push(contact);
    }
    if (!result.has_more || !result.next_cursor) break;
    if (result.next_cursor === cursor) throw new Error('好友分页未前进，请重试');
    cursor = result.next_cursor;
  }
  return contacts;
}

/** 建群与添加成员共用一个选择器；这里只绑定建群弹窗的 DOM。 */
function groupPickerController() {
  if (groupPicker) return groupPicker;
  groupPicker = createMemberPicker({
    root: groupContactsElement,
    search: groupSearchElement,
    more: groupMoreButton,
    count: groupContactsCountElement,
    selection: groupSelectionElement,
    onChange: updateGroupCreateState,
    empty: '还没有好友。通过分享链接发送好友申请，对方确认后即可加入群聊。'
  });
  return groupPicker;
}

function showGroupPicker(contacts, note) {
  const picker = groupPickerController();
  picker.setContacts(contacts);
  picker.setNote(note || '');
}

function closeGroupModal() {
  groupLoadSeq += 1;
  groupBusy = false;
  if (groupModal) groupModal.hidden = true;
}

async function openGroupModal() {
  if (!groupModal || !groupContactsElement) return;
  groupLoadSeq += 1;
  const loadSeq = groupLoadSeq;
  groupBusy = false;
  groupModal.hidden = false;
  if (groupTitleInput) { groupTitleInput.value = ''; groupTitleInput.disabled = false; }
  if (groupErrorElement) groupErrorElement.textContent = '';
  if (groupCreateButton) {
    groupCreateButton.disabled = false;
    groupCreateButton.textContent = '创建';
  }
  const picker = groupPickerController();
  const selfId = identity ? identity.actor_id : '';
  picker.reset();
  picker.setExcluded(selfId ? [selfId] : []);
  picker.setNote('正在读取好友…');
  try {
    await ensureIdentity();
    if (loadSeq !== groupLoadSeq || groupModal.hidden) return;
    const contacts = await loadGroupContacts();
    if (loadSeq !== groupLoadSeq || groupModal.hidden) return;
    picker.setExcluded(identity ? [identity.actor_id] : []);
    picker.setNote('正在读取本机与受管 Agent…');
    const ownerActorId = identity ? identity.actor_id : '';
    const merged = await mergeAgentPickerContacts(ownerActorId, contacts);
    if (loadSeq !== groupLoadSeq || groupModal.hidden) return;
    showGroupPicker(merged.contacts);
    if (groupTitleInput) groupTitleInput.focus();
  } catch (error) {
    if (loadSeq !== groupLoadSeq || groupModal.hidden) return;
    picker.setContacts([]);
    picker.setNote('');
    if (groupErrorElement) {
      groupErrorElement.textContent = '读取好友失败：' + (error && error.message ? error.message : error);
    }
  }
}

if (newGroupButton) newGroupButton.addEventListener('click', openGroupModal);
if (groupCancelButton) groupCancelButton.addEventListener('click', closeGroupModal);
if (groupModal) {
  groupModal.addEventListener('click', function (event) {
    if (event.target === groupModal) closeGroupModal();
  });
}
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape' || !groupModal || groupModal.hidden) return;
  event.preventDefault();
  closeGroupModal();
});
if (groupForm) {
  groupForm.addEventListener('submit', async function (event) {
    event.preventDefault();
    if (groupBusy || !groupModal || groupModal.hidden) return;
    const selected = groupPicker ? groupPicker.selectedIds() : [];
    if (selected.length === 0) {
      groupErrorElement.textContent = '请至少选择一个成员';
      return;
    }
    const title = groupTitleInput.value.trim();
    if (selected.length > MEMBER_CHANGE_MAX) {
      groupErrorElement.textContent = '单次最多选择 ' + MEMBER_CHANGE_MAX + ' 名成员';
      return;
    }
    const generation = groupLoadSeq;
    const owner = identity && identity.actor_id;
    const fingerprint = JSON.stringify([owner, title, selected.slice().sort()]);
    if (!groupCreateIntent || groupCreateIntent.fingerprint !== fingerprint) {
      groupCreateIntent = { fingerprint: fingerprint, requestId: requestId('group') };
    }
    const intent = groupCreateIntent;
    groupBusy = true;
    groupPicker.setBusy(true);
    groupTitleInput.disabled = true;
    updateGroupCreateState();
    groupErrorElement.textContent = '正在创建…';
    try {
      const args = {
        request_id: intent.requestId,
        kind: 'group',
        members: selected.slice().sort()
      };
      if (title) args.title = title;
      const result = await callTool('network_room_create', args);
      if (!identity || identity.actor_id !== owner) return;
      const currentFilter = roomFilter;
      const newRoomId = seedRoomCacheFromDetail(result);
      if (groupCreateIntent === intent) groupCreateIntent = null;
      if (generation !== groupLoadSeq || groupModal.hidden) {
        setRoomFilter(currentFilter);
        showToast('群聊已创建，可在会话列表打开');
        return;
      }
      groupErrorElement.textContent = '';
      const failures = (result.results || []).filter(function (entry) { return entry.status === 'failed'; });
      if (failures.length) showToast('群已创建，未加入：' + failures.map(function (entry) { return entry.name; }).join('、'));
      closeGroupModal();
      navigateTo('/c/' + encodeURIComponent(newRoomId));
    } catch (error) {
      if (generation !== groupLoadSeq || groupModal.hidden) return;
      groupErrorElement.textContent =
        '创建失败：' + (error && error.message ? error.message : error);
    } finally {
      if (generation === groupLoadSeq) {
        groupBusy = false;
        groupTitleInput.disabled = false;
        groupPicker.setBusy(false);
        updateGroupCreateState();
      }
    }
  });
}

`;
