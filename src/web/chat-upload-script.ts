/**
 * 输入框附件入口与待发送文件 chips。
 *
 * 左侧“+”、隐藏文件选择器、粘贴图片与聊天区拖拽共用
 * `enqueueDroppedFiles`（`POST /mcp-upload` → bind），上传成功后只在正文上方
 * 生成 chip，不再把公开 URL 插入 textarea。发送时由 `composerOutgoingBody`
 * 统一拼接正文、文件公开 URL 与固定的 `@WeBots 维护员`。
 *
 * 删除 chip 是用户显式操作，直接调用 `network_room_file_delete` 并刷新右侧文件栏；
 * 文件名与 URL 只用 textContent 写入 DOM，不输出到 console。
 */
export const CHAT_UPLOAD_SCRIPT = `
const COMPOSER_MENTION = '@WeBots 维护员';
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
    file_id: null,
    public_url: null,
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

/** bind 返回公开 URL 后才可发送与删除；响应缺字段按失败处理。 */
function completeComposerUpload(entry, bound) {
  if (!entry) return false;
  const boundFile = bound && bound.file && typeof bound.file === 'object' ? bound.file : bound;
  const fileId = boundFile && (boundFile.file_id || boundFile.fileId);
  const publicUrl = fileSafeUrl(boundFile && boundFile.public_url);
  if (!fileId || !publicUrl) {
    abortComposerUpload(entry);
    return false;
  }
  entry.file_id = String(fileId);
  entry.public_url = publicUrl;
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

function composerFileChip(entry) {
  const chip = document.createElement('div');
  chip.className = 'composer-file';
  chip.setAttribute('role', 'listitem');
  chip.dataset.fileId = entry.file_id || '';
  const badge = document.createElement('span');
  badge.className = 'composer-file-badge';
  badge.setAttribute('aria-hidden', 'true');
  badge.textContent = composerFileBadge(entry.name);
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
  chip.append(badge, main, remove);
  return chip;
}

function renderComposerFiles(roomId) {
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

/** 发送成功后只清空本地 chips，不删除已进入房间文件列表的文件。 */
function clearComposerFiles(roomId) {
  composerFileEntries.delete(roomId);
  if (activeRoomId === roomId) renderComposerFiles(roomId);
}

/**
 * 构建发送正文：用户文本（trim）+ 各文件 public_url（每行一个）
 * + 末尾固定 @WeBots 维护员。用户文本已包含该字符串时不重复。
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
  if (body.indexOf(COMPOSER_MENTION) < 0) {
    body += (body ? '\\n' : '') + COMPOSER_MENTION;
  }
  return body;
}

/** 上传队列忙碌时只做视觉提示，不禁用按钮或输入框；输入仍可继续排队。 */
function updateAttachBusy() {
  if (!attachFileButton) return;
  const busy = filesUploadRunning || filesUploadTasks.length > 0;
  attachFileButton.classList.toggle('busy', busy);
  attachFileButton.setAttribute('aria-busy', busy ? 'true' : 'false');
  attachFileButton.title = busy ? '正在上传文件…' : '上传文件';
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

if (attachFileButton && attachFileInput) {
  attachFileButton.addEventListener('click', function () {
    if (!composerUploadReady()) {
      setDropStatus('请先打开一个会话再上传文件。');
      return;
    }
    attachFileInput.click();
  });
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
