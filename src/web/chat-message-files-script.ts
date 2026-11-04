/**
 * 消息正文文件卡片：识别同源 `/f/<fileId>`，HEAD 元数据、LRU 缓存与安全预览。
 *
 * 由 `chatClientScript` 拼进同一个内联 `<script>`，与聊天/文件模块共享
 * `fileSafeUrl`、`formatFileSize`、`openFilePreview` 等函数。卡片只放在
 * `.msg-content` 下、`.bubble` 外；所有文件名与正文都走 `textContent`。
 *
 * HEAD 只在卡片进入 `#messages` 视口后发起（无 IntersectionObserver 时
 * 退回队列），并发上限 4；相同 fileId 共用 in-flight Promise，命中缓存
 * 的卡片即时显示。服务端返回的 MIME 在本地重新做安全分类，不依赖
 * `filePreviewKind` 对 `text/*` 的宽松回退。
 */
export const CHAT_MESSAGE_FILES_SCRIPT = `
const MESSAGE_FILE_MAX = 8;
const MESSAGE_FILE_CACHE_MAX = 256;
const MESSAGE_FILE_CACHE_TTL_MS = 5 * 60 * 1000;
const MESSAGE_FILE_FAILURE_TTL_MS = 60 * 1000;
const MESSAGE_FILE_CONCURRENCY = 4;
const MESSAGE_FILE_TRAILING = '.,;:!?()[]{}<>"\\'' +
  '。，、；：！？）】》」』”’…·';
// 与公开下载头共享同一份白名单：SVG/HTML/XML/JS 属于主动内容。
const MESSAGE_FILE_RASTER = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon'
]);
const MESSAGE_FILE_ACTIVE = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'image/svg',
  'application/xml',
  'text/xml',
  'application/javascript',
  'text/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/x-javascript'
]);
const MESSAGE_FILE_LINK = /\\[([^\\]\\n]{0,200})\\]\\(\\s*<?((?:https?:\\/\\/|\\/f\\/)[^)\\s>]+)>?\\s*\\)|((?:https?:\\/\\/|\\/f\\/)[^\\s<>\\"']+)/g;
const messageFileCache = new Map();
const messageFileInflight = new Map();
const messageFileQueue = [];
let messageFileActive = 0;
let messageFileObserver;

/** 轻量文件名清洗：控制字符变空格，限制长度；不解析任何标记。 */
function messageFileCleanName(value) {
  let text = String(value || '')
    .replace(/[\\u0000-\\u001f\\u007f-\\u009f]+/g, ' ')
    .trim();
  text = text.replace(/^[-*+]\\s+/, '').replace(/^\\d+[.)]\\s+/, '');
  if (text.length > 160) text = text.slice(0, 160);
  return text;
}

function messageFileHref(fileId) {
  return fileSafeUrl('/f/' + fileId);
}

function messageFileDownloadHref(fileId) {
  return fileSafeUrl('/f/' + fileId + '?download=1');
}

/** 只接受同源 /f/f_<22>；query/hash 与尾部标点在这里被丢弃。 */
function messageFileLink(raw) {
  let value = String(raw || '').trim();
  while (value.length > 0 &&
    MESSAGE_FILE_TRAILING.indexOf(value.charAt(value.length - 1)) >= 0) {
    value = value.slice(0, -1);
  }
  if (!value) return null;
  let url;
  try {
    url = new URL(value, location.origin);
  } catch (error) {
    return null;
  }
  if (url.origin !== location.origin || url.username || url.password) return null;
  const match = url.pathname.match(/^\\/f\\/(f_[A-Za-z0-9_-]{22})$/);
  if (!match) return null;
  return { fileId: match[1], href: '/f/' + match[1] };
}

/** HEAD 失败时使用 URL 前一行文件名；Markdown 标签优先。 */
function messageFileFallback(text, index, label) {
  const labelName = messageFileCleanName(label);
  if (labelName && labelName.indexOf('/f/') < 0 && !/^https?:/i.test(labelName)) {
    return labelName;
  }
  const lines = text.slice(0, index).split('\\n');
  for (let cursor = lines.length - 2; cursor >= 0; cursor -= 1) {
    const line = messageFileCleanName(lines[cursor]);
    if (!line) continue;
    if (line.indexOf('/f/') >= 0 || /^https?:/i.test(line)) return '';
    return line;
  }
  return '';
}

/** 扫描正文（含 Markdown 链接），按出现顺序去重并限制 8 个。 */
function messageFileLinks(text) {
  const value = String(text || '');
  const entries = [];
  const seen = new Set();
  MESSAGE_FILE_LINK.lastIndex = 0;
  let match;
  while ((match = MESSAGE_FILE_LINK.exec(value)) !== null) {
    if (entries.length >= MESSAGE_FILE_MAX) break;
    const link = messageFileLink(match[2] || match[3] || '');
    if (!link || seen.has(link.fileId)) continue;
    seen.add(link.fileId);
    entries.push({
      fileId: link.fileId,
      href: link.href,
      fallback: messageFileFallback(value, match.index, match[1] || '')
    });
  }
  return entries;
}

/** RFC 5987 filename* 优先，普通 filename 兜底。 */
function messageFileDispositionName(header) {
  const value = String(header || '');
  if (!value) return '';
  const star = /filename\\*\\s*=\\s*([^']*)'[^']*'([^;]+)/i.exec(value);
  if (star) {
    let encoded = star[2].trim();
    if (encoded.charAt(0) === '"' && encoded.charAt(encoded.length - 1) === '"') {
      encoded = encoded.slice(1, -1);
    }
    const charset = star[1].trim().toLowerCase();
    if (!charset || charset === 'utf-8') {
      try {
        return decodeURIComponent(encoded);
      } catch (error) {
        return encoded;
      }
    }
  }
  const plain = /filename\\s*=\\s*("([^"]*)"|([^;]+))/i.exec(value);
  if (!plain) return '';
  return plain[2] !== undefined ? plain[2] : plain[3].trim();
}

function messageFileMime(value) {
  const essence = String(value || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(essence)
    ? essence
    : 'application/octet-stream';
}

/**
 * 安全分类：主动内容与未知类型只给下载，只有光栅图片/PDF/安全文本/
 * 音频/视频才允许复用预览弹窗。
 */
function messageFileKind(value) {
  const mime = messageFileMime(value);
  if (MESSAGE_FILE_ACTIVE.has(mime) || mime.endsWith('+xml')) return 'other';
  if (MESSAGE_FILE_RASTER.has(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.indexOf('text/') === 0) return 'text';
  if (mime === 'application/json' || mime === 'application/x-ndjson' ||
    mime.endsWith('+json')) {
    return 'text';
  }
  if (mime.indexOf('audio/') === 0) return 'audio';
  if (mime.indexOf('video/') === 0) return 'video';
  return 'other';
}

function messageFileCacheGet(fileId) {
  const entry = messageFileCache.get(fileId);
  if (!entry) return null;
  const ttl = entry.ok ? MESSAGE_FILE_CACHE_TTL_MS : MESSAGE_FILE_FAILURE_TTL_MS;
  if (Date.now() - entry.at >= ttl) {
    messageFileCache.delete(fileId);
    return null;
  }
  // Map 插入顺序即 LRU：命中后移到末尾。
  messageFileCache.delete(fileId);
  messageFileCache.set(fileId, entry);
  return entry;
}

function messageFileCacheSet(fileId, entry) {
  messageFileCache.delete(fileId);
  messageFileCache.set(fileId, entry);
  while (messageFileCache.size > MESSAGE_FILE_CACHE_MAX) {
    const oldest = messageFileCache.keys().next().value;
    if (oldest === undefined) break;
    messageFileCache.delete(oldest);
  }
}

/** 超时/Abort 与浏览器错误都归一为失败缓存，由卡片回退到正文文件名。 */
function messageFileFetchMeta(href) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, WEB_REQUEST_TIMEOUT_MS);
  return fetch(href, {
    method: 'HEAD',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    signal: controller.signal
  }).then(function (response) {
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const mime = messageFileMime(response.headers.get('content-type'));
    const length = response.headers.get('content-length');
    const size = length === null ? null : Number(length);
    return {
      name: messageFileCleanName(
        messageFileDispositionName(response.headers.get('content-disposition'))
      ),
      mime: mime,
      size: Number.isFinite(size) && size >= 0 ? size : null,
      kind: messageFileKind(mime)
    };
  }).finally(function () {
    clearTimeout(timer);
  });
}

function enqueueMessageFileTask(task) {
  if (task.priority) messageFileQueue.unshift(task);
  else messageFileQueue.push(task);
  drainMessageFileQueue();
}

function drainMessageFileQueue() {
  while (messageFileActive < MESSAGE_FILE_CONCURRENCY && messageFileQueue.length > 0) {
    const task = messageFileQueue.shift();
    if (!task) break;
    messageFileActive += 1;
    Promise.resolve().then(task.run).catch(function () {}).then(function () {
      messageFileActive -= 1;
      drainMessageFileQueue();
    });
  }
}

function requestMessageFileMeta(fileId, href, priority) {
  const cached = messageFileCacheGet(fileId);
  if (cached) {
    return cached.ok ? Promise.resolve(cached.meta) : Promise.reject(cached.error);
  }
  const existing = messageFileInflight.get(fileId);
  if (existing) return existing;
  let resolveTask;
  let rejectTask;
  const promise = new Promise(function (resolve, reject) {
    resolveTask = resolve;
    rejectTask = reject;
  });
  // 卡片可能在请求完成前被房间切换移除；提前挂一个空处理器避免 unhandled。
  promise.catch(function () {});
  messageFileInflight.set(fileId, promise);
  enqueueMessageFileTask({
    priority: Boolean(priority),
    run: function () {
      return messageFileFetchMeta(href).then(function (meta) {
        messageFileCacheSet(fileId, { ok: true, at: Date.now(), meta: meta });
        messageFileInflight.delete(fileId);
        resolveTask(meta);
      }, function (error) {
        messageFileCacheSet(fileId, { ok: false, at: Date.now(), error: error });
        messageFileInflight.delete(fileId);
        rejectTask(error);
      });
    }
  });
  return promise;
}

function messageFileIntersectionObserver() {
  if (messageFileObserver !== undefined) return messageFileObserver;
  if (!messagesElement || typeof IntersectionObserver !== 'function') {
    messageFileObserver = null;
    return null;
  }
  messageFileObserver = new IntersectionObserver(function (entries) {
    const observer = messageFileObserver;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (observer) observer.unobserve(entry.target);
      loadMessageFileCard(entry.target, true);
    }
  }, { root: messagesElement, rootMargin: '160px 0px' });
  return messageFileObserver;
}

/** 房间切换/全量重绘时断开旧卡片观察，缓存本身保留。 */
function resetMessageFileCards() {
  if (messageFileObserver) messageFileObserver.disconnect();
  messageFileObserver = undefined;
}

function unobserveMessageFileCards(container) {
  if (!container || !messageFileObserver) return;
  for (const child of Array.from(container.children)) {
    messageFileObserver.unobserve(child);
  }
}

function scheduleMessageFileCard(card) {
  const fileId = card.getAttribute('data-file-id');
  if (!fileId) return;
  const cached = messageFileCacheGet(fileId);
  if (cached) {
    if (cached.ok) applyMessageFileMeta(card, cached.meta);
    else applyMessageFileFailure(card);
    return;
  }
  const observer = messageFileIntersectionObserver();
  if (observer) {
    observer.observe(card);
    return;
  }
  loadMessageFileCard(card, false);
}

function loadMessageFileCard(card, priority) {
  const fileId = card.getAttribute('data-file-id');
  const href = fileId ? messageFileHref(fileId) : null;
  if (!fileId || !href) {
    applyMessageFileFailure(card);
    return;
  }
  requestMessageFileMeta(fileId, href, priority).then(function (meta) {
    if (card.isConnected) applyMessageFileMeta(card, meta);
  }, function () {
    if (card.isConnected) applyMessageFileFailure(card);
  });
}

function messageFileActionButton(label, className) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'msg-file-action ' + className;
  button.textContent = label;
  return button;
}

function messageFileDownloadLink(fileId, name) {
  const href = messageFileDownloadHref(fileId);
  if (!href) return null;
  const link = document.createElement('a');
  link.className = 'msg-file-action msg-file-download';
  link.href = href;
  link.rel = 'noopener noreferrer';
  link.referrerPolicy = 'no-referrer';
  link.setAttribute('download', name || '文件');
  link.textContent = '下载';
  return link;
}

function messageFileCard(entry) {
  const card = document.createElement('div');
  card.className = 'msg-file';
  card.setAttribute('data-file-id', entry.fileId);
  card.setAttribute('data-loading', '1');
  card.__messageFileFallback = entry.fallback || '文件';
  const badge = document.createElement('span');
  badge.className = 'msg-file-kind';
  badge.textContent = '文件';
  const main = document.createElement('span');
  main.className = 'msg-file-main';
  const name = document.createElement('span');
  name.className = 'msg-file-name';
  name.textContent = card.__messageFileFallback;
  name.title = card.__messageFileFallback;
  const size = document.createElement('span');
  size.className = 'msg-file-size';
  size.textContent = '正在读取…';
  main.append(name, size);
  const actions = document.createElement('span');
  actions.className = 'msg-file-actions';
  const download = messageFileDownloadLink(entry.fileId, card.__messageFileFallback);
  if (download) actions.append(download);
  card.append(badge, main, actions);
  scheduleMessageFileCard(card);
  return card;
}

function updateMessageFileActions(card, meta) {
  const actions = card.querySelector('.msg-file-actions');
  if (!actions) return;
  const existing = actions.querySelector('.msg-file-preview');
  if (meta.kind === 'other') {
    if (existing) existing.remove();
    return;
  }
  if (!existing) {
    const preview = messageFileActionButton('预览', 'msg-file-preview');
    preview.addEventListener('click', function () {
      openMessageFilePreview(card);
    });
    actions.insertBefore(preview, actions.firstChild);
  }
}

function applyMessageFileMeta(card, meta) {
  card.removeAttribute('data-loading');
  const name = meta.name || card.__messageFileFallback || '文件';
  const badge = card.querySelector('.msg-file-kind');
  if (badge) badge.textContent = fileIconLabel(meta.kind);
  const nameNode = card.querySelector('.msg-file-name');
  if (nameNode) {
    nameNode.textContent = name;
    nameNode.title = name;
  }
  const sizeNode = card.querySelector('.msg-file-size');
  if (sizeNode) {
    sizeNode.textContent = meta.size === null || meta.size === undefined
      ? ''
      : formatFileSize(meta.size);
  }
  card.__messageFileMeta = meta;
  const download = card.querySelector('.msg-file-download');
  if (download) download.setAttribute('download', name);
  updateMessageFileActions(card, meta);
}

function applyMessageFileFailure(card) {
  card.removeAttribute('data-loading');
  card.classList.add('unavailable');
  const name = card.__messageFileFallback || '文件';
  const nameNode = card.querySelector('.msg-file-name');
  if (nameNode) {
    nameNode.textContent = name;
    nameNode.title = name;
  }
  const sizeNode = card.querySelector('.msg-file-size');
  if (sizeNode) sizeNode.textContent = '';
}

function openMessageFilePreview(card) {
  const meta = card.__messageFileMeta;
  const fileId = card.getAttribute('data-file-id');
  if (!meta || !fileId) return;
  const href = messageFileHref(fileId);
  const download = messageFileDownloadHref(fileId);
  if (!href) return;
  const nameNode = card.querySelector('.msg-file-name');
  const name = (nameNode && nameNode.textContent) || card.__messageFileFallback || '文件';
  openFilePreview({
    name: name,
    mime_type: meta.mime,
    size: meta.size === null ? undefined : meta.size,
    preview_kind: meta.kind,
    preview_url: href,
    download_url: download || href,
    public_url: href
  });
}

/**
 * 扫描文本并渲染/更新 .msg-files。
 *
 * existing 存在时原地替换卡片（展开全文），否则新建容器；无链接时
 * 移除旧容器并返回 null。
 */
function mountMessageFiles(text, existing) {
  const entries = messageFileLinks(text);
  if (entries.length === 0) {
    if (existing) {
      unobserveMessageFileCards(existing);
      existing.remove();
    }
    return null;
  }
  const container = existing || document.createElement('div');
  container.className = 'msg-files';
  unobserveMessageFileCards(container);
  container.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const entry of entries) fragment.append(messageFileCard(entry));
  container.append(fragment);
  return container;
}
`;
