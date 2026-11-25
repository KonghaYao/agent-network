import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

import { LIMITS } from '../../../contracts/limits';
import { renderedWatermark, type HistoryItem } from '../../lib/chat';
import type { BodyPendingRegistry } from './body-pending';
import { useTimelineGesture, type TimelineReleaseIntent } from './use-timeline-gesture';

/**
 * 虚拟时间线的贴底与 reveal 控制。
 *
 * 负责 pinned/atBottom、入口 reveal 门控、滚动意图跟踪、ResizeObserver /
 * item-list MutationObserver 校正与残差 scrollToIndex。视图与数据组合留在
 * `TimelineVirtual`，这里只依赖 scroller ref、items 与已读回调。
 */

export interface TimelineBottomFollowOptions {
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerRef: RefObject<HTMLDivElement | null>;
  scrollerNode: HTMLDivElement | null;
  items: HistoryItem[];
  bodyPending: BodyPendingRegistry;
  anchored: boolean;
  restoring: boolean;
  onMarkRead: (through: string) => void;
}

export interface TimelineBottomFollow {
  pinned: boolean;
  pinnedRef: RefObject<boolean>;
  anchoredRef: RefObject<boolean>;
  hasNew: boolean;
  ready: boolean;
  suppressFollowUntilRef: RefObject<number>;
  initialSettledRef: RefObject<boolean>;
  visibleEndRef: RefObject<number>;
  setPin: (value: boolean) => void;
  setHasNew: (value: boolean) => void;
  followOutput: (isAtBottom: boolean) => false | 'auto';
  revealWhenSettled: () => void;
  watchInitialReveal: () => void;
  scheduleMarkRead: (endIndex: number) => void;
  handleAtBottom: (value: boolean) => void;
  handleTotalListHeightChanged: () => void;
  /** 提交后、绘制前的同步贴底；由调用方在原布局 effect 位置执行。 */
  snapPinnedToBottom: () => void;
  /** 明确的“回到最新”意图：清除手势门控并恢复跟随。 */
  followLatest: () => void;
}

