/** Per-identity preferences on this browser. They never change server read watermarks. */
export const CHAT_ROOM_PREFERENCES_SCRIPT = `
const ROOM_PREFERENCES_PREFIX = 'agent-network-room-preferences-v1:';
let roomPreferencesActor = null;
let roomPreferences = {};

function loadRoomPreferences() {
  const actor = identity && identity.actor_id;
  if (roomPreferencesActor === actor) return;
  roomPreferencesActor = actor;
  roomPreferences = {};
  if (!actor) return;
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_PREFERENCES_PREFIX + actor) || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (!/^rm_[a-zA-Z0-9_-]+$/.test(key) || !value || typeof value !== 'object') continue;
      roomPreferences[key] = { pinned: value.pinned === true, muted: value.muted === true };
    }
  } catch (error) {}
}

function roomPreference(roomId) {
  loadRoomPreferences();
  return roomPreferences[roomId] || { pinned: false, muted: false };
}

function unreadAttention(entry) {
  return Number(entry.my_last_read_seq) < Number(entry.head_seq) && !roomPreference(entry.room_id).muted;
}

function toggleRoomPreference(field) {
  if (!identity || !roomMenuTarget) return;
  const roomId = roomMenuTarget.roomId;
  const previous = roomPreference(roomId);
  const value = Object.assign({}, previous, { [field]: !previous[field] });
  roomPreferences[roomId] = value;
  if (!value.pinned && !value.muted) delete roomPreferences[roomId];
  let saved = true;
  try { localStorage.setItem(ROOM_PREFERENCES_PREFIX + identity.actor_id, JSON.stringify(roomPreferences)); }
  catch (error) { saved = false; }
  closeRoomMenu();
  renderRooms();
  showToast(saved ? '已更新，仅在此浏览器生效' : '已临时更新；浏览器未能保存设置');
}

function syncRoomPreferenceMenu(roomId) {
  const pref = roomPreference(roomId);
  document.getElementById('room-menu-pin').textContent = pref.pinned ? '取消置顶' : '置顶聊天';
  document.getElementById('room-menu-mute').textContent = pref.muted ? '恢复消息提醒' : '消息免打扰';
}

window.addEventListener('storage', function (event) {
  if (identity && event.key === ROOM_PREFERENCES_PREFIX + identity.actor_id) {
    roomPreferencesActor = null;
    renderRooms();
  }
});
`;
