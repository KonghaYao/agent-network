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
    item.preview, item.body_bytes, item.created_at, item.sender_id,
    isAgentMessage(item), senderName(item.sender_id), room && room.kind,
    identity && identity.name, timelineMentionVersion
  ]);
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

/** Older pages register in the same index, so the next refresh reuses them too. */
function appendHistory(container, items, options) {
  prepareTimelineMentions();
  let previous = Number(options && options.previousTimestamp) || 0;
  const result = { first: null, last: null, lastTimestamp: previous };
  for (const item of items) {
    const entry = createTimelineNode(item);
    timelineDivider(entry, item, previous);
    if (entry.divider) container.append(entry.divider);
    container.append(entry.node);
    if (entry.receipt) container.append(entry.receipt);
    if (!result.first) result.first = entry.divider || entry.node;
    result.last = entry.receipt || entry.node;
    previous = timelineTimestamp(item) || previous;
  }
  result.lastTimestamp = previous;
  return result;
}
`;
