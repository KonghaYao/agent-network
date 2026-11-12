import { LIMITS } from '../contracts/limits';

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
let expandedBodyCacheSize = 0;
// 用户显式展开的超长消息；与全文缓存分离，收起后重新渲染仍保持收起。
const longMessageExpanded = new Set();
function rememberLongExpanded(messageId, expanded) {
  longMessageExpanded.delete(messageId);
  if (!expanded) return;
  longMessageExpanded.add(messageId);
  while (longMessageExpanded.size > ${LIMITS.webExpandedBodyCacheMax}) {
    longMessageExpanded.delete(longMessageExpanded.values().next().value);
  }
}
function rememberExpandedBody(messageId, text) {
  const previous = expandedMessageBodies.get(messageId);
  if (previous !== undefined) expandedBodyCacheSize -= previous.length * 2;
  expandedMessageBodies.delete(messageId);
  expandedMessageBodies.set(messageId, text);
  expandedBodyCacheSize += text.length * 2;
  while (expandedBodyCacheSize > ${LIMITS.webExpandedBodyCacheBytes} ||
         expandedMessageBodies.size > ${LIMITS.webExpandedBodyCacheMax}) {
    const oldest = expandedMessageBodies.keys().next().value;
    expandedBodyCacheSize -= expandedMessageBodies.get(oldest).length * 2;
    expandedMessageBodies.delete(oldest);
  }
}
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
  const text = receiptText(item);
  if (label && label.textContent === text && receipt.classList.contains('stale') === claimStale(item)) return;
  const scroller = messagesElement;
  const aboveViewport = receipt.isConnected && scroller &&
    receipt.getBoundingClientRect().bottom < scroller.getBoundingClientRect().top;
  const beforeHeight = aboveViewport ? receipt.getBoundingClientRect().height : 0;
  if (label) label.textContent = text;
  receipt.classList.toggle('stale', claimStale(item));
  // 列表构建阶段节点尚未入树：只写文本，不读布局。
  // 整表替换后的最终高度由 scrollController 的 rAF 钉底/锚点恢复统一校准。
  if (!receipt.isConnected) return;
  const afterHeight = receipt.getBoundingClientRect().height;
  if (!scrollController.isPinned() && aboveViewport && afterHeight !== beforeHeight) {
    scrollController.adjustScroll(afterHeight - beforeHeight);
  }
  scrollController.noteContentChanged();
}

/** 未到阈值时用一次性本地定时器补上提示，页面刷新会重新计算。 */
function scheduleReceipt(receipt, item) {
  clearTimeout(receipt.__receiptTimer);
  const states = item.delivery_states || {};
  if (!Number(states.claimed || 0)) return;
  const last = Number(item.delivery_updated_at || item.delivery_claimed_at || 0);
  if (!last) return;
  const delay = last + CLAIM_STALE_MS - Date.now();
  if (delay <= 0) return;
  receipt.__receiptTimer = setTimeout(function () {
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

const BASE64_TEXT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

/** base64 字符占比：空白也计入分母，避免把带空格的英文长文误判成 base64。 */
function base64CharRatioOk(text) {
  if (!text) return false;
  let allowed = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (BASE64_TEXT_CHARS.indexOf(text.charAt(index)) >= 0) allowed += 1;
  }
  return allowed / text.length >= 0.95;
}

function base64CleanLength(text) {
  return text.replace(/\\s+/g, '').length;
}

/** 与 Markdown 岛 entry.tsx 的 isBase64Block 保持同一判定规则。 */
function isBase64BlockText(text) {
  const clean = text.replace(/\\s+/g, '');
  if (clean.length < WEB_BASE64_COLLAPSE_CHARS) return false;
  if (!/[A-Za-z]/.test(clean) || !/[0-9]/.test(clean)) return false;
  return base64CharRatioOk(text);
}

function isBase64LineCandidate(line) {
  const trimmed = line.trim();
  return trimmed.length > 0 && base64CharRatioOk(trimmed);
}

/**
 * 把正文切成普通文本与连续 base64 行块。
 *
 * 只把整行几乎全为 base64 字符的连续行合并；带前缀的句子不会被卷进折叠块，
 * 短哈希也不会达到长度阈值。返回空数组表示正文没有可折叠 base64。
 */
function splitBase64Segments(text) {
  const segments = [];
  if (!text) return segments;
  const lines = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf('\\n', lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    lines.push({ start: lineStart, end: lineEnd, text: text.slice(lineStart, lineEnd) });
    if (newline < 0) break;
    lineStart = newline + 1;
  }
  let index = 0;
  let plainStart = 0;
  while (index < lines.length) {
    if (!isBase64LineCandidate(lines[index].text)) {
      index += 1;
      continue;
    }
    let endIndex = index;
    while (endIndex < lines.length && isBase64LineCandidate(lines[endIndex].text)) {
      endIndex += 1;
    }
    const candidateStart = lines[index].start;
    const candidateEnd = lines[endIndex - 1].end;
    const candidate = text.slice(candidateStart, candidateEnd);
    if (!isBase64BlockText(candidate)) {
      index += 1;
      continue;
    }
    if (candidateStart > plainStart) {
      segments.push({ text: text.slice(plainStart, candidateStart), base64: false });
    }
    segments.push({ text: candidate, base64: true });
    plainStart = candidateEnd;
    index = endIndex;
  }
  if (plainStart < text.length) segments.push({ text: text.slice(plainStart), base64: false });
  return segments;
}

function base64SizeLabel(text) {
  const kb = base64CleanLength(text) / 1024;
  const value = kb >= 10 ? String(Math.round(kb)) : (Math.round(kb * 10) / 10).toFixed(1);
  return 'base64 内容 · 约 ' + value + ' KB';
}

/**
 * 纯文本 base64 折叠块：不解码、不链接化、不做 Markdown 二次解析。
 * 折叠态只写入预览文本；完整原文保留在闭包里，复制始终使用完整原文。
 */
function createBase64Block(text) {
  const root = document.createElement('div');
  root.className = 'msg-base64';
  root.dataset.base64Length = String(base64CleanLength(text));
  const head = document.createElement('div');
  head.className = 'msg-base64-head';
  const title = document.createElement('span');
  title.className = 'msg-base64-title';
  title.textContent = base64SizeLabel(text);
  const actions = document.createElement('span');
  actions.className = 'msg-base64-actions';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'msg-base64-toggle';
  toggle.textContent = '查看';
  toggle.setAttribute('aria-expanded', 'false');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'msg-base64-copy';
  copy.textContent = '复制';
  const status = document.createElement('span');
  status.className = 'msg-base64-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const body = document.createElement('div');
  body.className = 'msg-base64-body';
  const pre = document.createElement('pre');
  let expanded = false;
  const paint = function () {
    pre.textContent = expanded ? text : text.slice(0, WEB_BASE64_PREVIEW_CHARS);
    root.classList.toggle('is-expanded', expanded);
    toggle.textContent = expanded ? '收起' : '查看';
    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  };
  paint();
  toggle.addEventListener('click', function () {
    expanded = !expanded;
    paint();
  });
  copy.addEventListener('click', function () {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') {
      status.textContent = '复制失败';
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      status.textContent = '已复制';
    }, function () {
      status.textContent = '复制失败';
    });
  });
  actions.append(toggle, copy, status);
  head.append(title, actions);
  body.append(pre);
  root.append(head, body);
  return root;
}

