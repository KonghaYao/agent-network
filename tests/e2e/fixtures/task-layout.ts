import { expect, type Locator } from '@playwright/test';

export const LONG_TASK_URL = `https://github.com/LioRae/lenso-ui/blob/main/${'long-task-segment-'.repeat(36)}?description=${'任务正文'.repeat(80)}`;

/** 同时检查内容与滚动容器，不把 Lenso 材质装饰层的亚像素边缘当作正文溢出。 */
export async function expectNoHorizontalOverflow(root: Locator): Promise<void> {
  await expect(root).toBeVisible();
  await expect.poll(() => root.evaluate((element) =>
    [element, ...element.querySelectorAll('.bubble, .msg-content, .msg-markdown, pre, code, .task-bar, .task-bar-preview, .task-dock-list, .task-dock-item-trigger, .task-dock-preview, .task-preview-text, .task-preview-recent, .task-trace-items, .task-trace-item, .task-trace-preview, .task-complete-message')]
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node.clientWidth > 0)
      .filter((node) => node.scrollWidth > node.clientWidth)
      .map((node) => `${node.tagName}.${node.className}: ${node.scrollWidth}/${node.clientWidth} ${getComputedStyle(node).whiteSpace}/${getComputedStyle(node).overflowWrap}/${getComputedStyle(node).wordBreak}`),
  )).toEqual([]);
}
