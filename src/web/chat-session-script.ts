/**
 * 房间状态层：active 房间、代次、缓存、草稿、滚动与刷新链。
 *
 * 由 `chatClientScript` 拼进同一个内联 `<script>`，与其他片段共享作用域。
 * 所有房间异步结果在 `await` 后必须比对 `activeRoomId` + `roomEpoch`；
 * 旧请求只允许被丢弃，不得写入新房间的 DOM。
 */
export const CHAT_SESSION_SCRIPT = `
let activeRoomId = initialRoomId;
let roomEpoch = 0;
let roomAbort = null;
let roomCache = new Map();
let drafts = new Map();
let peerDetails = new Map();
let roomsPromise = null;
let roomsLoadedAt = 0;
let identityPromise = null;
let refreshChain = Promise.resolve();
let refreshQueued = false;
let refreshRoomId = null;
let reloadTimer = null;
let sidebarScrollTop = 0;
let room = null;
let members = new Map();
let nextOlder = null;
let currentItems = [];

function isAbortError(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

function isActiveRoom(roomId, epoch) {
  return activeRoomId === roomId && roomEpoch === epoch;
}

function sessionSignal() {
  return roomAbort ? roomAbort.signal : undefined;
}

function resetRefreshChain() {
  refreshChain = Promise.resolve();
  refreshQueued = false;
  refreshRoomId = null;
}

function pruneRoomCache() {
  const maxRooms = 20;
  while (roomCache.size > maxRooms) {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const entry of roomCache.entries()) {
      if (entry[0] === activeRoomId) continue;
      const savedAt = Number(entry[1] && entry[1].savedAt) || 0;
      if (savedAt < oldestAt) {
        oldestAt = savedAt;
        oldestId = entry[0];
      }
    }
    if (!oldestId) break;
    roomCache.delete(oldestId);
  }
}

function cacheRoomState(roomId, patch) {
  if (!roomId) return;
  const cache = roomCache.get(roomId) || {
    room: null,
    members: [],
    items: [],
    nextOlder: null,
    scrollTop: 0,
    lastMessage: null
  };
  if (patch) {
    if ('room' in patch) cache.room = patch.room;
    if ('members' in patch) cache.members = patch.members;
    if ('items' in patch) cache.items = patch.items.slice();
    if ('nextOlder' in patch) cache.nextOlder = patch.nextOlder;
    if ('scrollTop' in patch) cache.scrollTop = patch.scrollTop;
    if ('lastMessage' in patch) cache.lastMessage = patch.lastMessage;
  }
  cache.savedAt = Date.now();
  roomCache.set(roomId, cache);
  pruneRoomCache();
}

function snapshotActiveRoom() {
  if (!activeRoomId || !room) return;
  cacheRoomState(activeRoomId, {
    room: room,
    members: Array.from(members.values()),
    items: currentItems.slice(),
    nextOlder: nextOlder,
    scrollTop: messagesElement ? messagesElement.scrollTop : 0
  });
}

function snapshotSidebarScroll() {
  if (sidebarListElement) sidebarScrollTop = sidebarListElement.scrollTop;
}

function restoreSidebarScroll() {
  if (!sidebarListElement) return;
  const top = sidebarScrollTop;
  requestAnimationFrame(function () {
    sidebarListElement.scrollTop = top;
  });
}

/** 从已缓存的房间成员推导 direct 名称/在线状态，避免重复请求。 */
function cachedPeerSummary(roomId, me) {
  if (peerDetails.has(roomId)) return peerDetails.get(roomId);
  const cache = roomCache.get(roomId);
  if (!cache || !cache.members || !me) return null;
  const others = cache.members.filter(function (member) {
    return member.actor_id !== me.actor_id;
  });
  if (others.length === 0) return null;
  const summary = {
    name: others.map(function (member) { return member.name; }).join('、'),
    peer_kind: others.length === 1 ? others[0].kind : null,
    peer_online: others.length === 1 && others[0].kind === 'agent' ? others[0].online : null,
    peer_actor_id: others.length === 1 ? others[0].actor_id : null
  };
  peerDetails.set(roomId, summary);
  return summary;
}

function directSummaryFromDetail(detail) {
  const detailRoom = detail.room;
  if (detailRoom.kind !== 'direct') {
    return {
      name: detailRoom.title || '群聊',
      peer_kind: null,
      peer_online: null,
      peer_actor_id: null
    };
  }
  const others = detail.members.filter(function (member) {
    return !identity || member.actor_id !== identity.actor_id;
  });
  return {
    name: others.map(function (member) { return member.name; }).join('、') || '单聊',
    peer_kind: others.length === 1 ? others[0].kind : null,
    peer_online: others.length === 1 && others[0].kind === 'agent' ? others[0].online : null,
    peer_actor_id: others.length === 1 ? others[0].actor_id : null
  };
}

function applyRoomHeader() {
  if (!room) return;
  if (room.kind === 'direct') {
    const others = [];
    for (const member of members.values()) {
      if (!identity || member.actor_id !== identity.actor_id) others.push(member);
    }
    const peer = directPeer();
    titleElement.textContent = others.map(function (member) { return member.name; }).join('、') || '单聊';
    if (peer && peer.kind === 'agent') {
      subtitleElement.textContent = presenceLabel(peer.online);
      subtitleElement.hidden = false;
    } else {
      subtitleElement.textContent = '';
      subtitleElement.hidden = true;
    }
  } else {
    titleElement.textContent = room.title || '群聊';
    subtitleElement.textContent = '群聊 · ' + members.size + ' 人';
    subtitleElement.hidden = false;
  }
  updateRenameAffordance();
  updateMembersAffordance();
}

function applyRoomDetail(detail) {
  room = detail.room;
  members = new Map(detail.members.map(function (member) {
    return [member.actor_id, member];
  }));
  applyRoomHeader();
  const summary = directSummaryFromDetail(detail);
  if (detail.room.kind === 'direct') peerDetails.set(detail.room.room_id, summary);
  const entry = roomEntries.find(function (item) { return item.room_id === detail.room.room_id; });
  if (entry) {
    entry.name = summary.name;
    entry.peer_kind = summary.peer_kind;
    entry.peer_online = summary.peer_online;
    entry.peer_actor_id = summary.peer_actor_id;
    entry.head_seq = detail.room.head_seq;
    renderRooms();
  }
}

function isNearBottom() {
  if (!messagesElement) return true;
  return messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 80;
}

function scrollToBottom(force) {
  if (!messagesElement) return;
  if (force || isNearBottom()) messagesElement.scrollTop = messagesElement.scrollHeight;
}

function restoreScroll(top) {
  if (!messagesElement) return;
  const roomId = activeRoomId;
  const epoch = roomEpoch;
  messagesElement.scrollTop = top;
  requestAnimationFrame(function () {
    if (isActiveRoom(roomId, epoch)) messagesElement.scrollTop = top;
  });
}

function setChatLoading(loading, options) {
  const settings = options || {};
  if (chatBodyElement) chatBodyElement.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (chatLoadingElement) chatLoadingElement.hidden = !loading;
  if (chatSkeletonElement) {
    chatSkeletonElement.hidden = !loading || !settings.skeleton;
  }
  if (loading && !settings.keepContent && messagesElement) {
    resetMarkdownHandles();
    messagesElement.replaceChildren();
  }
}

function setChatError(message) {
  setChatLoading(false);
  if (chatErrorTextElement) chatErrorTextElement.textContent = message;
  if (chatErrorElement) chatErrorElement.hidden = false;
  if (subtitleElement) {
    subtitleElement.textContent = '加载失败';
    subtitleElement.hidden = false;
  }
  if (messagesElement) {
    resetMarkdownHandles();
    messagesElement.replaceChildren();
  }
  if (sendButton) sendButton.disabled = true;
}

function clearChatError() {
  if (chatErrorElement) chatErrorElement.hidden = true;
  if (chatErrorTextElement) chatErrorTextElement.textContent = '';
  if (sendButton && activeRoomId) sendButton.disabled = false;
}

function handleRoomError(error, roomId, epoch) {
  if (isAbortError(error) || !isActiveRoom(roomId, epoch)) return;
  const code = error && error.code;
  let message = error && error.message ? String(error.message) : String(error);
  if (code === 'NOT_MEMBER') {
    message = '无法打开该会话：你不在会话中，或已被移出。';
  } else if (code === 'NOT_FOUND') {
    message = '会话不存在或已失效。';
  } else if (code === 'CREDENTIAL_INVALID') {
    message = '身份已失效，请重试。';
  } else if (message.indexOf('请求超时') >= 0) {
    message = '请求超时，请重试。';
  } else {
    message = '加载会话失败：' + message;
  }
  setChatError(message);
}

function applyCachedRoom(cache) {
  room = cache.room || null;
  members = new Map((cache.members || []).map(function (member) {
    return [member.actor_id, member];
  }));
  currentItems = (cache.items || []).slice();
  nextOlder = cache.nextOlder || null;
  if (olderButton) olderButton.hidden = !nextOlder;
  applyRoomHeader();
  renderMessageList(currentItems);
  restoreScroll(Number(cache.scrollTop) || 0);
  if (bodyInput) bodyInput.value = drafts.get(activeRoomId) || '';
  resizeComposer();
}

async function loadLatest(roomId, epoch, options) {
  const humanTimeline = Boolean(identity && identity.kind === 'human');
  const args = {
    room_id: roomId,
    direction: 'before',
    limit: 50
  };
  if (humanTimeline) args.view = 'timeline';
  const page = await callTool('network_history_list', args, undefined, sessionSignal());
  if (!isActiveRoom(roomId, epoch)) return null;
  const previousTop = messagesElement ? messagesElement.scrollTop : 0;
  const wasNearBottom = isNearBottom();
  const rawItems = humanTimeline ? (page.timeline_items || []) : page.items;
  nextOlder = humanTimeline
    ? (page.timeline_has_more ? page.timeline_next_cursor : null)
    : (page.has_more ? page.next_cursor : null);
  if (olderButton) olderButton.hidden = !nextOlder;
  currentItems = mergeTimelineItems([], rawItems.slice().reverse());
  renderMessageList(currentItems);
  if ((options && options.forceScroll) || wasNearBottom) {
    scrollToBottom(true);
  } else if (messagesElement) {
    messagesElement.scrollTop = previousTop;
  }
  return page;
}

/** 消息与 presence 共用稳定 ID；跨页/同页只保留首次出现的一条。 */
function timelineItemKey(item) {
  if (item && item.kind === 'presence') return 'presence:' + item.presence_event_id;
  return 'message:' + (item && item.message_id ? item.message_id : '');
}

/**
 * 合并时间线并按稳定 ID 去重。
 *
 * before 页返回展示顺序倒序，调用方先 reverse 得到正序；after 补读遵循
 * “按展示 key 插入”而不是简单 append。
 */
function mergeTimelineItems(base, incoming) {
  const seen = new Set();
  const merged = [];
  for (const item of base || []) {
    const key = timelineItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  for (const item of incoming || []) {
    const key = timelineItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  merged.sort(function (a, b) {
    const left = timelineTimestamp(a);
    const right = timelineTimestamp(b);
    if (left !== right) return left - right;
    return timelineCommitSeq(a) - timelineCommitSeq(b);
  });
  return merged;
}

function timelineTimestamp(item) {
  if (!item) return 0;
  return Number(item.kind === 'presence' ? item.occurred_at : item.created_at) || 0;
}

function timelineCommitSeq(item) {
  if (!item) return 0;
  return Number(item.kind === 'presence' ? item.timeline_seq : item.created_seq) || 0;
}

/** 侧栏预览只取真实消息；presence 永远不能覆盖 last_message。 */
function latestRealMessage(page) {
  if (room && room.last_message) return room.last_message;
  const items = page.timeline_items || page.items || [];
  return items.find(function (item) { return item.kind !== 'presence'; }) || null;
}

async function markRoomRead(roomId, headSeq, epoch) {
  try {
    await callTool('network_room_mark_read', {
      room_id: roomId,
      through_seq: headSeq
    }, undefined, sessionSignal());
    return isActiveRoom(roomId, epoch);
  } catch (error) {
    if (isAbortError(error)) return false;
    // 已读失败不影响聊天；保留未读标记，下次刷新重试。
    return false;
  }
}

async function doRefresh(roomId, epoch, forceScroll) {
  const detail = await callTool('network_room_get', { room_id: roomId }, undefined, sessionSignal());
  if (!isActiveRoom(roomId, epoch)) return;
  applyRoomDetail(detail);
  const page = await loadLatest(roomId, epoch, { forceScroll: forceScroll });
  if (!page || !isActiveRoom(roomId, epoch)) return;
  setChatLoading(false);
  clearChatError();
  statusElement.textContent = stickyStatus;
  const lastMessage = latestRealMessage(page);
  cacheRoomState(roomId, {
    room: room,
    members: Array.from(members.values()),
    items: currentItems.slice(),
    nextOlder: nextOlder,
    scrollTop: messagesElement ? messagesElement.scrollTop : 0,
    lastMessage: lastMessage
  });
  const readSucceeded = await markRoomRead(roomId, room.head_seq, epoch);
  if (!isActiveRoom(roomId, epoch)) return;
  updateRoomEntry(room, lastMessage, readSucceeded);
}

/**
 * 串行刷新，且合并等待中的请求。
 *
 * 刷新期间到达的新消息或自己刚发出的消息会再排一次，
 * 不会被“正在刷新”直接丢弃；切换房间时链按 roomId 重置。
 */
function refresh(forceScroll) {
  const roomId = activeRoomId;
  if (!roomId) return Promise.resolve();
  const epoch = roomEpoch;
  if (refreshRoomId !== roomId) {
    resetRefreshChain();
    refreshRoomId = roomId;
  }
  if (refreshQueued) return refreshChain;
  refreshQueued = true;
  const chainRoomId = roomId;
  refreshChain = refreshChain
    .catch(function () {})
    .then(function () {
      // 切换房间会重置链；旧回调不得清除新房间的排队标志。
      if (refreshRoomId !== chainRoomId) return;
      refreshQueued = false;
      if (!isActiveRoom(roomId, epoch)) return;
      return doRefresh(roomId, epoch, forceScroll);
    });
  return refreshChain;
}

async function loadOlder() {
  const roomId = activeRoomId;
  if (!roomId || !nextOlder) return;
  const epoch = roomEpoch;
  const humanTimeline = Boolean(identity && identity.kind === 'human');
  if (olderButton) olderButton.disabled = true;
  try {
    const args = {
      room_id: roomId,
      direction: 'before',
      cursor: nextOlder,
      limit: 50
    };
    if (humanTimeline) args.view = 'timeline';
    const page = await callTool('network_history_list', args, undefined, sessionSignal());
    if (!isActiveRoom(roomId, epoch)) return;
    const previousHeight = messagesElement.scrollHeight;
    const rawItems = humanTimeline ? (page.timeline_items || []) : page.items;
    const merged = mergeTimelineItems(currentItems, rawItems.slice().reverse());
    const known = new Set(currentItems.map(timelineItemKey));
    const olderItems = merged.filter(function (item) {
      return !known.has(timelineItemKey(item));
    });
    const fragment = document.createDocumentFragment();
    appendHistory(fragment, olderItems);
    messagesElement.prepend(fragment);
    messagesElement.scrollTop += messagesElement.scrollHeight - previousHeight;
    currentItems = merged;
    nextOlder = humanTimeline
      ? (page.timeline_has_more ? page.timeline_next_cursor : null)
      : (page.has_more ? page.next_cursor : null);
    if (olderButton) olderButton.hidden = !nextOlder;
    cacheRoomState(roomId, {
      items: currentItems,
      nextOlder: nextOlder,
      scrollTop: messagesElement.scrollTop
    });
  } catch (error) {
    if (!isAbortError(error) && isActiveRoom(roomId, epoch)) {
      statusElement.textContent = '加载更早消息失败：' + error.message;
    }
  } finally {
    if (isActiveRoom(roomId, epoch) && olderButton) olderButton.disabled = false;
  }
}

function ensureRoomEntry(detail) {
  const detailRoom = detail.room;
  const summary = directSummaryFromDetail(detail);
  let entry = roomEntries.find(function (item) { return item.room_id === detailRoom.room_id; });
  if (!entry) {
    entry = {
      room_id: detailRoom.room_id,
      kind: detailRoom.kind,
      name: summary.name,
      head_seq: detailRoom.head_seq || 0,
      // 新建单聊时调用方会先写入本地已读位置，避免刚创建的会话闪出未读红点。
      my_last_read_seq: detailRoom.my_last_read_seq != null ? detailRoom.my_last_read_seq : 0,
      last_message: null,
      updated_at: detailRoom.updated_at || Date.now(),
      peer_kind: summary.peer_kind,
      peer_online: summary.peer_online,
      peer_actor_id: summary.peer_actor_id,
      peer_loaded: true
    };
    roomEntries.push(entry);
  } else {
    entry.name = summary.name;
    entry.peer_kind = summary.peer_kind;
    entry.peer_online = summary.peer_online;
    entry.peer_actor_id = summary.peer_actor_id;
    entry.peer_loaded = true;
    entry.kind = detailRoom.kind;
    entry.head_seq = detailRoom.head_seq;
    entry.updated_at = detailRoom.updated_at;
  }
  roomEntries = sortRooms(roomEntries);
  renderRooms();
  return entry;
}

/** 建群/建单聊成功后用返回的 roomDetail 预填缓存，导航后立即渲染。 */
function seedRoomCacheFromDetail(detail) {
  const entry = ensureRoomEntry(detail);
  cacheRoomState(detail.room.room_id, {
    room: detail.room,
    members: detail.members,
    items: [],
    nextOlder: null,
    scrollTop: 0,
    lastMessage: entry.last_message || null
  });
  return detail.room.room_id;
}

async function openRoom(roomId, options) {
  const settings = options || {};
  if (!roomId) {
    closeRoomView();
    return;
  }
  if (activeRoomId === roomId && room && !settings.force) {
    try {
      await refresh(false);
    } catch (error) {
      if (!isAbortError(error) && isActiveRoom(roomId, roomEpoch)) {
        statusElement.textContent = '刷新失败：' + (error && error.message ? error.message : error);
      }
    }
    return;
  }
  const previousId = activeRoomId;
  snapshotActiveRoom();
  activeRoomId = roomId;
  const epoch = ++roomEpoch;
  if (roomAbort) roomAbort.abort();
  roomAbort = new AbortController();
  resetRefreshChain();
  activateFilesRoom(roomId);
  activateMonitorRoom(roomId);
  if (previousId !== roomId) {
    stickyStatus = '';
    statusElement.textContent = '';
    hideMentionPicker();
    closeRenameForm();
    closeMembersModal();
  }
  room = null;
  members = new Map();
  nextOlder = null;
  currentItems = [];
  renderRooms();
  clearChatError();
  if (sendButton) sendButton.disabled = false;
  const cache = roomCache.get(roomId);
  if (cache) {
    applyCachedRoom(cache);
    setChatLoading(false);
  } else {
    const keepContent = Boolean(messagesElement && messagesElement.childElementCount > 0);
    setChatLoading(true, {
      keepContent: keepContent,
      skeleton: Boolean(settings.initial) || !keepContent
    });
    if (!keepContent) {
      titleElement.textContent = '会话';
      subtitleElement.textContent = '正在加载…';
      subtitleElement.hidden = false;
    }
    if (bodyInput) bodyInput.value = drafts.get(roomId) || '';
    resizeComposer();
  }
  try {
    await ensureIdentity();
  } catch (error) {
    handleRoomError(error, roomId, epoch);
    return;
  }
  if (!isActiveRoom(roomId, epoch)) return;
  try {
    await refresh(!cache);
  } catch (error) {
    if (isAbortError(error) || !isActiveRoom(roomId, epoch)) return;
    if (cache) {
      setChatLoading(false);
      statusElement.textContent = '刷新失败：' + (error && error.message ? error.message : error);
    } else {
      handleRoomError(error, roomId, epoch);
    }
  }
}

function closeRoomView() {
  snapshotActiveRoom();
  deactivateFilesRoom();
  deactivateMonitorRoom();
  activeRoomId = null;
  roomEpoch += 1;
  if (roomAbort) roomAbort.abort();
  roomAbort = null;
  resetRefreshChain();
  room = null;
  members = new Map();
  nextOlder = null;
  currentItems = [];
  setChatLoading(false);
  if (chatErrorElement) chatErrorElement.hidden = true;
  if (chatErrorTextElement) chatErrorTextElement.textContent = '';
  if (sendButton) sendButton.disabled = false;
  if (titleElement) titleElement.textContent = '单聊';
  if (subtitleElement) {
    subtitleElement.textContent = '';
    subtitleElement.hidden = true;
  }
  if (olderButton) olderButton.hidden = true;
  if (renameButton) renameButton.hidden = true;
  if (renameForm) renameForm.hidden = true;
  updateMembersAffordance();
  if (statusElement) statusElement.textContent = '';
  stickyStatus = '';
  hideMentionPicker();
}
`;
