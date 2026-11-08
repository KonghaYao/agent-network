import { LIMITS } from '../contracts/limits';

/**
 * 统一 actor stream（`agentnet://stream`）客户端片段。
 *
 * 每个页面只保留一条长连接，切换房间不重建；首页也启动。事件信封位于
 * `params._meta["io.agent-network/event"]`，本片段只负责解析来源并触发
 * UI 刷新，不弹窗、不发声、不写 `#status`。
 *
 * 由 `chatClientScript` 拼进同一个内联 `<script>`，与其他片段共享作用域。
 */
export const CHAT_STREAM_SCRIPT = `
const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META_KEY = 'io.agent-network/event';
// 这些错误不是网络抖动：继续退避只会制造无意义请求。
// RATE_LIMITED 在 stream 路径上只表示当前身份已有上限条物理连接
// （其他标签页/设备），重试不会自愈，必须停下来提示用户处理。
const STREAM_FATAL_CODES = [
  'CREDENTIAL_INVALID',
  'INVALID_ARGUMENT',
  'NOT_MEMBER',
  'FORBIDDEN',
  'PERMISSION_DENIED',
  'UNAUTHORIZED',
  'ACTOR_NOT_FOUND',
  'RATE_LIMITED'
];
const STREAM_CONNECTION_LIMIT = ${LIMITS.streamConnectionsPerActor};
const STREAM_RECONNECT_BASE_MS = ${LIMITS.reconnectBaseMs};
const STREAM_RECONNECT_MAX_MS = ${LIMITS.reconnectMaxMs};
const STREAM_RECONNECT_JITTER_RATIO = ${LIMITS.reconnectJitterRatio};
const STREAM_RECONNECT_STABLE_MS = ${LIMITS.reconnectStableMs};
// 瞬时失败保持静默；连续失败达到该次数（或持续超过该时长）才给非阻塞提示。
const STREAM_BANNER_AFTER_FAILURES = 3;
const STREAM_BANNER_AFTER_MS = 30000;
const STREAM_SEEN_EVENT_LIMIT = 500;

let streamStopped = true;
let streamTask = 0;
let streamController = null;
let streamReader = null;
let streamReconnectTimer = null;
let streamRetryResolve = null;
let streamStableTimer = null;
let streamCatchUpTimer = null;
let roomListRefreshTimer = null;
let streamConnected = false;
let streamHadAck = false;
let streamAttempt = 0;
let streamFailures = 0;
let streamFailureStartedAt = 0;
const streamSeenEventIds = new Set();

function streamDebug(message, detail) {
  if (detail === undefined) console.debug('[agentnet-stream] ' + message);
  else console.debug('[agentnet-stream] ' + message, detail);
}

/** 断线状态只用侧栏一个小圆点表示；详细原因放 title/aria-label，不显示长句。 */
function setStreamStatus(text) {
  const value = text || '';
  if (!streamDotElement) return;
  streamDotElement.textContent = '';
  streamDotElement.hidden = !value;
  streamDotElement.title = value;
  streamDotElement.setAttribute('aria-label', value);
  if (!value) {
    streamDotElement.removeAttribute('data-state');
  } else if (value.indexOf('已停止') >= 0) {
    streamDotElement.setAttribute('data-state', 'stopped');
  } else {
    streamDotElement.removeAttribute('data-state');
  }
}

function parseSseBlock(block) {
  const lines = block.split('\\n');
  const dataLines = [];
  for (const line of lines) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  return dataLines.join('\\n');
}

function isFatalStreamCode(code) {
  return typeof code === 'string' && STREAM_FATAL_CODES.indexOf(code) >= 0;
}

/** 终止提示按错误码区分：连接数上限需要用户关闭其他页面，不是网络故障。 */
function streamStopStatus(failure) {
  if (failure && failure.code === 'RATE_LIMITED') {
    return '实时连接已停止：当前身份已有 ' + STREAM_CONNECTION_LIMIT +
      ' 条实时连接（可能在其他标签页或设备打开），请关闭其他页面后刷新';
  }
  return '实时连接已停止：' +
    (failure && failure.message ? failure.message : '未知错误');
}

function computeStreamBackoff(attempt) {
  const exponent = Math.max(0, attempt - 1);
  const base = Math.min(
    STREAM_RECONNECT_MAX_MS,
    STREAM_RECONNECT_BASE_MS * Math.pow(2, exponent)
  );
  const jitter = 1 + ((Math.random() * 2) - 1) * STREAM_RECONNECT_JITTER_RATIO;
  return Math.max(0, Math.round(base * jitter));
}

function rememberStreamEvent(eventId) {
  streamSeenEventIds.add(eventId);
  if (streamSeenEventIds.size <= STREAM_SEEN_EVENT_LIMIT) return;
  const oldest = streamSeenEventIds.values().next().value;
  if (oldest !== undefined) streamSeenEventIds.delete(oldest);
}

function clearStreamTimers() {
  if (streamReconnectTimer) {
    clearTimeout(streamReconnectTimer);
    streamReconnectTimer = null;
  }
  if (streamRetryResolve) {
    const resolve = streamRetryResolve;
    streamRetryResolve = null;
    resolve();
  }
  if (streamStableTimer) {
    clearTimeout(streamStableTimer);
    streamStableTimer = null;
  }
  if (streamCatchUpTimer) {
    clearTimeout(streamCatchUpTimer);
    streamCatchUpTimer = null;
  }
  if (roomListRefreshTimer) {
    clearTimeout(roomListRefreshTimer);
    roomListRefreshTimer = null;
  }
}

/** 先取消 reader 再 abort；只 abort 可能让旧 SSE 继续占用同源连接池。 */
function closeStreamTransport() {
  const reader = streamReader;
  streamReader = null;
  if (reader) {
    try {
      reader.cancel().catch(function () {});
    } catch (error) {
      // reader 可能已经被浏览器关闭。
    }
  }
  const controller = streamController;
  streamController = null;
  if (controller) controller.abort();
}

function waitForStreamRetry(delay) {
  return new Promise(function (resolve) {
    streamRetryResolve = resolve;
    streamReconnectTimer = setTimeout(function () {
      streamReconnectTimer = null;
      streamRetryResolve = null;
      resolve();
    }, delay);
  });
}

/**
 * 页面恢复可见或网络恢复时提前结束退避。
 *
 * 不重置 attempt，避免反复 online 造成 1s 抖动风暴；正在建立连接时
 * abort 当前请求，由循环按同一套退避重新开始。
 */
function retryActorStreamNow() {
  if (streamStopped || streamConnected) return;
  if (streamReconnectTimer) {
    clearTimeout(streamReconnectTimer);
    streamReconnectTimer = null;
    const resolve = streamRetryResolve;
    streamRetryResolve = null;
    if (resolve) resolve();
    return;
  }
  if (streamController) {
    streamDebug('retry requested while connecting');
    streamController.abort();
  }
}

function noteStreamConnected() {
  streamConnected = true;
  streamFailures = 0;
  streamFailureStartedAt = 0;
  setStreamStatus('');
  if (streamStableTimer) clearTimeout(streamStableTimer);
  streamStableTimer = setTimeout(function () {
    streamStableTimer = null;
    if (streamConnected) streamAttempt = 0;
  }, STREAM_RECONNECT_STABLE_MS);
}

function noteStreamFailure(failure) {
  if (streamFailures === 0) streamFailureStartedAt = Date.now();
  streamFailures += 1;
  streamDebug(
    'stream disconnected: ' +
      (failure && failure.message ? failure.message : 'unknown') +
      (failure && failure.code ? ' [' + failure.code + ']' : '')
  );
  const elapsed = Date.now() - streamFailureStartedAt;
  if (streamFailures >= STREAM_BANNER_AFTER_FAILURES || elapsed >= STREAM_BANNER_AFTER_MS) {
    setStreamStatus('实时连接暂时不可用，正在自动重试…');
  }
}

/** 断线恢复后补拉：列表用 network_rooms_list，当前房间用 history 刷新。 */
function scheduleStreamCatchUp() {
  if (streamCatchUpTimer) return;
  streamCatchUpTimer = setTimeout(function () {
    streamCatchUpTimer = null;
    if (streamStopped) return;
    scheduleRoomListRefresh(true);
    // 断线期间可能有已提交但未收到响应的发送，重连后先对账。
    outboxScheduleReconcile(0);
    if (activeRoomId) {
      // 断线期间可能错过任务事件；让房间刷新重新读取任务列表。
      invalidateRoomTasks();
      scheduleRoomRefresh(activeRoomId);
      scheduleFilesRefresh(activeRoomId);
    }
  }, 0);
}

function scheduleRoomListRefresh(urgent) {
  if (urgent && roomListRefreshTimer) {
    clearTimeout(roomListRefreshTimer);
    roomListRefreshTimer = null;
  }
  if (roomListRefreshTimer) return;
  roomListRefreshTimer = setTimeout(function () {
    roomListRefreshTimer = null;
    Promise.resolve(roomsPromise).then(function () {
      if (!streamStopped) return loadRooms();
    }).catch(function (error) {
      streamDebug('list refresh failed', error && error.message ? error.message : String(error));
    });
  }, urgent ? 0 : WEB_REFRESH_DEBOUNCE_MS);
}

/**
 * 订阅建立后按“订阅 → login → 补拉”的顺序恢复会话。
 * Web 身份是 human，不需要 network_login。
 */
function afterStreamConnected(task, isReconnect) {
  ensureIdentity().then(function (me) {
    if (task !== streamTask || streamStopped) return undefined;
    if (me && me.kind === 'agent') {
      return callTool('network_login', {}).catch(function (error) {
        streamDebug('login after ack failed', error && error.message ? error.message : String(error));
      }).then(function () {
        if (task === streamTask && !streamStopped) {
          if (isReconnect) scheduleStreamCatchUp();
          syncCatchUp();
        }
      });
    }
    if (isReconnect) scheduleStreamCatchUp();
    syncCatchUp();
    return undefined;
  }).catch(function (error) {
    streamDebug('identity after ack failed', error && error.message ? error.message : String(error));
  });
}

/** 按 source 更新当前房间与侧栏；attention 只影响刷新速度，不打扰用户。 */
function handleStreamEventFrame(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (payload.v !== undefined && Number(payload.v) !== 1) return;
  const items = Array.isArray(payload.items) ? payload.items : [];
  let urgent = payload.attention === 'action_required';
  const selfId = identity && identity.actor_id ? identity.actor_id : '';
  let refreshRoom = false;
  let refreshList = false;
  let leaveRoom = false;

  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const eventId = rawItem.event_id !== undefined
      ? String(rawItem.event_id)
      : rawItem.seq !== undefined ? String(rawItem.seq) : '';
    if (eventId) {
      if (streamSeenEventIds.has(eventId)) continue;
      rememberStreamEvent(eventId);
    }
    const source = typeof rawItem.source === 'string' ? rawItem.source : '';
    const kind = typeof rawItem.kind === 'string' ? rawItem.kind : '';
    if (rawItem.attention === 'action_required') urgent = true;
    const roomId = typeof rawItem.room_id === 'string' ? rawItem.room_id : '';
    switch (source) {
      case 'room.message':
        // 服务端已排除发送者；保留防御，避免自己的发送刷新造成重复渲染。
        if (selfId && rawItem.sender_id === selfId) break;
        refreshList = true;
        if (roomId && roomId === activeRoomId) {
          refreshRoom = true;
          // 上翻阅读时不打断；只显示通用“有新消息”，不伪造条数。
          if (!scrollController.isPinned()) scrollController.noteNewMessage();
        }
        break;
      case 'delivery.created':
      case 'delivery.updated':
      case 'delivery.cancelled':
      case 'delivery.retried':
        // 回执即使 sender_id 指向自己也要刷新，发送方需要看到 claimed/completed。
        refreshList = true;
        if (roomId && roomId === activeRoomId) refreshRoom = true;
        break;
      case 'room.created':
      case 'room.read':
        refreshList = true;
        break;
      case 'room.membership': {
        refreshList = true;
        const removedSelf = roomId && rawItem.change === 'removed' &&
          selfId && rawItem.subject_id === selfId;
        if (removedSelf) discardRoomCache(roomId);
        if (roomId && roomId === activeRoomId) {
          if (removedSelf) leaveRoom = true;
          else refreshRoom = true;
        }
        break;
      }
      case 'room.file':
        // 文件通知只刷新文件面板；非当前房间标脏缓存，下次打开再拉取。
        if (roomId) scheduleFilesRefresh(roomId);
        break;
      case 'room.presence':
        // 上下线只更新当前房间时间线；不改 head、不产生未读或侧栏预览。
        if (roomId && roomId === activeRoomId) refreshRoom = true;
        break;
      case 'task.updated':
        // 任务事件只刷新任务面板、我的任务与侧栏 badge，不触发消息未读；
        // 任务卡片本身是普通消息，历史仍由 room.message 维护。
        if (rawItem.change === 'offered') showToast('收到任务接手请求');
        scheduleRoomTasksRefresh(roomId);
        break;
      case 'room.tasks':
        // 历史房间任务事件只刷新任务行与侧栏 badge，不触发消息历史刷新或未读。
        scheduleRoomTasksRefresh(roomId);
        break;
      case 'profile.updated':
        refreshList = true;
        break;
      case 'contact':
        // 好友申请与关系变化只提示刷新，不是待办，也不产生房间刷新。
        refreshContactBadge();
        if (contactModal && !contactModal.hidden) loadContactRequests();
        break;
      case 'device':
        // 设备安全事件只让已打开的配对弹窗刷新；不产生待办或房间未读。
        window.dispatchEvent(new CustomEvent('agentnet:device'));
        break;
      case 'mention.reminder':
        // human 个人提醒不是待办，也不产生 delivery；当前房间已在看消息时
        // 只刷新列表，不重复弹提示。
        refreshList = true;
        if (!roomId || roomId !== activeRoomId) {
          showToast(rawItem.mention_all ? '群聊 @所有人 提醒' : '有人在群聊中提到了你');
        }
        break;
      case 'session.login':
        break;
      default:
        streamDebug('ignored source', {
          source: source || '(missing)',
          kind: kind,
          seq: rawItem.seq,
          message_id: rawItem.message_id,
          delivery_id: rawItem.delivery_id
        });
    }
  }

  if (payload.more || Number(payload.dropped) > 0) {
    streamDebug('frame truncated; scheduling catch-up');
    scheduleStreamCatchUp();
  }
  if (leaveRoom && activeRoomId) {
    streamDebug('removed from active room', activeRoomId);
    navigateTo('/', { replace: true });
  } else if (refreshRoom && activeRoomId) {
    scheduleRoomRefresh(activeRoomId);
  }
  if (refreshList) scheduleRoomListRefresh(urgent);
}

function isStreamAck(message) {
  if (!message || message.method !== 'notifications/subscriptions/acknowledged') return false;
  const subscriptions =
    message.params &&
    message.params.notifications &&
    message.params.notifications.resourceSubscriptions;
  return Array.isArray(subscriptions) && subscriptions.indexOf(STREAM_URI) >= 0;
}

function handleStreamNotification(message) {
  if (!message || message.method !== 'notifications/resources/updated') return;
  const params = message.params;
  if (!params || params.uri !== STREAM_URI) return;
  const meta = params._meta;
  const payload = meta ? meta[STREAM_EVENT_META_KEY] : null;
  if (!payload || typeof payload !== 'object') {
    streamDebug('notification without event envelope');
    return;
  }
  handleStreamEventFrame(payload);
}

async function readActorStream(reader, task) {
  const decoder = new TextDecoder();
  let buffer = '';
  let ackedAt = 0;
  while (!streamStopped && streamTask === task) {
    const step = await reader.read();
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true }).replaceAll('\\r\\n', '\\n');
    let boundary = buffer.indexOf('\\n\\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = parseSseBlock(block);
      if (data) {
        let message = null;
        try {
          message = JSON.parse(data);
        } catch (error) {
          message = null;
        }
        if (message) {
          if (!ackedAt && isStreamAck(message)) {
            ackedAt = Date.now();
            const isReconnect = streamHadAck || streamAttempt > 0;
            streamHadAck = true;
            noteStreamConnected();
            afterStreamConnected(task, isReconnect);
          } else if (message.method === 'notifications/resources/updated') {
            handleStreamNotification(message);
          } else if (message.result && message.result.resultType === 'complete') {
            streamDebug('stream completed by server');
          }
        }
      }
      boundary = buffer.indexOf('\\n\\n');
    }
  }
  return ackedAt;
}

async function streamResponseFailure(response) {
  let message = '';
  let code = '';
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    text = '';
  }
  if (text) {
    try {
      const payload = JSON.parse(text);
      const failure = payload && payload.error;
      if (failure) {
        if (typeof failure.message === 'string') message = failure.message;
        if (failure.data && typeof failure.data.code === 'string') code = failure.data.code;
      }
    } catch (error) {
      // 非 JSON 响应按传输错误处理。
    }
  }
  if (response.status === 401 || response.status === 403) {
    return { fatal: true, code: code, message: message || '凭据无效' };
  }
  if (isFatalStreamCode(code)) return { fatal: true, code: code, message: message || code };
  return { fatal: false, code: code, message: message || ('HTTP ' + response.status) };
}

function streamThrownFailure(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  if (isFatalStreamCode(code)) {
    return { fatal: true, code: code, message: error.message || code };
  }
  return {
    fatal: false,
    code: code,
    message: error && error.message ? error.message : '网络中断'
  };
}

async function openActorStream(task) {
  let response;
  try {
    response = await api(
      'subscriptions/listen',
      { notifications: { resourceSubscriptions: [STREAM_URI] } },
      undefined,
      undefined,
      streamController ? streamController.signal : undefined
    );
  } catch (error) {
    if (streamStopped || streamTask !== task) return { stopped: true, ackedAt: 0 };
    return { failure: streamThrownFailure(error), ackedAt: 0 };
  }
  if (streamStopped || streamTask !== task) return { stopped: true, ackedAt: 0 };
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    return { failure: await streamResponseFailure(response), ackedAt: 0 };
  }
  if (!response.body) {
    return { failure: { fatal: false, message: '响应没有正文' }, ackedAt: 0 };
  }
  const reader = response.body.getReader();
  streamReader = reader;
  try {
    const ackedAt = await readActorStream(reader, task);
    return { failure: null, ackedAt: ackedAt };
  } catch (error) {
    if (streamStopped || streamTask !== task) return { stopped: true, ackedAt: 0 };
    return { failure: streamThrownFailure(error), ackedAt: 0 };
  } finally {
    if (streamReader === reader) streamReader = null;
    try {
      reader.cancel().catch(function () {});
    } catch (error) {
      // reader 可能已经被浏览器关闭。
    }
  }
}

async function runActorStream(task) {
  while (!streamStopped && streamTask === task) {
    if (!identity) {
      try {
        await ensureIdentity();
      } catch (error) {
        if (streamStopped || streamTask !== task) return;
        const failure = streamThrownFailure(error);
        if (failure.fatal) {
          streamConnected = false;
          setStreamStatus(streamStopStatus(failure));
          return;
        }
        noteStreamFailure(failure);
        streamAttempt += 1;
        await waitForStreamRetry(computeStreamBackoff(streamAttempt));
        continue;
      }
    }
    if (streamStopped || streamTask !== task) return;

    closeStreamTransport();
    const controller = new AbortController();
    streamController = controller;
    const result = await openActorStream(task);
    // 无论正常结束还是失败，都中止本次请求，避免旧连接占用连接池。
    closeStreamTransport();
    if (streamStopped || streamTask !== task || result.stopped) return;

    if (result.failure && result.failure.fatal) {
      streamConnected = false;
      setStreamStatus(streamStopStatus(result.failure));
      if (result.failure.code === 'CREDENTIAL_INVALID' || result.failure.code === 'UNAUTHORIZED') {
        showCredentialInvalidHome('实时连接使用的凭据已失效；本机不会自动创建替代身份。');
      }
      return;
    }

    const wasConnected = Boolean(result.ackedAt);
    if (wasConnected && Date.now() - result.ackedAt >= STREAM_RECONNECT_STABLE_MS) {
      streamAttempt = 0;
    }
    streamConnected = false;
    noteStreamFailure(
      result.failure || { message: wasConnected ? '连接已断开' : '建立连接前连接已结束' }
    );
    streamAttempt += 1;
    const delay = computeStreamBackoff(streamAttempt);
    streamDebug('reconnect in ' + delay + 'ms (attempt ' + streamAttempt + ')');
    await waitForStreamRetry(delay);
  }
}

function startActorStream() {
  if (!streamStopped) return;
  streamStopped = false;
  streamConnected = false;
  streamAttempt = 0;
  streamFailures = 0;
  streamFailureStartedAt = 0;
  const task = ++streamTask;
  runActorStream(task).catch(function (error) {
    streamDebug('stream loop failed', error && error.message ? error.message : String(error));
  });
}

function stopActorStream() {
  streamStopped = true;
  streamTask += 1;
  streamConnected = false;
  closeStreamTransport();
  clearStreamTimers();
  setStreamStatus('');
}

window.addEventListener('online', retryActorStreamNow);
window.addEventListener('pagehide', stopActorStream);
window.addEventListener('pageshow', function (event) {
  if (event.persisted) startActorStream();
});
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) retryActorStreamNow();
});
`;
