/**
 * 输入框附件入口与待发送文件 chips。
 *
 * 左侧“+”菜单的文件入口、隐藏文件选择器、粘贴图片、画板导出与聊天区拖拽
 * 共用 `enqueueDroppedFiles`（`POST /mcp-upload` → bind），上传成功后只在正文上方
 * 生成 chip，不再把公开 URL 插入 textarea。发送时由 `composerOutgoingBody`
 * 按当前房间拼接正文与文件公开 URL；附件发送时，只有当前群恰好有一个名称
 * 精确等于 `WeBots 维护员` 且不是发送者本人的 active Agent 成员才追加自动 @，
 * direct 与没有该成员的群都不追加。自动 @ 只是正文显示，不写入选择器目标。
 *
 * 删除 chip 是用户显式操作，直接调用 `network_room_file_delete` 并刷新右侧文件栏；
 * 文件名与 URL 只用 textContent 写入 DOM，不输出到 console。
 */
export const CHAT_UPLOAD_SCRIPT = `
const COMPOSER_MENTION_NAME = 'WeBots 维护员';
const COMPOSER_MENTION = '@' + COMPOSER_MENTION_NAME;
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

/**
 * 附件发送的自动 @：只有当前群恰好有一个 active Agent 名称精确等于
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

/**
 * 构建发送正文：用户文本（trim）+ 各文件 public_url（每行一个）
 * + 当前群存在唯一精确名称维护员时末尾自动 @。用户文本已包含该字符串时不重复。
 * pending attachments 按 room 读取，切房后不会带上另一房间的文件或自动 @；
 * 没有文本与可发送文件时返回空串，阻止空消息。
 */
function composerOutgoingBody(roomId, text) {
  const trimmed = String(text || '').trim();
  const urls = [];
  const entries = composerFileEntries.get(roomId) || [];
  for (const entry of entries) {
    if (entry.status === 'ready' && entry.public_url) urls.push(entry.public_url);
  }
  if (!trimmed && urls.length === 0) return '';
  const parts = [];
  if (trimmed) parts.push(trimmed);
  for (const url of urls) parts.push(url);
  let body = parts.join('\\n');
  const autoMention = urls.length > 0 ? composerAutoMention(roomId) : '';
  if (autoMention && body.indexOf(autoMention) < 0) {
    body += (body ? '\\n' : '') + autoMention;
  }
  return body;
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
    composerRequests.has(activeRoomId) || uploading;
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
