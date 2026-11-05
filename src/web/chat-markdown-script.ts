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
  const handle = markdownHandles.get(bubble);
  if (!handle) return;
  markdownHandles.delete(bubble);
  try {
    handle.destroy();
  } catch (error) {
    // 气泡可能已随消息区一起移除。
  }
}

/** 房间切换/清空消息区前统一 unmount，避免 React root 泄漏。 */
function resetMarkdownHandles() {
  for (const handle of markdownHandles.values()) {
    try {
      handle.destroy();
    } catch (error) {
      // 已卸载的 root 不应影响后续渲染。
    }
  }
  markdownHandles.clear();
}

/**
 * 把 AI 气泡从纯文本升级为 Markdown。
 *
 * 升级前记录是否接近底部、气泡是否在视口上方；React 改变高度后：
 * 原本接近底部 -> 保持底部；查看更早消息 -> 用高度差补偿 scrollTop。
 */
function upgradeBubbleMarkdown(bubble, text, options) {
  if (!bubble) return Promise.resolve(false);
  const preview = Boolean(options && options.preview);
  const retry = Boolean(options && options.retry);
  bubble.__markdownText = text;
  return loadMarkdownBundle(retry).then(function (module) {
    if (!module) {
      // 期间展开了全文或切换了房间：旧结果不得覆盖新文本。
      if (bubble.__markdownText === text) markBubbleMarkdownUnavailable(bubble);
      return false;
    }
    if (!bubble.isConnected) return false;
    // 期间展开了全文或切换了房间：旧请求不得覆盖新文本。
    if (bubble.__markdownText !== text) return false;
    const scroller = messagesElement;
    const wasNearBottom = isNearBottom();
    const scrollerTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const aboveViewport = scroller
      ? bubble.getBoundingClientRect().bottom < scrollerTop
      : false;
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
    if (wasNearBottom) {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    } else if (aboveViewport && scroller) {
      scroller.scrollTop += afterHeight - beforeHeight;
    }
    return true;
  });
}

/**
 * 渲染消息正文：先立即写纯文本，再按需异步升级 Markdown。
 * allowMarkdown 为 false 时（人类消息）不加载 bundle；截断预览也渲染
 * Markdown，但用 preview 让 Markdown 岛先闭合被 512B 切断的语法。
 * 已有 React root 时直接 update，避免预览与展开之间 Markdown→纯文本闪烁。
 */
function renderMessageBody(bubble, text, item, allowMarkdown, preview, retry) {
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
  if (markdown) {
    return upgradeBubbleMarkdown(bubble, text, {
      preview: Boolean(preview),
      retry: Boolean(retry)
    });
  }
  return Promise.resolve(false);
}
`;
