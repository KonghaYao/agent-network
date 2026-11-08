/**
 * AI 消息 Markdown 岛的 vanilla 桥接层。
 *
 * 页面外壳、文件卡片、输入框、回执仍是 vanilla；这里只负责：
 * - 懒加载带内容版本的 `/assets/chat-markdown.js`（成功/失败都只请求一次，
 *   展开时允许强制重试一次失败的加载）；
 * - 在 AI 气泡上挂载/更新/销毁 React root；
 * - 加载失败、React 挂载失败或消息已移除时保留纯文本，并显示可见提示；
 * - Markdown 升级后按接近底部/查看更早消息两种情况补偿滚动。
 *
 * 与 `chat-render-script.ts` 一起拼进同一个内联脚本，不引入模块作用域。
 */
export const CHAT_MARKDOWN_SCRIPT = `
const markdownHandles = new Map();
let markdownLoadPromise = null;
let markdownRetryUsed = false;
// 懒升级：首屏/加载更早先保留纯文本，消息进入视口附近才创建 React root。
// 只向下预取 300px：上翻加载历史时，视口上方的旧消息保持纯文本，
// 避免升级高度把阅读锚点推走；滚动进入视口时再升级。
const LAZY_MARKDOWN_ROOT_MARGIN = '0px 0px 300px 0px';
const LAZY_MARKDOWN_BATCH = 2;
let lazyMarkdownObserver = null;
let lazyMarkdownQueue = [];
let lazyMarkdownRunning = false;
let lazyMarkdownGeneration = 0;
// 视口上方（含部分露出）的消息先保持纯文本；上翻时再由 scroll 事件唤醒。
let deferredMarkdownTasks = [];
let deferredMarkdownFrame = 0;
let markdownScrollBound = false;

/** 纯文本快速路径：没有 Markdown 结构且没有需要高亮的 @ 时不挂 Streamdown。 */
function markdownNeedsRender(text) {
  if (!text) return false;
  if (text.indexOf('@') >= 0) {
    const names = mentionNames();
    for (const name of names) {
      if (text.indexOf('@' + name) >= 0) return true;
    }
  }
  // 裸 URL 由 GFM autolink 处理，仍交给 Markdown 岛。
  if (text.indexOf('://') >= 0) return true;
  // 多行正文保留现有 remark-breaks 软换行语义。
  if (text.indexOf('\\n') >= 0 || text.indexOf('\\r') >= 0) return true;
  // 反引号通过 charCode 判断，避免在模板字符串里转义。
  if (text.indexOf(String.fromCharCode(96)) >= 0) return true;
  const lines = text.split('\\n');
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    if (/^#{1,6}\\s/.test(trimmed)) return true;
    if (/^[-*+]\\s/.test(trimmed)) return true;
    if (/^\\d{1,9}[.)]\\s/.test(trimmed)) return true;
    if (trimmed.charAt(0) === '>' || trimmed.charAt(0) === '|') return true;
    if (/^(?:---|\\*\\*\\*|___)$/.test(trimmed)) return true;
  }
  return /\\*\\*[^*\\n]|__[^_\\n]|~~[^~\\n]|!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)/.test(text);
}

/** 优先使用服务端权威 sender_kind；旧缓存回退成员列表，再未知按纯文本。 */
function markdownMessageKind(item) {
  if (item && (item.sender_kind === 'human' || item.sender_kind === 'agent')) {
    return item.sender_kind;
  }
  const member = item ? members.get(item.sender_id) : null;
  if (member && (member.kind === 'human' || member.kind === 'agent')) return member.kind;
  return null;
}

function isAgentMessage(item) {
  return markdownMessageKind(item) === 'agent';
}

/** 只请求一次；forceRetry 最多重建一次失败的 Promise，避免每次展开都打 404。 */
function loadMarkdownBundle(forceRetry) {
  if (forceRetry && !markdownRetryUsed) {
    markdownRetryUsed = true;
    markdownLoadPromise = null;
  }
  if (!markdownLoadPromise) {
    markdownLoadPromise = import(MARKDOWN_ASSET_URL).then(function (module) {
      if (!module || typeof module.mountMarkdown !== 'function') return null;
      return module;
    }).catch(function () {
      // 只记录资源路径，不输出正文、token 或成员名。
      console.warn('markdown bundle unavailable: ' + MARKDOWN_ASSET_URL);
      return null;
    });
  }
  return markdownLoadPromise;
}

/** bundle/挂载失败时给气泡可见提示，不再静默回退为纯文本。 */
function markBubbleMarkdownUnavailable(bubble) {
  if (!bubble) return;
  bubble.dataset.markdownUnavailable = '1';
  if (bubble.querySelector('.md-unavailable')) return;
  const note = document.createElement('div');
  note.className = 'md-unavailable';
  note.textContent = 'Markdown 渲染不可用，已显示纯文本';
  bubble.append(note);
}

function clearBubbleMarkdownFailure(bubble) {
  if (!bubble) return;
  delete bubble.dataset.markdownUnavailable;
  const notes = bubble.querySelectorAll('.md-unavailable');
  for (const note of notes) note.remove();
}

function destroyBubbleMarkdown(bubble) {
  const lazyElement = bubble.__markdownLazyElement;
  if (lazyElement) {
    lazyElement.__markdownLazyTask = null;
    if (lazyMarkdownObserver) lazyMarkdownObserver.unobserve(lazyElement);
  }
  bubble.__markdownLazyElement = null;
  const handle = markdownHandles.get(bubble);
  if (!handle) return;
  markdownHandles.delete(bubble);
  try {
    handle.destroy();
  } catch (error) {
    // 气泡可能已随消息区一起移除。
  }
}

/** 房间切换/清空消息区前统一 unmount，避免 React root 与观察队列泄漏。 */
function resetMarkdownHandles() {
  for (const handle of markdownHandles.values()) {
    try {
      handle.destroy();
    } catch (error) {
      // 已卸载的 root 不应影响后续渲染。
    }
  }
  markdownHandles.clear();
  resetLazyMarkdown();
}

function resetLazyMarkdown() {
  lazyMarkdownGeneration += 1;
  if (lazyMarkdownObserver) {
    lazyMarkdownObserver.disconnect();
    lazyMarkdownObserver = null;
  }
  lazyMarkdownQueue = [];
  deferredMarkdownTasks = [];
  if (deferredMarkdownFrame) {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(deferredMarkdownFrame);
    else clearTimeout(deferredMarkdownFrame);
    deferredMarkdownFrame = 0;
  }
  lazyMarkdownRunning = false;
}

/** 上翻或布局变化后重试视口上方的待升级消息。 */
function scheduleDeferredMarkdown() {
  if (deferredMarkdownFrame || deferredMarkdownTasks.length === 0 || !messagesElement) return;
  const run = function () {
    deferredMarkdownFrame = 0;
    flushDeferredMarkdown();
  };
  deferredMarkdownFrame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(run)
    : setTimeout(run, 16);
}

function flushDeferredMarkdown() {
  if (!messagesElement || deferredMarkdownTasks.length === 0) return;
  const listTop = messagesElement.getBoundingClientRect().top;
  const remaining = [];
  for (const task of deferredMarkdownTasks) {
    if (!task.bubble.isConnected) continue;
    // 仍完全/部分位于视口上方：继续等，避免升级高度推走阅读锚点。
    if (task.element.getBoundingClientRect().top < listTop - 1) {
      remaining.push(task);
      continue;
    }
    enqueueLazyMarkdown(task);
  }
  deferredMarkdownTasks = remaining;
}

function bindMarkdownScroll() {
  if (markdownScrollBound || !messagesElement) return;
  messagesElement.addEventListener('scroll', scheduleDeferredMarkdown, { passive: true });
  markdownScrollBound = true;
}

function lazyMarkdownObserverFor() {
  if (lazyMarkdownObserver) return lazyMarkdownObserver;
  if (typeof IntersectionObserver !== 'function' || !messagesElement) return null;
  const observer = new IntersectionObserver(function (entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting || !entry.target.isConnected) continue;
      const task = entry.target.__markdownLazyTask;
      if (!task) continue;
      entry.target.__markdownLazyTask = null;
      observer.unobserve(entry.target);
      enqueueLazyMarkdown(task);
    }
  }, { root: messagesElement, rootMargin: LAZY_MARKDOWN_ROOT_MARGIN });
  lazyMarkdownObserver = observer;
  return observer;
}

/** 登记懒升级；节点进入视口附近后由观察器入队。 */
function registerLazyMarkdown(element, bubble, text, preview, retry) {
  if (!element || !bubble) return;
  // 记录当前待升级文本；mountBubbleMarkdown 用它丢弃过期预览。
  bubble.__markdownText = text;
  const task = {
    element: element,
    bubble: bubble,
    text: text,
    preview: Boolean(preview),
    retry: Boolean(retry)
  };
  bubble.__markdownLazyElement = element;
  element.__markdownLazyTask = task;
  bindMarkdownScroll();
  const observer = lazyMarkdownObserverFor();
  if (observer) {
    observer.observe(element);
    return;
  }
  // 无 IntersectionObserver：仍走同一队列分批升级，避免同步 flushSync 串行。
  element.__markdownLazyTask = null;
  enqueueLazyMarkdown(task);
}

function enqueueLazyMarkdown(task) {
  lazyMarkdownQueue.push(task);
  drainLazyMarkdownQueue().catch(function () {
    // 单条挂载失败由 mountBubbleMarkdown 回退纯文本；队列继续处理其余节点。
  });
}

function lazyMarkdownFrame() {
  return new Promise(function (resolve) {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(function () { resolve(); });
    } else {
      setTimeout(resolve, 16);
    }
  });
}

/**
 * 分批升级：先等 bundle，再把队列按每帧 2 条 mount。
 * 同一批仍复用共享的 bundle Promise，但不会在 bundle resolve 时一次性
 * 对几十条消息串行 flushSync。
 */
async function drainLazyMarkdownQueue() {
  if (lazyMarkdownRunning || lazyMarkdownQueue.length === 0) return;
  const generation = lazyMarkdownGeneration;
  lazyMarkdownRunning = true;
  try {
    const module = await loadMarkdownBundle(false);
    while (lazyMarkdownQueue.length > 0 && generation === lazyMarkdownGeneration) {
      const batch = lazyMarkdownQueue.splice(0, LAZY_MARKDOWN_BATCH);
      const listTop = messagesElement ? messagesElement.getBoundingClientRect().top : 0;
      for (const task of batch) {
        task.element.__markdownLazyTask = null;
        task.bubble.__markdownLazyElement = null;
        if (!task.bubble.isConnected) continue;
        // bundle 失败时直接提示纯文本回退；不涉及 Markdown 高度，无需等待视口。
        if (!module) {
          if (task.bubble.__markdownText === task.text) markBubbleMarkdownUnavailable(task.bubble);
          continue;
        }
        // 节点在视口上方：延后到用户上翻或滚动停止后再升级，避免推走锚点。
        if (task.element.getBoundingClientRect().top < listTop - 1) {
          deferredMarkdownTasks.push(task);
          continue;
        }
        mountBubbleMarkdown(task.bubble, task.text, {
          preview: task.preview,
          retry: task.retry
        }, module);
      }
      if (deferredMarkdownTasks.length > 0) scheduleDeferredMarkdown();
      if (lazyMarkdownQueue.length > 0 && generation === lazyMarkdownGeneration) {
        await lazyMarkdownFrame();
      }
    }
  } finally {
    if (generation === lazyMarkdownGeneration) lazyMarkdownRunning = false;
  }
}

/**
 * 把 AI 气泡从纯文本升级为 Markdown。
 *
 * 升级前记录是否接近底部、气泡是否在视口上方；React 改变高度后：
 * 原本接近底部 -> 保持底部；查看更早消息 -> 用高度差补偿 scrollTop。
 */
function upgradeBubbleMarkdown(bubble, text, options) {
  if (!bubble) return Promise.resolve(false);
  const retry = Boolean(options && options.retry);
  bubble.__markdownText = text;
  return loadMarkdownBundle(retry).then(function (module) {
    if (!module) {
      // 期间展开了全文或切换了房间：旧结果不得覆盖新文本。
      if (bubble.__markdownText === text) markBubbleMarkdownUnavailable(bubble);
      return false;
    }
    return mountBubbleMarkdown(bubble, text, options, module);
  });
}

/** 已拿到 bundle 时的同步挂载；懒队列按帧分批调用，避免串行 flushSync。 */
function mountBubbleMarkdown(bubble, text, options, module) {
  if (!bubble || !bubble.isConnected) return false;
  // 期间展开了全文或切换了房间：旧请求不得覆盖新文本。
  if (bubble.__markdownText !== text) return false;
  const preview = Boolean(options && options.preview);
  const scroller = messagesElement;
  const wasPinned = scrollController.isPinned();
  const scrollerTop = scroller ? scroller.getBoundingClientRect().top : 0;
  const bubbleTop = bubble.getBoundingClientRect().top;
  // 包含“顶部已越过视口上沿”的气泡：它加高会推动下方可见内容。
  const startsAboveViewport = scroller ? bubbleTop < scrollerTop : false;
  const beforeHeight = bubble.getBoundingClientRect().height;
  const mountOptions = { mentions: mentionNames(), preview: preview };
  let handle = markdownHandles.get(bubble);
  try {
    if (handle) {
      handle.update(text, mountOptions);
    } else {
      handle = module.mountMarkdown(bubble, text, mountOptions);
      if (handle) markdownHandles.set(bubble, handle);
    }
  } catch (error) {
    // 保留调用方已写入的纯文本，并给出可见提示。
    if (!markdownHandles.has(bubble)) markBubbleMarkdownUnavailable(bubble);
    return false;
  }
  if (!handle) {
    markBubbleMarkdownUnavailable(bubble);
    return false;
  }
  clearBubbleMarkdownFailure(bubble);
  const afterHeight = bubble.getBoundingClientRect().height;
  if (!wasPinned && startsAboveViewport && scroller) {
    // 上翻阅读时补偿视口上沿以上的气泡；控制器随后用阅读锚点校正残差。
    scrollController.adjustScroll(afterHeight - beforeHeight);
  }
  scrollController.noteContentChanged();
  return true;
}

/**
 * 渲染消息正文：先立即写纯文本，再按需异步升级 Markdown。
 * allowMarkdown 为 false 时（人类消息）不加载 bundle；截断预览也渲染
 * Markdown，但用 preview 让 Markdown 岛先闭合被 512B 切断的语法。
 * 已有 React root 时直接 update，避免预览与展开之间 Markdown→纯文本闪烁。
 * element 存在时（首屏列表）只登记懒升级，不立即创建 React root；
 * 展开全文/自动展开等用户可见动作仍立即挂载。
 */
function renderMessageBody(bubble, text, item, allowMarkdown, preview, retry, element) {
  const markdown = allowMarkdown && isAgentMessage(item);
  if (markdown && markdownHandles.has(bubble)) {
    return upgradeBubbleMarkdown(bubble, text, {
      preview: Boolean(preview),
      retry: Boolean(retry)
    });
  }
  destroyBubbleMarkdown(bubble);
  bubble.__markdownText = null;
  clearBubbleMarkdownFailure(bubble);
  renderRichText(bubble, text);
  if (!markdown) return Promise.resolve(false);
  // 纯文本快速路径：@ 高亮已由 renderRichText 完成，不创建 Streamdown root。
  if (!markdownNeedsRender(text)) return Promise.resolve(false);
  if (element) {
    registerLazyMarkdown(element, bubble, text, Boolean(preview), Boolean(retry));
    return Promise.resolve(false);
  }
  return upgradeBubbleMarkdown(bubble, text, {
    preview: Boolean(preview),
    retry: Boolean(retry)
  });
}
`;
