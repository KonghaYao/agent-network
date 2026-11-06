/**
 * 会话列表渲染片段。
 *
 * `chatClientScript` 把它拼进同一个 `<script>`，因此与 `chat-script.ts`
 * 共享作用域；拆文件只为控制单文件行数，不改变页面行为。
 */
export const CHAT_LIST_SCRIPT = `
let searchQuery = '';
let emptyListMessage = '';
const ROOM_FILTER_KEY = 'agent-network-room-filter';
const roomFilterElement = document.getElementById('room-filter');
const roomFilterButtons = roomFilterElement
  ? Array.prototype.slice.call(roomFilterElement.querySelectorAll('[data-room-filter]'))
  : [];
let roomFilter = readRoomFilter();

function readRoomFilter() {
  try {
    return localStorage.getItem(ROOM_FILTER_KEY) === 'group' ? 'group' : 'direct';
  } catch (error) {
    return 'direct';
  }
}

function persistRoomFilter(value) {
  try {
    localStorage.setItem(ROOM_FILTER_KEY, value);
  } catch (error) {
    // 隐私模式禁用存储时只影响记忆，不影响本次筛选。
  }
}

function updateRoomFilterTabs() {
  for (const button of roomFilterButtons) {
    const selected = button.dataset.roomFilter === roomFilter;
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    button.tabIndex = selected ? 0 : -1;
  }
}

function setRoomFilter(value, options) {
  if (value !== 'direct' && value !== 'group') return;
  const settings = options || {};
  if (value !== roomFilter) {
    roomFilter = value;
    persistRoomFilter(value);
    updateRoomFilterTabs();
  }
  if (settings.render !== false) renderRooms();
}

/** 进入房间时切到对应分类，避免当前会话被另一分类隐藏。 */
function syncRoomFilterForRoom(roomId) {
  if (!roomId) return;
  const entry = roomEntries.find(function (item) { return item.room_id === roomId; });
  if (!entry || (entry.kind !== 'direct' && entry.kind !== 'group')) return;
  if (entry.kind !== roomFilter) setRoomFilter(entry.kind, { render: false });
}

function roomFilterEmptyMessage() {
  if (emptyListMessage) return emptyListMessage;
  return roomFilter === 'group'
    ? '还没有群聊。点击右上角 + 新建群聊。'
    : '还没有单聊。打开 Agent 分享链接即可开始。';
}

const AVATAR_COLORS = ['#5b8def', '#e8a33d', '#6aa84f', '#d96459', '#8e7cc3', '#3d9a9a'];

function avatarColor(name) {
  const chars = Array.from(String(name || '?'));
  let hash = 0;
  for (const char of chars) hash = (hash * 31 + char.codePointAt(0)) % 9973;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function firstChar(name) {
  const chars = Array.from(String(name || '单聊').trim());
  return chars.length > 0 ? chars[0] : '聊';
}

/** 在线状态文案；true 在线、false 离线、null 表示服务端暂时无法确认。 */
function presenceLabel(online) {
  if (online === true) return '在线';
  if (online === false) return '离线';
  return '未知';
}

/**
 * 会话列表圆形头像；群聊为 2×2 首字色块，避免所有群共用同一个字。
 * 非群聊优先匹配本地头像映射（品牌图标仅 Agent，用户头像按规则），
 * 未命中保留首字/颜色 fallback。
 */
function avatarElement(name, kind, className) {
  const element = document.createElement('span');
  element.className = (className || 'avatar') + (kind === 'group' ? ' avatar-grid' : '');
  element.setAttribute('aria-hidden', 'true');
  if (kind === 'group') {
    const chars = Array.from(String(name || '群聊').trim()).filter(function (char) {
      return char.trim().length > 0;
    });
    if (chars.length === 0) chars.push('群');
    for (let index = 0; index < 4; index += 1) {
      const cell = document.createElement('span');
      cell.className = 'avatar-cell';
      cell.textContent = chars[index % chars.length];
      cell.style.background = AVATAR_COLORS[index % AVATAR_COLORS.length];
      element.append(cell);
    }
  } else if (!applyAgentAvatar(element, name, kind)) {
    element.textContent = firstChar(name);
    element.style.background = avatarColor(name);
  }
  return element;
}

function pad2(value) {
  return value < 10 ? '0' + value : String(value);
}

function clockTime(date) {
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes());
}

/** 会话列表时间：今天显示时:分，昨天显示“昨天”，更早显示日期。 */
function relativeTime(value) {
  const ms = Number(value);
  if (!ms || Number.isNaN(ms)) return '';
  const date = new Date(ms);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return clockTime(date);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天';
  const monthDay = (date.getMonth() + 1) + '/' + date.getDate();
  if (date.getFullYear() === now.getFullYear()) return monthDay;
  return date.getFullYear() + '/' + monthDay;
}

function messageTime(entry) {
  return entry.last_message ? Number(entry.last_message.created_at) : 0;
}

function sortRooms(entries) {
  return entries.slice().sort(function (a, b) {
    const byMessage = messageTime(b) - messageTime(a);
    if (byMessage !== 0) return byMessage;
    return Number(b.updated_at) - Number(a.updated_at);
  });
}

function setListHint(text) {
  if (!listStatusElement) return;
  listStatusElement.textContent = text;
  listStatusElement.hidden = !text;
}

function setEmptyListMessage(text) {
  emptyListMessage = text;
  setListHint(text);
}

function setListRetry(visible) {
  if (listRetryElement) listRetryElement.hidden = !visible;
}

function clearListSkeleton() {
  if (!roomListElement) return;
  for (const item of Array.from(roomListElement.querySelectorAll('.room-skeleton'))) {
    item.remove();
  }
}

function updateAccount(me) {
  if (accountNameElement) accountNameElement.textContent = me.name || '未命名';
  if (accountAvatarElement) {
    accountAvatarElement.textContent = firstChar(me.name);
    if (!applyAgentAvatar(accountAvatarElement, me.name, me.kind || 'human')) {
      accountAvatarElement.style.background = avatarColor(me.name);
    }
  }
  const renameButton = document.getElementById('account-rename');
  if (renameButton) renameButton.hidden = false;
  const actions = document.querySelector('.account-actions');
  if (actions) actions.hidden = false;
  if (newGroupButton) newGroupButton.disabled = false;
  const startButton = document.getElementById('logged-out-start');
  if (startButton) startButton.hidden = true;
  syncLogoutVisibility();
}

/**
 * 已退出登录的本机首页：不自动注册新身份，显示分享链接/连接提示词引导。
 *
 * 只调整现有 DOM，不请求服务端；创建新身份由“创建新身份并继续”按钮显式触发。
 */
function showLoggedOutHome() {
  if (roomListElement) roomListElement.replaceChildren();
  clearListSkeleton();
  setListRetry(false);
  setEmptyListMessage(
    '已退出登录。本机登录凭据与已保存的 Agent 连接提示词已清除；当前 token 仍然有效，其他设备不受影响。打开 Agent 分享链接或使用已有连接提示词即可继续；需要新身份时点击下方按钮。'
  );
  if (accountNameElement) accountNameElement.textContent = '未登录';
  if (accountAvatarElement) {
    resetAgentAvatar(accountAvatarElement);
    accountAvatarElement.textContent = '?';
    accountAvatarElement.style.background = '';
  }
  const renameButton = document.getElementById('account-rename');
  if (renameButton) renameButton.hidden = true;
  const actions = document.querySelector('.account-actions');
  if (actions) actions.hidden = true;
  if (newGroupButton) newGroupButton.disabled = true;
  const startButton = document.getElementById('logged-out-start');
  if (startButton) {
    startButton.hidden = false;
    startButton.disabled = false;
  }
  const emptyTitle = document.getElementById('empty-title');
  if (emptyTitle) emptyTitle.textContent = '已退出登录';
  const emptyHint = document.getElementById('empty-hint');
  if (emptyHint) {
    emptyHint.textContent = '打开 Agent 分享链接，或使用已有连接提示词；需要新身份时点击左侧“创建新身份并继续”。';
  }
  syncLogoutVisibility();
}

function roomMatches(entry, query) {
  if (!query) return true;
  if (String(entry.name || '').toLowerCase().indexOf(query) >= 0) return true;
  const preview = entry.last_message ? entry.last_message.preview : '';
  return String(preview || '').toLowerCase().indexOf(query) >= 0;
}

function renderRooms() {
  if (!roomListElement) return;
  roomListElement.setAttribute('aria-label', roomFilter === 'group' ? '群聊' : '单聊');
  // 归档只影响默认列表与总览搜索；房间与消息仍可按 /c/<room_id> 使用。
  const visibleEntries = roomEntries.filter(function (entry) {
    return !isArchivedAgentRoom(entry) && entry.kind === roomFilter;
  });
  const query = searchQuery.trim().toLowerCase();
  const entries = query ? visibleEntries.filter(function (entry) {
    return roomMatches(entry, query);
  }) : visibleEntries;
  const unarchivedEntries = roomEntries.filter(function (entry) {
    return !isArchivedAgentRoom(entry);
  });
  const scroller = roomListElement.parentElement;
  const previousScroll = scroller ? scroller.scrollTop : 0;
  roomListElement.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'room-item' + (entry.room_id === activeRoomId ? ' active' : '');
    link.href = '/c/' + encodeURIComponent(entry.room_id);
    link.title = entry.name;
    link.dataset.roomId = entry.room_id;
    link.dataset.roomName = entry.name;
    link.dataset.roomKind = entry.kind;
    if (entry.room_id === activeRoomId) link.setAttribute('aria-current', 'page');
    const agentPeer = entry.kind === 'direct' && entry.peer_kind === 'agent';
    const avatar = avatarElement(entry.name, agentPeer ? 'agent' : entry.kind);
    const main = document.createElement('div');
    main.className = 'room-main';
    const top = document.createElement('div');
    top.className = 'room-top';
    const name = document.createElement('span');
    name.className = 'room-name';
    name.textContent = entry.name;
    const time = document.createElement('span');
    time.className = 'room-time';
    time.textContent = relativeTime(entry.last_message ? entry.last_message.created_at : entry.updated_at);
    top.append(name);
    const taskProgress = taskSummary.get(entry.room_id);
    if (taskProgress && taskProgress.total > 0) {
      const taskBadge = document.createElement('span');
      taskBadge.className = 'room-task-badge';
      taskBadge.textContent = taskProgress.done + '/' + taskProgress.total;
      taskBadge.title = '任务完成 ' + taskProgress.done + '/' + taskProgress.total;
      taskBadge.setAttribute(
        'aria-label',
        '任务已完成 ' + taskProgress.done + ' 个，共 ' + taskProgress.total + ' 个'
      );
      top.append(taskBadge);
    }
    top.append(time);
    const preview = document.createElement('div');
    preview.className = 'room-preview';
    preview.textContent = entry.last_message ? entry.last_message.preview : '还没有消息';
    main.append(top, preview);
    const avatarWrap = document.createElement('span');
    avatarWrap.className = 'avatar-wrap';
    avatarWrap.append(avatar);
    // 侧栏只提示明确离线：在线、未知和无法确认都不渲染状态点。
    if (
      entry.kind === 'direct' &&
      entry.peer_kind === 'agent' &&
      entry.peer_online === false
    ) {
      const presence = document.createElement('span');
      presence.className = 'presence-dot offline';
      presence.setAttribute('aria-label', 'Agent 离线');
      presence.title = '离线';
      avatarWrap.append(presence);
    }
    if (entry.my_last_read_seq !== entry.head_seq) {
      const dot = document.createElement('span');
      dot.className = 'unread';
      dot.setAttribute('aria-label', '未读');
      avatarWrap.append(dot);
    }
    link.append(avatarWrap, main);
    item.append(link);
    roomListElement.append(item);
  }
  if (query && entries.length === 0) {
    setListHint('没有匹配的会话');
  } else if (entries.length === 0) {
    if (roomEntries.length > 0 && unarchivedEntries.length === 0) {
      setListHint('会话已归档，可在已归档 Agents 中恢复。');
    } else {
      setListHint(roomFilterEmptyMessage());
    }
  } else {
    setListHint('');
  }
  if (scroller) scroller.scrollTop = previousScroll;
}

function updateRoomEntry(roomValue, lastItem, readSucceeded) {
  const entry = roomEntries.find(function (item) { return item.room_id === roomValue.room_id; });
  if (!entry) return;
  entry.head_seq = roomValue.head_seq;
  entry.updated_at = roomValue.updated_at;
  if (readSucceeded) entry.my_last_read_seq = roomValue.head_seq;
  if (lastItem) entry.last_message = lastItem;
  roomEntries = sortRooms(roomEntries);
  renderRooms();
}

/** active 房间不在列表结果里时（深链旧房间、刚建群）补回条目。 */
function mergeActiveRoom(summaries) {
  if (!activeRoomId) return summaries;
  if (summaries.some(function (entry) { return entry.room_id === activeRoomId; })) {
    return summaries;
  }
  const cache = roomCache.get(activeRoomId);
  const activeDetailRoom = room && room.room_id === activeRoomId ? room : null;
  const detailRoom = activeDetailRoom || (cache && cache.room ? cache.room : null);
  const detail = {
    room: detailRoom || {
      room_id: activeRoomId,
      kind: 'direct',
      title: '',
      head_seq: 0,
      updated_at: Date.now()
    },
    members: activeDetailRoom
      ? Array.from(members.values())
      : cache && cache.members
        ? cache.members
        : []
  };
  const summary = directSummaryFromDetail(detail);
  summaries.push({
    room_id: activeRoomId,
    kind: detail.room.kind,
    name: summary.name,
    head_seq: detail.room.head_seq || 0,
    my_last_read_seq: 0,
    last_message: cache ? cache.lastMessage || null : null,
    updated_at: detail.room.updated_at || Date.now(),
    peer_kind: summary.peer_kind,
    peer_online: summary.peer_online,
    peer_actor_id: summary.peer_actor_id,
    peer_loaded: true
  });
  return summaries;
}

/**
 * 第二阶段：后台补全 direct 对方名称与在线状态。
 *
 * 并发上限 4；每个失败只保留占位名称，不影响已经渲染的列表。
 * 已有缓存（peerDetails / roomCache）的 direct 房间不再请求。
 */
async function fillDirectPeers(me) {
  const queue = roomEntries.filter(function (entry) {
    return entry.kind === 'direct' && !entry.peer_loaded;
  });
  if (queue.length === 0) {
    await refreshArchivedAgentState(false);
    return;
  }
  let index = 0;
  let renderScheduled = false;
  function scheduleRoomsRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    const run = function () {
      renderScheduled = false;
      renderRooms();
    };
    if (window.requestAnimationFrame) requestAnimationFrame(run);
    else setTimeout(run, 16);
  }
  async function worker() {
    while (index < queue.length) {
      const entry = queue[index];
      index += 1;
      try {
        const detail = await callTool('network_room_get', { room_id: entry.room_id });
        const summary = directSummaryFromDetail(detail);
        peerDetails.set(entry.room_id, summary);
        const current = roomEntries.find(function (item) {
          return item.room_id === entry.room_id;
        });
        if (current) {
          current.name = summary.name;
          current.peer_kind = summary.peer_kind;
          current.peer_online = summary.peer_online;
          current.peer_actor_id = summary.peer_actor_id;
          current.peer_loaded = true;
        }
        scheduleRoomsRender();
      } catch (error) {
        // 房间不可读时保留占位名称，列表仍可展示。
      }
    }
  }
  const workers = [];
  const limit = Math.min(4, queue.length);
  for (let slot = 0; slot < limit; slot += 1) workers.push(worker());
  await Promise.all(workers);
  await refreshArchivedAgentState(false);
}

/**
 * 列表加载：single-flight + 两阶段。
 *
 * 第一阶段只取 network_rooms_list 并立即渲染摘要；第二阶段在后台补
 * direct 名称/在线状态。首屏骨架与错误提示都在这里收口。
 */
async function loadRooms(options) {
  if (roomsPromise) return roomsPromise;
  const hadEntries = roomEntries.length > 0;
  roomsPromise = (async function () {
    try {
      const me = await ensureIdentity();
      updateAccount(me);
      // 侧栏任务 badge 一次汇总，避免对每个房间调用 list；失败不影响会话列表。
      const summaryPromise = callTool('network_task_summary', {}).catch(function () {
        return null;
      });
      const page = await callTool('network_rooms_list', { limit: 50 });
      const taskSummaryResult = await summaryPromise;
      const summaries = page.items.map(function (entry) {
        const cached = entry.kind === 'direct' ? cachedPeerSummary(entry.room_id, me) : null;
        return {
          room_id: entry.room_id,
          kind: entry.kind,
          name: cached
            ? cached.name
            : entry.kind === 'direct'
              ? '单聊'
              : entry.title || '群聊',
          head_seq: entry.head_seq,
          my_last_read_seq: entry.my_last_read_seq,
          last_message: entry.last_message,
          updated_at: entry.updated_at,
          peer_kind: cached ? cached.peer_kind : null,
          // 人类成员没有在线概念，保持 null 且不渲染状态点。
          peer_online: cached ? cached.peer_online : null,
          peer_actor_id: cached ? cached.peer_actor_id : null,
          peer_loaded: Boolean(cached) || entry.kind !== 'direct'
        };
      });
      roomEntries = sortRooms(mergeActiveRoom(summaries));
      if (taskSummaryResult) applyTaskSummary(taskSummaryResult);
      // 首次加载（含深链）按当前房间选分类；后台刷新不覆盖用户手动切换。
      if (!hadEntries) syncRoomFilterForRoom(activeRoomId);
      // 空态文案由当前分类决定；错误与退出登录文案仍由 emptyListMessage 覆盖。
      emptyListMessage = '';
      renderRooms();
      clearListSkeleton();
      setListRetry(false);
      await fillDirectPeers(me);
      roomsLoadedAt = Date.now();
    } catch (error) {
      if (isAbortError(error)) return;
      const message = '读取会话失败：' + (error && error.message ? error.message : String(error));
      clearListSkeleton();
      if (hadEntries || roomEntries.length > 0) {
        setListHint(message);
      } else {
        setEmptyListMessage(message);
      }
      setListRetry(true);
    } finally {
      roomsPromise = null;
      clearListSkeleton();
    }
  })();
  return roomsPromise;
}

if (listRetryElement) {
  listRetryElement.addEventListener('click', function () {
    setListRetry(false);
    loadRooms({ force: true });
  });
}

if (searchInput) {
  searchInput.addEventListener('input', function () {
    searchQuery = searchInput.value;
    renderRooms();
  });
  searchInput.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || !searchInput.value) return;
    searchInput.value = '';
    searchQuery = '';
    renderRooms();
  });
}

if (roomFilterElement) {
  roomFilterElement.addEventListener('click', function (event) {
    const button = event.target && event.target.closest
      ? event.target.closest('[data-room-filter]')
      : null;
    if (!button) return;
    setRoomFilter(button.dataset.roomFilter);
  });
  roomFilterElement.addEventListener('keydown', function (event) {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].indexOf(event.key) < 0) return;
    event.preventDefault();
    const index = roomFilterButtons.findIndex(function (button) {
      return button.getAttribute('aria-selected') === 'true';
    });
    let next = index;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = roomFilterButtons.length - 1;
    else if (event.key === 'ArrowLeft') next = (index - 1 + roomFilterButtons.length) % roomFilterButtons.length;
    else next = (index + 1) % roomFilterButtons.length;
    const target = roomFilterButtons[next];
    if (!target) return;
    setRoomFilter(target.dataset.roomFilter);
    target.focus();
  });
}
updateRoomFilterTabs();
`;