/** 纯文本写入，只把已知成员名对应的 @ 片段包成高亮，避免 HTML 注入。 */
function appendRichText(element, text) {
  const names = mentionNames();
  if (names.length === 0) {
    if (text) element.append(document.createTextNode(text));
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

/**
 * 纯文本正文：把连续 base64 行替换为折叠块，其余文本仍走 @ 高亮。
 * allowBase64=false 用于 512B 截断预览，避免复制按钮只拿到半截 base64。
 */
function renderRichText(element, text, allowBase64) {
  element.replaceChildren();
  const segments = allowBase64 ? splitBase64Segments(text) : [];
  if (segments.length === 0) {
    appendRichText(element, text);
    return 0;
  }
  let folded = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment.base64) {
      element.append(createBase64Block(segment.text));
      folded += 1;
      continue;
    }
    let chunk = segment.text;
    // 折叠块本身是块级元素；去掉紧邻的换行，避免 pre-wrap 再撑出一行空白。
    if (index > 0 && segments[index - 1].base64) {
      if (chunk.indexOf('\\r\\n') === 0) chunk = chunk.slice(2);
      else if (chunk.charAt(0) === '\\n') chunk = chunk.slice(1);
    }
    if (index + 1 < segments.length && segments[index + 1].base64) {
      if (chunk.endsWith('\\r\\n')) chunk = chunk.slice(0, -2);
      else if (chunk.charAt(chunk.length - 1) === '\\n') chunk = chunk.slice(0, -1);
    }
    if (chunk) appendRichText(element, chunk);
  }
  return folded;
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
  if (Number(item.body_bytes) === 0) {
    const recalled = systemLineItem('msg-recalled', '此消息已撤回');
    recalled.dataset.messageId = item.message_id;
    return recalled;
  }
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
  // 起点摘要行位于气泡上方，只占一个紧凑槽；非起点保持 hidden。
  const taskSlot = document.createElement('div');
  taskSlot.className = 'msg-task-bar-slot';
  taskSlot.hidden = true;
  content.append(taskSlot);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.title = fullTime(item.created_at);
  // 已展开过的消息优先使用完整正文；刷新/重建不能让它退回预览。
  const cachedBody = expandedMessageBodies.get(item.message_id);
  const longBody = item.body_bytes >= WEB_LONG_MESSAGE_COLLAPSE_BYTES;
  // 全文缓存被 LRU 淘汰后，展开标记同时失效，避免出现“已展开但只有预览”。
  if (longBody && cachedBody === undefined) longMessageExpanded.delete(item.message_id);
  // 超长消息的展开是用户显式状态；收起后保留全文缓存，再次查看不再读服务端。
  const longExpanded = longBody && cachedBody !== undefined &&
    longMessageExpanded.has(item.message_id);
  const showFull = longBody ? longExpanded : cachedBody !== undefined;
  const bodyText = showFull && cachedBody !== undefined ? cachedBody : item.preview;
  // 折叠只看预览是否被截断；全文已缓存时收起后仍保留「查看全文」。
  const truncated = !showFull &&
    item.body_bytes > messageTextEncoder.encode(item.preview).length;
  const collapsed = longBody && !longExpanded;
  if (collapsed) bubble.classList.add('is-collapsed');
  // 预览也渲染 Markdown；截断可能切断语法，由 Markdown 岛用 remend 闭合。
  // 传入 element：首屏只登记懒升级，消息进入视口附近后才创建 React root。
  renderMessageBody(bubble, bodyText, item, agent, truncated, false, element);
  content.append(bubble);
  // 折叠只限制正文可视高度；附件按已缓存的完整正文挂载，收起后卡片不丢。
  const filesText = cachedBody === undefined ? bodyText : cachedBody;
  const filesRef = { current: mountMessageFiles(filesText, null) };
  if (filesRef.current) content.append(filesRef.current);
  if (truncated || longExpanded) {
    let expand = null;
    let collapse = null;
    if (longBody) {
      collapse = document.createElement('button');
      collapse.type = 'button';
      collapse.className = 'collapse';
      collapse.textContent = '收起';
      collapse.setAttribute('aria-expanded', 'true');
      collapse.hidden = !longExpanded;
      collapse.addEventListener('click', function () {
        rememberLongExpanded(item.message_id, false);
        bubble.classList.add('is-collapsed');
        collapse.hidden = true;
        if (!expand.isConnected) content.insertBefore(expand, collapse);
        expand.disabled = false;
        expand.textContent = '查看全文';
        scrollController.noteContentChanged();
      });
    }
    if (truncated || longBody) {
      expand = document.createElement('button');
      expand.type = 'button';
      expand.className = 'expand';
      expand.textContent = '查看全文';
      expand.setAttribute('aria-expanded', 'false');
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
          const cachedFull = expandedMessageBodies.get(item.message_id);
          const fullText = cachedFull === undefined
            ? await readMessageShared(item.message_id)
            : cachedFull;
          // 读取期间切房或重建：旧响应不得写入新房间的状态栏、气泡或文件卡片。
          if (stale()) return;
          const rendered = await renderMessageBody(bubble, fullText, item, agent, false, retry);
          if (stale()) return;
          filesRef.current = mountMessageFiles(fullText, filesRef.current);
          if (filesRef.current && !filesRef.current.isConnected) {
            // 引用块在正文上方；附件重新挂载时仍保持在正文下方、展开按钮之前。
            content.insertBefore(filesRef.current, expand);
          }
          if (rendered || !agent) {
            rememberExpandedBody(item.message_id, fullText);
            bubble.classList.remove('is-collapsed');
            expand.remove();
            if (collapse) {
              rememberLongExpanded(item.message_id, true);
              collapse.hidden = false;
            }
          } else {
            // bundle 重试仍失败：不记展开态，正文已是完整纯文本，保留按钮供稍后再试。
            // 超长消息此时先解除折叠，让完整纯文本可见；重新渲染会回到折叠预览。
            if (collapse) bubble.classList.remove('is-collapsed');
            expand.disabled = false;
            expand.textContent = '查看全文';
          }
        } catch (error) {
          if (stale()) return;
          expand.disabled = false;
          expand.textContent = '查看全文';
          statusElement.textContent = '读取正文失败：' + error.message;
        }
      });
      // 展开后重新收起时才把按钮插回；初次展开由下方折叠按钮接管。
      if (truncated) content.append(expand);
    }
    if (longBody) content.append(collapse);
    if (expand && agent && !longBody && item.body_bytes <= WEB_AGENT_AUTO_EXPAND_BYTES) {
      // 候选只登记观察；进入视口附近才入队读取，按钮在此之前保持可点击。
      registerAgentAutoExpand(item, element, bubble, content, expand, filesRef);
    }
  }
  appendMessageActions(item, content);
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
  agentAutoExpandReads.clear();
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
      // 引用块在正文上方；附件重新挂载时仍保持在正文下方、展开按钮之前。
      content.insertBefore(filesRef.current, expand);
    }
    if (rendered) {
      rememberExpandedBody(item.message_id, fullText);
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

async function readMessage(messageId) {
  const signal = sessionSignal();
  let chunk = await callTool('network_message_read', { message_id: messageId }, undefined, signal);
  let text = chunk.chunk;
  let cursor = chunk.next_cursor;
  for (let index = 0; index < MAX_CHUNKS && cursor && !chunk.eof; index += 1) {
    chunk = await callTool('network_message_read', {
      message_id: messageId,
      chunk_cursor: cursor
    }, undefined, signal);
    text += chunk.chunk;
    cursor = chunk.next_cursor;
  }
  if (cursor) text += '\\n…（消息过长，已截断）';
  return text;
}
`;
