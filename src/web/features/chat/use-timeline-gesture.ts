import { useEffect, useRef, type RefObject } from 'react';

import { LIMITS } from '../../../contracts/limits';

/**
 * 时间线滚动手势跟踪。
 *
 * 负责触摸/指针/滚轮/键盘的意图记录、手势门控与松手快照。视图侧的贴底
 * 判定留在 `use-timeline-bottom-follow`，这里只维护输入状态与事件绑定，
 * 避免两者互相耦合。
 */

export type TimelineMoveDirection = 'up' | 'down' | null;

/** 松手（或兜底解除手势）当刻的快照；re-pin 只看这份快照。 */
export interface TimelineReleaseIntent {
  at: number;
  /** 松手当刻的真实 gap，不取手势内历史最小值。 */
  gap: number;
  /** 最后一次 scrollTop 变化方向。 */
  direction: TimelineMoveDirection;
  /** 本次手势内是否真正到达底部（gap ≤ 2）。 */
  reachedBottom: boolean;
}

export interface TimelineGestureOptions {
  scrollerNode: HTMLDivElement | null;
  scrollerRef: RefObject<HTMLDivElement | null>;
  pointerActiveRef: RefObject<boolean>;
  pointerActiveAtRef: RefObject<number>;
  touchActiveRef: RefObject<boolean>;
  lastTouchAtRef: RefObject<number>;
  lastWheelAtRef: RefObject<number>;
  touchYRef: RefObject<number | null>;
  touchDyRef: RefObject<number>;
  lastInteractionAtRef: RefObject<number>;
  lastUpwardInputRef: RefObject<number>;
  lastDownwardInputRef: RefObject<number>;
  lastAtBottomAtRef: RefObject<number>;
  lastMoveDirectionRef: RefObject<TimelineMoveDirection>;
  releaseIntentRef: RefObject<TimelineReleaseIntent | null>;
  lastGapRef: RefObject<number>;
  readyRef: RefObject<boolean>;
  pinnedRef: RefObject<boolean>;
  anchoredRef: RefObject<boolean>;
  restoringRef: RefObject<boolean>;
  initialSettledRef: RefObject<boolean>;
  recheckFollowRef: RefObject<() => void>;
  gestureActive: () => boolean;
  gestureHeld: () => boolean;
  schedulePinRecheck: (delay?: number) => void;
  scheduleBottomRetry: () => void;
  settleBottom: () => void;
  setPin: (value: boolean) => void;
}

