import { LIMITS } from '../contracts/limits';

/**
 * 消息区滚动状态：持久 pinned、底部 sentinel、上翻冻结与已读去抖。
 *
 * 与其它 chat-* 片段拼进同一个内联 `<script>` 共享作用域。这里只维护
 * “是否跟随底部”和 mark_read 调度；消息拉取、渲染与房间切换仍由
 * `chat-session-script.ts` 负责。阈值只来自 `src/contracts/limits.ts`。
 *
 * 关键不变量：
 * - 进入/切换房间一律 pinned；用户上翻由 wheel/touch/按键意图立即取消；
 * - pinned 时任何异步高度变化都通过 `noteContentChanged()` 在 rAF 中钉底；
 * - unpinned 时不重绘消息，也不 mark_read，未读红点保留到用户回到底部。
 */
export const CHAT_SCROLL_SCRIPT = `
const SCROLL_STICKY_PX = ${LIMITS.webScrollStickyPx};
const SCROLL_UNPIN_PX = ${LIMITS.webScrollUnpinPx};
const SCROLL_INTENT_PX = ${LIMITS.webScrollIntentPx};
const SCROLL_MARK_READ_DELAY_MS = ${LIMITS.webScrollMarkReadDelayMs};

let messagesEndElement = null;
let messagesScrollObserver = null;
let messagesResizeObserver = null;
let scrollFrame = 0;
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
  let suppressScrollUntil = 0;
  let anchorElement = null;
  let anchorOffset = 0;
  let anchorUntil = 0;
  let anchorRaf = 0;
  let anchorTimer = 0;
  let anchorSettleTimer = 0;

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

  /** 程序化滚动会立刻产生 scroll 事件，短窗口内忽略，避免误判用户上翻。 */
  function pinToBottom() {
    if (!messagesElement) return;
    suppressScrollUntil = performance.now() + 50;
    messagesElement.scrollTop = messagesElement.scrollHeight;
  }

  /**
   * 全量替换消息 DOM 时 scrollTop 会被浏览器夹到 0，随后产生的 scroll
   * 事件不是用户上翻。替换前打开更长的静默窗口。
   */
  function beginContentChange() {
    suppressScrollUntil = performance.now() + 150;
  }

  /** 高度补偿产生的 scroll 事件不得被当作“用户上翻”而重设阅读锚点。 */
  function adjustScroll(delta) {
    if (!messagesElement || !delta) return;
    suppressScrollUntil = performance.now() + 80;
    messagesElement.scrollTop += delta;
  }

  /**
   * 上翻阅读锚点：记录视口内最下方消息的 top。之后 Markdown/文件卡片/
   * 回执在上方加高时，用它把同一元素拉回原位置，避免逐项补偿累积漂移。
   */
  function captureAnchor() {
    if (!messagesElement) return;
    const listTop = messagesElement.getBoundingClientRect().top;
    const listBottom = messagesElement.getBoundingClientRect().bottom;
    let target = null;
    for (const child of messagesElement.children) {
      if (child === messagesEndElement) continue;
      const rect = child.getBoundingClientRect();
      if (rect.top >= listBottom || rect.bottom <= listTop) continue;
      target = child;
      break;
    }
    if (!target) {
      anchorElement = null;
      return;
    }
    anchorElement = target;
    anchorOffset = target.getBoundingClientRect().top - listTop;
    anchorUntil = performance.now() + 30_000;
  }

  function clearAnchor() {
    anchorElement = null;
    anchorUntil = 0;
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
  }

  function restoreAnchor() {
    if (pinned || !messagesElement || !anchorElement) return;
    if (!anchorElement.isConnected || performance.now() > anchorUntil) {
      anchorElement = null;
      return;
    }
    const listTop = messagesElement.getBoundingClientRect().top;
    const current = anchorElement.getBoundingClientRect().top - listTop;
    const delta = current - anchorOffset;
    if (Math.abs(delta) < 0.5) return;
    adjustScroll(delta);
  }

  function scheduleAnchorRestore() {
    if (pinned || !anchorElement) return;
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

  function nextFramePin() {
    if (!pinned) return;
    requestAnimationFrame(function () {
      if (!pinned) return;
      pinToBottom();
    });
  }

  function noteContentChanged() {
    if (!pinned) {
      scheduleAnchorRestore();
      return;
    }
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(function () {
      scrollFrame = 0;
      if (!pinned) return;
      pinToBottom();
      // 第二帧覆盖同一任务内继续挂载 Markdown / 文件卡片造成的高度。
      nextFramePin();
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

  function unpin() {
    if (!pinned) {
      captureAnchor();
      return;
    }
    pinned = false;
    clearMarkReadTimer();
    captureAnchor();
  }

  function pinNow() {
    pinned = true;
    clearAnchor();
    hideJumpLatest();
    pinToBottom();
    noteContentChanged();
    scheduleMarkRead();
  }

  function reset(nextRoomId, nextEpoch) {
    clearMarkReadTimer();
    clearAnchor();
    markReadLastKey = null;
    markReadInFlightKey = null;
    markReadNext = null;
    pinned = true;
    forceNextApply = false;
    roomId = nextRoomId || null;
    epoch = Number(nextEpoch) || 0;
    scrollTouchY = null;
    hideJumpLatest();
    ensureMessagesEnd();
    noteContentChanged();
  }

  function noteNewMessage() {
    if (pinned) return;
    showJumpLatest();
  }

  function handleScroll() {
    if (performance.now() < suppressScrollUntil) return;
    const gap = distanceFromBottom();
    if (gap <= SCROLL_STICKY_PX) {
      if (!pinned) pinNow();
      return;
    }
    if (gap > SCROLL_UNPIN_PX) {
      if (pinned) unpin();
      else captureAnchor();
    }
  }

  function install() {
    if (!messagesElement) return;
    messagesElement.addEventListener('scroll', handleScroll, { passive: true });
    messagesElement.addEventListener('wheel', function (event) {
      if (event.deltaY < 0 && distanceFromBottom() > 0) unpin();
    }, { passive: true });
    messagesElement.addEventListener('touchstart', function (event) {
      const touch = event.touches && event.touches[0];
      scrollTouchY = touch ? touch.clientY : null;
    }, { passive: true });
    messagesElement.addEventListener('touchmove', function (event) {
      if (scrollTouchY === null) return;
      const touch = event.touches && event.touches[0];
      if (!touch) return;
      if (touch.clientY - scrollTouchY > SCROLL_INTENT_PX) {
        scrollTouchY = null;
        unpin();
      }
    }, { passive: true });
    messagesElement.addEventListener('touchend', function () {
      scrollTouchY = null;
    }, { passive: true });
    document.addEventListener('keydown', function (event) {
      const key = event.key;
      if (key !== 'PageUp' && key !== 'Home' && key !== 'ArrowUp') return;
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' ||
          target.isContentEditable)) return;
      if (distanceFromBottom() > 0) unpin();
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
    isPinned: function () { return pinned; },
    distanceFromBottom: distanceFromBottom,
    noteContentChanged: noteContentChanged,
    beginContentChange: beginContentChange,
    adjustScroll: adjustScroll,
    captureAnchor: captureAnchor,
    restoreAnchor: restoreAnchor,
    noteNewMessage: noteNewMessage,
    pinNow: pinNow,
    unpin: unpin,
    scrollToBottom: function () {
      pinned = true;
      clearAnchor();
      pinToBottom();
      noteContentChanged();
    },
    pinNextApply: function () {
      pinned = true;
      forceNextApply = true;
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