export function useTimelineBottomFollow({
  virtuosoRef,
  scrollerRef,
  scrollerNode,
  items,
  bodyPending,
  anchored,
  restoring,
  onMarkRead,
}: TimelineBottomFollowOptions): TimelineBottomFollow {
  const pinnedRef = useRef(true);
  const [pinned, setPinned] = useState(true);
  const [hasNew, setHasNew] = useState(false);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(false);
  const revealWatchRef = useRef(0);
  const revealedAtRef = useRef(0);
  const revealedPerfRef = useRef(0);
  const anchoredRef = useRef(anchored);
  const restoringRef = useRef(restoring);
  const initialSettledRef = useRef(false);
  const atBottomRef = useRef(false);
  const visibleEndRef = useRef(0);
  const lastUpwardInputRef = useRef(0);
  const lastDownwardInputRef = useRef(0);
  const lastAtBottomAtRef = useRef(0);
  // 用户手势门控：触摸/指针/滚轮期间以及松手后的短窗口内，任何自动贴底
  // （父级 layout effect、RO/MO 校正、残差 scrollToIndex）都必须让位。
  // 移动端只有 wheel 会取消 pinned；触摸若不门控，每个 scroll 都会被同步
  // 写回底部，手指完全滚不动，也到不了真正的底部。
  const lastInteractionAtRef = useRef(0);
  const touchActiveRef = useRef(false);
  const pointerActiveRef = useRef(false);
  const pointerActiveAtRef = useRef(0);
  const lastTouchAtRef = useRef(0);
  const lastWheelAtRef = useRef(0);
  const touchYRef = useRef<number | null>(null);
  const touchDyRef = useRef(0);
  // 最后一次真实滚动方向与松手快照。滚动条拖到底后 Virtuoso 还会继续
  // 测量/footer，松手时看到的 gap 可能是 18–287px 的残留；只看该 gap 无法
  // 区分“拖到底的测量残留”和“主动停在半路”。re-pin 只看方向 + 本次手势
  // 是否真正到过底部，且松手后上翻绝不拉回。
  const lastMoveDirectionRef = useRef<'up' | 'down' | null>(null);
  const releaseIntentRef = useRef<TimelineReleaseIntent | null>(null);
  // 门控结束后的复核：手势/惯性/布局变化的最后一次 scroll 可能落在 250ms
  // 门控内被跳过，之后不会再有事件触发贴底判定。这里统一安排一次延迟复核。
  const pinRecheckTimerRef = useRef<number | null>(null);
  const recheckFollowRef = useRef<() => void>(() => {});
  // re-pin 后的短重试：Virtuoso 可能在贴底写入之后才补齐测量与 footer，
  // 单次写入会留下 18–287px。限定次数与总窗口，避免与测量循环无限互抢。
  const pinSettleRef = useRef<{ timer: number | null; attempts: number }>({
    timer: null,
    attempts: 0,
  });
  const pinSettleTickRef = useRef<() => void>(() => {});
  // 最近一次真实 gap：窗口/键盘 resize 在布局之后才派发事件，只能依赖
  // resize 前的采样判断“收缩前是否真实贴底”。
  const lastGapRef = useRef(Number.POSITIVE_INFINITY);
  const suppressFollowUntilRef = useRef(0);
  const markReadTimerRef = useRef<number | null>(null);
  const pendingReadThroughRef = useRef<string | null>(null);
  const bottomCorrectionRef = useRef<() => void>(() => {});
  const lastItemIndexRef = useRef(0);
  // Virtuoso 的尺寸缓存偶尔比真实内容矮（本机实测为 footer 的 18px）：写完
  // scrollTop=scrollHeight 后它仍可能在同一帧末尾按旧锚点写回。用
  // scrollToIndex(align:'end') 让内部定位重算后再贴真实底部；最多 2 次。
  const bottomRetryRef = useRef({ attempts: 0, frame: 0 });
  anchoredRef.current = anchored;
  restoringRef.current = restoring;
  lastItemIndexRef.current = Math.max(0, items.length - 1);

  const setPin = useCallback((value: boolean) => {
    pinnedRef.current = value;
    scrollerRef.current?.setAttribute('data-virt-pinned', String(value));
    setPinned(value);
    if (value) setHasNew(false);
  }, [scrollerRef]);

  // 明确的“回到最新”意图：按钮点击、发送后强制贴底、拖到底后 re-pin。
  // 绕过手势门控并把向下意图置为当前，保证随后的贴底与 followOutput 生效。
  const followLatest = useCallback(() => {
    touchActiveRef.current = false;
    pointerActiveRef.current = false;
    touchYRef.current = null;
    touchDyRef.current = 0;
    lastInteractionAtRef.current = 0;
    lastUpwardInputRef.current = 0;
    lastDownwardInputRef.current = Date.now();
    lastMoveDirectionRef.current = 'down';
    releaseIntentRef.current = null;
    // 旧的 unpinned 复核不能打断平滑滚动/贴底。
    if (pinRecheckTimerRef.current !== null) {
      window.clearTimeout(pinRecheckTimerRef.current);
      pinRecheckTimerRef.current = null;
    }
    setPin(true);
  }, [setPin]);

  // 延迟复核只保留最后一次安排：滚动/布局事件连续到达时重置计时器，
  // 在最后一次事件约 webScrollSuppressPinMs 后执行。
  const schedulePinRecheck = useCallback((delay: number = LIMITS.webScrollSuppressPinMs) => {
    if (pinRecheckTimerRef.current !== null) window.clearTimeout(pinRecheckTimerRef.current);
    pinRecheckTimerRef.current = window.setTimeout(() => {
      pinRecheckTimerRef.current = null;
      recheckFollowRef.current();
    }, Math.max(0, delay));
  }, []);

  const revealWhenSettled = useCallback(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    revealedAtRef.current = Date.now();
    revealedPerfRef.current = performance.now();
    initialSettledRef.current = true;
    setReady(true);
  }, []);

  useEffect(
    () => () => {
      if (markReadTimerRef.current !== null) window.clearTimeout(markReadTimerRef.current);
      if (pinRecheckTimerRef.current !== null) window.clearTimeout(pinRecheckTimerRef.current);
      if (pinSettleRef.current.timer !== null) {
        window.clearTimeout(pinSettleRef.current.timer);
        pinSettleRef.current.timer = null;
      }
      if (revealWatchRef.current !== 0) cancelAnimationFrame(revealWatchRef.current);
    },
    [],
  );

  // 已读水位：只推进到当前可见的最后一条消息；anchor/恢复期间不推进。
  const scheduleMarkRead = useCallback(
    (endIndex: number) => {
      if (anchoredRef.current || restoringRef.current || !atBottomRef.current) return;
      const through = renderedWatermark(items.slice(0, Math.max(0, endIndex) + 1));
      if (!through) return;
      // range 变化会随高度测量反复触发；同一个可见水位已在等待时不要
      // 清掉重设定时器，避免底部高度变化时反复“落已读”。
      if (through === pendingReadThroughRef.current && markReadTimerRef.current !== null) return;
      pendingReadThroughRef.current = through;
      if (markReadTimerRef.current !== null) window.clearTimeout(markReadTimerRef.current);
      markReadTimerRef.current = window.setTimeout(() => {
        markReadTimerRef.current = null;
        pendingReadThroughRef.current = null;
        if (anchoredRef.current || restoringRef.current || !atBottomRef.current) return;
        onMarkRead(through);
      }, LIMITS.webScrollMarkReadDelayMs);
    },
    [items, onMarkRead],
  );

  // 手势是否仍被按住。触摸端可能丢失 touchend（合成手势、系统中断），
  // 单靠 touchActive 布尔会让门控永久卡住；超过一个门控窗口没有新的
  // touch 事件就不再视为按住。指针同理：pointerup/pointercancel 可能在
  // 窗口外丢失，超过 webScrollPointerMaxHoldMs 没有事件就解除门控。
  const gestureHeld = useCallback(
    () =>
      (pointerActiveRef.current &&
        Date.now() - pointerActiveAtRef.current < LIMITS.webScrollPointerMaxHoldMs) ||
      (touchActiveRef.current &&
        Date.now() - lastTouchAtRef.current < LIMITS.webScrollSuppressPinMs),
    [],
  );

  // 手势期间（含松手短窗口）一律暂停自动贴底。触摸用 touchActive，鼠标拖
  // 滚动条用 pointerActive，滚轮/键盘用时间戳窗口，三者合并成一个判断。
  const gestureActive = useCallback(
    () =>
      gestureHeld() ||
      Date.now() - lastInteractionAtRef.current < LIMITS.webScrollSuppressPinMs,
    [gestureHeld],
  );

  // 是否应跟随底部：pinned；首次显示前默认为真；或用户刚从底部向下滚、
  // 尚未出现向上意图（到达瞬间 Virtuoso 的 atBottom 回调可能晚一两帧）。
  const wantsBottom = useCallback(() => {
    if (!readyRef.current) return true;
    // 用户正在操纵滚动：不要每帧与手势争抢。
    if (gestureActive()) return false;
    if (pinnedRef.current) return true;
    const now = Date.now();
    // 搜索/引用/Task 跳转刚发生时，入口 settle 的贴底宽限不得把定位拉回底部。
    if (now < suppressFollowUntilRef.current) return false;
    if (now - lastUpwardInputRef.current < 500) return false;
    // 刚显示后的首轮异步长高（图片/Markdown）：用户还没机会操作，
    // 继续贴底，避免 reveal 后立刻出现一帧空隙。
    if (now - revealedAtRef.current < 500) return true;
    return (
      now - lastAtBottomAtRef.current < 500 &&
      now - lastDownwardInputRef.current < 500
    );
  }, [gestureActive]);

  const cancelBottomRetry = useCallback(() => {
    const state = bottomRetryRef.current;
    if (state.frame !== 0) {
      cancelAnimationFrame(state.frame);
      state.frame = 0;
    }
    state.attempts = 0;
  }, []);

  // 下一帧确认残差：真实底部仍差 >2px 时让 Virtuoso 重新对齐一次。最多 2 次，
  // 每次仍先写真实 scrollHeight；预算耗尽后停止，避免与测量循环无限互抢。
  const bottomRetryTick = useCallback(() => {
    const state = bottomRetryRef.current;
    state.frame = 0;
    // 隐藏阶段由 watchInitialReveal 每帧 settle，不需要 scrollToIndex 介入；
    // 提前调用会让 Virtuoso 在首轮测量中反复切换 range，反而把即将 reveal
    // 的正文窗口卸载掉。
    if (!readyRef.current) {
      state.attempts = 0;
      return;
    }
    if (gestureActive()) {
      state.attempts = 0;
      return;
    }
    if (!pinnedRef.current || anchoredRef.current || restoringRef.current) {
      state.attempts = 0;
      return;
    }
    const scroller = scrollerRef.current;
    if (!scroller) {
      state.attempts = 0;
      return;
    }
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) {
      state.attempts = 0;
      return;
    }
    if (state.attempts >= 2) {
      state.attempts = 0;
      return;
    }
    state.attempts += 1;
    virtuosoRef.current?.scrollToIndex({
      index: lastItemIndexRef.current,
      align: 'end',
      behavior: 'auto',
    });
    scroller.scrollTop = scroller.scrollHeight;
    state.frame = requestAnimationFrame(bottomRetryTick);
  }, [gestureActive, scrollerRef, virtuosoRef]);

  const scheduleBottomRetry = useCallback(() => {
    if (!readyRef.current) return;
    const state = bottomRetryRef.current;
    if (state.frame !== 0) return;
    state.attempts = 0;
    state.frame = requestAnimationFrame(bottomRetryTick);
  }, [bottomRetryTick]);

  useEffect(() => cancelBottomRetry, [cancelBottomRetry]);

  const cancelPinSettle = useCallback(() => {
    const state = pinSettleRef.current;
    if (state.timer !== null) {
      window.clearTimeout(state.timer);
      state.timer = null;
    }
    state.attempts = 0;
  }, []);

  const pinSettleTick = useCallback(() => {
    const state = pinSettleRef.current;
    if (!pinnedRef.current || anchoredRef.current || restoringRef.current) {
      state.attempts = 0;
      return;
    }
    // 期间出现上翻/手势：立刻停止，不能把用户刚离开的位置拉回底部。
    if (gestureHeld() || Date.now() - lastUpwardInputRef.current < LIMITS.webScrollSuppressPinMs) {
      state.attempts = 0;
      return;
    }
    const scroller = scrollerRef.current;
    if (!scroller) {
      state.attempts = 0;
      return;
    }
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) {
      state.attempts = 0;
      return;
    }
    if (state.attempts >= LIMITS.webScrollPinRetryMax) {
      state.attempts = 0;
      return;
    }
    state.attempts += 1;
    scroller.scrollTop = scroller.scrollHeight;
    scheduleBottomRetry();
    state.timer = window.setTimeout(() => {
      state.timer = null;
      pinSettleTickRef.current();
    }, LIMITS.webScrollPinRetryStepMs);
  }, [gestureHeld, scheduleBottomRetry, scrollerRef]);
  pinSettleTickRef.current = pinSettleTick;

  // re-pin 后的短重试入口：第一次在 80ms 后复核，最多 3 次（约 240ms），
  // 覆盖 Virtuoso 松手后继续测量/footer 增长的窗口。
  const schedulePinSettle = useCallback(() => {
    if (!readyRef.current) return;
    const state = pinSettleRef.current;
    if (state.timer !== null) return;
    state.attempts = 0;
    state.timer = window.setTimeout(() => {
      state.timer = null;
      pinSettleTickRef.current();
    }, LIMITS.webScrollPinRetryStepMs);
  }, []);

  useEffect(() => cancelPinSettle, [cancelPinSettle]);

  // MutationObserver 的轻量贴底：只看 markdown/文件卡插入后的真实 gap，
  // 不在同一微任务里触发 scrollToIndex（那会让 Virtuoso 在 reveal 瞬间
  // 重算 range 并缩掉已渲染高度）。残差交给下一帧的 scroll/layout 校验。
  const snapBottom = useCallback(() => {
    if (anchoredRef.current || restoringRef.current) return;
    if (!wantsBottom()) {
      // 门控期间追加的内容不能立刻贴底，但门控结束后必须补一次判定。
      if (gestureActive() && pinnedRef.current) schedulePinRecheck();
      return;
    }
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [gestureActive, schedulePinRecheck, scrollerRef, wantsBottom]);

  // 只用于“已经在贴底”的同步修正：pinned 且非 anchor/恢复窗口，且真实
  // 离底超过 2px。直接写 scrollTop 发生在同一帧内（totalListHeightChanged
  // 与 ResizeObserver 都在绘制前），避免先画出一帧“消息整体上移”。
  const settleBottom = useCallback(() => {
    if (anchoredRef.current || restoringRef.current) return;
    // 首次显示前还没有用户手势可尊重：无条件贴底，保证 reveal 的第一帧
    // 就在真实底部。显示后只跟随 pinned / 到达中的向下手势。
    if (!wantsBottom()) {
      // 手势门控压住了这次贴底：门控结束后重新判定，避免布局变化/追加
      // 内容永久留下空隙。
      if (gestureActive() && pinnedRef.current) schedulePinRecheck();
      return;
    }
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) {
      cancelBottomRetry();
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
    scheduleBottomRetry();
  }, [
    cancelBottomRetry,
    gestureActive,
    scheduleBottomRetry,
    schedulePinRecheck,
    scrollerRef,
    wantsBottom,
  ]);

  // 门控结束后的统一复核：fling 惯性结束、滚动条松手、pointerup 丢失或
  // 键盘收缩都可能把最后一次布局 scroll 落在 250ms 门控内。此时：
  // - pinned：补一次贴底（门控期间追加的内容）；
  // - unpinned：只有“方向向下 + 本次手势真正到过底部”或“方向向下 +
  //   松手位置 ≤2px”才 re-pin；
  // - 方向向上绝不 re-pin，无论手势中是否到过底部，保持用户当前阅读位置。
  // 判定使用松手快照（方向/落点），而不是松手后的当前 gap：Virtuoso 在
  // 拖到底后还会继续测量/footer，留下 18–287px 残留。
  const recheckFollow = useCallback(() => {
    if (gestureHeld()) return;
    if (anchoredRef.current || restoringRef.current) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
    lastGapRef.current = gap;
    if (pinnedRef.current) {
      if (gap > 2) {
        scroller.scrollTop = scroller.scrollHeight;
        scheduleBottomRetry();
        schedulePinSettle();
      }
      return;
    }
    if (!readyRef.current) return;
    const now = Date.now();
    const release = releaseIntentRef.current;
    // 松手意图只在短窗口内有效；超过窗口的“向下”可能是后续程序化写回，
    // 不能把用户早已停在半路的位置重新拉底。
    const fresh = release !== null && now - release.at <= LIMITS.webScrollReleaseIntentMs;
    const direction = fresh ? release.direction : lastMoveDirectionRef.current;
    const releaseGap = fresh && Number.isFinite(release.gap) ? release.gap : gap;
    const reachedBottom = fresh && release.reachedBottom;
    const directionDown = direction === 'down';
    // 上翻后松手（或兜底解除手势）绝不拉回底部，即使之前到过底部。
    if (!directionDown) return;
    // 到过真实底部时，Virtuoso 的测量残留（46–287px）仍按手势落点吸收；
    // 没到过底部则必须真的停在底部 2px 内，向下停在 85px 不算。
    if (!reachedBottom && releaseGap > 2) return;
    followLatest();
    settleBottom();
    schedulePinSettle();
  }, [
    followLatest,
    gestureHeld,
    scheduleBottomRetry,
    schedulePinSettle,
    scrollerRef,
    settleBottom,
  ]);
  recheckFollowRef.current = recheckFollow;

  // 进入房间时高度先按估算值布局，随后 Markdown/图片/文件卡才给出真实高度。
  // 不能“一次 atBottom 就显示”：那会把估算阶段的回退画给用户。这里在隐藏
  // 状态下逐帧贴底，连续若干帧高度不变且贴底后才显示；最长等
  // webTimelineRevealMaxWaitMs，超时必须显示，不能白屏。
  const watchInitialReveal = useCallback(() => {
    if (readyRef.current || revealWatchRef.current !== 0) return;
    const startedAt = performance.now();
    let lastHeight = -1;
    let stableFrames = 0;
    const tick = () => {
      revealWatchRef.current = 0;
      if (readyRef.current) return;
      const scroller = scrollerRef.current;
      if (!scroller) {
        revealWatchRef.current = requestAnimationFrame(tick);
        return;
      }
      settleBottom();
      const height = Math.round(scroller.scrollHeight);
      const pendingBodies = bodyPending.count();
      if (height === lastHeight) {
        stableFrames += 1;
      } else {
        stableFrames = 0;
        lastHeight = height;
      }
      const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const elapsed = performance.now() - startedAt;
      // 正文还在异步加载（慢 Markdown）时不能只凭“高度稳定”reveal：空气泡
      // 本身就是稳定的。等挂载窗口的正文计数归零；超时上限放宽到
      // webTimelineRevealPendingMaxWaitMs，避免资源挂住时长期白屏。
      const maxWait =
        pendingBodies > 0
          ? LIMITS.webTimelineRevealPendingMaxWaitMs
          : LIMITS.webTimelineRevealMaxWaitMs;
      if (
        elapsed >= maxWait ||
        (pendingBodies === 0 &&
          stableFrames >= LIMITS.webTimelineRevealStableFrames &&
          gap <= 2)
      ) {
        // reveal 的第一帧必须已经在真实底部。
        settleBottom();
        revealWhenSettled();
        return;
      }
      revealWatchRef.current = requestAnimationFrame(tick);
    };
    revealWatchRef.current = requestAnimationFrame(tick);
  }, [bodyPending, revealWhenSettled, scrollerRef, settleBottom]);

  // 首次进入的兜底：即使 atBottom/range 信号都没出现，也要在
  // webTimelineRevealMaxWaitMs 后显示；空会话同样适用。anchor/恢复窗口
  // 由各自路径决定显示时机。
  useEffect(() => {
    if (anchored || restoring) return;
    watchInitialReveal();
  }, [anchored, restoring, watchInitialReveal]);

  const handleAtBottom = useCallback(
    (value: boolean) => {
      atBottomRef.current = value;
      const scrollTop = scrollerRef.current?.scrollTop ?? 0;
      scrollerRef.current?.setAttribute('data-virt-at-bottom', String(value));
      scrollerRef.current?.setAttribute('data-virt-scroll-top', String(Math.round(scrollTop)));
      if (value) {
        lastAtBottomAtRef.current = Date.now();
        // 不在这里标 initialSettled：显示前 scrollTop 仍是 0 时，onScroll
        // 的“到顶即取消贴底”会把入口校正挡掉。等 reveal 时再置位。
        watchInitialReveal();
        if (anchoredRef.current) {
          setPin(false);
          return;
        }
        // Virtuoso 的 atBottom 阈值是 80px，键盘/窗口尺寸变化也会让它报
        // “到底”。只有手指不在屏幕上、且真正贴底（≤2px）或刚在向下滚时
        // 才恢复跟随；否则保持 unpinned，交给「回到最新」。
        if (!pinnedRef.current) {
          if (gestureHeld()) {
            // 手指/指针仍在屏幕上时不能立刻 pin（可能只是路过底部），
            // 但必须安排松手后的复核，否则会永久停在 unpinned。
            schedulePinRecheck();
            return;
          }
          const scroller = scrollerRef.current;
          const gap = scroller
            ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
            : Number.POSITIVE_INFINITY;
          if (gap > 2 && Date.now() - lastDownwardInputRef.current >= 500) return;
          setPin(true);
        }
        scheduleMarkRead(visibleEndRef.current);
        return;
      }
      if (!pinnedRef.current || anchoredRef.current) return;
      // 只有明确的向上意图才取消贴底；向下滚动的惯性/异步长高造成的
      // atBottom=false 必须保持 pinned，交给同步校正贴回底部。触摸方向由
      // touchmove 的位移判定，不能一律当成上翻。
      if (Date.now() - lastUpwardInputRef.current < 500) setPin(false);
    },
    [
      gestureHeld,
      scheduleMarkRead,
      schedulePinRecheck,
      scrollerRef,
      setPin,
      watchInitialReveal,
    ],
  );

  // 手势输入（触摸/指针/滚轮/键盘）、门控与松手快照集中在独立 hook：
  // 事件绑定与方向记录不应挤占贴底判定逻辑，也保持单文件行数上限。
  useTimelineGesture({
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
  });

  // 内容异步长高（Markdown 岛、图片、文件卡）时保持贴底；虚拟化后
  // Virtuoso 只在追加数据时 followOutput，不会自动跟随单条 item 的高度变化。
  //
  // 只观察 item list 的高度，不做整棵 scroller 的 MutationObserver：后者会
  // 对每次挂载、卸载、文本变化强制写 scrollTop，与 Virtuoso 的测量/range
  // 重算互相触发，滚到底部时表现为反复抖动。校正还必须满足：
  // - 需要跟随底部（pinned、入口显示前，或刚在底部且正在向下滚）；
  // - 真实滚动位置确实离底（>2px）。已经在底部时 no-op，避免制造多余的
  //   scroll 事件与 range 重算；
  // - ResizeObserver 回调里同步校正（绘制前），rAF 只作合并兜底。
  useEffect(() => {
    const node = scrollerNode;
    if (!node) return undefined;
    let frame = 0;
    let list: HTMLElement | null = null;
    let retries = 0;
    let mutations: MutationObserver | null = null;
    const needsCorrection = () => {
      if (anchoredRef.current || restoringRef.current) return false;
      if (!wantsBottom()) return false;
      const scroller = scrollerRef.current;
      if (!scroller) return false;
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2;
    };
    const correct = () => {
      // ResizeObserver 会在绘制前同步调用；若已有排队的 rAF，先取消，
      // 避免同一轮高度变化重复写 scrollTop。
      if (frame) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      // 调度后到执行前用户可能已上翻，必须在帧内再次确认。
      if (!needsCorrection()) {
        retries = 0;
        cancelBottomRetry();
        return;
      }
      const scroller = scrollerRef.current;
      if (!scroller) return;
      // Virtuoso 的尺寸缓存可能仍按估算高度计算底部；先让它自己把内部
      // 滚动状态更新到最新（图片/长高场景的官方入口），避免我们写 scrollTop
      // 之后它又按旧锚点写回。再兜底贴真实 scrollHeight。
      virtuosoRef.current?.autoscrollToBottom();
      scroller.scrollTop = scroller.scrollHeight;
      scheduleBottomRetry();
      // Virtuoso 可能在同帧末尾按旧锚点把 scrollTop 写回去；高度变化后的
      // 几帧内继续贴底，直到它稳定。预算有限，避免无限互抢。
      if (retries < 8) {
        retries += 1;
        frame = requestAnimationFrame(correct);
      }
    };
    const schedule = () => {
      retries = 0;
      if (frame || !needsCorrection()) return;
      frame = requestAnimationFrame(correct);
    };
    bottomCorrectionRef.current = schedule;
    // item list 的尺寸变化在绘制前送达：同步贴底，避免先画出一帧空隙。
    // rAF 仍保留给 totalListHeightChanged 等合并路径兜底。
    const observer = new ResizeObserver(() => {
      retries = 0;
      correct();
    });
    const observeContent = () => {
      const next = node.querySelector<HTMLElement>('[data-testid="virtuoso-item-list"]');
      if (next === list) return;
      observer.disconnect();
      mutations?.disconnect();
      list = next;
      if (next) {
        observer.observe(next);
        // Markdown 岛是命令式挂载进 DOM 的，不经过本组件的 React 提交；
        // 只看 item list 的高度变化会漏掉“正文刚插入、尚未测量”的那一帧。
        // MutationObserver 回调是微任务，仍在绘制前；只在真实离底时写
        // scrollTop，已贴底时 no-op，不参与 Virtuoso 的测量循环。
        mutations = new MutationObserver(() => {
          // reveal 后的头几帧 Virtuoso 还在完成首轮测量；此时插入/卸载
          // 节点由 settle、ResizeObserver 与 layout effect 处理，MO 再写
          // scrollTop 会让它重算 range、缩掉已渲染高度（本机 232px 的
          // scrollTop 回退）。MO 只负责 reveal 稳定后的异步晚到内容。
          if (
            readyRef.current &&
            performance.now() - revealedPerfRef.current >= LIMITS.webTimelineMutationSettleMs
          ) {
            snapBottom();
          }
        });
        mutations.observe(next, { childList: true, subtree: true });
      }
    };
    observeContent();
    // Virtuoso 可能在 effect 之后才创建 item list；只补几帧，不做全量 DOM 观察。
    let retry = 0;
    let retryFrame = 0;
    const retryObserve = () => {
      observeContent();
      if (!list && retry < 10) {
        retry += 1;
        retryFrame = requestAnimationFrame(retryObserve);
      }
    };
    if (!list) retryFrame = requestAnimationFrame(retryObserve);
    return () => {
      bottomCorrectionRef.current = () => {};
      observer.disconnect();
      mutations?.disconnect();
      if (frame) cancelAnimationFrame(frame);
      if (retryFrame) cancelAnimationFrame(retryFrame);
    };
  }, [
    cancelBottomRetry,
    items.length,
    scheduleBottomRetry,
    scrollerNode,
    scrollerRef,
    snapBottom,
    virtuosoRef,
    wantsBottom,
  ]);

  // Virtuoso 的 totalListHeight 还包含 header/footer（例如 outbox 行），
  // item list 的 ResizeObserver 覆盖不到；两个信号合并到同一帧校正。
  // 这个回调在测量后、绘制前触发，必须在这里同步贴底：只排 rAF 会先画出
  // 一帧“最新消息上移”，下一帧才跳回底部，就是可见的回退。
  const handleTotalListHeightChanged = useCallback(() => {
    settleBottom();
    bottomCorrectionRef.current();
  }, [settleBottom]);

  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      if (!isAtBottom || anchoredRef.current || restoringRef.current) return false as const;
      // 手指还在屏幕上/刚松手的短窗口内不自动跟随：新消息到达时用户可能
      // 正在上翻，不能把视角拽回底部。
      if (gestureActive()) return false as const;
      return 'auto' as const;
    },
    [gestureActive],
  );

  // 相关提交（items/pinned/ready）后、浏览器绘制前再贴一次底。Virtuoso 的
  // 异步测量/内部滚动状态可能在本组件提交之后才按旧锚点写回 scrollTop；
  // ResizeObserver 与 totalListHeightChanged 都是“事件驱动”的兜底，覆盖不了
  // 这种提交后的写回。只在 pinned 且非 anchor/恢复窗口时执行；gap 已 ≤2 时
  // no-op，同一帧多次提交也只有第一次真正写 scrollTop（幂等合并）。
  // 入口隐藏阶段与 reveal 后走同一条路径：是否显示由 watchInitialReveal 的
  // settle/pending 门控决定，这里不再按“reveal 后 N ms”跳过。
  // 绝不在用户上翻/搜索定位时抢滚动。
  const snapPinnedToBottom = useCallback(() => {
    if (gestureActive()) {
      // 手势期间不要留有排队的残差校正，否则松手瞬间会补一次跳底。
      cancelBottomRetry();
      if (pinnedRef.current) schedulePinRecheck();
      return;
    }
    if (!pinnedRef.current || anchoredRef.current || restoringRef.current) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) {
      cancelBottomRetry();
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
    scheduleBottomRetry();
  }, [
    cancelBottomRetry,
    gestureActive,
    items,
    pinned,
    ready,
    scheduleBottomRetry,
    schedulePinRecheck,
    scrollerRef,
  ]);

  // 明确的“回到最新”意图（按钮、发送、拖到底 re-pin）见上方 followLatest。

  return {
    pinned,
    pinnedRef,
    anchoredRef,
    hasNew,
    ready,
    suppressFollowUntilRef,
    initialSettledRef,
    visibleEndRef,
    setPin,
    setHasNew,
    followOutput,
    revealWhenSettled,
    watchInitialReveal,
    scheduleMarkRead,
    handleAtBottom,
    handleTotalListHeightChanged,
    snapPinnedToBottom,
    followLatest,
  };
}