export function useTimelineGesture({
  scrollerNode,
  scrollerRef,
  pointerActiveRef,
  pointerActiveAtRef,
  touchActiveRef,
  lastTouchAtRef,
  lastWheelAtRef,
  touchYRef,
  touchDyRef,
  lastInteractionAtRef,
  lastUpwardInputRef,
  lastDownwardInputRef,
  lastAtBottomAtRef,
  lastMoveDirectionRef,
  releaseIntentRef,
  lastGapRef,
  readyRef,
  pinnedRef,
  anchoredRef,
  restoringRef,
  initialSettledRef,
  recheckFollowRef,
  gestureActive,
  gestureHeld,
  schedulePinRecheck,
  scheduleBottomRetry,
  settleBottom,
  setPin,
}: TimelineGestureOptions): void {
  // 本次手势内是否真正到达 maxTop/真实底部（gap ≤ 2），以及上一次
  // scrollTop；两者只服务手势跟踪，不参与视图渲染。
  const reachedBottomAtRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const lastScrollHeightRef = useRef(0);
  useEffect(() => {
    const node = scrollerNode;
    if (!node) return undefined;
    // 松手时记录方向、落点与“本次手势内是否真正到过底部”；后续复核用
    // 这份快照而不是松手后的当前 gap，避免把 Virtuoso 的测量/footer 残留
    // 当成用户主动停在半路，也避免把“到过底部后上翻 554px”当成到底。
    const captureReleaseIntent = () => {
      const scroller = scrollerRef.current;
      const gap = scroller
        ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
        : Number.POSITIVE_INFINITY;
      releaseIntentRef.current = {
        at: Date.now(),
        gap,
        direction: lastMoveDirectionRef.current,
        reachedBottom: reachedBottomAtRef.current > 0,
      };
      reachedBottomAtRef.current = 0;
    };
    const mark = (event: Event) => {
      const now = Date.now();
      if (event.type === 'wheel') {
        lastInteractionAtRef.current = now;
        lastWheelAtRef.current = now;
        const delta = (event as WheelEvent).deltaY;
        if (delta < 0) {
          lastUpwardInputRef.current = now;
          lastMoveDirectionRef.current = 'up';
          reachedBottomAtRef.current = 0;
          releaseIntentRef.current = null;
          setPin(false);
        } else if (delta > 0) {
          // 向下滚动明确取消“向上意图”，记录“正在向底部走”，允许到达
          // 瞬间的高度测量同步贴底。
          lastUpwardInputRef.current = 0;
          lastDownwardInputRef.current = now;
          lastMoveDirectionRef.current = 'down';
          const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
          if (gap <= 2) reachedBottomAtRef.current = now;
        }
        return;
      }
      if (event.type === 'keydown') {
        const key = (event as KeyboardEvent).key;
        if (key === 'PageUp' || key === 'ArrowUp' || key === 'Home') {
          lastInteractionAtRef.current = now;
          lastUpwardInputRef.current = now;
          lastMoveDirectionRef.current = 'up';
          reachedBottomAtRef.current = 0;
          releaseIntentRef.current = null;
          setPin(false);
        }
        return;
      }
      if (event.type === 'pointerdown') {
        // 只有滚动容器内的指针（含容器自身的滚动条）才算手势；输入框、
        // 页面其他区域的 tap 不能打开门控，否则随后的布局 scroll 会被
        // 误判成用户离开底部。
        if (!(event.target instanceof Node) || !node.contains(event.target)) return;
        pointerActiveRef.current = true;
        pointerActiveAtRef.current = now;
        lastInteractionAtRef.current = now;
        lastScrollTopRef.current = node.scrollTop;
        lastScrollHeightRef.current = node.scrollHeight;
        // 新手势从干净的方向/落点开始，避免上一次拖到底的记录影响本次。
        lastMoveDirectionRef.current = null;
        reachedBottomAtRef.current = 0;
        releaseIntentRef.current = null;
        armPointerHold();
        // 只门控、不立即 unpin：点消息/长按不代表要离开底部。真正的滚动
        // 意图由 touchmove 的位移或 atBottom=false 判定，避免误显示按钮。
        return;
      }
      if (event.type === 'touchstart') {
        if (!(event.target instanceof Node) || !node.contains(event.target)) return;
        touchActiveRef.current = true;
        lastTouchAtRef.current = now;
        touchYRef.current = (event as TouchEvent).touches?.[0]?.clientY ?? null;
        touchDyRef.current = 0;
        lastInteractionAtRef.current = now;
        lastScrollTopRef.current = node.scrollTop;
        lastScrollHeightRef.current = node.scrollHeight;
        lastMoveDirectionRef.current = null;
        reachedBottomAtRef.current = 0;
        releaseIntentRef.current = null;
        return;
      }
      if (event.type === 'touchmove') {
        lastInteractionAtRef.current = now;
        lastTouchAtRef.current = now;
        const y = (event as TouchEvent).touches?.[0]?.clientY ?? null;
        if (y !== null && touchYRef.current !== null) {
          // 手指下移 = 内容上移 = 上翻；手指上移 = 滚向底部。逐段累计，
          // 避免 1–2px 的小步位移永远达不到阈值。
          touchDyRef.current += y - touchYRef.current;
          if (touchDyRef.current > LIMITS.webScrollIntentPx) {
            lastUpwardInputRef.current = now;
            lastDownwardInputRef.current = 0;
            lastMoveDirectionRef.current = 'up';
            reachedBottomAtRef.current = 0;
            releaseIntentRef.current = null;
            touchDyRef.current = 0;
          } else if (touchDyRef.current < -LIMITS.webScrollIntentPx) {
            lastUpwardInputRef.current = 0;
            lastDownwardInputRef.current = now;
            lastMoveDirectionRef.current = 'down';
            touchDyRef.current = 0;
          }
        }
        touchYRef.current = y;
        // 手指已经开始滚动：取消跟随，否则 scroll 事件会把位置写回底部。
        setPin(false);
        return;
      }
      if (event.type === 'touchend' || event.type === 'touchcancel') {
        touchActiveRef.current = false;
        lastTouchAtRef.current = now;
        touchYRef.current = null;
        touchDyRef.current = 0;
        lastInteractionAtRef.current = now;
        captureReleaseIntent();
        // 不在松手瞬间判定：fling 惯性可能还要几百毫秒才停。门控结束、
        // scrollend 或最后一次 scroll 后的复核会覆盖惯性终点；停在半路
        // 则保持 unpinned，交给「回到最新」。
        schedulePinRecheck();
        return;
      }
    };
    const onScroll = () => {
      const top = node.scrollTop;
      const previousTop = lastScrollTopRef.current;
      const previousHeight = lastScrollHeightRef.current;
      // 只有 scrollTop 真的向上移动才算“用户离开底部”。视口/键盘收缩
      // 会改变 clientHeight（gap 变大）而 scrollTop 不变，不能被当成手势。
      const movedUp = top < previousTop - 0.5;
      const movedDown = top > previousTop + 0.5;
      const heightGrowth = node.scrollHeight - previousHeight;
      lastScrollTopRef.current = top;
      lastScrollHeightRef.current = node.scrollHeight;
      if (pointerActiveRef.current) {
        pointerActiveAtRef.current = Date.now();
        armPointerHold();
      }
      const gap = node.scrollHeight - top - node.clientHeight;
      lastGapRef.current = gap;

      if (movedDown) {
        lastMoveDirectionRef.current = 'down';
        if (gap <= 2) reachedBottomAtRef.current = Date.now();
      } else if (movedUp) {
        // 只记录方向，不在这里写 lastUpwardInput：Virtuoso 的测量回写也会
        // 产生向上 scroll，不能被当成用户上翻而长期阻止 re-pin。用户上翻
        // 的位移必须超过同期内容测量增长；锚点回写（上移量约等于高度增长）
        // 与仍处在真实底部的回写（gap ≤2）都不改变方向。
        const userUp = previousTop - top > Math.max(2, heightGrowth + 2);
        if (gap > 2 && userUp) lastMoveDirectionRef.current = 'up';
      }
      if (gap <= LIMITS.webScrollStickyPx) lastAtBottomAtRef.current = Date.now();
      // 手势期间只要真的上移离开了底部，就交还控制权（触摸/拖滚动条都算）。
      // 这比等 Virtuoso 的 atBottom 回调更早，避免先被贴底写回。
      if (
        gestureActive() &&
        movedUp &&
        !anchoredRef.current &&
        !restoringRef.current &&
        top > LIMITS.webScrollStickyPx &&
        gap > 2
      ) {
        setPin(false);
      }
      // 程序化滚动（Virtuoso 按旧锚点写回）也可能把贴底位置改小；scroll
      // 事件在绘制前派发，此时同步贴回真实底部，避免这一帧被画出来。
      if (
        readyRef.current &&
        pinnedRef.current &&
        !anchoredRef.current &&
        !restoringRef.current &&
        // 到顶是明确的“离开底部”信号（下方会 unpin），不能被程序化
        // scrollTop=0 触发的贴底抢回去；只吸收底部附近的程序化写回。
        node.scrollTop > LIMITS.webScrollStickyPx &&
        gap > 2
      ) {
        settleBottom();
      }
      // 真实到达底部（≤2px）且没有近期上翻意图时立即 pinned，不等 Virtuoso
      // 的 atBottom 回调。超高消息测量可能持续几百毫秒，回调晚到时不能用
      // 500ms 输入窗口兜底。手势期间也允许：到真实底部后继续上翻会被
      // touchmove/scroll 的向上位移立刻取消。
      if (
        !pinnedRef.current &&
        !anchoredRef.current &&
        !restoringRef.current &&
        gap <= 2 &&
        Date.now() - lastUpwardInputRef.current >= 500 &&
        // 滚轮滚动仍在自己 250ms 门控内时不要中途 pin：测量补偿会把
        // scrollTop 短暂上移，提前 pin 会打断仍在进行的滚轮滚动。
        Date.now() - lastWheelAtRef.current >= LIMITS.webScrollSuppressPinMs
      ) {
        setPin(true);
      }
      // 程序化/测试滚动到顶部也视为离开底部；初始定位完成前忽略。
      // 用真实可滚动高度判断，避免 atBottom 回调晚于 scroll 事件时误判。
      if (
        initialSettledRef.current &&
        node.scrollTop <= 2 &&
        node.scrollHeight > node.clientHeight + LIMITS.webScrollStickyPx
      ) {
        // 程序化滚到顶部同样视为向上意图，避免 reveal 宽限期内把用户拉回底部。
        lastUpwardInputRef.current = Date.now();
        setPin(false);
      }
      // 最后一次 scroll 可能落在门控/惯性窗口内：约 webScrollSuppressPinMs
      // 后复核一次，覆盖 fling 终点、滚动条拖到底与布局变化留下的 gap。
      if (
        !anchoredRef.current &&
        !restoringRef.current &&
        (!pinnedRef.current || gestureActive())
      ) {
        schedulePinRecheck();
      }
    };
    // 指针可能在滚动容器外释放（鼠标拖滚动条、触摸被系统取消）；在 window
    // 上兜底解除门控，避免 pointerActive 卡住导致永久停止跟随。
    const releasePointer = () => {
      // 外部 tap（输入框、页面其他区域）从未进入 pointerActive，不能因此
      // 打开门控或解除 pinned。
      if (!pointerActiveRef.current) return;
      pointerActiveRef.current = false;
      lastInteractionAtRef.current = Date.now();
      clearPointerHold();
      captureReleaseIntent();
      // 拖滚动条松手后立即复核（方向向下且到底即恢复），惯性/后续布局由
      // 延迟复核兜底。
      recheckFollowRef.current();
      schedulePinRecheck();
    };
    // pointerup/pointercancel 可能在窗口外丢失：超过 webScrollPointerMaxHoldMs
    // 没有指针事件就解除门控，并按本次手势的方向/落点做一次 re-pin 复核。
    let pointerHoldTimer: number | null = null;
    const clearPointerHold = () => {
      if (pointerHoldTimer !== null) {
        window.clearTimeout(pointerHoldTimer);
        pointerHoldTimer = null;
      }
    };
    const armPointerHold = () => {
      clearPointerHold();
      pointerHoldTimer = window.setTimeout(() => {
        pointerHoldTimer = null;
        if (!pointerActiveRef.current) return;
        pointerActiveRef.current = false;
        lastInteractionAtRef.current = Date.now();
        captureReleaseIntent();
        recheckFollowRef.current();
      }, LIMITS.webScrollPointerMaxHoldMs);
    };
    node.addEventListener('wheel', mark, { passive: true });
    node.addEventListener('touchstart', mark, { passive: true });
    node.addEventListener('touchmove', mark, { passive: true });
    node.addEventListener('touchend', mark, { passive: true });
    node.addEventListener('touchcancel', mark, { passive: true });
    node.addEventListener('pointerdown', mark, { passive: true });
    node.addEventListener('keydown', mark);
    node.addEventListener('scroll', onScroll, { passive: true });
    // scrollend 是惯性/滚动真正停止的明确信号：此时再判定一次，比只等
    // 250ms 定时器更快恢复跟随（定时器仍作不支持该事件时的兜底）。
    const onScrollEnd = () => {
      if (gestureHeld()) return;
      schedulePinRecheck(0);
    };
    node.addEventListener('scrollend', onScrollEnd, { passive: true });
    window.addEventListener('pointerup', releasePointer, { passive: true });
    window.addEventListener('pointercancel', releasePointer, { passive: true });
    // 窗口失焦时 pointerup 可能不会到达：解除手势门控后按松手快照复核。
    // 方向向上时 recheckFollow 不会 re-pin，保持用户当前阅读位置。
    const releaseOnBlur = () => {
      pointerActiveRef.current = false;
      touchActiveRef.current = false;
      clearPointerHold();
      captureReleaseIntent();
      recheckFollowRef.current();
    };
    window.addEventListener('blur', releaseOnBlur);
    // 键盘/窗口尺寸变化：收缩前是 pinned 或真实贴底时才重新贴底；用户已
    // 上翻时保持原位。rAF 合并连续的 resize，避免逐帧写 scrollTop。
    let resizeFrame = 0;
    const onViewportResize = () => {
      if (resizeFrame !== 0 || !readyRef.current) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        if (gestureHeld()) return;
        if (anchoredRef.current || restoringRef.current) return;
        const scroller = scrollerRef.current;
        if (!scroller) return;
        if (!pinnedRef.current) {
          // resize 事件在布局之后才到；用 resize 前的采样判断是否真实贴底。
          if (lastGapRef.current > 2) return;
          if (Date.now() - lastUpwardInputRef.current < LIMITS.webScrollSuppressPinMs) return;
          setPin(true);
        }
        if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2) {
          scroller.scrollTop = scroller.scrollHeight;
          scheduleBottomRetry();
        }
      });
    };
    window.addEventListener('resize', onViewportResize);
    window.visualViewport?.addEventListener('resize', onViewportResize);
    // 图片解码完成到布局长高之间没有 ResizeObserver 可达的同步点；
    // 在 load 捕获后下一帧按真实高度贴底，避免图片加载留下的一帧空隙。
    const onImageLoad = (event: Event) => {
      if (!(event.target instanceof HTMLImageElement)) return;
      requestAnimationFrame(() => {
        settleBottom();
      });
    };
    node.addEventListener('load', onImageLoad, true);
    return () => {
      node.removeEventListener('wheel', mark);
      node.removeEventListener('touchstart', mark);
      node.removeEventListener('touchmove', mark);
      node.removeEventListener('touchend', mark);
      node.removeEventListener('touchcancel', mark);
      window.removeEventListener('pointerup', releasePointer);
      window.removeEventListener('pointercancel', releasePointer);
      window.removeEventListener('blur', releaseOnBlur);
      window.removeEventListener('resize', onViewportResize);
      window.visualViewport?.removeEventListener('resize', onViewportResize);
      if (resizeFrame !== 0) cancelAnimationFrame(resizeFrame);
      if (pointerHoldTimer !== null) window.clearTimeout(pointerHoldTimer);
      node.removeEventListener('pointerdown', mark);
      node.removeEventListener('keydown', mark);
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('scrollend', onScrollEnd);
      node.removeEventListener('load', onImageLoad, true);
    };
  }, [
    anchoredRef,
    gestureActive,
    gestureHeld,
    initialSettledRef,
    lastAtBottomAtRef,
    lastDownwardInputRef,
    lastGapRef,
    lastInteractionAtRef,
    lastMoveDirectionRef,
    lastTouchAtRef,
    lastUpwardInputRef,
    lastWheelAtRef,
    pinnedRef,
    pointerActiveAtRef,
    pointerActiveRef,
    readyRef,
    recheckFollowRef,
    releaseIntentRef,
    restoringRef,
    scheduleBottomRetry,
    schedulePinRecheck,
    scrollerNode,
    scrollerRef,
    setPin,
    settleBottom,
    touchDyRef,
    touchYRef,
  ]);
}
