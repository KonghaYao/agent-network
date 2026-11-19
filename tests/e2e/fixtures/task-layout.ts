import { expect, type Locator } from '@playwright/test';

/** 头像及 +N 都必须留在摘要 pill 内，不能只依赖外层裁切掩盖错误 rect。 */
export async function expectTaskAvatarsContained(bar: Locator): Promise<void> {
  const avatars = bar.locator('.task-bar-avatars');
  await expect(avatars).toHaveCSS('overflow', 'hidden');
  const values = await avatars.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const pill = element.closest('.task-bar')!.getBoundingClientRect();
    const inside = (child: DOMRect, parent: DOMRect) => child.left >= parent.left - .5 &&
      child.right <= parent.right + .5 && child.top >= parent.top - .5 && child.bottom <= parent.bottom + .5;
    return {
      contained: inside(box, pill) && [...element.querySelectorAll('*')].every(node => {
        const rect = node.getBoundingClientRect();
        // Badge 的隐藏装饰节点为零面积，不参与可见布局。
        return rect.width === 0 || rect.height === 0 || inside(rect, box);
      }),
      avatars: [...element.querySelectorAll('[data-lenso-slot="avatar"]')].map(node => {
        const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
        return { width: rect.width, height: rect.height, radius: css.borderRadius, margin: css.marginLeft };
      }),
    };
  });
  expect(values.contained).toBe(true);
  expect(values.avatars.length).toBeLessThanOrEqual(3);
  for (const [index, avatar] of values.avatars.entries()) {
    expect(avatar).toEqual({ width: 20, height: 20, radius: '50%', margin: index === 0 ? '0px' : '-6px' });
  }
}

/** 预览卡不能切过底层聊天头像，在卡边留下彩色竖条。 */
export async function expectTaskPreviewContained(preview: Locator): Promise<void> {
  await expect(preview).toHaveCSS('overflow', 'hidden');
  await expect.poll(() => preview.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const outside = [...element.querySelectorAll('[data-lenso-slot="avatar"]')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.left < box.left || rect.right > box.right || rect.top < box.top || rect.bottom > box.bottom;
    });
    const strips = [...document.querySelectorAll('#messages .msg-avatar')].filter(node => {
      const rect = node.getBoundingClientRect();
      return rect.left < box.left && rect.right > box.left && rect.top < box.bottom && rect.bottom > box.top;
    });
    return { outside: outside.length, strips: strips.length };
  })).toEqual({ outside: 0, strips: 0 });
}

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
