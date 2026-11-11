/** Older-history loading and reading-anchor preservation. */
export const CHAT_HISTORY_SCRIPT = `
function findTimelineElement(item) {
  if (!messagesElement || !item) return null;
  for (const child of messagesElement.children) {
    if (!child.dataset) continue;
    if (item.kind === 'presence') {
      if (child.dataset.presenceId === item.presence_event_id) return child;
    } else if (child.dataset.messageId === item.message_id) {
      return child;
    }
  }
  return null;
}

/**
 * 修 prepend 接缝：新插入块的最后一条与旧首条间隔 <=5 分钟时，
 * 删除旧首条前的重复时间胶囊；>5 分钟则保证恰好一个。
 */
function reconcilePrependSeam(oldFirstItem, olderLastItem) {
  if (!oldFirstItem || !olderLastItem || oldFirstItem.kind === 'presence') return;
  const oldFirstElement = findTimelineElement(oldFirstItem);
  if (!oldFirstElement) return;
  const previous = oldFirstElement.previousElementSibling;
  const divider = previous && previous.classList.contains('msg-time') ? previous : null;
  const gap = timelineTimestamp(oldFirstItem) - timelineTimestamp(olderLastItem);
  if (gap > TIME_GAP) {
    if (!divider) {
      const entry = timelineNodes.get(timelineItemKey(oldFirstItem));
      const node = timeDivider(timelineTimestamp(oldFirstItem));
      if (entry) entry.divider = node;
      messagesElement.insertBefore(node, oldFirstElement);
    }
  } else if (divider) {
    const entry = timelineNodes.get(timelineItemKey(oldFirstItem));
    if (entry) entry.divider = null;
    divider.remove();
  }
}

async function loadOlder() {
  const roomId = activeRoomId;
  // 单飞：按钮禁用只是 UI 保护，重复事件/键盘仍可能再次触发。
  if (!roomId || !nextOlder || olderLoading) return;
  const epoch = roomEpoch;
  const cursor = nextOlder;
  const humanTimeline = Boolean(identity && identity.kind === 'human');
  // 只有已离底时才需要取消跟随；手动/自动入口都在消息流顶部，底部不会触发加载。
  if (!scrollController.isPinned()) scrollController.unpin();
  olderLoading = true;
  olderError = '';
  updateOlderAffordance();
  try {
    const args = {
      room_id: roomId,
      direction: 'before',
      cursor: cursor,
      limit: 50
    };
    if (humanTimeline) args.view = 'timeline';
    const page = await callTool('network_history_list', args, undefined, sessionSignal());
    if (!isActiveRoom(roomId, epoch)) return;
    const anchorSnapshot = scrollController.capturePrependAnchor();
    const oldFirstItem = currentItems[0] || null;
    const rawItems = humanTimeline ? (page.timeline_items || []) : page.items;
    const merged = mergeTimelineItems(currentItems, rawItems.slice().reverse());
    const known = new Set(currentItems.map(timelineItemKey));
    const olderItems = merged.filter(function (item) {
      return !known.has(timelineItemKey(item));
    });
    if (olderItems.length > 0) {
      const fragment = document.createDocumentFragment();
      appendHistory(fragment, olderItems);
      messagesElement.prepend(fragment);
      ensureHistoryPager();
      syncTaskCardMarkers(messagesElement);
      reconcilePrependSeam(oldFirstItem, olderItems[olderItems.length - 1]);
      scrollController.restorePrependAnchor(anchorSnapshot);
    }
    currentItems = merged;
    const nextCursor = humanTimeline
      ? (page.timeline_has_more ? page.timeline_next_cursor : null)
      : (page.has_more ? page.next_cursor : null);
    // 游标不前进说明这一页无法再向前推进；停止请求并给出到底提示。
    if (!nextCursor || nextCursor === cursor) {
      nextOlder = null;
      olderEnded = true;
    } else {
      nextOlder = nextCursor;
      olderEnded = false;
    }
    olderError = '';
    scrollController.noteContentChanged();
    cacheRoomState(roomId, {
      items: currentItems,
      nextOlder: nextOlder,
      olderEnded: olderEnded,
      scrollTop: messagesElement ? messagesElement.scrollTop : 0
    });
  } catch (error) {
    if (!isAbortError(error) && isActiveRoom(roomId, epoch)) {
      olderError = '加载更早失败：' + (error && error.message ? error.message : error);
    }
  } finally {
    if (isActiveRoom(roomId, epoch)) {
      olderLoading = false;
      updateOlderAffordance();
      // 用户可能在请求途中继续上翻并抵达顶部；此时不会再产生 scroll
      // 事件。完成本页后重查一次，接续被单飞锁挡住的加载意图。
      if (!olderError && nextOlder && olderAutoTopReached()) scheduleOlderAutoLoad();
    }
  }
}

`;
