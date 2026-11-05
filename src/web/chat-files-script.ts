/**
 * 房间文件模块：面板布局、按房间缓存、列表渲染与刷新调度。
 *
 * 与聊天脚本拼进同一个内联 `<script>`，共享 `callTool`、`requestId`、
 * `ensureIdentity` 等函数。操作类逻辑在 `CHAT_FILES_ACTIONS_SCRIPT`，
 * 两个片段共同构成完整的文件模块。
 */
export const CHAT_FILES_SCRIPT = `
const FILES_PAGE_LIMIT = 30;
const FILES_OPEN_KEY = 'agent-network-files-open';
const FILES_TEXT_PREVIEW_BYTES = 262144;
const FILES_NOTICE_MS = 2400;
const FILES_PREVIEW_RANGE = 'bytes=0-' + (FILES_TEXT_PREVIEW_BYTES - 1);
const filesPaneElement = document.getElementById('files-pane');
const filesListElement = document.getElementById('files-list');
const filesToggleButton = document.getElementById('files-toggle');
const filesCloseButton = document.getElementById('files-close');
const filesBackdropElement = document.getElementById('files-backdrop');
const filesUploadButton = document.getElementById('files-upload');
const filesInputElement = document.getElementById('files-input');
const filesDropElement = document.getElementById('files-drop');
const filesProgressElement = document.getElementById('files-progress');
const filesProgressTextElement = document.getElementById('files-progress-text');
const filesProgressBar = document.getElementById('files-progress-bar');
const filesStatusElement = document.getElementById('files-status');
const filesErrorElement = document.getElementById('files-error');
const filesErrorTextElement = document.getElementById('files-error-text');
const filesRetryButton = document.getElementById('files-retry');
const filesBindRetryButton = document.getElementById('files-bind-retry');
const filesEmptyElement = document.getElementById('files-empty');
const filesMoreButton = document.getElementById('files-more');
const filePreviewElement = document.getElementById('file-preview');
const filePreviewTitle = document.getElementById('file-preview-title');
const filePreviewMeta = document.getElementById('file-preview-meta');
const filePreviewBody = document.getElementById('file-preview-body');
const filePreviewClose = document.getElementById('file-preview-close');
const filePreviewDownload = document.getElementById('file-preview-download');

let filesCache = new Map();
let filesActiveRoomId = null;
let filesEpoch = 0;
let filesAbort = null;
let filesRequestSeq = 0;
let filesRefreshTimer = null;
let filesPendingRoomId = null;
let filesStatusTimer = null;
let filesDesktopOpen = readFilesPreference();
let filesOverlayOpen = false;
let filesFocusBeforeOpen = null;
let filesPreviewFocus = null;
let filesPreviewAbort = null;
let filesUploadTasks = [];
let filesUploadRunning = false;
let filesPendingBinds = new Map();
let filesDeleteTimer = null;
let filesDeleteButton = null;
let filesDragDepth = 0;
let filesLastDesktopLayout = isFilesDesktop();

function readFilesPreference() {
  try {
    return localStorage.getItem(FILES_OPEN_KEY) !== '0';
  } catch (error) {
    return true;
  }
}

function writeFilesPreference(open) {
  try {
    localStorage.setItem(FILES_OPEN_KEY, open ? '1' : '0');
  } catch (error) {
    // 隐私模式禁用存储时只影响记忆，不影响本次开关。
  }
}

function isFilesDesktop() {
  return window.matchMedia('(min-width: 1200px)').matches;
}

function isFilesMobile() {
  return window.matchMedia('(max-width: 759px)').matches;
}

function filesVisible() {
  return Boolean(filesPaneElement && !filesPaneElement.hidden);
}

function filesEpochCurrent(roomId, epoch) {
  return filesActiveRoomId === roomId && filesEpoch === epoch;
}

function filesCacheFor(roomId) {
  let cache = filesCache.get(roomId);
  if (!cache) {
    cache = {
      items: [],
      nextCursor: null,
      hasMore: false,
      scrollTop: 0,
      loadedAt: 0,
      loaded: false
    };
    filesCache.set(roomId, cache);
  }
  return cache;
}

function pruneFilesCache() {
  const maxRooms = 20;
  while (filesCache.size > maxRooms) {
    let oldestId = null;
    let oldestAt = Infinity;
    for (const entry of filesCache.entries()) {
      if (entry[0] === filesActiveRoomId) continue;
      const at = Number(entry[1] && entry[1].loadedAt) || 0;
      if (at < oldestAt) {
        oldestAt = at;
        oldestId = entry[0];
      }
    }
    if (!oldestId) break;
    filesCache.delete(oldestId);
  }
}

function invalidateFiles(roomId) {
  if (!roomId) return;
  const cache = filesCache.get(roomId);
  if (cache) cache.loaded = false;
}

function snapshotFilesScroll(roomId) {
  if (!roomId || !filesListElement) return;
  const cache = filesCache.get(roomId);
  if (cache) cache.scrollTop = filesListElement.scrollTop;
}

function syncFilesChrome() {
  if (!filesPaneElement) return;
  const onRoom = document.body.classList.contains('page-room');
  const desktop = isFilesDesktop();
  const mobile = isFilesMobile();
  const overlayOpen = !desktop && filesOverlayOpen;
  const visible = onRoom && (desktop ? filesDesktopOpen : overlayOpen);
  filesPaneElement.hidden = !visible;
  if (filesBackdropElement) {
    filesBackdropElement.hidden = !(onRoom && !desktop && !mobile && overlayOpen);
  }
  document.body.classList.toggle('files-page-open', onRoom && mobile && overlayOpen);
  document.body.classList.toggle('files-drawer-open', onRoom && !desktop && !mobile && overlayOpen);
  if (filesToggleButton) {
    filesToggleButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
    filesToggleButton.classList.toggle('active', visible);
  }
  if (filesCloseButton) {
    const mobilePage = onRoom && isFilesMobile();
    filesCloseButton.textContent = mobilePage ? '返回' : '关闭';
    filesCloseButton.setAttribute('aria-label', mobilePage ? '返回聊天' : '关闭文件栏');
  }
  if (!onRoom) filesOverlayOpen = false;
  if (!visible) closeFilePreview(false);
}

function restoreFilesFocus() {
  const target = filesFocusBeforeOpen && filesFocusBeforeOpen.isConnected
    ? filesFocusBeforeOpen
    : filesToggleButton;
  filesFocusBeforeOpen = null;
  if (!target) return;
  requestAnimationFrame(function () {
    if (target.focus) target.focus();
  });
}

function toggleFilesPane() {
  if (!activeRoomId) return;
  if (isFilesDesktop()) {
    const willOpen = !filesDesktopOpen;
    if (willOpen) closeMonitorPane({ restoreFocus: false });
    filesDesktopOpen = willOpen;
    writeFilesPreference(filesDesktopOpen);
    syncFilesChrome();
    if (filesDesktopOpen) {
      ensureFilesLoaded(activeRoomId);
    } else {
      restoreFilesFocus();
    }
    return;
  }
  const willOpen = !filesOverlayOpen;
  if (willOpen) closeMonitorPane({ restoreFocus: false });
  filesOverlayOpen = willOpen;
  if (willOpen) {
    filesFocusBeforeOpen = document.activeElement;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }
  syncFilesChrome();
  if (willOpen) {
    ensureFilesLoaded(activeRoomId);
    if (isFilesMobile() && filesCloseButton) {
      requestAnimationFrame(function () {
        if (filesVisible()) filesCloseButton.focus();
      });
    }
  } else {
    restoreFilesFocus();
  }
}

function closeFilesPane(options) {
  const settings = options && typeof options === 'object' ? options : {};
  const restoreFocus = settings.restoreFocus !== false;
  if (!filesPaneElement || filesPaneElement.hidden) {
    if (restoreFocus) restoreFilesFocus();
    return;
  }
  if (isFilesDesktop()) {
    filesDesktopOpen = false;
    writeFilesPreference(false);
  } else {
    filesOverlayOpen = false;
  }
  syncFilesChrome();
  if (restoreFocus) restoreFilesFocus();
}

function activateFilesRoom(roomId) {
  if (!roomId) return;
  if (filesActiveRoomId === roomId) {
    syncFilesChrome();
    updateFilesBindRetry();
    if (filesVisible()) ensureFilesLoaded(roomId);
    return;
  }
  snapshotFilesScroll(filesActiveRoomId);
  filesEpoch += 1;
  if (filesAbort) filesAbort.abort();
  filesAbort = null;
  filesActiveRoomId = roomId;
  if (!isFilesDesktop()) filesOverlayOpen = false;
  closeFilePreview(false);
  clearFilesError();
  setFilesStatus('');
  if (filesProgressElement) filesProgressElement.hidden = true;
  updateFilesBindRetry();
  const pendingBind = filesPendingBinds.get(roomId);
  if (pendingBind) {
    setFilesStatus(
      '「' + pendingBind.name + '」已上传，但尚未加入房间。点击“重试加入房间”。',
      { error: true }
    );
  }
  const cache = filesCache.get(roomId);
  if (cache && (cache.items.length > 0 || cache.loaded)) {
    renderFiles(cache);
  } else {
    renderFilesSkeleton();
  }
  syncFilesChrome();
  if (filesVisible()) ensureFilesLoaded(roomId);
}

function deactivateFilesRoom() {
  snapshotFilesScroll(filesActiveRoomId);
  filesEpoch += 1;
  if (filesAbort) filesAbort.abort();
  filesAbort = null;
  filesActiveRoomId = null;
  filesOverlayOpen = false;
  closeFilePreview(false);
  clearFilesError();
  setFilesStatus('');
  if (filesProgressElement) filesProgressElement.hidden = true;
  updateFilesBindRetry();
  syncFilesChrome();
}

/**
 * 统一 stream 的 room.file 提示入口：300ms 合并，不轮询。
 * 非当前房间只标脏缓存，等下次打开再拉取。
 */
function scheduleFilesRefresh(roomId) {
  if (!roomId) return;
  if (roomId !== filesActiveRoomId || !filesVisible()) {
    invalidateFiles(roomId);
    return;
  }
  filesPendingRoomId = roomId;
  if (filesRefreshTimer) return;
  filesRefreshTimer = setTimeout(function () {
    filesRefreshTimer = null;
    const target = filesPendingRoomId;
    filesPendingRoomId = null;
    if (!target || target !== filesActiveRoomId || !filesVisible()) {
      if (target) invalidateFiles(target);
      return;
    }
    refreshFiles(target, { force: true, preserveScroll: true, silent: true });
  }, WEB_REFRESH_DEBOUNCE_MS);
}

function ensureFilesLoaded(roomId) {
  if (!roomId || !filesVisible() || filesActiveRoomId !== roomId) return;
  const cache = filesCache.get(roomId);
  if (cache && cache.loaded) {
    renderFiles(cache);
    return;
  }
  if (!cache || cache.items.length === 0) {
    renderFilesSkeleton();
  } else {
    renderFiles(cache);
  }
  refreshFiles(roomId, { force: true, preserveScroll: true, silent: true });
}

function refreshFiles(roomId, options) {
  const settings = options || {};
  const epoch = filesEpoch;
  const cache = filesCacheFor(roomId);
  if (settings.preserveScroll !== false) snapshotFilesScroll(roomId);
  clearFilesError();
  if (cache.items.length === 0) {
    renderFilesSkeleton();
    if (!settings.silent) setFilesStatus('正在读取文件…');
  } else if (filesActiveRoomId === roomId) {
    renderFiles(cache);
  }
  return loadFilesPage(roomId, epoch, { reset: true }).catch(function (error) {
    if (isAbortError(error) || !filesEpochCurrent(roomId, epoch)) return false;
    if (filesActiveRoomId === roomId) {
      if (cache.items.length === 0 && filesListElement) {
        filesListElement.replaceChildren();
        if (filesEmptyElement) filesEmptyElement.hidden = true;
      }
      showFilesError('读取文件失败：' + errorMessage(error));
    }
    return false;
  });
}

async function loadFilesPage(roomId, epoch, options) {
  const settings = options || {};
  if (filesAbort) filesAbort.abort();
  const controller = new AbortController();
  filesAbort = controller;
  const requestSeq = ++filesRequestSeq;
  const cache = filesCacheFor(roomId);
  const args = { room_id: roomId, limit: FILES_PAGE_LIMIT };
  if (settings.cursor) args.cursor = settings.cursor;
  try {
    await ensureIdentity();
    if (!filesEpochCurrent(roomId, epoch) || requestSeq !== filesRequestSeq) return false;
    const result = await callTool('network_room_file_list', args, undefined, controller.signal);
    if (!filesEpochCurrent(roomId, epoch) || requestSeq !== filesRequestSeq) return false;
    const payload = result || {};
    const pageItems = Array.isArray(payload.items) ? payload.items : [];
    if (settings.reset) cache.items = [];
    const seen = new Set();
    for (const existing of cache.items) seen.add(fileKey(existing));
    for (const item of pageItems) {
      if (!item || typeof item !== 'object') continue;
      const key = fileKey(item);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      cache.items.push(item);
    }
    const nextCursor = typeof payload.next_cursor === 'string' && payload.next_cursor
      ? payload.next_cursor
      : null;
    cache.nextCursor = nextCursor;
    cache.hasMore = Boolean(payload.has_more) && Boolean(nextCursor);
    cache.loaded = true;
    cache.loadedAt = Date.now();
    pruneFilesCache();
    if (filesActiveRoomId === roomId) {
      clearFilesError();
      setFilesStatus('');
      renderFiles(cache);
    }
    return true;
  } finally {
    if (filesAbort === controller) filesAbort = null;
  }
}

async function loadMoreFiles() {
  const roomId = filesActiveRoomId;
  if (!roomId) return;
  const cache = filesCacheFor(roomId);
  if (!cache.hasMore || !cache.nextCursor) return;
  if (filesMoreButton) {
    filesMoreButton.disabled = true;
    filesMoreButton.textContent = '加载中…';
  }
  try {
    await loadFilesPage(roomId, filesEpoch, { cursor: cache.nextCursor, reset: false });
  } catch (error) {
    if (filesActiveRoomId === roomId) {
      setFilesStatus('加载更多失败：' + errorMessage(error), { error: true });
    }
  } finally {
    if (filesMoreButton) {
      filesMoreButton.disabled = false;
      filesMoreButton.textContent = '加载更多';
    }
  }
}

function renderFiles(cache) {
  if (!filesListElement) return;
  const fragment = document.createDocumentFragment();
  for (const item of cache.items) fragment.append(renderFileItem(item));
  filesListElement.replaceChildren(fragment);
  if (filesEmptyElement) filesEmptyElement.hidden = !(cache.loaded && cache.items.length === 0);
  if (filesMoreButton) filesMoreButton.hidden = !cache.hasMore;
  const roomId = filesActiveRoomId;
  const top = Number(cache.scrollTop) || 0;
  requestAnimationFrame(function () {
    if (filesActiveRoomId === roomId && filesListElement) filesListElement.scrollTop = top;
  });
}

function renderFilesSkeleton() {
  if (!filesListElement) return;
  filesListElement.replaceChildren();
  for (let index = 0; index < 3; index += 1) {
    const item = document.createElement('li');
    item.className = 'file-skeleton';
    item.setAttribute('aria-hidden', 'true');
    const avatar = document.createElement('span');
    avatar.className = 'skeleton-avatar';
    const lines = document.createElement('span');
    lines.className = 'file-skeleton-lines';
    const first = document.createElement('span');
    const second = document.createElement('span');
    lines.append(first, second);
    item.append(avatar, lines);
    filesListElement.append(item);
  }
  if (filesEmptyElement) filesEmptyElement.hidden = true;
  if (filesMoreButton) filesMoreButton.hidden = true;
}

function renderFileItem(item) {
  const element = document.createElement('li');
  element.className = 'file-item';
  element.dataset.fileId = String(item.file_id || '');
  const row = document.createElement('div');
  row.className = 'file-row';
  const kind = filePreviewKind(item);
  const thumb = document.createElement('span');
  thumb.className = 'file-thumb';
  const thumbUrl = kind === 'image' && isRasterImage(item)
    ? fileSafeUrl(item.preview_url || item.download_url || item.public_url)
    : null;
  if (thumbUrl) {
    const image = document.createElement('img');
    image.src = thumbUrl;
    image.alt = '';
    image.loading = 'lazy';
    image.referrerPolicy = 'no-referrer';
    thumb.append(image);
  } else {
    thumb.textContent = fileIconLabel(kind);
  }
  const main = document.createElement('div');
  main.className = 'file-main';
  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = item.name || '未命名文件';
  name.title = item.name || '未命名文件';
  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = fileMetaText(item);
  main.append(name, meta);
  row.append(thumb, main);
  const actions = document.createElement('div');
  actions.className = 'file-actions';
  actions.append(fileActionButton('预览', '', function () { openFilePreview(item); }));
  if (fileCopyUrl(item)) {
    actions.append(fileActionButton('复制链接', '', function () { copyFileLink(item); }));
  }
  const downloadUrl = fileDownloadUrl(item);
  if (downloadUrl) {
    const link = document.createElement('a');
    link.className = 'file-action';
    link.href = downloadUrl;
    link.download = item.name || '文件';
    link.rel = 'noopener';
    link.referrerPolicy = 'no-referrer';
    link.textContent = '下载';
    actions.append(link);
  }
  if (item.can_delete === true) {
    const button = fileActionButton('删除', 'danger', function () {
      requestDeleteFile(button, item);
    });
    actions.append(button);
  }
  element.append(row, actions);
  return element;
}

function fileActionButton(label, extraClass, handler) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-action' + (extraClass ? ' ' + extraClass : '');
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}
`;
