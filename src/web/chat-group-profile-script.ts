/** Group settings reuse the existing member dialog; each edit belongs to one opening. */
export const CHAT_GROUP_PROFILE_SCRIPT = `
const groupNameInput = document.getElementById('group-name-input');
const groupNameSave = document.getElementById('group-name-save');
const groupProfileStatus = document.getElementById('group-profile-status');
const groupLeaveButton = document.getElementById('group-leave');
const groupDissolveButton = document.getElementById('group-dissolve');
let groupProfileContext = null;

function closeGroupProfile() {
  groupProfileContext = null;
}

function openGroupProfile() {
  if (!room || room.kind !== 'group') return;
  groupProfileContext = { roomId: activeRoomId, epoch: roomEpoch, title: room.title || '', busy: false };
  groupNameInput.value = groupProfileContext.title;
  updateGroupProfileCapabilities();

  groupNameSave.disabled = false;
  groupNameSave.textContent = '保存群名';
  groupProfileStatus.textContent = '';
  groupLeaveButton.hidden = !room.can_leave;
  groupDissolveButton.hidden = !room.can_dissolve;
}

function updateGroupProfileCapabilities() {
  if (!groupNameInput || !room) return;
  const editable = roomCapability('edit_profile');
  groupNameInput.disabled = !editable;
  groupNameSave.hidden = !editable;
  groupLeaveButton.hidden = !room.can_leave;
  groupDissolveButton.hidden = !room.can_dissolve;
}

async function saveGroupName() {
  const context = groupProfileContext;
  if (!context || context.busy || !isActiveRoom(context.roomId, context.epoch)) return;
  const title = groupNameInput.value.trim();
  if (!title) { groupProfileStatus.textContent = '群名称不能为空'; return; }
  if (!context.intent || context.intent.title !== title) {
    context.intent = { title: title, requestId: requestId('group-name') };
  }
  context.busy = true;
  context.retryPending = false;
  groupNameSave.disabled = true;
  groupProfileStatus.textContent = '正在保存…';
  try {
    const result = await callTool('network_room_rename', {
      request_id: context.intent.requestId, room_id: context.roomId,
      title: title, expected_title: context.title
    });
    if (!isActiveRoom(context.roomId, context.epoch) || groupProfileContext !== context) return;
    applyRoomDetail(result);
    snapshotActiveRoom();
    context.title = result.room.title;
    context.intent = null;
    context.retryPending = false;
    groupProfileStatus.textContent = '群名称已更新';
  } catch (error) {
    if (groupProfileContext !== context) return;
    if (error && error.code === 'VERSION_CONFLICT') {
      // 读取权威标题，改用新 expected_title 生成新 request_id；不自动覆盖并发修改。
      context.intent = null;
      try {
        const latest = await callTool('network_room_get', { room_id: context.roomId });
        if (!isActiveRoom(context.roomId, context.epoch) || groupProfileContext !== context) return;
        const draft = groupNameInput.value;
        applyRoomDetail(latest);
        context.title = latest.room.title || '';
        groupNameInput.value = draft;
        context.retryPending = true;
        groupNameStatusConflict(latest.room.title || '');
      } catch (refreshError) {
        if (groupProfileContext !== context) return;
        groupProfileStatus.textContent =
          '群名称已变化，草稿已保留；暂时无法读取最新群名，请稍后点击“保存群名”重试。';
      }
    } else {
      groupProfileStatus.textContent = '保存失败：' +
        (error && error.message ? error.message : error);
    }
  } finally {
    context.busy = false;
    if (groupProfileContext === context) groupNameSave.disabled = false;
    if (groupProfileContext === context) {
      groupNameSave.textContent = context.retryPending ? '确认覆盖并重试' : '保存群名';
    }
  }
}

function groupNameStatusConflict(currentTitle) {
  const shown = String(currentTitle || '');
  groupProfileStatus.textContent = '群名已更新为“' + shown + '”。你的草稿已保留；确认后点击“确认覆盖并重试”。';
}

function groupLifecycleTarget() {
  if (!room || room.kind !== 'group') return null;
  return { roomId: activeRoomId, roomName: room.title || '群聊', kind: 'group',
    can_leave: room.can_leave, can_dissolve: room.can_dissolve, read_only: room.read_only };
}

if (groupNameSave) groupNameSave.addEventListener('click', saveGroupName);
if (groupNameInput) groupNameInput.addEventListener('keydown', function (event) {
  if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); saveGroupName(); }
});
if (groupLeaveButton) groupLeaveButton.addEventListener('click', function () {
  safetyLeaveGroup(groupLifecycleTarget());
});
if (groupDissolveButton) groupDissolveButton.addEventListener('click', function () {
  safetyDissolveGroup(groupLifecycleTarget());
});
`;
