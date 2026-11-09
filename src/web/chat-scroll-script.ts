import { LIMITS } from '../contracts/limits';

/**
 * 消息区滚动状态：持久 pinned、底部 sentinel、上翻冻结与已读去抖。
 *
 * 与其它 chat-* 片段拼进同一个内联 `<script>` 共享作用域。这里只维护
 * “是否跟随底部”和 mark_read 调度；消息拉取、渲染与房间切换仍由
 * `chat-session-script.ts` 负责。阈值只来自 `src/contracts/limits.ts`。
 *
 * 关键不变量：
 * - 首次进入房间 pinned；切回恢复阅读锚点，用户上翻立即取消跟随；
 * - 上翻后进入短 suppressPin 窗口，异步高度与 scroll 事件都不得自动回底；
 * - 只有“回到最新”按钮或用户明确向下滚回底部才重新 pinned；
 * - 程序化 scrollTop 写入期间产生的 scroll 事件不得改变 pinned；
 * - pinned 时异步高度变化合并到单个 rAF 钉底，不再每帧重复；
 * - unpinned 时不重绘消息，也不 mark_read，未读红点保留到用户回到底部。
 */
export const CHAT_SCROLL_SCRIPT = `
const SCROLL_STICKY_PX = ${LIMITS.webScrollStickyPx};
const SCROLL_INTENT_PX = ${LIMITS.webScrollIntentPx};
const SCROLL_MARK_READ_DELAY_MS = ${LIMITS.webScrollMarkReadDelayMs};
const SCROLL_SUPPRESS_PIN_MS = ${LIMITS.webScrollSuppressPinMs};
const SCROLL_PROGRAMMATIC_MS = ${LIMITS.webScrollProgrammaticMs};
const SCROLL_USER_IDLE_MS = ${LIMITS.webScrollUserIdleMs};
const SCROLL_ANCHOR_MAX_SHIFT_PX = ${LIMITS.webScrollAnchorMaxShiftPx};

let messagesEndElement = null;
let messagesScrollObserver = null;
let messagesResizeObserver = null;
let scrollTouchY = null;

/** 末尾 1px sentinel：内容被整体重建后重新挂到列表末尾。 */
function ensureMessagesEnd() {
  if (!messagesElement) return null;
  if (!messagesEndElement) {
    messagesEndElement = document.createElement('li');
    messagesEndElement.id = 'messages-end';
    messagesEndElement.className = 'messages-end';
    messagesEndElement.setAttribute('aria-hidden', 'true');
  }
  if (messagesEndElement.parentNode !== messagesElement ||
      messagesElement.lastElementChild !== messagesEndElement) {
    messagesElement.append(messagesEndElement);
  }
  if (messagesScrollObserver) messagesScrollObserver.observe(messagesEndElement);
  return messagesEndElement;
}

const scrollController = (function () {
  let pinned = true;
  let forceNextApply = false;
  let roomId = null;
  let epoch = 0;
  let markReadTimer = null;
  let markReadLastKey = null;
  let markReadInFlightKey = null;
  let markReadNext = null;
  /** 用户上翻后的短窗口：期间任何异步高度都不得把视图拽回底部。 */
  let suppressPinUntil = 0;
  /** 全量重建时落点未知，短窗口内忽略 scroll 事件；已知落点按精确位置判断。 */
  let programmaticUntil = 0;
  /** 程序化写入后的真实 scrollTop；用于识别迟到一帧以上的 scroll 事件。 */
  let programmaticTop = -1;
  /** 用户正在滚动的空闲窗口；期间不做阅读锚点补偿，避免和手势打架。 */
  let userScrollUntil = 0;
  let lastScrollTop = null;
  let lastScrollHeight = -1;
  /** 最近一次钉底后的真实 scrollTop；用于识别外部/用户已经把视口移走。 */
  let lastPinnedBottomTop = -1;
  /** 全量重建消息 DOM 期间 scrollTop 会被钳制，不能据此判定用户上翻。 */
  let contentRebuild = false;
  let pinFrame = 0;
  let trailingPinFrame = 0;
  let captureFrame = 0;
  let anchorElement = null;
  let anchorOffset = 0;
  let anchorUntil = 0;
  // 切回会话时锚点来自明确的消息 ID；首轮 Markdown 重建可能累计改变
  // 数百像素高度。允许跟随这轮布局，任意用户滚动意图立即结束恢复。
  let explicitRoomAnchor = false;
  let anchorRaf = 0;
  let anchorTimer = 0;
  let anchorSettleTimer = 0;
  let anchorIdleTimer = 0;

  function nowMs() {
    return performance.now();
  }

  function distanceFromBottom() {
    if (!messagesElement) return 0;
    return Math.max(
      0,
      messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight
    );
  }

  function hideJumpLatest() {
    if (!jumpLatestButton) return;
    jumpLatestButton.hidden = true;
  }

  function showJumpLatest() {
    if (!jumpLatestButton) return;
    if (jumpLatestLabel) jumpLatestLabel.textContent = '有新消息 · 回到最新';
    jumpLatestButton.hidden = false;
  }

  function cancelPendingPins() {
    if (pinFrame) {
      cancelAnimationFrame(pinFrame);
      pinFrame = 0;
    }
    if (trailingPinFrame) {
      cancelAnimationFrame(trailingPinFrame);
      trailingPinFrame = 0;
    }
  }

  /** 记住程序化写入后的真实位置；浏览器会把 scrollTop 钳制到合法范围。 */
  function markProgrammatic() {
    programmaticUntil = nowMs() + SCROLL_PROGRAMMATIC_MS;
    programmaticTop = messagesElement ? messagesElement.scrollTop : -1;
  }

  /** 钉底：只在 pinned 状态调用；写入期间产生的 scroll 事件会被静默。 */
  function pinToBottom() {
    if (!messagesElement) return;
    messagesElement.scrollTop = messagesElement.scrollHeight;
    markProgrammatic();
    lastPinnedBottomTop = messagesElement.scrollTop;
    contentRebuild = false;
  }

  /**
   * 全量替换消息 DOM 时 scrollTop 会被浏览器夹到 0，随后产生的 scroll
   * 事件不是用户上翻。替换前打开静默窗口。
   */
  function beginContentChange() {
    contentRebuild = true;
    programmaticUntil = nowMs() + SCROLL_PROGRAMMATIC_MS;
    programmaticTop = -1;
  }

  /** 高度补偿产生的 scroll 事件不得被当作“用户上翻”而重设阅读锚点。 */
  function adjustScroll(delta) {
    if (!messagesElement || !delta) return;
    messagesElement.scrollTop += delta;
    markProgrammatic();
  }

  /**
   * 上翻阅读锚点：记录视口内最先相交的消息。之后 Markdown/文件卡片/
   * 回执在上方加高时，用它把同一元素拉回原位置，避免逐项补偿累积漂移。
   */
  function firstVisibleChild() {
    if (!messagesElement) return null;
    const listTop = messagesElement.getBoundingClientRect().top;
    const listBottom = messagesElement.getBoundingClientRect().bottom;
    for (const child of messagesElement.children) {
      // 时间胶囊可能在前插接缝处被删除，不能作为跨 prepend 的稳定锚点。
      if (child === messagesEndElement || child.id === 'history-pager' ||
          child.classList.contains('msg-time')) continue;
      const rect = child.getBoundingClientRect();
      if (rect.top >= listBottom || rect.bottom <= listTop) continue;
      return { element: child, offset: rect.top - listTop };
    }
    return null;
  }

  function firstVisibleMessage() {
    if (!messagesElement) return null;
    const listTop = messagesElement.getBoundingClientRect().top;
    const listBottom = messagesElement.getBoundingClientRect().bottom;
    for (const child of messagesElement.children) {
      if (!child.dataset || child.classList.contains('msg-time')) continue;
      const messageId = child.dataset.messageId || null;
      const presenceId = child.dataset.presenceId || null;
      if (!messageId && !presenceId) continue;
      const rect = child.getBoundingClientRect();
      if (rect.top >= listBottom || rect.bottom <= listTop) continue;
      return {
        messageId: messageId,
        presenceId: presenceId,
        offset: rect.top - listTop
      };
    }
    return null;
  }

  function capturePosition() {
    if (!messagesElement) return { scrollTop: 0, pinned: true, anchor: null };
    reconcilePinned();
    const anchor = firstVisibleMessage();
    return {
      scrollTop: messagesElement.scrollTop,
      pinned: pinned,
      anchor: anchor
    };
  }

  function restoreMessageAnchor(anchor) {
    if (!messagesElement || !anchor) return;
    let target = null;
    for (const child of messagesElement.children) {
      if (!child.dataset) continue;
      if ((anchor.messageId && child.dataset.messageId === anchor.messageId) ||
          (anchor.presenceId && child.dataset.presenceId === anchor.presenceId)) {
        target = child;
        break;
      }
    }
    if (!target) return;
    const listTop = messagesElement.getBoundingClientRect().top;
    const drift = target.getBoundingClientRect().top - listTop - anchor.offset;
    if (Math.abs(drift) >= 0.5) {
      messagesElement.scrollTop += drift;
    }
  }

  function captureAnchor() {
    explicitRoomAnchor = false;
    const target = firstVisibleChild();
    if (!target) {
      anchorElement = null;
      return;
    }
    anchorElement = target.element;
    anchorOffset = target.offset;
    anchorUntil = performance.now() + 30_000;
  }

  /**
   * 记录“向前插入历史”前的视口快照。
   *
   * 只用 scrollTop/scrollHeight 不够：异步 Markdown 高度变化会让高度差失效。
   * 这里同时记住视口首条消息及其相对列表顶部的位置，插入后优先按元素恢复。
   */
  function capturePrependAnchor() {
    if (!messagesElement) return null;
    const target = firstVisibleChild();
    return {
      scrollTop: messagesElement.scrollTop,
      height: messagesElement.scrollHeight,
      element: target ? target.element : null,
      offset: target ? target.offset : 0
    };
  }

  /**
   * 前插完成后恢复视口。
   *
   * - 先按内容高度差补偿，保证前插的消息不会把当前视口推走；
   * - 请求期间用户自己滚动过时，只做高度补偿，不用旧锚点把用户拉回去；
   * - 用户没滚动且锚点仍在 DOM 中时，再按锚点相对位置修正渲染误差，
   *   并把锚点交给后续异步高度恢复使用。
   */
  function restorePrependAnchor(snapshot) {
    if (!messagesElement || !snapshot) return;
    const currentTop = messagesElement.scrollTop;
    const userMoved = Math.abs(currentTop - snapshot.scrollTop) > 1;
    const heightDelta = messagesElement.scrollHeight - snapshot.height;
    if (heightDelta) messagesElement.scrollTop = currentTop + heightDelta;
    if (!userMoved && snapshot.element && snapshot.element.isConnected) {
      const listTop = messagesElement.getBoundingClientRect().top;
      const drift = snapshot.element.getBoundingClientRect().top - listTop - snapshot.offset;
      if (Math.abs(drift) >= 0.5 && Math.abs(drift) <= SCROLL_ANCHOR_MAX_SHIFT_PX) {
        messagesElement.scrollTop += drift;
      }
      anchorElement = snapshot.element;
      anchorOffset = snapshot.offset;
      anchorUntil = performance.now() + 30_000;
    }
    markProgrammatic();
  }

  /** 滚动事件里每帧最多重算一次锚点，避免 200 条消息时每个事件都遍历布局。 */
  function captureAnchorSoon() {
    if (pinned || !messagesElement || captureFrame) return;
    captureFrame = requestAnimationFrame(function () {
      captureFrame = 0;
      if (!pinned) captureAnchor();
    });
  }

  /** 取消待执行的锚点恢复；锚点元素保留，等 captureAnchorSoon 用新位置重算。 */
  function cancelAnchorRestore() {
    if (anchorRaf) {
      cancelAnimationFrame(anchorRaf);
      anchorRaf = 0;
    }
    if (anchorTimer) {
      clearTimeout(anchorTimer);
      anchorTimer = 0;
    }
    if (anchorSettleTimer) {
      clearTimeout(anchorSettleTimer);
      anchorSettleTimer = 0;
    }
    if (anchorIdleTimer) {
      clearTimeout(anchorIdleTimer);
      anchorIdleTimer = 0;
    }
  }

  function clearAnchor() {
    explicitRoomAnchor = false;
    anchorElement = null;
    anchorUntil = 0;
    if (captureFrame) {
      cancelAnimationFrame(captureFrame);
      captureFrame = 0;
    }
    cancelAnchorRestore();
  }

  function restoreAnchor() {
    if (pinned || !messagesElement || !anchorElement) return;
    if (nowMs() < userScrollUntil) return;
    if (!anchorElement.isConnected || performance.now() > anchorUntil) {
      anchorElement = null;
      return;
    }
    const listTop = messagesElement.getBoundingClientRect().top;
    const current = anchorElement.getBoundingClientRect().top - listTop;
    const delta = current - anchorOffset;
    if (Math.abs(delta) < 0.5) return;
    // 锚点被甩出太远：说明视口已经换位置，旧锚点不能再把用户拉回去。
    if (!explicitRoomAnchor && Math.abs(delta) > SCROLL_ANCHOR_MAX_SHIFT_PX) {
      anchorElement = null;
      return;
    }
    adjustScroll(delta);
  }

  function scheduleAnchorRestore() {
    if (pinned || !anchorElement) return;
    // 用户仍在滚动时先等待手势结束，否则补偿会抵消惯性滚动。
    const delay = userScrollUntil - nowMs();
    if (delay > 0) {
      if (!anchorIdleTimer) {
        anchorIdleTimer = setTimeout(function () {
          anchorIdleTimer = 0;
          scheduleAnchorRestore();
        }, delay + 16);
      }
      return;
    }
    if (!anchorRaf) {
      anchorRaf = requestAnimationFrame(function () {
        anchorRaf = 0;
        restoreAnchor();
      });
    }
    if (!anchorTimer) {
      anchorTimer = setTimeout(function () {
        anchorTimer = 0;
        restoreAnchor();
      }, 80);
    }
    if (!anchorSettleTimer) {
      anchorSettleTimer = setTimeout(function () {
        anchorSettleTimer = 0;
        restoreAnchor();
      }, 250);
    }
  }

  /**
   * 视口是否已离开上次钉底位置：内容变高本身不会改变 scrollTop，
   * 只有用户/外部 scrollIntoView 才会把它移走；此时不能再钉底。
   */
  function viewportLeftPinnedBottom() {
    if (!messagesElement || contentRebuild || lastPinnedBottomTop < 0) return false;
    return messagesElement.scrollTop < lastPinnedBottomTop - 1 &&
      distanceFromBottom() > SCROLL_STICKY_PX;
  }

  /**
   * 视口已经离开上次钉底位置时立即取消跟随。
   *
   * 外部 scrollIntoView 的 scroll 事件可能被全量重建窗口吞掉；只依赖事件
   * 会让 pinned 停留在 true，随后的刷新/异步高度就会把用户拽回底部。
   */
  function reconcilePinned() {
    if (!pinned || !viewportLeftPinnedBottom()) return false;
    userScrollUntil = nowMs() + SCROLL_USER_IDLE_MS;
    suppressPinUntil = nowMs() + SCROLL_SUPPRESS_PIN_MS;
    unpin();
    return true;
  }

  /**
   * 内容高度变化：pinned 时合并到单个 rAF 钉底，user 上翻后不再自动回底。
   * 第二个尾帧只覆盖 React/Markdown 在同一任务后继续提交的高度。
   */
  function noteContentChanged() {
    if (!messagesElement) return;
    reconcilePinned();
    if (!pinned) {
      scheduleAnchorRestore();
      return;
    }
    if (nowMs() < suppressPinUntil) return;
    if (pinFrame) return;
    pinFrame = requestAnimationFrame(function () {
      pinFrame = 0;
      if (!pinned || nowMs() < suppressPinUntil) return;
      reconcilePinned();
      if (!pinned) return;
      pinToBottom();
      if (trailingPinFrame) return;
      trailingPinFrame = requestAnimationFrame(function () {
        trailingPinFrame = 0;
        if (!pinned || nowMs() < suppressPinUntil) return;
        reconcilePinned();
        if (!pinned) return;
        pinToBottom();
      });
    });
  }

  function markReadKeyFor(targetRoomId, targetEpoch, headSeq) {
    return String(targetRoomId) + ':' + String(targetEpoch) + ':' + String(headSeq);
  }

  function currentHeadSeq(targetRoomId) {
    if (!room || room.room_id !== targetRoomId) return null;
    return room.head_seq == null ? null : room.head_seq;
  }

  function clearMarkReadTimer() {
    if (!markReadTimer) return;
    clearTimeout(markReadTimer);
    markReadTimer = null;
  }

  /**
   * 只有 pinned 且实际距底 <= sticky 才标记已读；250ms 去抖 + 按
   * room/epoch/head 单飞。重复刷新同一 head 不会再发请求。
   */
  function scheduleMarkRead(targetRoomId, targetEpoch, headSeq) {
    const readRoomId = targetRoomId || roomId;
    const readEpoch = targetEpoch === undefined ? epoch : targetEpoch;
    const readHead = headSeq === undefined || headSeq === null
      ? currentHeadSeq(readRoomId)
      : headSeq;
    if (!readRoomId || readHead === null || readHead === undefined) return;
    if (!pinned || distanceFromBottom() > SCROLL_STICKY_PX) return;
    const key = markReadKeyFor(readRoomId, readEpoch, readHead);
    if (key === markReadLastKey || key === markReadInFlightKey) return;
    clearMarkReadTimer();
    markReadTimer = setTimeout(function () {
      markReadTimer = null;
      if (!pinned || roomId !== readRoomId || epoch !== readEpoch) return;
      if (distanceFromBottom() > SCROLL_STICKY_PX) return;
      if (key === markReadLastKey || key === markReadInFlightKey) return;
      if (markReadInFlightKey) {
        markReadNext = { roomId: readRoomId, epoch: readEpoch, headSeq: readHead };
        return;
      }
      markReadInFlightKey = key;
      Promise.resolve(performMarkRead(readRoomId, readEpoch, readHead))
        .then(function (ok) {
          if (ok) markReadLastKey = key;
        })
        .catch(function () {})
        .then(function () {
          if (markReadInFlightKey === key) markReadInFlightKey = null;
          if (!markReadNext) return;
          const next = markReadNext;
          markReadNext = null;
          scheduleMarkRead(next.roomId, next.epoch, next.headSeq);
        });
    }, SCROLL_MARK_READ_DELAY_MS);
  }

  /**
   * 用户上翻意图：立即取消跟随并打开 suppressPin 窗口。
   * 已经在 unpinned 时只刷新窗口，不再重复计算阅读锚点。
   */
  function unpin() {
    suppressPinUntil = nowMs() + SCROLL_SUPPRESS_PIN_MS;
    cancelPendingPins();
    if (!pinned) return;
    pinned = false;
    clearMarkReadTimer();
    captureAnchor();
  }

  /** 用户明确要求回到底部（按钮/回到最新），或明确向下滚回底部。 */
  function pinNow() {
    pinned = true;
    suppressPinUntil = 0;
    clearAnchor();
    hideJumpLatest();
    pinToBottom();
    scheduleMarkRead();
  }

  function reset(nextRoomId, nextEpoch) {
    clearMarkReadTimer();
    clearAnchor();
    cancelPendingPins();
    markReadLastKey = null;
    markReadInFlightKey = null;
    markReadNext = null;
    pinned = true;
    forceNextApply = false;
    suppressPinUntil = 0;
    programmaticUntil = 0;
    programmaticTop = -1;
    userScrollUntil = 0;
    lastScrollTop = null;
    lastScrollHeight = -1;
    lastPinnedBottomTop = -1;
    contentRebuild = false;
    scrollTouchY = null;
    roomId = nextRoomId || null;
    epoch = Number(nextEpoch) || 0;
    hideJumpLatest();
    ensureMessagesEnd();
    noteContentChanged();
  }

  function noteNewMessage() {
    if (pinned) return;
    showJumpLatest();
  }

  /**
   * scroll 事件只用于“方向意图”：
   * - 向上（delta < 0，且不是内容变矮被钳制）立即 unpin；
   * - 向下且已进入 sticky 区才重新 pin；
   * - 程序化写入（钉底/高度补偿）一律忽略。
   */
  function handleScroll() {
    if (!messagesElement) return;
    const target = messagesElement.scrollTop;
    const height = messagesElement.scrollHeight;
    const previous = lastScrollTop;
    const heightChanged = lastScrollHeight >= 0 && height !== lastScrollHeight;
    lastScrollTop = target;
    lastScrollHeight = height;
    const current = nowMs();
    const gap = distanceFromBottom();
    // 钉底/高度补偿：只有落点正是我们写入的位置才忽略，迟到的 scroll 事件也能识别；
    // 位置对不上说明是用户的滚动或外部 scrollIntoView，必须按真实意图处理。
    const programmatic = programmaticTop >= 0
      ? Math.abs(target - programmaticTop) <= 1
      : current < programmaticUntil;
    if (programmatic) {
      // 外部写入恰好落在底部（或迟到事件）：恢复跟随，避免锚点补偿再把视图拉走。
      if (!pinned && gap <= 0.5) pinNow();
      return;
    }
    if (previous === null) return;
    const delta = target - previous;
    if (Math.abs(delta) < 0.5) return;
    // 真实滚动：旧锚点的恢复定时器作废，避免把刚滚到的位置拉回去。
    cancelAnchorRestore();
    if (delta > 0) {
      userScrollUntil = current + SCROLL_USER_IDLE_MS;
      if (pinned) return;
      if (gap <= SCROLL_STICKY_PX) pinNow();
      else captureAnchorSoon();
      return;
    }
    // 内容变矮时浏览器会把 scrollTop 钳制回新的最大值：仍在底部，不是上翻。
    if (gap <= 0.5) return;
    // 与高度变化同一事件的负位移通常来自钳制（Markdown 先变矮再长高）；
    // 真正的上翻会由 wheel/touch 意图或下一次 scroll 补上。
    if (heightChanged) {
      captureAnchorSoon();
      return;
    }
    userScrollUntil = current + SCROLL_USER_IDLE_MS;
    suppressPinUntil = current + SCROLL_SUPPRESS_PIN_MS;
    if (pinned) unpin();
    else captureAnchorSoon();
  }

  function noteUserScrolling() {
    explicitRoomAnchor = false;
    userScrollUntil = nowMs() + SCROLL_USER_IDLE_MS;
    cancelAnchorRestore();
  }

  function install() {
    if (!messagesElement) return;
    messagesElement.addEventListener('scroll', handleScroll, { passive: true });
    messagesElement.addEventListener('wheel', function (event) {
      if (event.deltaY === 0) return;
      noteUserScrolling();
      if (event.deltaY < 0) unpin();
    }, { passive: true });
    messagesElement.addEventListener('pointerdown', noteUserScrolling, { passive: true });
    messagesElement.addEventListener('touchstart', function (event) {
      noteUserScrolling();
      const touch = event.touches && event.touches[0];
      scrollTouchY = touch ? touch.clientY : null;
    }, { passive: true });
    messagesElement.addEventListener('touchmove', function (event) {
      if (scrollTouchY === null) return;
      const touch = event.touches && event.touches[0];
      if (!touch) return;
      const delta = touch.clientY - scrollTouchY;
      if (delta > SCROLL_INTENT_PX) {
        scrollTouchY = touch.clientY;
        noteUserScrolling();
        unpin();
      } else if (delta < -SCROLL_INTENT_PX) {
        // 反向移动超过阈值后重设基准，避免累计位移误判方向。
        scrollTouchY = touch.clientY;
      }
    }, { passive: true });
    messagesElement.addEventListener('touchend', function () {
      scrollTouchY = null;
    }, { passive: true });
    document.addEventListener('keydown', function (event) {
      const key = event.key;
      const up = key === 'PageUp' || key === 'Home' || key === 'ArrowUp';
      if (!up && key !== 'PageDown' && key !== 'End' && key !== 'ArrowDown' && key !== ' ') return;
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
          target.isContentEditable)) return;
      noteUserScrolling();
      if (up) unpin();
    });
    if (typeof IntersectionObserver === 'function') {
      messagesScrollObserver = new IntersectionObserver(function (entries) {
        if (!entries.length) return;
        // sentinel 离开 80px 底部窗口且仍 pinned：内容刚长高，下一帧补钉。
        if (!entries[entries.length - 1].isIntersecting && pinned) noteContentChanged();
      }, {
        root: messagesElement,
        rootMargin: '0px 0px ' + SCROLL_STICKY_PX + 'px 0px',
        threshold: 0
      });
      ensureMessagesEnd();
    }
    if (typeof ResizeObserver === 'function') {
      messagesResizeObserver = new ResizeObserver(function () {
        noteContentChanged();
      });
      messagesResizeObserver.observe(messagesElement);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { noteContentChanged(); }).catch(function () {});
    }
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        noteContentChanged();
      });
    }
  }

  return {
    install: install,
    reset: reset,
    isPinned: function () {
      reconcilePinned();
      return pinned;
    },
    distanceFromBottom: distanceFromBottom,
    noteContentChanged: noteContentChanged,
    beginContentChange: beginContentChange,
    adjustScroll: adjustScroll,
    captureAnchor: captureAnchor,
    restoreAnchor: restoreAnchor,
    capturePrependAnchor: capturePrependAnchor,
    restorePrependAnchor: restorePrependAnchor,
    noteNewMessage: noteNewMessage,
    pinNow: pinNow,
    unpin: unpin,
    scrollToBottom: function () {
      pinned = true;
      suppressPinUntil = 0;
      clearAnchor();
      pinToBottom();
      noteContentChanged();
    },
    /** Restore a cached viewport without turning historical reading into a read action. */
    capturePosition: capturePosition,
    restorePosition: function (top, shouldPin, anchor) {
      if (!messagesElement) return;
      cancelPendingPins();
      clearAnchor();
      forceNextApply = false;
      suppressPinUntil = nowMs() + SCROLL_SUPPRESS_PIN_MS;
      const maxTop = Math.max(0, messagesElement.scrollHeight - messagesElement.clientHeight);
      const requestedTop = Number.isFinite(Number(top)) ? Number(top) : maxTop;
      messagesElement.scrollTop = Math.max(0, Math.min(requestedTop, maxTop));
      contentRebuild = false;
      pinned = Boolean(shouldPin) && distanceFromBottom() <= SCROLL_STICKY_PX;
      if (pinned) {
        suppressPinUntil = 0;
        clearAnchor();
        hideJumpLatest();
        pinToBottom();
      } else {
        restoreMessageAnchor(anchor);
        markProgrammatic();
        lastScrollTop = messagesElement.scrollTop;
        lastScrollHeight = messagesElement.scrollHeight;
        captureAnchor();
        explicitRoomAnchor = Boolean(anchor);
      }
    },
    pinNextApply: function () {
      pinned = true;
      forceNextApply = true;
      suppressPinUntil = 0;
      clearAnchor();
      hideJumpLatest();
      pinToBottom();
      noteContentChanged();
    },
    hasPinNextApply: function () { return forceNextApply; },
    clearPinNextApply: function () { forceNextApply = false; },
    scheduleMarkRead: scheduleMarkRead,
    close: function () {
      reset(null, epoch + 1);
    }
  };
})();

scrollController.install();
`;
