/**
 * 群公告片段：聊天区顶部展示，owner 与管理员可编辑。
 *
 * 授权来自服务端 `room.capabilities.manage_announcement`；普通成员只读。
 * 保存带 `expected_announcement_revision`，并发修改返回 VERSION_CONFLICT，
 * 页面保留弹窗并提示重新打开，不静默覆盖他人公告。
 * 片段与其它脚本拼进同一个内联 `<script>` 共享作用域。
 */
export const CHAT_ANNOUNCEMENT_SCRIPT = `
const roomAnnouncementElement = document.getElementById('room-announcement');
const roomAnnouncementEditButton = document.getElementById('room-announcement-edit');
const announcementModal = document.getElementById('announcement-modal');
const announcementForm = document.getElementById('announcement-form');
const announcementInput = document.getElementById('announcement-input');
const announcementSave = document.getElementById('announcement-save');
const announcementCancel = document.getElementById('announcement-cancel');
const announcementClose = document.getElementById('announcement-close');
const announcementError = document.getElementById('announcement-error');
const announcementMeta = document.getElementById('announcement-meta');
let announcementOpener = null;

function canManageAnnouncement() {
  return Boolean(
    room &&
    room.kind === 'group' &&
    room.capabilities &&
    room.capabilities.manage_announcement
  );
}

function announcementText() {
  return room && room.kind === 'group' && typeof room.announcement === 'string'
    ? room.announcement
    : '';
}

/** 由 applyRoomHeader 调用：群公告变化时同步顶部提示条与入口文案。 */
function applyRoomAnnouncement() {
  const text = announcementText();
  if (roomAnnouncementElement) {
    roomAnnouncementElement.hidden = text.length === 0;
    roomAnnouncementElement.textContent = text;
  }
  if (roomAnnouncementEditButton) {
    const group = Boolean(room && room.kind === 'group');
    const editable = canManageAnnouncement();
    roomAnnouncementEditButton.hidden = !group || (!text && !editable);
    roomAnnouncementEditButton.textContent = editable ? '公告' : '查看公告';
  }
}

function setAnnouncementError(message) {
  if (announcementError) announcementError.textContent = message || '';
}

function openAnnouncementModal() {
  if (!announcementModal || !room || room.kind !== 'group') return;
  const editable = canManageAnnouncement();
  announcementOpener = document.activeElement;
  announcementModal.hidden = false;
  if (announcementInput) {
    announcementInput.value = announcementText();
    announcementInput.readOnly = !editable;
  }
  if (announcementSave) announcementSave.hidden = !editable;
  setAnnouncementError('');
  if (announcementMeta) {
    announcementMeta.textContent = editable
      ? '最多 ' + ROOM_ANNOUNCEMENT_BYTES + ' 字节，保存后同步给所有成员'
      : '只有群 owner 或管理员可以编辑公告';
  }
  if (editable && announcementInput) announcementInput.focus();
  else if (announcementClose) announcementClose.focus();
}

function closeAnnouncementModal() {
  if (announcementModal) announcementModal.hidden = true;
  setAnnouncementError('');
  const opener = announcementOpener;
  announcementOpener = null;
  if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
}

async function submitAnnouncementForm(event) {
  event.preventDefault();
  if (!announcementModal || announcementModal.hidden || !room || room.kind !== 'group') return;
  if (!canManageAnnouncement()) {
    setAnnouncementError('只有群 owner 或管理员可以编辑公告。');
    return;
  }
  const value = announcementInput ? announcementInput.value.trim() : '';
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > ROOM_ANNOUNCEMENT_BYTES) {
    setAnnouncementError(
      '公告最多 ' + ROOM_ANNOUNCEMENT_BYTES + ' 字节，当前 ' + bytes + ' 字节。'
    );
    return;
  }
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  if (!roomId) return;
  const revision = typeof room.announcement_revision === 'number' ? room.announcement_revision : 1;
  if (announcementSave) {
    announcementSave.disabled = true;
    announcementSave.textContent = '正在保存…';
  }
  setAnnouncementError('');
  try {
    const result = await callTool('network_room_announcement_set', {
      request_id: requestId('announcement'),
      room_id: roomId,
      announcement: value,
      expected_announcement_revision: revision
    });
    if (!isActiveRoom(roomId, epoch)) return;
    applyRoomDetail(result);
    closeAnnouncementModal();
    statusElement.textContent = value ? '群公告已更新' : '群公告已清除';
  } catch (error) {
    if (!isActiveRoom(roomId, epoch)) return;
    const code = error && error.code;
    if (code === 'VERSION_CONFLICT') {
      setAnnouncementError('公告已被其他人更新，请关闭后重新打开再编辑。');
    } else if (code === 'NOT_OWNER' || code === 'PERMISSION_DENIED') {
      setAnnouncementError('只有群 owner 或管理员可以编辑公告。');
    } else {
      setAnnouncementError('保存公告失败：' + (error && error.message ? error.message : error));
    }
  } finally {
    if (announcementSave) {
      announcementSave.disabled = false;
      announcementSave.textContent = '保存';
    }
  }
}

if (roomAnnouncementEditButton) {
  roomAnnouncementEditButton.addEventListener('click', openAnnouncementModal);
}
if (announcementClose) announcementClose.addEventListener('click', closeAnnouncementModal);
if (announcementCancel) announcementCancel.addEventListener('click', closeAnnouncementModal);
if (announcementModal) {
  announcementModal.addEventListener('click', function (event) {
    if (event.target === announcementModal) closeAnnouncementModal();
  });
}
if (announcementForm) announcementForm.addEventListener('submit', submitAnnouncementForm);
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape' || !announcementModal || announcementModal.hidden) return;
  event.preventDefault();
  closeAnnouncementModal();
});
`;
