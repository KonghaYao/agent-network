/**
 * AI 消息 Markdown 岛的 vanilla 桥接层。
 *
 * 页面外壳、文件卡片、输入框、回执仍是 vanilla；这里只负责：
 * - 懒加载 `/assets/chat-markdown.js`（成功/失败都只请求一次）；
 * - 在 AI 气泡上挂载/更新/销毁 React root；
 * - 加载失败、React 挂载失败或消息已移除时保留纯文本；
 * - Markdown 升级后按接近底部/查看更早消息两种情况补偿滚动。
 *
 * 与 `chat-render-script.ts` 一起拼进同一个内联脚本，不引入模块作用域。
 */
export const CHAT_MARKDOWN_SCRIPT = `
const MARKDOWN_ASSET_URL = '/assets/chat-markdown.js';
const markdownHandles = new Map();
let markdownLoadPromise = null;

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

/** 只请求一次；失败后固定返回 null，不重试、不阻塞消息。 */
function loadMarkdownBundle() {
  if (!markdownLoadPromise) {
    markdownLoadPromise = import(MARKDOWN_ASSET_URL).then(function (module) {
      if (!module || typeof module.mountMarkdown !== 'function') return null;
      return module;
    }).catch(function () {
      return null;
    });
  }
  return markdownLoadPromise;
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
function upgradeBubbleMarkdown(bubble, text) {
  if (!bubble) return;
  bubble.__markdownText = text;
  loadMarkdownBundle().then(function (module) {
    if (!module || !bubble.isConnected) return;
    // 期间展开了全文或切换了房间：旧请求不得覆盖新文本。
    if (bubble.__markdownText !== text) return;
    const scroller = messagesElement;
    const wasNearBottom = isNearBottom();
    const scrollerTop = scroller ? scroller.getBoundingClientRect().top : 0;
    const aboveViewport = scroller
      ? bubble.getBoundingClientRect().bottom < scrollerTop
      : false;
    const beforeHeight = bubble.getBoundingClientRect().height;
    const options = { mentions: mentionNames() };
    let handle = markdownHandles.get(bubble);
    try {
      if (handle) {
        handle.update(text, options);
      } else {
        handle = module.mountMarkdown(bubble, text, options);
        if (handle) markdownHandles.set(bubble, handle);
      }
    } catch (error) {
      // 保留调用方已写入的纯文本。
      return;
    }
    if (!handle) return;
    const afterHeight = bubble.getBoundingClientRect().height;
    if (wasNearBottom) {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    } else if (aboveViewport && scroller) {
      scroller.scrollTop += afterHeight - beforeHeight;
    }
  });
}

/**
 * 渲染消息正文：先立即写纯文本，再按需异步升级 Markdown。
 * allowMarkdown 为 false 时（人类消息、512B 截断预览）不加载 bundle。
 */
function renderMessageBody(bubble, text, item, allowMarkdown) {
  destroyBubbleMarkdown(bubble);
  bubble.__markdownText = null;
  renderRichText(bubble, text);
  if (allowMarkdown && isAgentMessage(item)) upgradeBubbleMarkdown(bubble, text);
}
`;
