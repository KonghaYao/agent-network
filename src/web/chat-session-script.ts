import { LIMITS } from '../contracts/limits';

/**
 * 房间状态层：active 房间、代次、缓存、草稿、滚动与刷新链。
 *
 * 由 `chatClientScript` 拼进同一个内联 `<script>`，与其他片段共享作用域。
 * 所有房间异步结果在 `await` 后必须比对 `activeRoomId` + `roomEpoch`；
 * 旧请求只允许被丢弃，不得写入新房间的 DOM。
 */
export const CHAT_SESSION_SCRIPT = `
const OLDER_AUTO_TOP_RATIO = ${LIMITS.webOlderAutoTopRatio};
const ROOM_CACHE_RENDER_MAX = ${LIMITS.webRoomCacheRenderMax};
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
let refreshForcePending = false;
let reloadTimer = null;
let sidebarScrollTop = 0;
let room = null;
let members = new Map();
let invitedMembers = new Map();
/** 当前房间待确认的群主转让提议；null 表示没有有效提议。 */
let ownerTransfer = null;
let nextOlder = null;
let timelineResumeCursor = null;
let currentItems = [];
let olderLoading = false;
let olderEnded = false;
let olderError = '';
let olderAutoFrame = 0;

function isAbortError(error) {
  return Boolean(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
}

function isActiveRoom(roomId, epoch) {
  return activeRoomId === roomId && roomEpoch === epoch;
}

/**
 * pager 是消息流内部的首行：全量重绘/前插后都要把它放回列表最顶部。
 * 元素引用不变，点击监听也不需要重新绑定。
 */
function ensureHistoryPager() {
  if (!messagesElement || !historyPagerElement) return;
  if (historyPagerElement.parentNode !== messagesElement) {
    messagesElement.insertBefore(historyPagerElement, messagesElement.firstElementChild);
    return;
  }
  if (messagesElement.firstElementChild !== historyPagerElement) {
    messagesElement.insertBefore(historyPagerElement, messagesElement.firstElementChild);
  }
}

/** 加载更早按钮、加载态、失败重试与到底提示共用同一处状态收口。 */
function updateOlderAffordance() {
  const hasOlder = Boolean(nextOlder);
  ensureHistoryPager();
  if (olderButton) {
    olderButton.hidden = !hasOlder && !olderError;
    olderButton.disabled = olderLoading;
    olderButton.textContent = olderLoading
      ? '正在加载更早…'
      : (olderError ? '加载失败，点击重试' : '加载更早');
    olderButton.setAttribute('aria-busy', olderLoading ? 'true' : 'false');
    olderButton.title = olderError || '';
  }
  if (olderStatusElement) {
    const message = olderLoading
      ? ''
      : (olderEnded && !hasOlder ? '没有更早的消息' : '');
    olderStatusElement.textContent = message;
    olderStatusElement.hidden = !message;
  }
  if (historyPagerElement) {
    historyPagerElement.hidden = !hasOlder && !olderEnded && !olderError;
  }
}

/** 距可滚动顶部不超过 10% 才自动加载；内容不足一屏时不自动触发。 */
function olderAutoTopReached() {
  if (!messagesElement) return false;
  const maxTop = messagesElement.scrollHeight - messagesElement.clientHeight;
  if (maxTop <= 0) return false;
  return messagesElement.scrollTop <= maxTop * OLDER_AUTO_TOP_RATIO;
}

function cancelOlderAutoLoad() {
  if (!olderAutoFrame) return;
  cancelAnimationFrame(olderAutoFrame);
  olderAutoFrame = 0;
}

/**
 * scroll 事件只合并到下一帧检查一次；自动、手动与脚本恢复最终都走
 * loadOlder 的同一个 olderLoading 单飞锁，不排队第二个请求。
 */
function scheduleOlderAutoLoad() {
  if (olderAutoFrame) return;
  olderAutoFrame = requestAnimationFrame(function () {
    olderAutoFrame = 0;
    if (!activeRoomId || olderLoading || olderError || olderEnded || !nextOlder) return;
    if (!olderAutoTopReached()) return;
    loadOlder();
  });
}

function installOlderAutoLoad() {
  if (!messagesElement) return;
  messagesElement.addEventListener('scroll', scheduleOlderAutoLoad, { passive: true });
}

function sessionSignal() {
  return roomAbort ? roomAbort.signal : undefined;
}

function resetRefreshChain() {
  refreshChain = Promise.resolve();
  refreshQueued = false;
  refreshRoomId = null;
  refreshForcePending = false;
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
    invited: [],
    items: [],
    nextOlder: null,
    timelineResumeCursor: null,
    olderEnded: false,
    scrollTop: 0,
    pinned: true,
    anchor: null,
    syncCursorPrimed: false,
    lastMessage: null
  };
  if (patch) {
    if ('room' in patch) cache.room = patch.room;
    if ('members' in patch) cache.members = patch.members;
    if ('invited' in patch) cache.invited = patch.invited;
    if ('ownerTransfer' in patch) cache.ownerTransfer = patch.ownerTransfer;
    if ('items' in patch) cache.items = patch.items.slice();
    if ('nextOlder' in patch) cache.nextOlder = patch.nextOlder;
    if ('timelineResumeCursor' in patch) cache.timelineResumeCursor = patch.timelineResumeCursor;
    if ('olderEnded' in patch) cache.olderEnded = Boolean(patch.olderEnded);
    if ('scrollTop' in patch) cache.scrollTop = patch.scrollTop;
    if ('pinned' in patch) cache.pinned = Boolean(patch.pinned);
    if ('anchor' in patch) cache.anchor = patch.anchor;
    if ('syncCursorPrimed' in patch) cache.syncCursorPrimed = Boolean(patch.syncCursorPrimed);
    if ('lastMessage' in patch) cache.lastMessage = patch.lastMessage;
  }
  cache.savedAt = Date.now();
  roomCache.set(roomId, cache);
  pruneRoomCache();
}

function discardRoomCache(roomId) {
  roomCache.delete(roomId);
  peerDetails.delete(roomId);
  if (roomId !== activeRoomId) return;
  room = null;
  invitedMembers = new Map();
  ownerTransfer = null;
  currentItems = [];
  nextOlder = null;
  timelineResumeCursor = null;
  olderEnded = false;
  olderError = '';
  updateOlderAffordance();
}

function snapshotActiveRoom() {
  if (!activeRoomId || !room) return;
  const viewport = scrollController.capturePosition();
  cacheRoomState(activeRoomId, {
    room: room,
    members: Array.from(members.values()),
    invited: Array.from(invitedMembers.values()),
    ownerTransfer: ownerTransfer,
    items: currentItems.slice(),
    nextOlder: nextOlder,
    timelineResumeCursor: timelineResumeCursor,
    olderEnded: olderEnded,
    scrollTop: viewport.scrollTop,
    pinned: viewport.pinned,
    anchor: viewport.anchor
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
  applyRoomAnnouncement();
  updateCopyGroupInfoAffordance();
  renderTaskRow();
}

function applyRoomLifecycle(roomView) {
  const readOnly = Boolean(roomView && roomView.read_only);
  const banner = document.getElementById('room-archive-banner');
  if (banner) {
    banner.hidden = !readOnly;
    banner.textContent = readOnly
      ? '群聊已解散，当前为只读归档；截至解散点的历史仍可查看。已下载到本地的副本无法收回。'
      : '';
  }
  const composerElement = document.getElementById('composer');
  if (composerElement) composerElement.hidden = readOnly;
  const uploadButton = document.getElementById('files-upload');
  if (uploadButton) uploadButton.disabled = readOnly;
  const attachButton = document.getElementById('attach-file');
  if (attachButton) attachButton.disabled = readOnly;
  document.body.classList.toggle('room-read-only', readOnly);
}

function applyRoomDetail(detail) {
  const previousMembers = membersViewSignature(Array.from(members.values()),
    Array.from(invitedMembers.values()), ownerTransfer, room && room.capabilities);
  room = detail.room;
  members = new Map(detail.members.map(function (member) {
    return [member.actor_id, member];
  }));
  invitedMembers = new Map((detail.invited || []).map(function (invited) {
    return [invited.actor_id, invited];
  }));
  ownerTransfer = detail.owner_transfer || null;
  applyRoomLifecycle(room);
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
    entry.read_only = Boolean(detail.room.read_only);
    entry.can_leave = Boolean(detail.room.can_leave);
    entry.can_dissolve = Boolean(detail.room.can_dissolve);
    renderRooms();
  }
  // 邀请接受后 active/invited 会互换；弹窗开着时立即按新状态重绘。
  if (membersModal && !membersModal.hidden && previousMembers !==
      membersViewSignature(detail.members, detail.invited || [], ownerTransfer, room.capabilities)) {
    renderCurrentMembers();
    renderMembersContacts(membersCandidates(membersContactsCache), membersContactNote);
    updateGroupProfileCapabilities();
  }
}

function setChatLoading(loading, options) {
  const settings = options || {};
  if (chatBodyElement) chatBodyElement.setAttribute('aria-busy', loading ? 'true' : 'false');
  if (chatLoadingElement) chatLoadingElement.hidden = !loading;
  if (chatSkeletonElement) {
    chatSkeletonElement.hidden = !loading || !settings.skeleton;
  }
  if (loading && !settings.keepContent && messagesElement) {
    resetTimelineRender();
    scrollController.beginContentChange();
    messagesElement.replaceChildren();
    ensureHistoryPager();
  }
  syncComposerSendState();
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
    resetTimelineRender();
    scrollController.beginContentChange();
    messagesElement.replaceChildren();
    ensureHistoryPager();
  }
  syncComposerSendState();
}

function clearChatError() {
  if (chatErrorElement) chatErrorElement.hidden = true;
  if (chatErrorTextElement) chatErrorTextElement.textContent = '';
  syncComposerSendState();
}

function handleRoomError(error, roomId, epoch) {
  if (isAbortError(error) || !isActiveRoom(roomId, epoch)) return;
  const code = error && error.code;
  let message = error && error.message ? String(error.message) : String(error);
  if (code === 'NOT_MEMBER' || code === 'NOT_FOUND') discardRoomCache(roomId);
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

/**
 * 应用缓存房间：元数据、成员、草稿与输入框总是立即恢复；
 * 普通回访只在缓存不超过 ROOM_CACHE_RENDER_MAX 时整表预渲染；上翻历史
 * 后回访会保留已加载时间线与可见消息锚点，避免切房把用户带到底部。
 * 超过阈值的 pinned 缓存继续走轻量加载态，避免普通切回重绘长历史。
 */
function applyCachedRoom(cache, options) {
  const settings = options || {};
  const wantsRender = settings.renderItems !== false;
  const limit = Number.isFinite(settings.itemsLimit) && settings.itemsLimit > 0
    ? Math.min(Math.floor(settings.itemsLimit), ROOM_CACHE_RENDER_MAX)
    : ROOM_CACHE_RENDER_MAX;
  const cachedItems = cache.items || [];
  const longCache = cachedItems.length > ROOM_CACHE_RENDER_MAX;
  const restoringHistory = cache.pinned === false;
  const renderItems = wantsRender && (!longCache || restoringHistory);
  room = cache.room || null;
  applyRoomLifecycle(room);
  members = new Map((cache.members || []).map(function (member) {
    return [member.actor_id, member];
  }));
  invitedMembers = new Map((cache.invited || []).map(function (invited) {
    return [invited.actor_id, invited];
  }));
  ownerTransfer = cache.ownerTransfer || null;
  currentItems = renderItems
    ? cachedItems.slice(Math.max(0, cachedItems.length - (restoringHistory ? cachedItems.length : limit)))
    : [];
  if (currentItems.length < cachedItems.length) {
    // 只是预览或被丢弃的长缓存：旧游标会跳过最新页，交给刷新重新建立。
    olderEnded = false;
    nextOlder = null;
    timelineResumeCursor = null;
  } else {
    // 到底状态属于房间自身：切走再切回时不能因为重新取最新页而恢复按钮。
    olderEnded = Boolean(cache.olderEnded);
    nextOlder = olderEnded ? null : (cache.nextOlder || null);
    timelineResumeCursor = cache.timelineResumeCursor || null;
  }
  olderLoading = false;
  olderError = '';
  updateOlderAffordance();
  applyRoomHeader();
  if (renderItems) {
    renderMessageList(currentItems);
  } else {
    setChatLoading(true, { keepContent: false, skeleton: true });
  }
  if (restoringHistory) {
    scrollController.restorePosition(cache.scrollTop, false, cache.anchor);
  } else {
    scrollController.scrollToBottom();
  }
  if (bodyInput) {
    if (!drafts.has(activeRoomId)) {
      const storedDraft = draftLoad(activeRoomId);
      if (storedDraft) drafts.set(activeRoomId, storedDraft);
    }
    bodyInput.value = drafts.get(activeRoomId) || '';
  }
  if (typeof syncComposerReply === 'function') syncComposerReply();
  renderComposerFiles(activeRoomId);
  resizeComposer();
}

async function fetchLatestPage(roomId, epoch) {
  const humanTimeline = Boolean(identity && identity.kind === 'human');
  const args = {
    room_id: roomId,
    direction: 'before',
    limit: 50
  };
  if (humanTimeline) args.view = 'timeline';
  const page = await callTool('network_history_list', args, undefined, sessionSignal());
  if (!isActiveRoom(roomId, epoch)) return null;
  const rawItems = humanTimeline ? (page.timeline_items || []) : page.items;
  return {
    page: page,
    timelineResumeCursor: humanTimeline ? page.timeline_resume_cursor : null,
    items: rawItems.slice().reverse(),
    nextOlder: humanTimeline
      ? (page.timeline_has_more ? page.timeline_next_cursor : null)
      : (page.has_more ? page.next_cursor : null)
  };
}

/**
 * 最新页刷新已存在条目的状态。历史增量从最后一次成功应用的位置追到
 * 本轮最新页的水位，避免离线超过一页时把中间消息跳过去。
 */
async function fetchRoomUpdate(roomId, epoch) {
  const latest = await fetchLatestPage(roomId, epoch);
  if (!latest || !timelineResumeCursor || !latest.timelineResumeCursor ||
      timelineResumeCursor === latest.timelineResumeCursor) return latest;

  const target = BigInt(latest.page.timeline_snapshot);
  let cursor = timelineResumeCursor;
  for (;;) {
    const page = await callTool('network_history_list', {
      room_id: roomId,
      view: 'timeline',
      direction: 'after',
      cursor: cursor,
      limit: 50
    }, undefined, sessionSignal());
    if (!isActiveRoom(roomId, epoch)) return null;
    const items = page.timeline_items;
    if (!Array.isArray(items) || !page.timeline_resume_cursor) {
      throw new Error('无效的时间线补拉响应');
    }
    latest.items.push(...items);
    latest.timelineResumeCursor = page.timeline_resume_cursor;
    const last = items[items.length - 1];
    const reachedTarget = last && BigInt(last.kind === 'presence' ? last.timeline_seq : last.created_seq) >= target;
    if (!page.timeline_has_more || reachedTarget) return latest;
    if (!page.timeline_next_cursor || page.timeline_next_cursor === cursor) {
      throw new Error('时间线补拉游标未前进');
    }
    cursor = page.timeline_next_cursor;
  }
}

/**
 * 最新页与已加载历史按稳定 key 合并；DOM 只追加新消息并更新回执。
 */
function applyLatestPage(result) {
  const incomingKeys = new Set(result.items.map(timelineItemKey));
  const hasLoadedOlder = currentItems.some(function (item) {
    return !incomingKeys.has(timelineItemKey(item));
  });
  currentItems = mergeTimelineItems(currentItems, result.items);
  timelineResumeCursor = result.timelineResumeCursor;
  // 已加载更早页时保留原游标；否则让最新页决定是否还能继续往前翻。
  // 已到底后最新页不得再写回游标，否则新消息刷新会让“加载更早”复活。
  if (olderEnded) {
    nextOlder = null;
  } else if (!hasLoadedOlder || !nextOlder) {
    nextOlder = result.nextOlder;
  }
  updateOlderAffordance();
  renderMessageList(currentItems);
  scrollController.clearPinNextApply();
  scrollController.noteContentChanged();
}

/** 消息与 presence 共用稳定 ID；跨页/同页只保留首次出现的一条。 */
function timelineItemKey(item) {
  if (item && item.kind === 'presence') return 'presence:' + item.presence_event_id;
  return 'message:' + (item && item.message_id ? item.message_id : '');
}

function hasLoadedTimelineItem(item) {
  if (!item) return false;
  const key = timelineItemKey(item);
  return currentItems.some(function (known) {
    return timelineItemKey(known) === key;
  });
}

/**
 * 合并时间线并按稳定 ID 去重。
 *
 * before 页返回展示顺序倒序，调用方先 reverse 得到正序；after 补读遵循
 * “按展示 key 插入”而不是简单 append。
 */
function mergeTimelineItems(base, incoming) {
  const indexByKey = new Map();
  const merged = [];
  for (const item of base || []) {
    const key = timelineItemKey(item);
    if (indexByKey.has(key)) continue;
    indexByKey.set(key, merged.length);
    merged.push(item);
  }
  for (const item of incoming || []) {
    const key = timelineItemKey(item);
    const existingIndex = indexByKey.get(key);
    if (existingIndex !== undefined) {
      // 同一消息以最新一次响应为准：回执状态、预览与正文长度可能已更新。
      merged[existingIndex] = item;
      continue;
    }
    indexByKey.set(key, merged.length);
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

async function performMarkRead(roomId, epoch, headSeq) {
  if (!isActiveRoom(roomId, epoch)) return false;
  const succeeded = await markRoomRead(roomId, headSeq, epoch);
  if (!succeeded || !isActiveRoom(roomId, epoch) || !room || room.room_id !== roomId) return false;
  // head 已前进时不把本地已读位置推到新 head，留给下一轮刷新。
  const atHead = String(room.head_seq == null ? '' : room.head_seq) === String(headSeq == null ? '' : headSeq);
  updateRoomEntry(room, room.last_message || null, atHead);
  return true;
}

async function doRefresh(roomId, epoch, forceScroll) {
  const detail = await callTool('network_room_get', { room_id: roomId }, undefined, sessionSignal());
  if (!isActiveRoom(roomId, epoch)) return;
  applyRoomDetail(detail);
  // 首次渲染（含切换房间后的空 currentItems）总是到底，不能被旧房间的上翻状态打断。
  const hadContent = currentItems.length > 0;
  const force = Boolean(forceScroll) || scrollController.hasPinNextApply() || !hadContent;
  const freeze = !force && !scrollController.isPinned() && hadContent;
  let result = null;
  if (!freeze) {
    result = await fetchRoomUpdate(roomId, epoch);
    if (!result || !isActiveRoom(roomId, epoch)) return;
    // 拉取期间用户上翻：丢弃本轮页面，消息区完全冻结。
    if (!force && !scrollController.isPinned() && currentItems.length > 0) result = null;
  }
  if (result) {
    applyLatestPage(result);
    if (!hadContent) scrollController.scrollToBottom();
  }
  setChatLoading(false);
  clearChatError();
  statusElement.textContent = stickyStatus;
  const lastMessage = room && room.last_message
    ? room.last_message
    : (result ? latestRealMessage(result.page) : null);
  const previousCache = roomCache.get(roomId);
  const shouldPrimeSyncCursor = Boolean(result && room &&
    (!previousCache || previousCache.syncCursorPrimed !== true));
  if (!result && lastMessage && !hasLoadedTimelineItem(lastMessage)) {
    // 通知丢失/重连补拉时也能提示有新消息，不伪造条数。
    scrollController.noteNewMessage();
  }
  if (scrollController.isPinned()) {
    scrollController.scrollToBottom();
  }
  cacheRoomState(roomId, {
    room: room,
    members: Array.from(members.values()),
    items: currentItems.slice(),
    nextOlder: nextOlder,
    timelineResumeCursor: timelineResumeCursor,
    olderEnded: olderEnded,
    scrollTop: messagesElement ? messagesElement.scrollTop : 0,
    pinned: scrollController.isPinned(),
    anchor: scrollController.capturePosition().anchor,
    syncCursorPrimed: shouldPrimeSyncCursor || Boolean(previousCache && previousCache.syncCursorPrimed),
    lastMessage: lastMessage
  });
  if (shouldPrimeSyncCursor && typeof syncCursorPrimeRoom === 'function') {
    syncCursorPrimeRoom(roomId, room.head_seq);
  }
  updateRoomEntry(room, lastMessage, false);
  // 任务列表只在进入房间/强制刷新/任务事件后读取；普通消息刷新不重复请求。
  if (force || roomTasksRoomId !== roomId) loadRoomTasks(roomId, epoch);
  // 只有仍跟随底部且实际 gap <= 80 时控制器才会真正调用 mark_read。
  if (result) scrollController.scheduleMarkRead(roomId, epoch, room.head_seq);
}

/**
 * 串行刷新，且合并等待中的请求。
 *
 * 刷新期间到达的新消息或自己刚发出的消息会再排一次，
 * 不会被“正在刷新”直接丢弃；force 标志独立保存，合并后仍生效。
 */
function refresh(forceScroll) {
  const roomId = activeRoomId;
  if (!roomId) return Promise.resolve();
  const epoch = roomEpoch;
  if (refreshRoomId !== roomId) {
    resetRefreshChain();
    refreshRoomId = roomId;
  }
  if (forceScroll || scrollController.hasPinNextApply()) refreshForcePending = true;
  if (refreshQueued) return refreshChain;
  refreshQueued = true;
  const chainRoomId = roomId;
  refreshChain = refreshChain
    .catch(function () {})
    .then(function () {
      // 切换房间会重置链；旧回调不得清除新房间的排队标志。
      if (refreshRoomId !== chainRoomId || !isActiveRoom(roomId, epoch)) return;
      refreshQueued = false;
      if (!isActiveRoom(roomId, epoch)) return;
      const force = refreshForcePending;
      refreshForcePending = false;
      return doRefresh(roomId, epoch, force);
    });
  return refreshChain;
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
      peer_loaded: true,
      read_only: Boolean(detailRoom.read_only),
      can_leave: Boolean(detailRoom.can_leave),
      can_dissolve: Boolean(detailRoom.can_dissolve)
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
  syncRoomFilterForRoom(detailRoom.room_id);
  renderRooms();
  return entry;
}

/** 建群/建单聊成功后用返回的 roomDetail 预填缓存，导航后立即渲染。 */
function seedRoomCacheFromDetail(detail) {
  const entry = ensureRoomEntry(detail);
  cacheRoomState(detail.room.room_id, {
    room: detail.room,
    members: detail.members,
    invited: detail.invited || [],
    ownerTransfer: detail.owner_transfer || null,
    items: [],
    nextOlder: null,
    timelineResumeCursor: null,
    olderEnded: false,
    scrollTop: 0,
    pinned: true,
    anchor: null,
    syncCursorPrimed: false,
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
    const epoch = roomEpoch;
    try {
      await refresh(false);
    } catch (error) {
      if (!isAbortError(error) && isActiveRoom(roomId, epoch)) {
        if (error && (error.code === 'NOT_MEMBER' || error.code === 'NOT_FOUND')) {
          handleRoomError(error, roomId, epoch);
          return;
        }
        statusElement.textContent = '刷新失败：' + (error && error.message ? error.message : error);
      }
    }
    return;
  }
  const previousId = activeRoomId;
  snapshotActiveRoom();
  activeRoomId = roomId;
  resetTimelineRender();
  messagesElement.replaceChildren();
  applyRoomLifecycle(null);
  syncRoomFilterForRoom(roomId);
  const epoch = ++roomEpoch;
  if (roomAbort) roomAbort.abort();
  roomAbort = new AbortController();
  resetRefreshChain();
  scrollController.reset(roomId, epoch);
  cancelOlderAutoLoad();
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
  invitedMembers = new Map();
  ownerTransfer = null;
  applyRoomAnnouncement();
  updateMembersAffordance();
  nextOlder = null;
  timelineResumeCursor = null;
  currentItems = [];
  olderLoading = false;
  olderEnded = false;
  olderError = '';
  updateOlderAffordance();
  resetRoomTasks();
  renderRooms();
  clearChatError();
  updateCopyGroupInfoAffordance();
  syncComposerSendState();
  const cache = roomCache.get(roomId);
  const longCache = Boolean(cache && (cache.items || []).length > ROOM_CACHE_RENDER_MAX);
  const restoreHistory = Boolean(cache && cache.pinned === false && !settings.force);
  if (cache) {
    // 长缓存只恢复房间元数据并显示加载态，不预渲染全部已加载历史。
    applyCachedRoom(cache, longCache ? { renderItems: cache.pinned === false } : undefined);
    if (!longCache || cache.pinned === false) setChatLoading(false);
  } else {
    const keepContent = false;
    setChatLoading(true, {
      keepContent: keepContent,
      skeleton: Boolean(settings.initial) || !keepContent
    });
    if (!keepContent) {
      titleElement.textContent = '会话';
      subtitleElement.textContent = '正在加载…';
      subtitleElement.hidden = false;
    }
    if (bodyInput) {
      if (!drafts.has(roomId)) {
        const storedDraft = draftLoad(roomId);
        if (storedDraft) drafts.set(roomId, storedDraft);
      }
      bodyInput.value = drafts.get(roomId) || '';
    }
    if (typeof syncComposerReply === 'function') syncComposerReply();
    renderComposerFiles(roomId);
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
    // 返回上翻阅读中的缓存时先保留其视口；新消息通过“回到最新”提示呈现。
    await refresh(restoreHistory ? false : true);
  } catch (error) {
    if (isAbortError(error) || !isActiveRoom(roomId, epoch)) return;
    if (error && (error.code === 'NOT_MEMBER' || error.code === 'NOT_FOUND')) {
      handleRoomError(error, roomId, epoch);
    } else if (cache && !longCache) {
      setChatLoading(false);
      statusElement.textContent = '刷新失败：' + (error && error.message ? error.message : error);
    } else {
      // 长缓存没有可安全回退的预览；显示明确错误与重试，不留空白。
      handleRoomError(error, roomId, epoch);
    }
  }
}

function closeRoomView() {
  snapshotActiveRoom();
  deactivateFilesRoom();
  deactivateMonitorRoom();
  activeRoomId = null;
  resetTimelineRender();
  messagesElement.replaceChildren();
  applyRoomLifecycle(null);
  roomEpoch += 1;
  if (roomAbort) roomAbort.abort();
  roomAbort = null;
  resetRefreshChain();
  cancelOlderAutoLoad();
  room = null;
  members = new Map();
  invitedMembers = new Map();
  ownerTransfer = null;
  applyRoomAnnouncement();
  updateMembersAffordance();
  nextOlder = null;
  timelineResumeCursor = null;
  currentItems = [];
  olderLoading = false;
  olderEnded = false;
  olderError = '';
  updateOlderAffordance();
  resetRoomTasks();
  setChatLoading(false);
  if (chatErrorElement) chatErrorElement.hidden = true;
  if (chatErrorTextElement) chatErrorTextElement.textContent = '';
  syncComposerSendState();
  renderComposerFiles(null);
  if (titleElement) titleElement.textContent = '单聊';
  if (subtitleElement) {
    subtitleElement.textContent = '';
    subtitleElement.hidden = true;
  }
  if (olderButton) olderButton.hidden = true;
  if (renameButton) renameButton.hidden = true;
  if (renameForm) renameForm.hidden = true;
  updateMembersAffordance();
  updateCopyGroupInfoAffordance();
  if (statusElement) statusElement.textContent = '';
  stickyStatus = '';
  hideMentionPicker();
  scrollController.close();
}
`;
