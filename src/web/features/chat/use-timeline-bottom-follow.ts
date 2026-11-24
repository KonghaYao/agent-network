import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';

import { LIMITS } from '../../../contracts/limits';
import { renderedWatermark, type HistoryItem } from '../../lib/chat';
import type { BodyPendingRegistry } from './body-pending';

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

  // 是否应跟随底部：pinned；首次显示前默认为真；或用户刚从底部向下滚、
  // 尚未出现向上意图（到达瞬间 Virtuoso 的 atBottom 回调可能晚一两帧）。
  const wantsBottom = useCallback(() => {
    if (!readyRef.current || pinnedRef.current) return true;
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
  }, []);

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
  }, [scrollerRef, virtuosoRef]);

  const scheduleBottomRetry = useCallback(() => {
    if (!readyRef.current) return;
    const state = bottomRetryRef.current;
    if (state.frame !== 0) return;
    state.attempts = 0;
    state.frame = requestAnimationFrame(bottomRetryTick);
  }, [bottomRetryTick]);

  useEffect(() => cancelBottomRetry, [cancelBottomRetry]);

  // MutationObserver 的轻量贴底：只看 markdown/文件卡插入后的真实 gap，
  // 不在同一微任务里触发 scrollToIndex（那会让 Virtuoso 在 reveal 瞬间
  // 重算 range 并缩掉已渲染高度）。残差交给下一帧的 scroll/layout 校验。
  const snapBottom = useCallback(() => {
    if (anchoredRef.current || restoringRef.current) return;
    if (!wantsBottom()) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) return;
    scroller.scrollTop = scroller.scrollHeight;
  }, [scrollerRef, wantsBottom]);

  // 只用于“已经在贴底”的同步修正：pinned 且非 anchor/恢复窗口，且真实
  // 离底超过 2px。直接写 scrollTop 发生在同一帧内（totalListHeightChanged
  // 与 ResizeObserver 都在绘制前），避免先画出一帧“消息整体上移”。
  const settleBottom = useCallback(() => {
    if (anchoredRef.current || restoringRef.current) return;
    // 首次显示前还没有用户手势可尊重：无条件贴底，保证 reveal 的第一帧
    // 就在真实底部。显示后只跟随 pinned / 到达中的向下手势。
    if (!wantsBottom()) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) {
      cancelBottomRetry();
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
    scheduleBottomRetry();
  }, [cancelBottomRetry, scheduleBottomRetry, scrollerRef, wantsBottom]);

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
        // Virtuoso 的高度测量可能连续触发 atBottom=true；已经 pinned 时
        // 不重复 setState，只保留首次到底/新水位时的已读调度。
        if (!pinnedRef.current) setPin(true);
        scheduleMarkRead(visibleEndRef.current);
        return;
      }
      if (!pinnedRef.current || anchoredRef.current) return;
      // 只有近期“向上”意图才取消贴底；向下滚动的惯性/异步长高造成的
      // atBottom=false 必须保持 pinned，交给同步校正贴回底部。
      if (Date.now() - lastUpwardInputRef.current < 500) setPin(false);
    },
    [scheduleMarkRead, scrollerRef, setPin, watchInitialReveal],
  );

  useEffect(() => {
    const node = scrollerNode;
    if (!node) return undefined;
    const mark = (event: Event) => {
      if (event.type === 'wheel') {
        const delta = (event as WheelEvent).deltaY;
        if (delta < 0) {
          lastUpwardInputRef.current = Date.now();
          setPin(false);
        } else if (delta > 0) {
          // 向下滚动明确取消“向上意图”，记录“正在向底部走”，允许到达
          // 瞬间的高度测量同步贴底。
          lastUpwardInputRef.current = 0;
          lastDownwardInputRef.current = Date.now();
        }
        return;
      }
      if (event.type === 'keydown') {
        const key = (event as KeyboardEvent).key;
        if (key === 'PageUp' || key === 'ArrowUp' || key === 'Home') {
          lastUpwardInputRef.current = Date.now();
          setPin(false);
        }
        return;
      }
      lastUpwardInputRef.current = Date.now();
    };
    const onScroll = () => {
      const gap = node.scrollHeight - node.scrollTop - node.clientHeight;
      if (gap <= LIMITS.webScrollStickyPx) lastAtBottomAtRef.current = Date.now();
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
      // 向下手势真正到达底部时立即 pinned，不等 Virtuoso 的 atBottom 回调。
      // 超高消息测量可能持续几百毫秒，回调晚到时不能用 500ms 输入窗口兜底。
      if (
        !pinnedRef.current &&
        !anchoredRef.current &&
        !restoringRef.current &&
        gap <= 2 &&
        Date.now() - lastDownwardInputRef.current < 500 &&
        Date.now() - lastUpwardInputRef.current >= 500
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
    };
    node.addEventListener('wheel', mark, { passive: true });
    node.addEventListener('touchstart', mark, { passive: true });
    node.addEventListener('touchmove', mark, { passive: true });
    node.addEventListener('pointerdown', mark, { passive: true });
    node.addEventListener('keydown', mark);
    node.addEventListener('scroll', onScroll, { passive: true });
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
      node.removeEventListener('pointerdown', mark);
      node.removeEventListener('keydown', mark);
      node.removeEventListener('scroll', onScroll);
      node.removeEventListener('load', onImageLoad, true);
    };
  }, [scrollerNode, setPin, settleBottom]);

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
      return 'auto' as const;
    },
    [],
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
    if (!pinnedRef.current || anchoredRef.current || restoringRef.current) return;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 2) {
      cancelBottomRetry();
      return;
    }
    scroller.scrollTop = scroller.scrollHeight;
    scheduleBottomRetry();
  }, [cancelBottomRetry, items, pinned, ready, scheduleBottomRetry, scrollerRef]);

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
  };
}
