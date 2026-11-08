/**
 * 消息渲染片段：时间胶囊、头像、群聊发送者、@ 高亮与回执。
 *
 * 与列表片段一样由 `chatClientScript` 拼进同一作用域；纯 DOM 构造，
 * 不把消息正文当 HTML 注入。
 */
export const CHAT_RENDER_SCRIPT = `
const TIME_GAP = 5 * 60 * 1000;
// 列表渲染复用同一个 encoder，避免每条消息构造一次。
const messageTextEncoder = new TextEncoder();
// 气泡 title 只显示到分钟；按分钟缓存 Intl 结果，长列表不逐条格式化。
const fullTimeCache = new Map();
let cachedMentionNames = null;
// 已展开全文的消息正文；刷新重建 DOM 后仍直接渲染完整正文。
const expandedMessageBodies = new Map();
// 同一 message_id 的自动展开只发一次读取；刷新重建的节点共享同一结果。
const agentAutoExpandReads = new Map();
// 自动展开队列只消费进入视口附近的消息，避免首屏 50 条同时发请求。
const AGENT_EXPAND_CONCURRENCY = 2;
const AGENT_EXPAND_ROOT_MARGIN = '200px 0px';
const AGENT_EXPAND_FALLBACK_MAX = 3;
let agentExpandObserver = null;
let agentExpandQueue = [];
let agentExpandActive = 0;
let agentExpandFallbackTasks = [];
let agentExpandFallbackFrame = 0;

function senderName(senderId) {
  if (identity && senderId === identity.actor_id) return '我';
  const member = members.get(senderId);
  return member ? member.name : senderId;
}

/** 气泡时间胶囊：今天只显示时分，更早带日期。 */
function chatTime(value) {
  const ms = Number(value);
  if (!ms || Number.isNaN(ms)) return '';
  const date = new Date(ms);
  const now = new Date();
  const clock = clockTime(date);
  if (date.toDateString() === now.toDateString()) return clock;
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return '昨天 ' + clock;
  const day = (date.getMonth() + 1) + '月' + date.getDate() + '日';
  if (date.getFullYear() === now.getFullYear()) return day + ' ' + clock;
  return date.getFullYear() + '年' + day + ' ' + clock;
}

function fullTime(value) {
  const ms = Number(value);
  if (!ms || Number.isNaN(ms)) return '';
  const minute = Math.floor(ms / 60_000);
  const cached = fullTimeCache.get(minute);
  if (cached !== undefined) return cached;
  const text = new Date(minute * 60_000).toLocaleString();
  if (fullTimeCache.size >= 512) fullTimeCache.clear();
  fullTimeCache.set(minute, text);
  return text;
}

const DELIVERY_STATES = ['pending', 'claimed', 'completed', 'failed', 'cancelled'];

function deliveryTotal(states) {
  let total = 0;
  for (const state of DELIVERY_STATES) total += Number(states[state] || 0);
  return total;
}

/**
 * 回执收件人前缀：能确定收件人时展示名字，无法确定时不猜测。
 *
 * delivery_states 只有状态计数，没有逐收件人映射；因此仅在“收件人数等于
 * 房间内其他 Agent 数”时列出全部名字，单收件人且只有一个 Agent 时直接命名。
 * 其余情况保留计数，避免把未收到消息的 Agent 误写成收件人。
 */
function receiptRecipients(states) {
  const total = deliveryTotal(states);
  if (total === 0) return '';
  const agents = [];
  for (const member of members.values()) {
    if (member.kind !== 'agent' || !member.name) continue;
    if (identity && member.actor_id === identity.actor_id) continue;
    agents.push(member.name);
  }
  if (agents.length === 1 && total === 1) return agents[0] + ' ';
  if (agents.length > 1 && agents.length === total) return agents.join('、') + ' · ';
  return '';
}

/**
 * 把 history_list 的 delivery_states 聚合成一条状态回执。
 *
 * 没有 delivery 表示消息只完成了广播（人类对人类的单聊、群聊未 @），
 * 显示为“已发送”；多 Agent 时按状态计数聚合，避免堆叠多行。
 */
function receiptStatus(states, named) {
  const pending = Number(states.pending || 0);
  const claimed = Number(states.claimed || 0);
  const completed = Number(states.completed || 0);
  const failed = Number(states.failed || 0);
  const cancelled = Number(states.cancelled || 0);
  const total = pending + claimed + completed + failed + cancelled;
  if (total === 0) return '已发送';
  if (total === 1) {
    if (pending === 1) return '已送达';
    if (claimed === 1) return named ? '已接收' : 'Agent 已接收';
    if (completed === 1) return '已处理';
    if (failed === 1) return '发送失败';
    return '已取消';
  }
  const parts = [];
  if (pending > 0) parts.push(pending + '/' + total + ' 已送达');
  if (claimed > 0) parts.push(claimed + '/' + total + ' 已接收');
  if (completed > 0) parts.push(completed + ' 已处理');
  if (failed > 0) parts.push(failed + ' 发送失败');
  if (cancelled > 0) parts.push(cancelled + ' 已取消');
  return parts.join(' · ');
}

/** 状态时间优先领取/更新时间；完成态没有独立时间，回退到消息时间。 */
function receiptTime(item) {
  return Number(item.delivery_updated_at || item.delivery_claimed_at || item.created_at) || 0;
}

function receiptText(item) {
  const states = item.delivery_states || {};
  const names = receiptRecipients(states);
  let text = names + receiptStatus(states, names.length > 0);
  const time = chatTime(receiptTime(item));
  if (time) text += ' · ' + time;
  if (claimStale(item)) text += ' · 处理中未更新';
  return text;
}

/**
 * claimed 超过阈值未 report/complete 时提示“处理中未更新”。
 *
 * 时间来自 history_list 的 delivery_claimed_at / delivery_updated_at，
 * 不新增数据库字段；只读已返回数据，不轮询服务端。
 */
function claimStale(item) {
  const states = item.delivery_states || {};
  if (!Number(states.claimed || 0)) return false;
  const last = Number(item.delivery_updated_at || item.delivery_claimed_at || 0);
  return last > 0 && Date.now() - last >= CLAIM_STALE_MS;
}

function applyReceipt(receipt, item) {
  const label = receipt.firstElementChild;
  if (label) label.textContent = receiptText(item);
  receipt.classList.toggle('stale', claimStale(item));
  // 列表构建阶段节点尚未入树：只写文本，不读布局。
  // 整表替换后的最终高度由 scrollController 的 rAF 钉底/锚点恢复统一校准。
  if (!receipt.isConnected) return;
  const scroller = messagesElement;
  const scrollerTop = scroller ? scroller.getBoundingClientRect().top : 0;
  const aboveViewport = scroller ? receipt.getBoundingClientRect().bottom < scrollerTop : false;
  const beforeHeight = receipt.getBoundingClientRect().height;
  // 异步回执文本变化可能加高；上翻阅读时补偿锚点，pinned 时由控制器补钉底。
  const afterHeight = receipt.getBoundingClientRect().height;
  if (!scrollController.isPinned() && aboveViewport && afterHeight !== beforeHeight) {
    scrollController.adjustScroll(afterHeight - beforeHeight);
  }
  scrollController.noteContentChanged();
}

/** 未到阈值时用一次性本地定时器补上提示，页面刷新会重新计算。 */
function scheduleReceipt(receipt, item) {
  const states = item.delivery_states || {};
  if (!Number(states.claimed || 0)) return;
  const last = Number(item.delivery_updated_at || item.delivery_claimed_at || 0);
  if (!last) return;
  const delay = last + CLAIM_STALE_MS - Date.now();
  if (delay <= 0) return;
  setTimeout(function () {
    if (receipt.isConnected) applyReceipt(receipt, item);
  }, delay + 50);
}

function mentionNames() {
  if (cachedMentionNames) return cachedMentionNames;
  const names = [];
  for (const member of members.values()) {
    if (member.name) names.push(member.name);
  }
  if (identity && identity.name) names.push(identity.name);
  names.sort(function (a, b) { return b.length - a.length; });
  cachedMentionNames = names;
  return names;
}

/** 每次房间渲染/历史批次开始时失效；同一批消息只计算一次成员名。 */
function invalidateMentionNames() {
  cachedMentionNames = null;
}

/** 纯文本写入，只把已知成员名对应的 @ 片段包成高亮，避免 HTML 注入。 */
function renderRichText(element, text) {
  element.replaceChildren();
  const names = mentionNames();
  if (names.length === 0) {
    element.textContent = text;
    return;
  }
  // last 是“已写入”的位置；scan 可以跳过未知 @，但不能因此丢掉它前面的正文。
  let scan = 0;
  let last = 0;
  while (scan < text.length) {
    const at = text.indexOf('@', scan);
    if (at < 0) break;
    let matched = null;
    for (const name of names) {
      if (text.startsWith(name, at + 1)) {
        matched = name;
        break;
      }
    }
    if (!matched) {
      scan = at + 1;
      continue;
    }
    if (at > last) element.append(document.createTextNode(text.slice(last, at)));
    const span = document.createElement('span');
    span.className = 'mention';
    span.textContent = '@' + matched;
    element.append(span);
    last = at + 1 + matched.length;
    scan = last;
  }
  if (last < text.length) element.append(document.createTextNode(text.slice(last)));
}

function timeDivider(value) {
  const element = document.createElement('li');
  element.className = 'msg-time';
  const label = document.createElement('span');
  label.textContent = chatTime(value);
  element.append(label);
  return element;
}

/**
 * 系统行：上下线时间线与投递回执共用居中、弱化的行结构。
 *
 * 只使用 textContent，不进入 Markdown、文件卡片、头像或气泡路径。
 */
function systemLineItem(className, labelText) {
  const element = document.createElement('li');
  element.className = 'msg-system ' + className;
  const label = document.createElement('span');
  label.textContent = labelText;
  element.append(label);
  return element;
}

/** 上下线时间线只使用 textContent，不进入 Markdown、文件卡片、头像或回执路径。 */
function presenceItem(item) {
  const name = senderName(item.agent_id);
  const action = item.transition === 'online' ? '上线' : '下线';
  const time = chatTime(item.occurred_at);
  const element = systemLineItem('msg-presence', name + ' ' + action + (time ? ' · ' + time : ''));
  element.dataset.presenceId = item.presence_event_id;
  if (item.time_basis === 'inferred') {
    element.firstElementChild.title = '下线时间为崩溃后推断';
  }
  return element;
}

/** 投递回执与上下线共用系统行；状态变化时只更新同一行文本。 */
function receiptItem(item) {
  const element = systemLineItem('msg-receipt', '');
  element.dataset.receiptFor = item.message_id;
  applyReceipt(element, item);
  scheduleReceipt(element, item);
  return element;
}

function messageItem(item) {
  const mine = Boolean(identity && item.sender_id === identity.actor_id);
  const agent = isAgentMessage(item);
  const element = document.createElement('li');
  element.className = 'msg' + (mine ? ' mine has-receipt' : '');
  element.dataset.messageId = item.message_id;
  // 任务同步按 message_id 索引节点；loadOlder 后不再全表查询。
  rememberTaskMarkerNode(item.message_id, element);
  // 任务入口统一在消息悬停或聚焦时显示；触屏保留人类入口，仅影响展示，不改变任务契约。
  element.dataset.senderKind = agent ? 'agent' : 'human';
  // 任务入口由后续任务片段按同一 message_id 补齐；这里只保留定位数据。
  element.dataset.messagePreview = String(item.preview || '');
  const sender = senderName(item.sender_id);
  const avatar = avatarElement(
    mine && identity ? identity.name : sender,
    agent ? 'agent' : null,
    'msg-avatar'
  );
  const content = document.createElement('div');
  content.className = 'msg-content';
  if (!mine && room && room.kind === 'group') {
    const senderLabel = document.createElement('div');
    senderLabel.className = 'msg-sender';
    senderLabel.textContent = sender;
    content.append(senderLabel);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.title = fullTime(item.created_at);
  // 已展开过的消息优先使用完整正文；刷新/重建不能让它退回预览。
  const expandedBody = expandedMessageBodies.get(item.message_id);
  const bodyText = expandedBody === undefined ? item.preview : expandedBody;
  const truncated = expandedBody === undefined &&
    item.body_bytes > messageTextEncoder.encode(item.preview).length;
  // 预览也渲染 Markdown；截断可能切断语法，由 Markdown 岛用 remend 闭合。
  // 传入 element：首屏只登记懒升级，消息进入视口附近后才创建 React root。
  renderMessageBody(bubble, bodyText, item, agent, truncated, false, element);
  content.append(bubble);
  const filesRef = { current: mountMessageFiles(bodyText, null) };
  if (filesRef.current) content.append(filesRef.current);
  if (truncated) {
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'expand';
    expand.textContent = '展开全文';
    expand.addEventListener('click', async function () {
      const roomId = activeRoomId;
      const epoch = roomEpoch;
      const stale = function () {
        return !isActiveRoom(roomId, epoch) || !expand.isConnected || !bubble.isConnected;
      };
      expand.disabled = true;
      expand.textContent = '正在展开…';
      // 预览阶段 bundle 失败时，展开只强制重试一次，避免每次点击都打 404。
      const retry = bubble.dataset.markdownUnavailable === '1';
      try {
        const fullText = await readMessage(item.message_id);
        // 读取期间切房或重建：旧响应不得写入新房间的状态栏、气泡或文件卡片。
        if (stale()) return;
        const rendered = await renderMessageBody(bubble, fullText, item, agent, false, retry);
        if (stale()) return;
        filesRef.current = mountMessageFiles(fullText, filesRef.current);
        if (filesRef.current && !filesRef.current.isConnected) {
          content.insertBefore(filesRef.current, expand);
        }
        if (rendered || !agent) {
          expandedMessageBodies.set(item.message_id, fullText);
          expand.remove();
        } else {
          // bundle 重试仍失败：不记展开态，正文已是完整纯文本，保留按钮供稍后再试。
          expand.disabled = false;
          expand.textContent = '展开全文';
        }
      } catch (error) {
        if (stale()) return;
        expand.disabled = false;
        expand.textContent = '展开全文';
        statusElement.textContent = '读取正文失败：' + error.message;
      }
    });
    content.append(expand);
    if (agent && item.body_bytes <= WEB_AGENT_AUTO_EXPAND_BYTES) {
      // 候选只登记观察；进入视口附近才入队读取，按钮在此之前保持可点击。
      registerAgentAutoExpand(item, element, bubble, content, expand, filesRef);
    }
  }
  const taskSlot = document.createElement('div');
  taskSlot.className = 'msg-task-slot';
  taskSlot.hidden = true;
  content.append(taskSlot);
  element.append(avatar, content);
  if (mine) {
    // 回执是消息下方的独立系统行，不放进气泡列，避免看起来像一条卡片。
    const fragment = document.createDocumentFragment();
    fragment.append(element, receiptItem(item));
    return fragment;
  }
  return element;
}

/**
 * 同一 message_id 的自动展开共享一次读取。
 *
 * 刷新可能在读取途中重建节点：旧节点被丢弃，新节点复用同一 Promise，
 * 既避免重复请求，也不会因为旧节点断开而让消息永远停在预览。
 */
function readMessageShared(messageId) {
  const existing = agentAutoExpandReads.get(messageId);
  if (existing) return existing;
  const pending = readMessage(messageId).finally(function () {
    if (agentAutoExpandReads.get(messageId) === pending) {
      agentAutoExpandReads.delete(messageId);
    }
  });
  agentAutoExpandReads.set(messageId, pending);
  return pending;
}

/**
 * 重建消息区前断开观察与待处理队列，避免旧节点/旧房间泄漏。
 *
 * 已经在读取中的任务无法取消，但完成时会检查节点是否仍连接；
 * 新渲染的节点会重新登记到新观察器。
 */
function resetAgentAutoExpand() {
  if (agentExpandObserver) {
    agentExpandObserver.disconnect();
    agentExpandObserver = null;
  }
  agentExpandQueue = [];
  agentExpandFallbackTasks = [];
  if (agentExpandFallbackFrame) {
    clearTimeout(agentExpandFallbackFrame);
    agentExpandFallbackFrame = 0;
  }
}

/** root 固定为消息滚动容器；只观察进入视口附近的消息。 */
function agentExpandObserverFor() {
  if (agentExpandObserver) return agentExpandObserver;
  if (typeof IntersectionObserver !== 'function' || !messagesElement) return null;
  const observer = new IntersectionObserver(function (entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting || !entry.target.isConnected) continue;
      const task = entry.target.__agentExpandTask;
      if (!task) continue;
      entry.target.__agentExpandTask = null;
      observer.unobserve(entry.target);
      enqueueAgentAutoExpand(task);
    }
  }, { root: messagesElement, rootMargin: AGENT_EXPAND_ROOT_MARGIN });
  agentExpandObserver = observer;
  return observer;
}

/** IntersectionObserver 不可用：只扫描当前可见/首屏少量候选。 */
function scheduleAgentExpandFallback() {
  if (agentExpandFallbackFrame) return;
  agentExpandFallbackFrame = setTimeout(function () {
    agentExpandFallbackFrame = 0;
    if (!messagesElement) return;
    const viewport = messagesElement.getBoundingClientRect();
    const remaining = [];
    let queued = 0;
    for (const task of agentExpandFallbackTasks) {
      if (!task.element.isConnected) continue;
      if (queued >= AGENT_EXPAND_FALLBACK_MAX) {
        remaining.push(task);
        continue;
      }
      const rect = task.element.getBoundingClientRect();
      if (rect.bottom >= viewport.top - 200 && rect.top <= viewport.bottom + 200) {
        queued += 1;
        enqueueAgentAutoExpand(task);
      } else {
        remaining.push(task);
      }
    }
    agentExpandFallbackTasks = remaining;
  }, 16);
}

/** 每个候选节点只登记一次；未进入视口时按钮仍可手动展开。 */
function registerAgentAutoExpand(item, element, bubble, content, expand, filesRef) {
  if (expandedMessageBodies.has(item.message_id)) {
    expand.remove();
    return;
  }
  const task = { item, element, bubble, content, expand, filesRef };
  const observer = agentExpandObserverFor();
  if (observer) {
    element.__agentExpandTask = task;
    observer.observe(element);
    return;
  }
  agentExpandFallbackTasks.push(task);
  scheduleAgentExpandFallback();
}

function enqueueAgentAutoExpand(task) {
  agentExpandQueue.push(task);
  drainAgentAutoExpandQueue();
}

function drainAgentAutoExpandQueue() {
  while (agentExpandActive < AGENT_EXPAND_CONCURRENCY && agentExpandQueue.length > 0) {
    const task = agentExpandQueue.shift();
    if (!task.element.isConnected) continue;
    agentExpandActive += 1;
    runAgentAutoExpand(task).finally(function () {
      agentExpandActive -= 1;
      drainAgentAutoExpandQueue();
    });
  }
}

/**
 * 自动展开一条已进入视口的 Agent 消息。
 *
 * 只在该节点仍连接时应用结果；房间切换/刷新重建后旧节点丢弃。
 * 文件卡片沿用现有挂载函数更新，不重复创建。
 */
async function runAgentAutoExpand(task) {
  const item = task.item;
  const element = task.element;
  const bubble = task.bubble;
  const content = task.content;
  const expand = task.expand;
  const filesRef = task.filesRef;
  expand.hidden = true;
  try {
    const fullText = await readMessageShared(item.message_id);
    if (!element.isConnected || !bubble.isConnected) return;
    // 自动展开是后台便利路径，不消耗用户手动展开的一次 bundle 重试机会。
    const rendered = await renderMessageBody(bubble, fullText, item, true, false, false);
    if (!element.isConnected || !bubble.isConnected) return;
    filesRef.current = mountMessageFiles(fullText, filesRef.current);
    if (filesRef.current && !filesRef.current.isConnected) {
      content.insertBefore(filesRef.current, expand);
    }
    if (rendered) {
      expandedMessageBodies.set(item.message_id, fullText);
      expand.remove();
    } else {
      // bundle 失败但正文已完整：保留按钮供稍后重试，不缓存为已展开。
      expand.hidden = false;
    }
  } catch (error) {
    // 失败恢复按钮；未进入视口的消息本来就保留按钮。
    if (element.isConnected) expand.hidden = false;
  }
}

/** 消息数超过阈值时才开启 content-visibility；短会话保持原生高度估算。 */
function updateMessagesLengthClass() {
  if (!messagesElement) return;
  const count = messagesElement.getElementsByClassName('msg').length;
  messagesElement.classList.toggle('messages--long', count > WEB_LONG_MESSAGE_THRESHOLD);
}

/** 全量替换消息区；缓存切换与首屏加载共用同一套渲染逻辑。 */
function renderMessageList(items) {
  if (!messagesElement) return;
  resetAgentAutoExpand();
  resetMarkdownHandles();
  resetMessageFileCards();
  resetTaskMarkerIndex();
  invalidateMentionNames();
  scrollController.beginContentChange();
  // 整表只在 DocumentFragment 中构建一次，最后统一入树；构建期间不读布局。
  const fragment = document.createDocumentFragment();
  if (historyPagerElement) fragment.append(historyPagerElement);
  // 服务端消息已出现在时间线时，先清掉对应的本地发送意图。
  outboxPruneAgainstTimeline(items);
  appendHistory(fragment, items);
  outboxAppendRows(fragment, activeRoomId);
  const end = ensureMessagesEnd();
  if (end) fragment.append(end);
  // 任务标记只同步本批新增节点，避免每次刷新全表 querySelectorAll + find。
  syncTaskCardMarkers(fragment);
  messagesElement.replaceChildren(fragment);
  ensureHistoryPager();
  updateMessagesLengthClass();
  scrollController.noteContentChanged();
}

/**
 * 连续消息间隔超过 5 分钟时插入居中时间胶囊；presence 行自带时间。
 *
 * previousTimestamp 供预置历史块使用；返回本段首/末节点与最后一条时间，
 * 供 prepend seam 或后续增量 DOM 复用，不改变消息顺序。
 */
function appendHistory(container, items, options) {
  invalidateMentionNames();
  let previous = Number(options && options.previousTimestamp) || 0;
  const result = { first: null, last: null, lastTimestamp: previous };
  const appendNode = function (node) {
    if (!result.first) {
      result.first = node.nodeType === 11 ? node.firstElementChild : node;
    }
    result.last = node.nodeType === 11 ? node.lastElementChild : node;
    container.append(node);
  };
  for (const item of items) {
    const created = timelineTimestamp(item);
    if (item.kind === 'presence') {
      appendNode(presenceItem(item));
    } else {
      if (!previous || created - previous > TIME_GAP) appendNode(timeDivider(created));
      appendNode(messageItem(item));
    }
    if (created) previous = created;
  }
  result.lastTimestamp = previous;
  return result;
}

async function readMessage(messageId) {
  let chunk = await callTool('network_message_read', { message_id: messageId });
  let text = chunk.chunk;
  let cursor = chunk.next_cursor;
  for (let index = 0; index < MAX_CHUNKS && cursor && !chunk.eof; index += 1) {
    chunk = await callTool('network_message_read', {
      message_id: messageId,
      chunk_cursor: cursor
    });
    text += chunk.chunk;
    cursor = chunk.next_cursor;
  }
  if (cursor) text += '\\n…（消息过长，已截断）';
  return text;
}
`;
