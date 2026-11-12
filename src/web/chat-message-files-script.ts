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
 *
 * 房间票据缓存 55 分钟；若缓存的票据 HEAD 返回 404（服务端重启导致旧密钥
 * 失效等），丢弃缓存并自动重新换取票据重试一次。自动重签按文件每次渲染
 * 至多一次，重试仍失败才显示“文件不可用”；手动“重试”可再次触发。
 */
export const CHAT_MESSAGE_FILES_SCRIPT = `
const MESSAGE_FILE_CACHE_MAX = 256;
const MESSAGE_FILE_CACHE_TTL_MS = 5 * 60 * 1000;
const MESSAGE_FILE_FAILURE_TTL_MS = 60 * 1000;
// 服务端票据 1 小时有效；客户端提前丢弃，避免长时间停留后反复使用失效地址。
const MESSAGE_FILE_TICKET_MAX_AGE_MS = 55 * 60 * 1000;
const MESSAGE_FILE_CONCURRENCY = 4;
const MESSAGE_FILE_DOWNLOAD_BUSY = '正在准备下载…';
const MESSAGE_FILE_DOWNLOAD_FAILED = '文件下载失败：文件不可用或链接已失效，请重试';
const MESSAGE_FILE_UNAVAILABLE = '文件不可用';
const MESSAGE_FILE_ESCAPED = /\\\\r\\\\n|\\\\n|\\\\r|\\\\t/g;
const MESSAGE_FILE_ABSOLUTE = /^([A-Za-z][A-Za-z0-9+.-]*):\\/\\/([^/?#]+)$/;
const MESSAGE_FILE_TOKEN_AFTER = /^[A-Za-z0-9_-]$/;
// 与 src/contracts/file-links.ts 的 PREFIX_DELIMITERS 保持一致。
const MESSAGE_FILE_DELIMITERS = "\\x22'\`()[]{}<>,;*|。，；：！？、）】》」』";
const MESSAGE_FILE_LINK = new RegExp('/f/(' + MESSAGE_FILE_ID_SOURCE + ')', 'g');
const MESSAGE_FILE_EXACT = new RegExp('^/f/(' + MESSAGE_FILE_ID_SOURCE + ')$');
const MESSAGE_FILE_MARKDOWN = /\\[([^\\]\\n]{0,200})\\]\\(\\s*<?([^)\\s>]+)>?\\s*\\)/g;
const MESSAGE_FILE_TRAILING = '.,;:!?()[]{}<>"\\'' +
  '。，、；：！？）】》」』”’…·';
// 与公开下载头共享主动内容分类：SVG/HTML/XML/JS 仍只给下载。
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
const messageFileCache = new Map();
const messageFileInflight = new Map();
const messageFileTickets = new Map();
const messageFilePendingDownloads = new Set();
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

/** 裸地址用于公开文件；私有文件点击下载前再换取带票据地址。 */
function messageFileRawDownloadHref(fileId) {
  return fileSafeUrl('/f/' + fileId + '?download=1');
}

function messageFileTicketEntry(fileId) {
  const ticket = messageFileTickets.get(fileId);
  if (!ticket) return null;
  if (Date.now() - ticket.at > MESSAGE_FILE_TICKET_MAX_AGE_MS) {
    messageFileTickets.delete(fileId);
    return null;
  }
  return ticket;
}

/**
 * 房间绑定文件的短时票据地址。
 *
 * 正文里的 \`/f/<id>\` 默认公开，裸地址可直接读；只有显式
 * \`network_file_publish { public: false }\` 撤销后，才需要用当前房间调用
 * \`network_room_file_get\` 取带 \`?t=\` 的地址。HEAD 先试裸地址，失败时
 * 再换取票据；票据按 fileId 缓存，超过客户端安全年龄后丢弃，下次渲染会
 * 向服务端重新换取。
 */
function messageFileTicketUrl(fileId) {
  const ticket = messageFileTicketEntry(fileId);
  if (!ticket || !ticket.url || ticket.url.indexOf('?') < 0) return messageFileHref(fileId);
  return ticket.url;
}

function messageFileRememberTicket(fileId, url, downloadUrl) {
  const preview = fileSafeUrl(url);
  const download = fileSafeUrl(downloadUrl);
  const signed = (preview && preview.indexOf('?') >= 0) ||
    (download && download.indexOf('?') >= 0);
  if (!signed) return;
  messageFileTickets.set(fileId, { url: preview, download: download, at: Date.now() });
}

function messageFileResolveTicket(fileId) {
  const cached = messageFileTicketUrl(fileId);
  if (cached && cached.indexOf('?') >= 0) return Promise.resolve(cached);
  if (typeof activeRoomId !== 'string' || !activeRoomId) return Promise.resolve(null);
  const roomId = activeRoomId;
  return callTool('network_room_file_get', { room_id: roomId, file_id: fileId }).then(
    function (result) {
      const file = result && result.file ? result.file : null;
      const url = file ? file.preview_url || file.public_url : null;
      if (url) messageFileRememberTicket(fileId, url, file.download_url);
      return url || null;
    }
  ).catch(function () { return null; });
}

/** 私有文件使用带票据地址；公开文件可没有票据，返回 null 时由点击流程按需换取。 */
function messageFileDownloadUrl(fileId) {
  const ticket = messageFileTicketEntry(fileId);
  if (!ticket) return null;
  if (ticket.download && ticket.download.indexOf('?') >= 0) {
    return messageFileForceDownload(ticket.download);
  }
  if (!ticket.url || ticket.url.indexOf('?') < 0) return null;
  return messageFileForceDownload(ticket.url);
}

function messageFileForceDownload(url) {
  const safe = fileSafeUrl(url);
  if (!safe) return null;
  if (safe.indexOf('download=1') >= 0) return safe;
  return fileSafeUrl(safe + (safe.indexOf('?') < 0 ? '?' : '&') + 'download=1');
}

/** 仅用于提取副本：字面量转义换行归一化，不回写消息。 */
function messageFileNormalizeEscaped(text) {
  return String(text || '').replace(MESSAGE_FILE_ESCAPED, function (match) {
    return match === '\\\\t' ? ' ' : '\\n';
  });
}

function messageFileDelimiter(char) {
  return char === undefined || /\\s/.test(char) || MESSAGE_FILE_DELIMITERS.indexOf(char) >= 0;
}

/** 与 src/contracts/file-links.ts 的 prefixOf 同构：根相对或同源绝对 URL。 */
function messageFilePrefix(text, index) {
  let start = index;
  while (start > 0 && !messageFileDelimiter(text.charAt(start - 1))) start -= 1;
  const prefix = text.slice(start, index);
  if (prefix === '') return { relative: true };
  if (!MESSAGE_FILE_ABSOLUTE.test(prefix)) return null;
  let url;
  try {
    url = new URL(prefix + '/');
  } catch (error) {
    return null;
  }
  return {
    relative: false,
    origin: url.origin,
    userinfo: Boolean(url.username || url.password)
  };
}

/** 与服务端 validSuffix 对齐：拒绝斜杠、多余 token 字符和点扩展名。 */
function messageFileValidSuffix(text, end) {
  const next = text.charAt(end);
  if (next === '/' || MESSAGE_FILE_TOKEN_AFTER.test(next)) return false;
  if (next === '.') return !MESSAGE_FILE_TOKEN_AFTER.test(text.charAt(end + 1));
  return true;
}

/** Markdown 链接目标精确匹配 /f/fileId；仅用于读取标签。 */
function messageFileTarget(raw) {
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
  const match = url.pathname.match(MESSAGE_FILE_EXACT);
  return match ? match[1] : null;
}

function messageFileLabels(text) {
  const labels = new Map();
  MESSAGE_FILE_MARKDOWN.lastIndex = 0;
  let match;
  while ((match = MESSAGE_FILE_MARKDOWN.exec(text)) !== null) {
    const fileId = messageFileTarget(match[2]);
    if (fileId && !labels.has(fileId)) labels.set(fileId, match[1]);
  }
  return labels;
}

/** HEAD 失败时的文件名：去掉成对 Markdown 标记，避免显示星号或反引号。 */
function messageFileFallbackName(value) {
  let text = messageFileCleanName(value);
  text = text.replace(/^\\*\\*([\\s\\S]+)\\*\\*$/, '$1')
    .replace(/^__([\\s\\S]+)__$/, '$1')
    .replace(/^\\x60([^\\x60]+)\\x60$/, '$1');
  return messageFileCleanName(text);
}

/** HEAD 失败时使用 URL 前一行文件名；Markdown 标签优先。 */
function messageFileFallback(text, index, label) {
  const labelName = messageFileFallbackName(label);
  if (labelName && labelName.indexOf('/f/') < 0 && !/^https?:/i.test(labelName)) {
    return labelName;
  }
  const lines = text.slice(0, index).split('\\n');
  for (let cursor = lines.length - 2; cursor >= 0; cursor -= 1) {
    const line = messageFileFallbackName(lines[cursor]);
    if (!line) continue;
    if (line.indexOf('/f/') >= 0 || /^https?:/i.test(line)) return '';
    return line;
  }
  return '';
}

/** 精确扫描同源 /f/ 文件链接，前缀/后缀校验与去重上限均与服务端一致。 */
function messageFileLinks(text) {
  const value = messageFileNormalizeEscaped(text);
  const labels = messageFileLabels(value);
  const entries = [];
  const seen = new Set();
  MESSAGE_FILE_LINK.lastIndex = 0;
  let match;
  while ((match = MESSAGE_FILE_LINK.exec(value)) !== null) {
    if (entries.length >= MESSAGE_FILE_MAX) break;
    const fileId = match[1];
    const end = match.index + match[0].length;
    if (!messageFileValidSuffix(value, end)) continue;
    const prefix = messageFilePrefix(value, match.index);
    if (!prefix) continue;
    if (!prefix.relative && (prefix.userinfo || prefix.origin !== location.origin)) continue;
    if (seen.has(fileId)) continue;
    seen.add(fileId);
    entries.push({
      fileId: fileId,
      href: '/f/' + fileId,
      fallback: messageFileFallback(value, match.index, labels.get(fileId) || '')
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
 *
 * 图片与缩略图/待发送共用 previewImageMime：image/jpg 归一为
 * image/jpeg，octet-stream 等缺失类型按文件名扩展名兜底。
 */
function messageFileKind(value, name) {
  if (previewImageMime(value, name)) return 'image';
  const mime = messageFileMime(value);
  if (MESSAGE_FILE_ACTIVE.has(mime) || mime.endsWith('+xml')) return 'other';
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
function messageFileFetchMeta(fileId, href) {
  function attempt(url) {
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, WEB_REQUEST_TIMEOUT_MS);
    return fetch(url, {
      method: 'HEAD',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal: controller.signal
    }).then(function (response) {
      if (!response.ok) {
        const httpError = new Error('HTTP ' + response.status);
        httpError.status = response.status;
        throw httpError;
      }
      const mime = messageFileMime(response.headers.get('content-type'));
      const length = response.headers.get('content-length');
      const size = length === null ? null : Number(length);
      const name = messageFileCleanName(
        messageFileDispositionName(response.headers.get('content-disposition'))
      );
      return {
        name: name,
        mime: mime,
        size: Number.isFinite(size) && size >= 0 ? size : null,
        kind: messageFileKind(mime, name)
      };
    }).finally(function () {
      clearTimeout(timer);
    });
  }
  return attempt(href).then(function (meta) {
    // 裸地址 HEAD 成功说明文件本身公开，下载失败时代码可回退到裸地址。
    meta.public = true;
    return meta;
  }).catch(function (error) {
    // 绑定到房间的文件裸 URL 不可读；用当前房间换取成员代次票据后重试。
    // 记录解析前是否已有缓存票据：只有“缓存票据失效”才自动重签。
    const cachedTicket = messageFileTicketEntry(fileId);
    return messageFileResolveTicket(fileId).then(function (ticketUrl) {
      if (!ticketUrl || ticketUrl === href) throw error;
      return attempt(ticketUrl).then(function (meta) {
        meta.public = false;
        return meta;
      }).catch(function (ticketError) {
        // 票据可能在服务端已失效（进程重启、密钥轮换、移出、重新加入）；
        // 丢弃缓存，让后续渲染重新换取绑定当前成员代次的地址。
        messageFileTickets.delete(fileId);
        // 仅缓存票据的 404 触发一次自动重签：新签票据仍失败则进入不可用，
        // 由失败缓存与手动“重试”控制后续请求，避免请求风暴。
        if (!cachedTicket || ticketError.status !== 404) throw ticketError;
        return messageFileResolveTicket(fileId).then(function (freshUrl) {
          if (!freshUrl || freshUrl === ticketUrl) throw ticketError;
          return attempt(freshUrl).then(function (meta) {
            meta.public = false;
            return meta;
          }).catch(function (retryError) {
            messageFileTickets.delete(fileId);
            throw retryError;
          });
        });
      });
    });
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
      return messageFileFetchMeta(fileId, href).then(function (meta) {
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
  const href = messageFileDownloadUrl(fileId) || messageFileRawDownloadHref(fileId);
  if (!href) return null;
  const link = document.createElement('a');
  link.className = 'msg-file-action msg-file-download';
  link.href = href;
  link.rel = 'noopener noreferrer';
  link.referrerPolicy = 'no-referrer';
  link.setAttribute('download', name || '文件');
  link.textContent = '下载';
  // 始终拦截默认跳转：公开文件可直接下载，私有文件的裸地址会 404，
  // 点击时再按需换取票据。
  link.addEventListener('click', function (event) {
    event.preventDefault();
    messageFileRequestDownload(link.closest('.msg-file'));
  });
  return link;
}

function messageFileNote(card) {
  let note = card.querySelector('.msg-file-note');
  if (note) return note;
  note = document.createElement('span');
  note.className = 'msg-file-note';
  note.hidden = true;
  const main = card.querySelector('.msg-file-main');
  if (main) main.append(note);
  else card.append(note);
  return note;
}

function setMessageFileNote(card, text) {
  if (!card) return;
  const note = messageFileNote(card);
  note.textContent = text || '';
  note.hidden = !text;
}

function messageFileCardName(card) {
  const nameNode = card ? card.querySelector('.msg-file-name') : null;
  return (nameNode && nameNode.textContent) || (card && card.__messageFileFallback) || '文件';
}

/** 程序化点击临时下载锚点：签名地址只存在于内存与本次 DOM，不写日志。 */
function messageFileTriggerDownload(url, name) {
  if (!url) return;
  const link = document.createElement('a');
  link.href = url;
  link.download = name || '文件';
  link.rel = 'noopener noreferrer';
  link.referrerPolicy = 'no-referrer';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * 卡片下载：有票据直接下载；没有票据先向服务端换取，失败给出可见提示。
 * 下载进行中重复点击不会重复发起票据请求。
 */
function messageFileRequestDownload(card) {
  if (!card || !card.isConnected) return;
  const fileId = card.getAttribute('data-file-id');
  if (!fileId) return;
  if (card.classList.contains('unavailable')) {
    showToast(MESSAGE_FILE_DOWNLOAD_FAILED);
    return;
  }
  if (card.dataset.downloadPending === '1') return;
  const cached = messageFileDownloadUrl(fileId);
  if (cached) {
    messageFileTriggerDownload(cached, messageFileCardName(card));
    return;
  }
  card.dataset.downloadPending = '1';
  const link = card.querySelector('.msg-file-download');
  if (link) link.setAttribute('aria-busy', 'true');
  setMessageFileNote(card, MESSAGE_FILE_DOWNLOAD_BUSY);
  messageFileResolveTicket(fileId).then(function (resolved) {
    const download = messageFileDownloadUrl(fileId) || messageFileForceDownload(resolved);
    if (!download) throw new Error('file ticket unavailable');
    if (link && link.isConnected) link.href = download;
    setMessageFileNote(card, '');
    messageFileTriggerDownload(download, messageFileCardName(card));
  }).catch(function () {
    if (card.__messageFilePublic) {
      // HEAD 已确认裸地址可读（公开发布文件），票据换取失败不阻断下载。
      setMessageFileNote(card, '');
      messageFileTriggerDownload(messageFileRawDownloadHref(fileId), messageFileCardName(card));
      return;
    }
    setMessageFileNote(card, MESSAGE_FILE_DOWNLOAD_FAILED);
    showToast(MESSAGE_FILE_DOWNLOAD_FAILED);
  }).finally(function () {
    card.removeAttribute('data-download-pending');
    if (link && link.isConnected) link.removeAttribute('aria-busy');
  });
}

/** 正文无对应卡片时的下载：同样先换票据，失败只提示、不跳转整页。 */
function messageFileRequestDownloadForFile(fileId, name) {
  if (!fileId || messageFilePendingDownloads.has(fileId)) return;
  const cached = messageFileDownloadUrl(fileId);
  if (cached) {
    messageFileTriggerDownload(cached, name || '文件');
    return;
  }
  messageFilePendingDownloads.add(fileId);
  showToast(MESSAGE_FILE_DOWNLOAD_BUSY);
  messageFileResolveTicket(fileId).then(function (resolved) {
    const download = messageFileDownloadUrl(fileId) || messageFileForceDownload(resolved);
    if (!download) throw new Error('file ticket unavailable');
    messageFileTriggerDownload(download, name || '文件');
    showToast('已开始下载');
  }).catch(function () {
    showToast(MESSAGE_FILE_DOWNLOAD_FAILED);
  }).finally(function () {
    messageFilePendingDownloads.delete(fileId);
  });
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
      openMessageFilePreview(card, preview);
    });
    actions.insertBefore(preview, actions.firstChild);
  }
}

/**
 * 图片卡片缩略图：只在 HEAD 确认可预览图片后加载同源 /f/ 地址。
 *
 * 图片加载失败时移除缩略图并保留原文件卡片，不出现破图图标；懒加载与
 * 异步解码避免历史图片阻塞消息渲染。点击由现有预览弹窗显示大图。
 */
function messageFileThumbnail(card, meta) {
  const existing = card.querySelector('.msg-file-thumb');
  if (existing) return existing;
  if (card.dataset.thumbFailed === '1') return null;
  const fileId = card.getAttribute('data-file-id');
  const name = meta.name || card.__messageFileFallback || '图片';
  if (!fileId || !isPreviewImage(meta.mime, name)) return null;
  const href = messageFileTicketUrl(fileId);
  if (!href) return null;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'msg-file-thumb';
  button.title = name;
  button.setAttribute('aria-label', '预览图片 ' + name);
  const image = document.createElement('img');
  image.src = href;
  image.alt = name;
  image.loading = 'lazy';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.addEventListener('load', function () {
    if (image.isConnected) scrollController.noteContentChanged();
  });
  image.addEventListener('error', function () {
    card.dataset.thumbFailed = '1';
    card.classList.remove('has-image');
    button.remove();
    scrollController.noteContentChanged();
  });
  button.addEventListener('click', function () {
    openMessageFilePreview(card, button);
  });
  button.append(image);
  card.classList.add('has-image');
  card.insertBefore(button, card.firstChild);
  scrollController.noteContentChanged();
  return button;
}

function applyMessageFileMeta(card, meta) {
  card.removeAttribute('data-loading');
  card.removeAttribute('data-download-pending');
  card.classList.remove('unavailable');
  const fileId = card.getAttribute('data-file-id');
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
  setMessageFileNote(card, '');
  const retry = card.querySelector('.msg-file-retry');
  if (retry) retry.remove();
  card.__messageFileMeta = meta;
  card.__messageFilePublic = Boolean(meta.public);
  const download = card.querySelector('.msg-file-download');
  if (download) {
    download.removeAttribute('aria-busy');
    delete download.dataset.unavailable;
    download.setAttribute('download', name);
    const downloadHref = messageFileDownloadUrl(fileId);
    if (downloadHref) download.href = downloadHref;
  }
  updateMessageFileActions(card, meta);
  messageFileThumbnail(card, meta);
  scrollController.noteContentChanged();
}

function applyMessageFileFailure(card) {
  card.removeAttribute('data-loading');
  card.removeAttribute('data-download-pending');
  card.classList.add('unavailable');
  const fileId = card.getAttribute('data-file-id');
  const thumb = card.querySelector('.msg-file-thumb');
  if (thumb) thumb.remove();
  card.classList.remove('has-image');
  const name = card.__messageFileFallback || '文件';
  const nameNode = card.querySelector('.msg-file-name');
  if (nameNode) {
    nameNode.textContent = name;
    nameNode.title = name;
  }
  const sizeNode = card.querySelector('.msg-file-size');
  if (sizeNode) sizeNode.textContent = '';
  const preview = card.querySelector('.msg-file-preview');
  if (preview) preview.remove();
  setMessageFileNote(card, MESSAGE_FILE_UNAVAILABLE);
  const download = card.querySelector('.msg-file-download');
  if (download) {
    if (fileId) download.href = messageFileRawDownloadHref(fileId) || download.href;
    download.removeAttribute('aria-busy');
    download.dataset.unavailable = '1';
  }
  const actions = card.querySelector('.msg-file-actions');
  if (actions) {
    let retry = actions.querySelector('.msg-file-retry');
    if (!retry) {
      retry = messageFileActionButton('重试', 'msg-file-retry');
      retry.addEventListener('click', function () {
        messageFileRetryCard(card);
      });
      actions.append(retry);
    }
    retry.disabled = false;
  }
  scrollController.noteContentChanged();
}

/** 重试重新解析元数据与票据；失败缓存先清除，避免命中 60 秒失败结果。 */
function messageFileRetryCard(card) {
  const fileId = card.getAttribute('data-file-id');
  if (!fileId) return;
  messageFileCache.delete(fileId);
  messageFileTickets.delete(fileId);
  delete card.dataset.thumbFailed;
  card.classList.remove('unavailable');
  card.setAttribute('data-loading', '1');
  card.removeAttribute('data-download-pending');
  const retry = card.querySelector('.msg-file-retry');
  if (retry) retry.disabled = true;
  const download = card.querySelector('.msg-file-download');
  if (download) delete download.dataset.unavailable;
  setMessageFileNote(card, '');
  loadMessageFileCard(card, true);
}

function openMessageFilePreview(card, trigger) {
  const meta = card.__messageFileMeta;
  const fileId = card.getAttribute('data-file-id');
  if (!meta || !fileId) return;
  const href = messageFileTicketUrl(fileId);
  const download = messageFileDownloadUrl(fileId);
  if (!href) return;
  const nameNode = card.querySelector('.msg-file-name');
  const name = (nameNode && nameNode.textContent) || card.__messageFileFallback || '文件';
  // 点击缩略图时按归一化图片类型打开，不把 HEAD 原始 MIME 传给预览弹窗。
  const imageMime = previewImageMime(meta.mime, name);
  openFilePreview({
    name: name,
    mime_type: imageMime || meta.mime,
    size: meta.size === null ? undefined : meta.size,
    preview_kind: imageMime ? 'image' : meta.kind,
    preview_url: href,
    download_url: download || href,
    public_url: href
  }, trigger);
}

function messageFileCardFor(message, fileId) {
  if (!message || !fileId) return null;
  const cards = message.querySelectorAll('.msg-file[data-file-id]');
  for (const card of cards) {
    if (card.getAttribute('data-file-id') === fileId) return card;
  }
  return null;
}

/** 正文同源 \`/f/<id>\` 链接：只取文件身份，忽略可能已过期或缺失的票据。 */
function messageFileBodyLink(target) {
  if (!target || !messagesElement || !messagesElement.contains(target)) return null;
  // 只处理气泡正文；卡片、任务附件和文件面板有自己的下载入口。
  const bubble = target.closest('.bubble');
  if (!bubble) return null;
  const anchor = target.closest('a[href]');
  if (!anchor || !bubble.contains(anchor)) return null;
  let url;
  try {
    url = new URL(anchor.getAttribute('href'), location.origin);
  } catch (error) {
    return null;
  }
  if (url.origin !== location.origin || url.username || url.password) return null;
  const match = url.pathname.match(MESSAGE_FILE_EXACT);
  return match ? match[1] : null;
}

/**
 * 正文文件链接不直接打开裸地址：有卡片时交给卡片（含票据换取与失败提示），
 * 没有卡片时复用同一套解析流程，避免浏览器跳到必 404 的页面。
 */
document.addEventListener('click', function (event) {
  if (event.defaultPrevented || event.button !== 0) return;
  const target = event.target instanceof Element ? event.target : null;
  const fileId = messageFileBodyLink(target);
  if (!fileId) return;
  event.preventDefault();
  const message = target.closest('.msg');
  const card = messageFileCardFor(message, fileId);
  if (card) {
    messageFileRequestDownload(card);
    return;
  }
  const anchor = target.closest('a[href]');
  const name = messageFileCleanName(anchor && anchor.textContent);
  messageFileRequestDownloadForFile(fileId, name || '文件');
});

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
