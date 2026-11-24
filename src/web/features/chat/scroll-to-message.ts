/**
 * 时间线消息定位抽象。
 *
 * DOM 路径直接对已挂载节点 `scrollIntoView`；虚拟路径由 TimelineVirtual 注册
 * “消息是否已加载 / 滚动到索引”的实现。调用方不感知当前渲染模式，也不在
 * 虚拟化后继续假设目标消息一定在 DOM 中。
 */

export type LoadedMessageTest = (messageId: string) => boolean;
export type ScrollToMessageHandler = (messageId: string) => boolean;

let loadedMessageTest: LoadedMessageTest | null = null;
let scrollHandler: ScrollToMessageHandler | null = null;

export function findMountedMessage(messageId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  for (const node of document.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (node.dataset.messageId === messageId) return node;
  }
  return null;
}

/** 虚拟时间线注册后，搜索定位可判断目标是否已在加载窗口内。 */
export function registerLoadedMessageTest(test: LoadedMessageTest | null): () => void {
  loadedMessageTest = test;
  return () => {
    if (loadedMessageTest === test) loadedMessageTest = null;
  };
}

/** 虚拟时间线注册滚动实现；返回 false 表示目标不在当前数据窗口。 */
export function registerScrollToMessage(handler: ScrollToMessageHandler | null): () => void {
  scrollHandler = handler;
  return () => {
    if (scrollHandler === handler) scrollHandler = null;
  };
}

export function isMessageLoaded(messageId: string): boolean {
  return loadedMessageTest?.(messageId) ?? findMountedMessage(messageId) !== null;
}

/**
 * 定位消息并居中显示。返回 false 时调用方可回退到 anchor 窗口或全文读取；
 * DOM 模式在目标未挂载时同样返回 false，保持既有语义。
 */
export function scrollToMessage(messageId: string): boolean {
  if (scrollHandler?.(messageId)) return true;
  const node = findMountedMessage(messageId);
  if (!node) return false;
  node.scrollIntoView({ block: 'center', inline: 'nearest' });
  return true;
}
