/**
 * 房间文件操作：预览、复制链接、删除、上传 + bind、错误提示与事件绑定。
 *
 * 与 `CHAT_FILES_SCRIPT` 拼进同一个内联 `<script>`，共享作用域。
 */
export const CHAT_FILES_ACTIONS_SCRIPT = `
function requestDeleteFile(button, item) {
  const roomId = item.room_id || filesActiveRoomId;
  if (!roomId || !item.file_id) return;
  if (button.dataset.confirm !== '1') {
    resetDeleteConfirmation();
    button.dataset.confirm = '1';
    button.textContent = '确认删除';
    filesDeleteButton = button;
    filesDeleteTimer = setTimeout(resetDeleteConfirmation, 4000);
    setFilesStatus('再次点击“确认删除”以移除「' + (item.name || '文件') + '」。');
    return;
  }
  resetDeleteConfirmation();
  deleteFile(button, roomId, item);
}

function resetDeleteConfirmation() {
  if (filesDeleteTimer) {
    clearTimeout(filesDeleteTimer);
    filesDeleteTimer = null;
  }
  if (filesDeleteButton && filesDeleteButton.isConnected) {
    filesDeleteButton.dataset.confirm = '';
    filesDeleteButton.textContent = '删除';
  }
  filesDeleteButton = null;
}

async function deleteFile(button, roomId, item) {
  button.disabled = true;
  button.textContent = '删除中…';
  try {
    await ensureIdentity();
    await callTool('network_room_file_delete', {
      request_id: requestId('file_del'),
      room_id: roomId,
      file_id: item.file_id
    });
    const cache = filesCacheFor(roomId);
    const key = fileKey(item);
    cache.items = cache.items.filter(function (entry) { return fileKey(entry) !== key; });
    cache.loaded = false;
    if (filesActiveRoomId === roomId) {
      renderFiles(cache);
      await refreshFiles(roomId, { force: true, preserveScroll: true, silent: true });
      setFilesStatus('已删除「' + (item.name || '文件') + '」。', { transient: true });
    }
  } catch (error) {
    if (filesActiveRoomId === roomId) {
      setFilesStatus('删除失败：' + errorMessage(error), { error: true });
    }
  } finally {
    if (button && button.isConnected) {
      button.disabled = false;
      button.textContent = '删除';
    }
  }
}

function openFilePreview(item) {
  if (!filePreviewElement || !filePreviewBody) return;
  closeFilePreview(false);
  filesPreviewFocus = document.activeElement;
  const kind = filePreviewKind(item);
  if (filePreviewTitle) filePreviewTitle.textContent = item.name || '文件预览';
  if (filePreviewMeta) filePreviewMeta.textContent = fileMetaText(item);
  updatePreviewDownload(item);
  filePreviewElement.hidden = false;
  renderFilePreviewBody(item, kind);
  if (filePreviewClose) filePreviewClose.focus();
}

function closeFilePreview(restoreFocus) {
  if (!filePreviewElement || filePreviewElement.hidden) return;
  filePreviewElement.hidden = true;
  if (filesPreviewAbort) {
    filesPreviewAbort.abort();
    filesPreviewAbort = null;
  }
  if (filePreviewBody) filePreviewBody.replaceChildren();
  if (filePreviewTitle) filePreviewTitle.textContent = '文件预览';
  if (filePreviewMeta) filePreviewMeta.textContent = '';
  if (filePreviewDownload) {
    filePreviewDownload.hidden = true;
    filePreviewDownload.removeAttribute('href');
    filePreviewDownload.removeAttribute('download');
  }
  const focus = filesPreviewFocus;
  filesPreviewFocus = null;
  if (restoreFocus && focus && focus.isConnected && focus.focus) {
    requestAnimationFrame(function () { focus.focus(); });
  }
}

function updatePreviewDownload(item) {
  if (!filePreviewDownload) return;
  const url = fileDownloadUrl(item);
  if (!url) {
    filePreviewDownload.hidden = true;
    filePreviewDownload.removeAttribute('href');
    return;
  }
  filePreviewDownload.hidden = false;
  filePreviewDownload.href = url;
  filePreviewDownload.download = item.name || '文件';
  filePreviewDownload.referrerPolicy = 'no-referrer';
}

function renderFilePreviewBody(item, kind) {
  if (!filePreviewBody) return;
  filePreviewBody.replaceChildren();
  const previewUrl = fileSafeUrl(item.preview_url || item.download_url || item.public_url);
  if (kind === 'image') {
    if (!previewUrl) {
      appendPreviewNote('预览链接无效，请下载后查看。');
      return;
    }
    if (!isRasterImage(item)) {
      appendPreviewNote('该图片类型不支持内联预览，请下载后查看。');
      return;
    }
    const image = document.createElement('img');
    image.src = previewUrl;
    image.alt = item.name || '图片预览';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', function () {
      if (!image.isConnected || !filePreviewBody) return;
      filePreviewBody.replaceChildren();
      appendPreviewNote('图片加载失败，请下载后查看。');
    });
    filePreviewBody.append(image);
    return;
  }
  if (kind === 'pdf') {
    if (!previewUrl) {
      appendPreviewNote('预览链接无效，请下载后查看。');
      return;
    }
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', '');
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.title = item.name || 'PDF 预览';
    frame.src = previewUrl;
    filePreviewBody.append(frame);
    return;
  }
  if (kind === 'text') {
    if (!previewUrl) {
      appendPreviewNote('预览链接无效，请下载后查看。');
      return;
    }
    const pre = document.createElement('pre');
    pre.textContent = '正在读取文本…';
    filePreviewBody.append(pre);
    loadTextPreview(previewUrl, pre);
    return;
  }
  if (kind === 'audio' || kind === 'video') {
    if (!previewUrl) {
      appendPreviewNote('预览链接无效，请下载后查看。');
      return;
    }
    const media = document.createElement(kind);
    media.controls = true;
    media.preload = 'metadata';
    if (kind === 'video') media.playsInline = true;
    media.src = previewUrl;
    filePreviewBody.append(media);
    return;
  }
  appendPreviewNote('该文件类型不支持在线预览，请下载后查看。');
}

function appendPreviewNote(text) {
  if (!filePreviewBody) return;
  const note = document.createElement('p');
  note.className = 'file-preview-note';
  note.textContent = text;
  filePreviewBody.append(note);
}

async function loadTextPreview(url, pre) {
  if (filesPreviewAbort) filesPreviewAbort.abort();
  const controller = new AbortController();
  filesPreviewAbort = controller;
  try {
    const response = await fetch(url, {
      headers: { Range: FILES_PREVIEW_RANGE },
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = await response.text();
    if (!pre.isConnected) return;
    pre.textContent = text.length > 0
      ? text.slice(0, FILES_TEXT_PREVIEW_BYTES)
      : '（空文件）';
  } catch (error) {
    if (isAbortError(error) || !pre.isConnected) return;
    pre.textContent = '读取文本预览失败：' + errorMessage(error);
  } finally {
    if (filesPreviewAbort === controller) filesPreviewAbort = null;
  }
}

function filePreviewKind(item) {
  const kind = String(item.preview_kind || '').toLowerCase();
  const mime = String(item.mime_type || '').toLowerCase();
  if (kind === 'pdf' && mime.indexOf('application/pdf') !== 0) return 'other';
  if (kind === 'image' || kind === 'pdf' || kind === 'text' || kind === 'audio' || kind === 'video') {
    return kind;
  }
  if (kind === 'other' || kind === 'unknown' || kind === 'file' || kind === 'download') {
    return 'other';
  }
  if (mime.indexOf('image/') === 0) return mime.indexOf('svg') >= 0 ? 'other' : 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.indexOf('audio/') === 0) return 'audio';
  if (mime.indexOf('video/') === 0) return 'video';
  if (mime.indexOf('text/') === 0 || mime === 'application/json' || mime === 'application/xml') {
    return 'text';
  }
  return 'other';
}

function isRasterImage(item) {
  const mime = String(item.mime_type || '').toLowerCase();
  if (mime.indexOf('svg') >= 0 || mime.indexOf('html') >= 0) return false;
  // 未知类型不内联：宁可下载，也不把 HTML/SVG 交给图片解码器。
  if (mime.indexOf('image/') !== 0) return false;
  return true;
}

function fileIconLabel(kind) {
  if (kind === 'image') return '图片';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'text') return 'TXT';
  if (kind === 'audio') return '音频';
  if (kind === 'video') return '视频';
  return '文件';
}

function fileKey(item) {
  return String(item.room_file_id || item.file_id || '');
}

function fileSafeUrl(value) {
  if (!value || typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value, location.origin);
  } catch (error) {
    return null;
  }
  if (url.origin !== location.origin) return null;
  if (url.username || url.password) return null;
  if (url.pathname.indexOf('/f/') !== 0) return null;
  return url.href;
}

function fileDownloadUrl(item) {
  return fileSafeUrl(item.download_url || item.public_url);
}

function fileCopyUrl(item) {
  return fileSafeUrl(item.download_url || item.public_url || item.preview_url);
}

function fileMetaText(item) {
  const parts = [];
  const size = formatFileSize(item.size);
  if (size) parts.push(size);
  parts.push(item.uploader_name || '未知上传者');
  const time = fileTimeLabel(item.created_at);
  if (time) parts.push(time);
  return parts.join(' · ');
}

function formatFileSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return '';
  if (size < 1024) return Math.round(size) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = size / 1024;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  return (amount >= 10 ? Math.round(amount) : Math.round(amount * 10) / 10) + ' ' + units[index];
}

function fileTimeLabel(value) {
  let ms = 0;
  if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string') {
    if (/^[0-9]+$/.test(value)) {
      ms = Number(value);
    } else {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) ms = parsed;
    }
  }
  return ms > 0 ? relativeTime(ms) : '';
}

async function copyFileLink(item) {
  const url = fileCopyUrl(item);
  if (!url) {
    setFilesStatus('无法复制：文件链接不是本站 /f/ 地址。', { error: true });
    return;
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(url);
      } catch (error) {
        legacyCopyText(url);
      }
    } else {
      legacyCopyText(url);
    }
    setFilesStatus('链接已复制。链接即下载权限，请勿转发给不信任的人。', { transient: true });
  } catch (error) {
    setFilesStatus('复制失败：' + errorMessage(error), { error: true });
  }
}

function setFilesStatus(text, options) {
  if (!filesStatusElement) return;
  const settings = options || {};
  if (filesStatusTimer) {
    clearTimeout(filesStatusTimer);
    filesStatusTimer = null;
  }
  filesStatusElement.textContent = text || '';
  filesStatusElement.classList.toggle('error', Boolean(settings.error));
  filesStatusElement.hidden = !text;
  if (text && settings.transient) {
    const expected = text;
    filesStatusTimer = setTimeout(function () {
      if (filesStatusElement && filesStatusElement.textContent === expected) {
        filesStatusElement.textContent = '';
        filesStatusElement.hidden = true;
        filesStatusElement.classList.remove('error');
      }
      filesStatusTimer = null;
    }, FILES_NOTICE_MS);
  }
}

function showFilesError(message) {
  if (filesErrorTextElement) filesErrorTextElement.textContent = message;
  if (filesErrorElement) filesErrorElement.hidden = false;
  if (filesRetryButton) filesRetryButton.hidden = false;
}

function clearFilesError() {
  if (filesErrorElement) filesErrorElement.hidden = true;
  if (filesErrorTextElement) filesErrorTextElement.textContent = '';
  if (filesRetryButton) filesRetryButton.hidden = false;
}

function errorMessage(error) {
  return error && error.message ? String(error.message) : String(error);
}

function updateFilesBindRetry() {
  if (!filesBindRetryButton) return;
  const pending = filesActiveRoomId ? filesPendingBinds.get(filesActiveRoomId) : null;
  filesBindRetryButton.hidden = !pending;
  if (!pending) filesBindRetryButton.textContent = '重试加入房间';
}

function enqueueSelectedFiles(fileList) {
  if (!activeRoomId) {
    setFilesStatus('请先打开一个会话再上传文件。', { error: true });
    return;
  }
  const files = Array.prototype.slice.call(fileList || []).filter(function (file) {
    return file && typeof file.name === 'string' && file.name.length > 0;
  });
  if (files.length === 0) return;
  filesUploadTasks.push({ roomId: activeRoomId, files: files });
  updateFilesBindRetry();
  if (!filesUploadRunning) runUploadTasks();
}

async function runUploadTasks() {
  if (filesUploadRunning) return;
  filesUploadRunning = true;
  try {
    while (filesUploadTasks.length > 0) {
      const task = filesUploadTasks.shift();
      let complete = true;
      for (let index = 0; index < task.files.length; index += 1) {
        const file = task.files[index];
        const bound = await uploadAndBind(
          task.roomId,
          file,
          index + 1,
          task.files.length,
          Boolean(task.insertUrl)
        );
        if (!bound) {
          complete = false;
          break;
        }
        if (task.insertUrl) {
          // bind 返回 { file: {...} }；只接受同源 /f/ 公开地址。
          const boundFile = bound.file && typeof bound.file === 'object' ? bound.file : bound;
          const publicUrl = fileSafeUrl(boundFile.public_url);
          if (!publicUrl) {
            complete = false;
            if (activeRoomId === task.roomId) {
              setDropStatus('「' + file.name + '」已上传，但响应缺少公开链接。');
            }
            break;
          }
          if (!insertComposerFileUrl(task.roomId, publicUrl)) {
            // 用户已切到其他房间：上传与 bind 保留在原房间，不再写新房间输入框。
            complete = false;
            break;
          }
        }
      }
      if (complete && filesActiveRoomId === task.roomId) {
        if (filesProgressElement) filesProgressElement.hidden = true;
        setFilesStatus('已上传 ' + task.files.length + ' 个文件。', { transient: true });
      }
      if (complete && task.insertUrl && activeRoomId === task.roomId) {
        setDropStatus(
          '已上传 ' + task.files.length + ' 个文件，链接已插入输入框。',
          { transient: true }
        );
      }
    }
  } finally {
    filesUploadRunning = false;
  }
}

async function uploadAndBind(roomId, file, index, total, announce) {
  const startText = '正在上传（' + index + '/' + total + '）：' + file.name;
  updateFilesProgress(roomId, startText, 0);
  if (announce) setDropStatusFor(roomId, startText);
  let token = null;
  try {
    await ensureIdentity();
    token = browserToken();
    if (!token) throw new Error('浏览器身份尚未初始化，请刷新页面后重试');
  } catch (error) {
    failUpload(roomId, file, error, announce);
    return null;
  }
  let uploaded = null;
  try {
    uploaded = await uploadFileToDrive(file, token, function (percent) {
      const text = '正在上传（' + index + '/' + total + '）：' + file.name + ' · ' + percent + '%';
      updateFilesProgress(roomId, text, percent);
      if (announce) setDropStatusFor(roomId, text);
    });
  } catch (error) {
    failUpload(roomId, file, error, announce);
    return null;
  }
  const fileId = uploaded && (uploaded.fileId || uploaded.file_id);
  if (!fileId) {
    failUpload(roomId, file, new Error('上传响应缺少 file_id'), announce);
    return null;
  }
  const bindText = '正在加入房间：' + file.name;
  updateFilesProgress(roomId, bindText, 100);
  if (announce) setDropStatusFor(roomId, bindText);
  let bound = null;
  try {
    bound = await bindFileToRoom(roomId, fileId, file.name);
  } catch (error) {
    filesPendingBinds.set(roomId, { fileId: fileId, name: file.name });
    if (filesActiveRoomId === roomId) {
      if (filesProgressElement) filesProgressElement.hidden = true;
      updateFilesBindRetry();
      const message = '已上传「' + file.name + '」，但加入房间失败：' + errorMessage(error) +
        '。可点击“重试加入房间”，不会重复上传。';
      setFilesStatus(message, { error: true });
      if (announce) setDropStatusFor(roomId, message);
    }
    return null;
  }
  invalidateFiles(roomId);
  if (filesActiveRoomId === roomId) {
    await refreshFiles(roomId, { force: true, preserveScroll: true, silent: true });
  }
  return bound && typeof bound === 'object' ? bound : { name: file.name };
}

function failUpload(roomId, file, error, announce) {
  if (filesActiveRoomId !== roomId) return;
  if (filesProgressElement) filesProgressElement.hidden = true;
  const message = '上传「' + file.name + '」失败：' + errorMessage(error);
  setFilesStatus(message, { error: true });
  if (announce) setDropStatusFor(roomId, message);
}

function updateFilesProgress(roomId, text, percent) {
  if (filesActiveRoomId !== roomId) return;
  if (filesProgressElement) filesProgressElement.hidden = false;
  if (filesProgressTextElement) filesProgressTextElement.textContent = text;
  if (filesProgressBar) filesProgressBar.value = Math.max(0, Math.min(100, Number(percent) || 0));
}

function uploadFileToDrive(file, token, onProgress) {
  return new Promise(function (resolve, reject) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/mcp-upload');
    xhr.setRequestHeader('authorization', 'Bearer ' + token);
    xhr.setRequestHeader('MCPP-Files-Version', '1');
    xhr.setRequestHeader('MCPP-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('MCPP-File-Size', String(file.size));
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.addEventListener('progress', function (event) {
      if (!event.lengthComputable || !event.total) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener('load', function () {
      let payload = null;
      try {
        payload = JSON.parse(xhr.responseText || '{}');
      } catch (error) {
        payload = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload &&
          (payload.fileId || payload.file_id)) {
        resolve(payload);
        return;
      }
      reject(uploadFailure(xhr.status, payload));
    });
    xhr.addEventListener('error', function () {
      reject(new Error('网络错误，上传失败'));
    });
    xhr.addEventListener('abort', function () {
      reject(new Error('上传已取消'));
    });
    xhr.send(file);
  });
}

function uploadFailure(status, payload) {
  if (status === 401 || status === 403) {
    return new Error('身份已失效，请刷新页面后重试');
  }
  if (status === 413) return new Error('文件超过大小限制');
  const nested = payload && payload.error;
  const message = typeof nested === 'string'
    ? nested
    : nested && nested.message
      ? nested.message
      : payload && payload.message;
  if (message) return new Error(String(message));
  return new Error('上传失败（HTTP ' + status + '）');
}

async function bindFileToRoom(roomId, fileId, name) {
  await ensureIdentity();
  const bound = await callTool('network_room_file_bind', {
    request_id: requestId('file_bind'),
    room_id: roomId,
    file_id: fileId
  });
  filesPendingBinds.delete(roomId);
  updateFilesBindRetry();
  return bound;
}

async function retryPendingBind() {
  const roomId = filesActiveRoomId;
  const pending = roomId ? filesPendingBinds.get(roomId) : null;
  if (!pending) return;
  if (filesBindRetryButton) {
    filesBindRetryButton.disabled = true;
    filesBindRetryButton.textContent = '正在重试…';
  }
  setFilesStatus('正在重新加入房间…');
  try {
    await bindFileToRoom(roomId, pending.fileId, pending.name);
    invalidateFiles(roomId);
    await refreshFiles(roomId, { force: true, preserveScroll: true, silent: true });
    setFilesStatus('已将「' + pending.name + '」加入房间。', { transient: true });
  } catch (error) {
    setFilesStatus('加入房间失败：' + errorMessage(error) + '。可再次重试，不会重复上传。', {
      error: true
    });
  } finally {
    if (filesBindRetryButton) {
      filesBindRetryButton.disabled = false;
      filesBindRetryButton.textContent = '重试加入房间';
    }
    updateFilesBindRetry();
  }
}

const composerDropElement = document.getElementById('composer-drop');
let composerDropDepth = 0;
let dropStatusTimer = null;

/** 只有打开房间后才接管拖拽；首页和其他路由不显示上传层。 */
function composerDropEnabled() {
  return Boolean(activeRoomId) && document.body.classList.contains('page-room');
}

function dragHasFiles(event) {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  if (transfer.files && transfer.files.length > 0) return true;
  const types = transfer.types ? Array.prototype.slice.call(transfer.types) : [];
  return types.indexOf('Files') >= 0;
}

/** 某些合成拖拽事件只填充 items；真实文件拖入时两者都可用。 */
function dragFiles(event) {
  const transfer = event.dataTransfer;
  if (!transfer) return [];
  const files = Array.prototype.slice.call(transfer.files || []);
  if (files.length > 0) return files;
  let items = [];
  try {
    items = transfer.items ? Array.prototype.slice.call(transfer.items) : [];
  } catch (error) {
    return files;
  }
  for (let index = 0; index < items.length; index += 1) {
    if (items[index].kind !== 'file') continue;
    const file = items[index].getAsFile();
    if (file) files.push(file);
  }
  return files;
}

function setComposerDropVisible(visible) {
  if (!composerDropElement) return;
  composerDropElement.hidden = !visible;
}

function hideComposerDrop() {
  composerDropDepth = 0;
  setComposerDropVisible(false);
}

/** 拖拽上传进度写聊天状态栏；文件栏关闭时也能看到每个文件的状态。 */
function setDropStatus(text, options) {
  if (!statusElement) return;
  const settings = options || {};
  if (dropStatusTimer) {
    clearTimeout(dropStatusTimer);
    dropStatusTimer = null;
  }
  if (!text) {
    if (!stickyStatus) statusElement.textContent = '';
    return;
  }
  statusElement.textContent = text;
  if (settings.transient) {
    const expected = text;
    dropStatusTimer = setTimeout(function () {
      if (statusElement && statusElement.textContent === expected && !stickyStatus) {
        statusElement.textContent = '';
      }
      dropStatusTimer = null;
    }, FILES_NOTICE_MS);
  }
}

/** 旧房间的上传进度不得写进新房间的状态栏。 */
function setDropStatusFor(roomId, text, options) {
  if (activeRoomId !== roomId) return;
  setDropStatus(text, options);
}

function enqueueDroppedFiles(fileList) {
  if (!activeRoomId) return;
  const files = Array.prototype.slice.call(fileList || []).filter(function (file) {
    return file && typeof file.name === 'string' && file.name.length > 0;
  });
  if (files.length === 0) return;
  filesUploadTasks.push({ roomId: activeRoomId, files: files, insertUrl: true });
  updateFilesBindRetry();
  setDropStatusFor(activeRoomId, '正在上传（1/' + files.length + '）：' + files[0].name);
  if (!filesUploadRunning) runUploadTasks();
}

/**
 * 在光标处插入公开 URL，不覆盖已有文本与选区。
 * 每个文件独占一行；实际发送仍由用户决定，不自动提交。
 */
function insertComposerFileUrl(roomId, url) {
  if (!bodyInput || !url || activeRoomId !== roomId) return false;
  if (!document.body.classList.contains('page-room')) return false;
  const value = bodyInput.value;
  const start = bodyInput.selectionStart === null ? value.length : bodyInput.selectionStart;
  const prefix = start > 0 && value.charAt(start - 1) !== '\\n' ? '\\n' : '';
  const inserted = prefix + url + '\\n';
  bodyInput.setRangeText(inserted, start, start, 'end');
  drafts.set(roomId, bodyInput.value);
  resizeComposer();
  bodyInput.focus();
  return true;
}

if (chatBodyElement) {
  chatBodyElement.addEventListener('dragenter', function (event) {
    if (!composerDropEnabled() || !dragHasFiles(event)) return;
    event.preventDefault();
    composerDropDepth += 1;
    setComposerDropVisible(true);
  });
  chatBodyElement.addEventListener('dragover', function (event) {
    if (!composerDropEnabled() || !dragHasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (composerDropDepth === 0) composerDropDepth = 1;
    setComposerDropVisible(true);
  });
  chatBodyElement.addEventListener('dragleave', function (event) {
    if (!composerDropEnabled() || composerDropDepth === 0) return;
    event.preventDefault();
    composerDropDepth = Math.max(0, composerDropDepth - 1);
    if (composerDropDepth === 0) setComposerDropVisible(false);
  });
  chatBodyElement.addEventListener('drop', function (event) {
    if (!composerDropEnabled()) return;
    const dropped = dragFiles(event);
    if (dropped.length === 0) {
      if (dragHasFiles(event)) event.preventDefault();
      hideComposerDrop();
      return;
    }
    event.preventDefault();
    hideComposerDrop();
    enqueueDroppedFiles(dropped);
  });
}
window.addEventListener('dragend', hideComposerDrop);
window.addEventListener('blur', hideComposerDrop);

if (filesToggleButton) filesToggleButton.addEventListener('click', toggleFilesPane);
if (filesCloseButton) filesCloseButton.addEventListener('click', closeFilesPane);
if (filesBackdropElement) filesBackdropElement.addEventListener('click', closeFilesPane);
if (filesUploadButton) {
  filesUploadButton.addEventListener('click', function () {
    if (filesInputElement) filesInputElement.click();
  });
}
if (filesInputElement) {
  filesInputElement.addEventListener('change', function () {
    enqueueSelectedFiles(filesInputElement.files);
    filesInputElement.value = '';
  });
}
if (filesDropElement) {
  filesDropElement.addEventListener('click', function () {
    if (filesInputElement) filesInputElement.click();
  });
  filesDropElement.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (filesInputElement) filesInputElement.click();
  });
  filesDropElement.addEventListener('dragenter', function (event) {
    event.preventDefault();
    filesDragDepth += 1;
    filesDropElement.classList.add('dragover');
  });
  filesDropElement.addEventListener('dragover', function (event) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  filesDropElement.addEventListener('dragleave', function (event) {
    event.preventDefault();
    filesDragDepth = Math.max(0, filesDragDepth - 1);
    if (filesDragDepth === 0) filesDropElement.classList.remove('dragover');
  });
  filesDropElement.addEventListener('drop', function (event) {
    event.preventDefault();
    filesDragDepth = 0;
    filesDropElement.classList.remove('dragover');
    if (event.dataTransfer) enqueueSelectedFiles(event.dataTransfer.files);
  });
}
if (filesListElement) {
  filesListElement.addEventListener('scroll', function () {
    if (!filesActiveRoomId) return;
    const cache = filesCache.get(filesActiveRoomId);
    if (cache) cache.scrollTop = filesListElement.scrollTop;
  }, { passive: true });
}
if (filesMoreButton) filesMoreButton.addEventListener('click', loadMoreFiles);
if (filesRetryButton) {
  filesRetryButton.addEventListener('click', function () {
    if (filesActiveRoomId) {
      refreshFiles(filesActiveRoomId, { force: true, preserveScroll: true });
    }
  });
}
if (filesBindRetryButton) filesBindRetryButton.addEventListener('click', retryPendingBind);
if (filePreviewClose) {
  filePreviewClose.addEventListener('click', function () { closeFilePreview(true); });
}
if (filePreviewElement) {
  filePreviewElement.addEventListener('click', function (event) {
    if (event.target === filePreviewElement) closeFilePreview(true);
  });
}
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;
  if (filePreviewElement && !filePreviewElement.hidden) {
    closeFilePreview(true);
    return;
  }
  if (filesOverlayOpen && filesVisible()) closeFilesPane();
});
window.addEventListener('resize', function () {
  const desktop = isFilesDesktop();
  if (desktop === filesLastDesktopLayout) return;
  filesLastDesktopLayout = desktop;
  filesOverlayOpen = false;
  syncFilesChrome();
  if (filesVisible() && activeRoomId) ensureFilesLoaded(activeRoomId);
});
`;
