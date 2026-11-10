/**
 * 输入框附件入口与待发送文件 chips。
 *
 * 左侧“+”菜单的文件入口、隐藏文件选择器、粘贴图片、画板导出与聊天区拖拽
 * 共用 `enqueueDroppedFiles`（`POST /mcp-upload` → bind），上传成功后只在正文上方
 * 生成 chip，不再把公开 URL 插入 textarea。发送时由 `composerOutgoingBody`
 * 拼接正文与文件公开 URL；人类在群聊里没有显式 @/选择时，先按正文出现的
 * active 成员显示名选择目标，正文没有任何成员名才回退到已加载时间线上
 * 最新一条消息的发送者。附件发送找不到有效目标时，退回“当前群唯一精确
 * 维护员”的兜底；direct、空目标、多个成员命中与重名成员都不追加。
 * 自动 @ 只是正文显示，不写入选择器目标。
 *
 * 删除 chip 是用户显式操作，直接调用 `network_room_file_delete` 并刷新右侧文件栏；
 * 文件名与 URL 只用 textContent 写入 DOM，不输出到 console。
 */
import { LIMITS } from '../contracts/limits';

export const CHAT_UPLOAD_SCRIPT = `
const COMPOSER_MENTION_NAME = 'WeBots 维护员';
const COMPOSER_MENTION = '@' + COMPOSER_MENTION_NAME;
const COMPOSER_BODY_MAX_BYTES = ${LIMITS.messageBodyBytes};
const composerBodyEncoder = new TextEncoder();
// 与服务端 resolveGroupTextMentions 保持一致的独立 token 边界。
const COMPOSER_MENTION_PREV_BLOCKED = /[\\p{L}\\p{N}_.%+\\-]/u;
const COMPOSER_MENTION_WORD = /[\\p{L}\\p{N}_]/u;
const attachFileButton = document.getElementById('attach-file');
const attachFileInput = document.getElementById('composer-file-input');
const composerFilesElement = document.getElementById('composer-files');

let composerFileEntries = new Map();
let composerFileSeq = 0;

function composerEntriesFor(roomId) {
  let entries = composerFileEntries.get(roomId);
  if (!entries) {
    entries = [];
    composerFileEntries.set(roomId, entries);
  }
  return entries;
}

function findComposerEntry(roomId, key) {
  const entries = composerFileEntries.get(roomId) || [];
  return entries.find(function (entry) { return entry.key === key; }) || null;
}

/** 上传开始即生成 chip，显示进度并禁用删除；失败时整条移除。 */
function beginComposerUpload(roomId, file) {
  composerFileSeq += 1;
  const entry = {
    key: 'cf_' + composerFileSeq + '_' + Date.now(),
    roomId: roomId,
    name: file.name,
    size: Number(file.size) || 0,
    mime: String(file.type || ''),
    imageFailed: false,
    file_id: null,
    public_url: null,
    preview_url: null,
    download_url: null,
    status: 'uploading',
    phase: 'upload',
    percent: 0,
    removing: false
  };
  composerEntriesFor(roomId).push(entry);
  renderComposerFiles(roomId);
  return entry;
}

function updateComposerUpload(entry, percent, phase) {
  if (!entry) return;
  entry.percent = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
  if (phase) entry.phase = phase;
  if (activeRoomId === entry.roomId) renderComposerFiles(entry.roomId);
}

/** bind 返回文件身份与带票据地址后才可发送与删除；响应缺字段按失败处理。 */
function completeComposerUpload(entry, bound) {
  if (!entry) return false;
  const boundFile = bound && bound.file && typeof bound.file === 'object' ? bound.file : bound;
  const fileId = boundFile && (boundFile.file_id || boundFile.fileId);
  const publicUrl = fileSafeUrl(boundFile && boundFile.public_url);
  if (!fileId || !publicUrl) {
    abortComposerUpload(entry);
    return false;
  }
  const previewUrl = fileSafeUrl(boundFile && boundFile.preview_url) || publicUrl;
  const downloadUrl = fileSafeUrl(boundFile && boundFile.download_url) ||
    previewUrl + (previewUrl.indexOf('?') >= 0 ? '&' : '?') + 'download=1';
  entry.file_id = String(fileId);
  entry.public_url = publicUrl;
  entry.preview_url = previewUrl;
  entry.download_url = downloadUrl;
  entry.mime = String(boundFile.mime_type || boundFile.mimeType || entry.mime || '');
  entry.status = 'ready';
  entry.percent = 100;
  if (activeRoomId === entry.roomId) renderComposerFiles(entry.roomId);
  return true;
}

function abortComposerUpload(entry) {
  if (!entry) return;
  removeComposerEntry(entry);
}

function removeComposerEntry(entry) {
  const entries = composerFileEntries.get(entry.roomId);
  if (!entries) return;
  const index = entries.findIndex(function (item) { return item.key === entry.key; });
  if (index >= 0) entries.splice(index, 1);
  if (entries.length === 0) composerFileEntries.delete(entry.roomId);
  if (activeRoomId === entry.roomId) renderComposerFiles(entry.roomId);
}

function composerFileBadge(name) {
  const match = /\\.([A-Za-z0-9]{1,5})$/u.exec(String(name || ''));
  const label = match ? match[1].toUpperCase() : 'FILE';
  return label.slice(0, 4);
}

function composerFileMeta(entry) {
  if (entry.status === 'uploading') {
    return entry.phase === 'join' ? '正在加入房间…' : '上传中 ' + entry.percent + '%';
  }
  if (entry.removing) return '正在删除…';
  return formatFileSize(entry.size) || '文件';
}

function composerImageReady(entry) {
  return entry.status === 'ready' &&
    Boolean(entry.public_url) &&
    !entry.imageFailed &&
    isPreviewImage(entry.mime, entry.name);
}

/** 待发送图片点击后复用房间文件的大图预览，关闭时焦点回到缩略图。 */
function openComposerImagePreview(entry, trigger) {
  if (!entry.preview_url) return;
  const imageMime = previewImageMime(entry.mime, entry.name);
  if (!imageMime) return;
  openFilePreview({
    name: entry.name,
    mime_type: imageMime,
    size: entry.size,
    preview_kind: 'image',
    preview_url: entry.preview_url,
    download_url: entry.download_url || entry.preview_url,
    public_url: entry.public_url
  }, trigger);
}

/** 48px 缩略图；加载失败时降级回带扩展名徽标的普通文件 chip。 */
function composerFileThumb(entry) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'composer-file-thumb';
  button.title = '预览 ' + entry.name;
  button.setAttribute('aria-label', '预览图片 ' + entry.name);
  const image = document.createElement('img');
  image.src = entry.preview_url || entry.public_url;
  image.alt = entry.name;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('error', function () {
    entry.imageFailed = true;
    if (activeRoomId === entry.roomId) renderComposerFiles(entry.roomId);
  });
  button.addEventListener('click', function () {
    openComposerImagePreview(entry, button);
  });
  button.append(image);
  return button;
}

function composerFileChip(entry) {
  const chip = document.createElement('div');
  chip.className = 'composer-file';
  chip.setAttribute('role', 'listitem');
  chip.dataset.fileId = entry.file_id || '';
  if (composerImageReady(entry)) {
    chip.classList.add('composer-file-image');
    chip.append(composerFileThumb(entry));
  } else {
    const badge = document.createElement('span');
    badge.className = 'composer-file-badge';
    badge.setAttribute('aria-hidden', 'true');
    badge.textContent = composerFileBadge(entry.name);
    chip.append(badge);
  }
  const main = document.createElement('span');
  main.className = 'composer-file-main';
  const name = document.createElement('span');
  name.className = 'composer-file-name';
  name.textContent = entry.name;
  name.title = entry.name;
  const meta = document.createElement('span');
  meta.className = 'composer-file-meta';
  meta.textContent = composerFileMeta(entry);
  main.append(name, meta);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'composer-file-remove';
  remove.textContent = '×';
  remove.setAttribute('aria-label', '移除 ' + entry.name);
  remove.title = '移除 ' + entry.name;
  remove.disabled = entry.status !== 'ready' || entry.removing;
  remove.addEventListener('click', function () {
    removeComposerFile(entry.roomId, entry.key);
  });
  chip.append(main, remove);
  return chip;
}

function renderComposerFiles(roomId) {
  syncComposerSendState();
  if (!composerFilesElement) return;
  const entries = roomId && roomId === activeRoomId
    ? composerFileEntries.get(roomId) || []
    : [];
  if (entries.length === 0) {
    composerFilesElement.replaceChildren();
    composerFilesElement.hidden = true;
    return;
  }
  composerFilesElement.hidden = false;
  composerFilesElement.replaceChildren();
  for (const entry of entries) composerFilesElement.append(composerFileChip(entry));
}

/**
 * 删除未发送文件：后端墓碑生效后移除 chip 并刷新文件栏。
 * 删除失败保留 chip 与可读错误，用户可再次点击。
 */
async function removeComposerFile(roomId, key) {
  const entry = findComposerEntry(roomId, key);
  if (!entry || entry.status !== 'ready' || entry.removing) return;
  entry.removing = true;
  if (activeRoomId === roomId) renderComposerFiles(roomId);
  try {
    await ensureIdentity();
    await callTool('network_room_file_delete', {
      request_id: requestId('file_chip_delete'),
      room_id: roomId,
      file_id: entry.file_id
    });
  } catch (error) {
    entry.removing = false;
    if (activeRoomId === roomId) {
      renderComposerFiles(roomId);
      setDropStatusFor(roomId, '删除「' + entry.name + '」失败：' + errorMessage(error));
    }
    return;
  }
  removeComposerEntry(entry);
  if (filesActiveRoomId === roomId) {
    invalidateFiles(roomId);
    await refreshFiles(roomId, { force: true, preserveScroll: true, silent: true });
  }
  setDropStatusFor(roomId, '已删除「' + entry.name + '」。', { transient: true });
}

/** 发送成功只清空本次已拼入正文的文件，保留发送期间新上传/仍在传输的 chips。 */
function clearComposerFiles(roomId, sentKeys) {
  const entries = composerFileEntries.get(roomId);
  if (!entries) {
    if (activeRoomId === roomId) renderComposerFiles(roomId);
    return;
  }
  if (!sentKeys) {
    composerFileEntries.delete(roomId);
  } else {
    const keep = entries.filter(function (entry) { return !sentKeys.has(entry.key); });
    if (keep.length === 0) composerFileEntries.delete(roomId);
    else composerFileEntries.set(roomId, keep);
  }
  if (activeRoomId === roomId) renderComposerFiles(roomId);
}

/** 发送前快照已就绪文件；只有这些 key 会进入正文并在成功后清除。 */
function composerReadyKeys(roomId) {
  const keys = new Set();
  const entries = composerFileEntries.get(roomId) || [];
  for (const entry of entries) {
    if (entry.status === 'ready' && entry.public_url) keys.add(entry.key);
  }
  return keys;
}

/** 独立 @名字 token：与服务端正文解析同一边界，只用于前端去重。 */
function composerMentionTokenAt(body, at, name) {
  const start = at + 1;
  if (!body.startsWith(name, start)) return false;
  if (at > 0 && COMPOSER_MENTION_PREV_BLOCKED.test(body.charAt(at - 1))) return false;
  const after = body.charAt(start + name.length);
  if (after && COMPOSER_MENTION_WORD.test(after)) return false;
  return true;
}

function composerBodyHasMention(body, name) {
  if (!name || body.indexOf('@') < 0) return false;
  const token = '@' + name;
  let from = 0;
  while (from <= body.length - token.length) {
    const at = body.indexOf(token, from);
    if (at < 0) return false;
    if (composerMentionTokenAt(body, at, name)) return true;
    from = at + 1;
  }
  return false;
}

/** 正文或选择器已经显式提到任何 active 成员时，不再追加自动 @。 */
function composerHasExplicitMention(roomId, body) {
  if ((mentionSelections.get(roomId) || []).length > 0) return true;
  if (body.indexOf('@') < 0) return false;
  for (const member of members.values()) {
    if (composerBodyHasMention(body, member.name)) return true;
  }
  return false;
}

/**
 * 人类群聊自动 @ 上一位成员：只看已加载时间线的最新一条消息。
 *
 * presence 不是消息，继续向前找；最新消息由自己发送则没有目标。
 * 候选发送者必须是当前 active 成员，且名字在 active 成员中唯一。
 * ignoreMessageId 用于发送收尾重算：忽略刚刚提交的那条消息，避免
 * 刷新把输入框误判成“已被编辑”而无法清空。
 */
function composerPreviousMemberMention(roomId, ignoreMessageId) {
  if (!room || room.kind !== 'group' || room.room_id !== roomId) return '';
  if (!identity || identity.kind !== 'human') return '';
  for (let index = currentItems.length - 1; index >= 0; index -= 1) {
    const item = currentItems[index];
    if (!item || item.kind === 'presence') continue;
    if (ignoreMessageId && item.message_id === ignoreMessageId) continue;
    if (!item.sender_id || item.sender_id === identity.actor_id) return '';
    const member = members.get(item.sender_id);
    if (!member || !member.name) return '';
    let named = 0;
    for (const other of members.values()) {
      if (other.name === member.name) named += 1;
    }
    if (named !== 1) return '';
    return '@' + member.name;
  }
  return '';
}

/**
 * 正文中的成员显示名整词匹配：名字两侧不能紧贴 ASCII 单词字符。
 *
 * 中文正文常与名字直接相连（“发给ChatGPT 网页版”），所以不能把 \\p{L}
 * 当边界；只拦 ASCII 单词内嵌与前缀，避免把 “ChatGPT” 命中到
 * “MyChatGPT” 里，也避免把更长的名字拆成前缀匹配。
 */
const COMPOSER_NAME_ASCII_WORD = /[A-Za-z0-9_]/;

function composerNameHitAt(body, start, name) {
  const end = start + name.length;
  if (start > 0 && COMPOSER_NAME_ASCII_WORD.test(body.charAt(start - 1))) return false;
  if (end < body.length && COMPOSER_NAME_ASCII_WORD.test(body.charAt(end))) return false;
  return true;
}

/**
 * 正文优先的自动 @ 目标：人类群聊里按 active 成员显示名选择。
 *
 * null 表示正文没有命中任何成员，调用方回退到上一位发送者；空串表示命中
 * 多个不同成员或重名无法唯一解析，此时不猜、不追加；'@名字' 表示恰好命中
 * 一个其他成员。只命中发送者自己按无命中处理。
 *
 * 名字按最长优先并收集已覆盖区间，避免“WeBots 维护员”同时命中“WeBots”。
 * direct 与 Agent 发送不走这条路径。
 */
function composerBodyMemberMention(roomId, body) {
  if (!room || room.kind !== 'group' || room.room_id !== roomId) return null;
  if (!identity || identity.kind !== 'human' || !body) return null;
  const byName = new Map();
  for (const member of members.values()) {
    if (!member || !member.name) continue;
    const list = byName.get(member.name);
    if (list) list.push(member);
    else byName.set(member.name, [member]);
  }
  const hits = [];
  for (const [name, list] of byName) {
    let from = 0;
    while (from <= body.length - name.length) {
      const at = body.indexOf(name, from);
      if (at < 0) break;
      if (composerNameHitAt(body, at, name)) {
        hits.push({ start: at, end: at + name.length, members: list });
      }
      from = at + 1;
    }
  }
  if (hits.length === 0) return null;
  hits.sort(function (left, right) {
    const leftLength = left.end - left.start;
    const rightLength = right.end - right.start;
    if (leftLength !== rightLength) return rightLength - leftLength;
    return left.start - right.start;
  });
  const claimed = [];
  const targets = new Map();
  let ambiguous = false;
  for (const hit of hits) {
    let covered = false;
    for (const range of claimed) {
      if (hit.start < range.end && range.start < hit.end) {
        covered = true;
        break;
      }
    }
    if (covered) continue;
    claimed.push({ start: hit.start, end: hit.end });
    // 同名多个成员时服务端无法唯一解析，不能生成自动 @。
    if (hit.members.length > 1) ambiguous = true;
    for (const member of hit.members) {
      if (member.actor_id === identity.actor_id) continue;
      targets.set(member.actor_id, member.name);
    }
  }
  if (ambiguous || targets.size > 1) return '';
  if (targets.size === 0) return null;
  return '@' + targets.values().next().value;
}

/**
 * 附件发送的兜底自动 @：只有当前群恰好有一个 active Agent 名称精确等于
 * COMPOSER_MENTION_NAME、且不是发送者本人时才返回，否则返回空串。
 *
 * 服务端按“最长成员名前缀”解析 @；群里只有“WeBots”时，正文若追加
 * “@WeBots 维护员”会被错误匹配到“WeBots”。这里必须用精确名称与 room_id
 * 双重约束，不能做前缀/包含匹配，也不能写死 actor_id。direct 用 invoke
 * 唤醒对方，文本 @ 只会误导，因此不追加。
 */
function composerAutoMention(roomId) {
  if (!room || room.kind !== 'group' || room.room_id !== roomId) return '';
  if (!identity) return '';
  let target = null;
  for (const member of members.values()) {
    if (member.kind !== 'agent' || member.name !== COMPOSER_MENTION_NAME) continue;
    // 重名 Agent 会让服务端无法唯一解析；发送者本人也不作为目标。
    if (target) return '';
    target = member;
  }
  if (!target || target.actor_id === identity.actor_id) return '';
  return COMPOSER_MENTION;
}

/** 用户文本（trim）+ 各文件 public_url（每行一个），不含自动 @。 */
function composerBodyParts(roomId, text) {
  const trimmed = String(text || '').trim();
  const urls = [];
  const entries = composerFileEntries.get(roomId) || [];
  for (const entry of entries) {
    if (entry.status === 'ready' && entry.public_url) urls.push(entry.public_url);
  }
  const parts = [];
  if (trimmed) parts.push(trimmed);
  for (const url of urls) parts.push(url);
  return { body: parts.join('\\n'), urls: urls };
}

/**
 * 构建发送正文：用户文本（trim）+ 各文件 public_url（每行一个）
 * + 自动 @。人类群聊先按正文出现的 active 成员显示名选择唯一目标；
 * 正文没有命中任何成员时才 @ 最新一条消息的发送者。正文命中多个成员
 * 不猜、不追加。没有上一位有效成员时，附件发送退回唯一精确维护员兜底。
 * 正文或选择器已有任何成员 @ 时不再追加；追加后超过正文上限则跳过追加、
 * 原文照发。
 * pending attachments 按 room 读取，切房后不会带上另一房间的文件或自动 @；
 * 没有文本与可发送文件时返回空串，阻止空消息。
 */
function composerOutgoingBody(roomId, text, ignoreMessageId) {
  const parts = composerBodyParts(roomId, text);
  const body = parts.body;
  if (!body) return '';
  if (composerHasExplicitMention(roomId, body)) return body;
  let autoMention = composerBodyMemberMention(roomId, body);
  if (autoMention === null) {
    autoMention = composerPreviousMemberMention(roomId, ignoreMessageId);
    if (!autoMention && parts.urls.length > 0) autoMention = composerAutoMention(roomId);
  }
  if (!autoMention || composerBodyHasMention(body, autoMention.slice(1))) return body;
  const candidate = body + '\\n' + autoMention;
  if (composerBodyEncoder.encode(candidate).length > COMPOSER_BODY_MAX_BYTES) return body;
  return candidate;
}

/** 附件入口与输入保持可用；当前房间有未完成上传时统一禁发。 */
function updateAttachBusy() {
  syncComposerSendState();
  if (!attachFileButton) return;
  const busy = filesUploadRunning || filesUploadTasks.length > 0;
  attachFileButton.classList.toggle('busy', busy);
  attachFileButton.setAttribute('aria-busy', busy ? 'true' : 'false');
  attachFileButton.title = busy ? '正在上传文件…' : '添加附件';
}

/** Send readiness is derived, so refresh/upload/late sends cannot unlock each other. */
function syncComposerSendState() {
  if (!sendButton) return;
  const entries = composerFileEntries.get(activeRoomId) || [];
  const uploading = entries.some(function (entry) { return entry.status === 'uploading'; }) ||
    filesUploadTasks.some(function (task) { return task.composer && task.roomId === activeRoomId; });
  const loading = chatBodyElement && chatBodyElement.getAttribute('aria-busy') === 'true';
  sendButton.disabled = !activeRoomId || !room || room.room_id !== activeRoomId ||
    Boolean(room.read_only) || Boolean(loading) || Boolean(chatErrorElement && !chatErrorElement.hidden) ||
    composerRequests.has(activeRoomId) || composerSendingRooms.has(activeRoomId) || uploading;
  sendButton.title = uploading ? '附件上传完成后可发送' : '';
}

function composerUploadReady() {
  return Boolean(activeRoomId) && document.body.classList.contains('page-room');
}

function insertAttachFiles(fileList) {
  const files = Array.prototype.slice.call(fileList || []).filter(function (file) {
    return file && typeof file.name === 'string' && file.name.length > 0;
  });
  if (files.length === 0) return;
  if (!composerUploadReady()) {
    setDropStatus('请先打开一个会话再上传文件。');
    return;
  }
  enqueueDroppedFiles(files);
}

/** 只收集剪贴板中的 image/*；纯文本或其他类型保持浏览器默认行为。 */
function clipboardImageFiles(event) {
  const data = event.clipboardData;
  if (!data) return [];
  const files = [];
  const seen = new Set();
  function push(file) {
    if (!file || !file.name || !file.type || file.type.indexOf('image/') !== 0) return;
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
  }
  const direct = Array.prototype.slice.call(data.files || []);
  direct.forEach(push);
  if (files.length === 0) {
    const items = Array.prototype.slice.call(data.items || []);
    for (let index = 0; index < items.length; index += 1) {
      if (items[index].kind !== 'file') continue;
      push(items[index].getAsFile ? items[index].getAsFile() : null);
    }
  }
  return files;
}

if (attachFileInput) {
  attachFileInput.addEventListener('change', function () {
    const picked = Array.prototype.slice.call(attachFileInput.files || []);
    // 先复制 FileList 再清空，允许再次选择同一文件；失败后也可直接重选。
    attachFileInput.value = '';
    insertAttachFiles(picked);
  });
  updateAttachBusy();
}

if (bodyInput) {
  bodyInput.addEventListener('paste', function (event) {
    const images = clipboardImageFiles(event);
    if (images.length === 0) return;
    event.preventDefault();
    insertAttachFiles(images);
  });
}

renderComposerFiles(activeRoomId);
`;
