import { createContext } from 'react';

/**
 * 已挂载消息的正文就绪计数。
 *
 * 虚拟时间线在入口隐藏阶段用 `count()` 判断当前挂载窗口里是否还有异步正文
 * （目前是 `/assets/chat-markdown.js` 与 Markdown 岛的首次挂载）没有完成；
 * 只有计数归零且高度稳定才 reveal，避免先把空气泡画给用户、再让真实高度
 * 在绘制后把底部顶开。
 *
 * 计数只覆盖当前挂载的窗口：消息随 Virtuoso 卸载时 release，不会累计整段
 * 历史。注册不触发 React 状态更新，只更新 ref 与 `data-body-pending`，因此
 * 不会参与渲染循环。
 */
export interface BodyPendingRegistry {
  /** 标记一条已挂载消息的正文未就绪；返回幂等的 release。 */
  begin(): () => void;
  /** 当前挂载窗口中未就绪的正文数量。 */
  count(): number;
}

export const BodyPendingContext = createContext<BodyPendingRegistry | null>(null);

export function createBodyPendingRegistry(onChange?: (count: number) => void): BodyPendingRegistry {
  let pending = 0;
  const publish = () => {
    onChange?.(pending);
  };
  return {
    begin() {
      pending += 1;
      publish();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        pending = Math.max(0, pending - 1);
        publish();
      };
    },
    count() {
      return pending;
    },
  };
}
