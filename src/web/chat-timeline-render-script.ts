/** Stable timeline nodes: refresh receipts and append messages without remounting history. */
export const CHAT_TIMELINE_RENDER_SCRIPT = `
let timelineRenderRoom = null;
const timelineNodes = new Map();
let timelineMentionNames = '';
let timelineMentionVersion = 0;

function prepareTimelineMentions() {
  invalidateMentionNames();
  const names = JSON.stringify(mentionNames());
  if (names !== timelineMentionNames) {
    timelineMentionNames = names;
    timelineMentionVersion += 1;
  }
}

function resetTimelineRender() {
  for (const entry of timelineNodes.values()) {
    if (entry.receipt) clearTimeout(entry.receipt.__receiptTimer);
  }
  timelineNodes.clear();
  timelineRenderRoom = activeRoomId;
  resetAgentAutoExpand();
  resetMarkdownHandles();
  resetMessageFileCards();
  resetTaskMarkerIndex();
  invalidateMentionNames();
}

function timelineBodySignature(item) {
  if (item.kind === 'presence') {
    return JSON.stringify([item, senderName(item.agent_id)]);
  }
  // Receipts are mutable; the body is not. Expanded bodies and React roots stay mounted.
  return JSON.stringify([
    item.preview, item.body_bytes, item.created_at, item.sender_id, item.reply_to,
    isAgentMessage(item), senderName(item.sender_id), room && room.kind,
    identity && identity.name, timelineMentionVersion
  ]);
}

/** 同一自然日才允许合并；跨天的上下线保留原始行。 */
function samePresenceDay(left, right) {
  const a = new Date(Number(left.occurred_at));
  const b = new Date(Number(right.occurred_at));
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

/** 合并组的第一条可能是下线；它意味着此前已经在线，用同一时间展示初始上线。 */
function initialOnlinePresence(item) {
  if (item.transition === 'online') return item;
  return Object.assign({}, item, { transition: 'online', time_basis: 'observed' });
}

/**
 * 相邻上下线合并：同一 actor、同一自然日，且中间没有消息或其他 actor 打断时，
 * 只保留初始上线与最终状态。全部在线的重复记录收敛为第一条；没有在线的组只保留
 * 最终下线，避免凭空补出上线。只影响渲染，原始事件、未读与在线查询保持不变。
 */
function collapsePresenceRuns(items) {
  const result = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index];
    if (!item || item.kind !== 'presence') {
      result.push(item);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < items.length) {
      const next = items[end];
      if (!next || next.kind !== 'presence' || next.agent_id !== item.agent_id ||
          !samePresenceDay(item, next)) break;
      end += 1;
    }
    if (end - index === 1) {
      result.push(item);
      index = end;
      continue;
    }
    const run = items.slice(index, end);
    const last = run[run.length - 1];
    if (!run.some(function (entry) { return entry.transition === 'online'; })) {
      result.push(last);
    } else {
      result.push(initialOnlinePresence(run[0]));
      if (run.some(function (entry) { return entry.transition === 'offline'; })) {
        result.push(last);
      }
    }
    index = end;
  }
  return result;
}

function createTimelineNode(item) {
  const fragment = document.createDocumentFragment();
  fragment.append(item.kind === 'presence' ? presenceItem(item) : messageItem(item));
  const entry = {
    signature: timelineBodySignature(item),
    node: fragment.firstElementChild,
    receipt: fragment.querySelector('.msg-receipt'),
    divider: null
  };
  timelineNodes.set(timelineItemKey(item), entry);
  return entry;
}

function disposeTimelineNode(entry) {
  if (entry.receipt) {
    clearTimeout(entry.receipt.__receiptTimer);
    entry.receipt.remove();
  }
  if (entry.divider) entry.divider.remove();
  const node = entry.node;
  if (agentExpandObserver) agentExpandObserver.unobserve(node);
  node.__agentExpandTask = null;
  for (const bubble of node.querySelectorAll('.bubble')) destroyBubbleMarkdown(bubble);
  for (const card of node.querySelectorAll('.msg-file')) {
    if (messageFileObserver) messageFileObserver.unobserve(card);
  }
  const nodes = taskMarkerNodes.get(node.dataset.messageId);
  if (nodes) nodes.delete(node);
  node.remove();
}

function timelineDivider(entry, item, previous) {
  const created = timelineTimestamp(item);
  const needsDivider = item.kind !== 'presence' && (!previous || created - previous > TIME_GAP);
  if (needsDivider) {
    if (!entry.divider) entry.divider = timeDivider(created);
    const label = chatTime(created);
    if (entry.divider.firstElementChild.textContent !== label) {
      entry.divider.firstElementChild.textContent = label;
    }
  } else if (entry.divider) {
    entry.divider.remove();
    entry.divider = null;
  }
}

function renderMessageList(items) {
  if (!messagesElement) return;
  items = collapsePresenceRuns(items);
  if (timelineRenderRoom !== activeRoomId) resetTimelineRender();
  prepareTimelineMentions();
  scrollController.beginContentChange();
  ensureHistoryPager();
  outboxPruneAgainstTimeline(items);
  const keep = new Set(items.map(timelineItemKey));
  for (const [key, entry] of timelineNodes) {
    if (!keep.has(key)) {
      disposeTimelineNode(entry);
      timelineNodes.delete(key);
    }
  }
  let cursor = historyPagerElement ? historyPagerElement.nextSibling : messagesElement.firstChild;
  const place = function (node) {
    if (!node) return;
    if (node !== cursor) messagesElement.insertBefore(node, cursor);
    cursor = node.nextSibling;
  };
  let previous = 0;
  for (const item of items) {
    const key = timelineItemKey(item);
    let entry = timelineNodes.get(key);
    if (entry && entry.signature !== timelineBodySignature(item)) {
      if (cursor === entry.divider || cursor === entry.node || cursor === entry.receipt) {
        cursor = (entry.receipt || entry.node).nextSibling;
      }
      disposeTimelineNode(entry);
      entry = null;
    }
    if (!entry) entry = createTimelineNode(item);
    const oldDivider = entry.divider;
    if (oldDivider && cursor === oldDivider) cursor = entry.node;
    timelineDivider(entry, item, previous);
    if (entry.divider === oldDivider && oldDivider && oldDivider.nextSibling === cursor) {
      cursor = oldDivider;
    }
    place(entry.divider);
    place(entry.node);
    if (entry.receipt) {
      applyReceipt(entry.receipt, item);
      scheduleReceipt(entry.receipt, item);
      place(entry.receipt);
    }
    previous = timelineTimestamp(item) || previous;
  }
  outboxRefreshRows();
  ensureMessagesEnd();
  syncTaskCardMarkers(messagesElement);
  updateMessagesLengthClass();
  scrollController.noteContentChanged();
}

`;
