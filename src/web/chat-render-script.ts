/**
 * 消息渲染片段：时间胶囊、头像、群聊发送者、@ 高亮与回执。
 *
 * 与列表片段一样由 `chatClientScript` 拼进同一作用域；纯 DOM 构造，
 * 不把消息正文当 HTML 注入。
 */
export const CHAT_RENDER_SCRIPT = `
const TIME_GAP = 5 * 60 * 1000;

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
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
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
  const names = [];
  for (const member of members.values()) {
    if (member.name) names.push(member.name);
  }
  if (identity && identity.name) names.push(identity.name);
  return names.sort(function (a, b) { return b.length - a.length; });
}

/** 纯文本写入，只把已知成员名对应的 @ 片段包成高亮，避免 HTML 注入。 */
function renderRichText(element, text) {
  element.replaceChildren();
  const names = mentionNames();
  if (names.length === 0) {
    element.textContent = text;
    return;
  }
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('@', index);
    if (at < 0) break;
    let matched = null;
    for (const name of names) {
      if (text.startsWith(name, at + 1)) {
        matched = name;
        break;
      }
    }
    if (!matched) {
      index = at + 1;
      continue;
    }
    if (at > index) element.append(document.createTextNode(text.slice(index, at)));
    const span = document.createElement('span');
    span.className = 'mention';
    span.textContent = '@' + matched;
    element.append(span);
    index = at + 1 + matched.length;
  }
  if (index < text.length) element.append(document.createTextNode(text.slice(index)));
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
  const sender = senderName(item.sender_id);
  const avatar = avatarElement(mine && identity ? identity.name : sender, null, 'msg-avatar');
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
  const truncated = item.body_bytes > new TextEncoder().encode(item.preview).length;
  // 预览也渲染 Markdown；截断可能切断语法，由 Markdown 岛用 remend 闭合。
  renderMessageBody(bubble, item.preview, item, agent, truncated);
  content.append(bubble);
  let filesElement = mountMessageFiles(item.preview, null);
  if (filesElement) content.append(filesElement);
  if (truncated) {
    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'expand';
    expand.textContent = '展开全文';
    expand.addEventListener('click', async function () {
      expand.disabled = true;
      expand.textContent = '正在展开…';
      // 预览阶段 bundle 失败时，展开只强制重试一次，避免每次点击都打 404。
      const retry = bubble.dataset.markdownUnavailable === '1';
      try {
        const fullText = await readMessage(item.message_id);
        const rendered = await renderMessageBody(bubble, fullText, item, agent, false, retry);
        filesElement = mountMessageFiles(fullText, filesElement);
        if (filesElement && !filesElement.isConnected) {
          content.insertBefore(filesElement, expand);
        }
        if (rendered) {
          expand.remove();
        } else {
          // bundle 重试仍失败：正文已是完整纯文本，保留按钮供稍后再试。
          expand.disabled = false;
          expand.textContent = '展开全文';
        }
      } catch (error) {
        expand.disabled = false;
        expand.textContent = '展开全文';
        statusElement.textContent = '读取正文失败：' + error.message;
      }
    });
    content.append(expand);
  }
  element.append(avatar, content);
  if (mine) {
    // 回执是消息下方的独立系统行，不放进气泡列，避免看起来像一条卡片。
    const fragment = document.createDocumentFragment();
    fragment.append(element, receiptItem(item));
    return fragment;
  }
  return element;
}

/** 全量替换消息区；缓存切换与首屏加载共用同一套渲染逻辑。 */
function renderMessageList(items) {
  if (!messagesElement) return;
  resetMarkdownHandles();
  resetMessageFileCards();
  messagesElement.replaceChildren();
  appendHistory(messagesElement, items);
}

/** 连续消息间隔超过 5 分钟时插入居中时间胶囊；presence 行自带时间。 */
function appendHistory(container, items) {
  let previous = 0;
  for (const item of items) {
    const created = timelineTimestamp(item);
    if (item.kind === 'presence') {
      container.append(presenceItem(item));
    } else {
      if (!previous || created - previous > TIME_GAP) container.append(timeDivider(created));
      container.append(messageItem(item));
    }
    if (created) previous = created;
  }
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
