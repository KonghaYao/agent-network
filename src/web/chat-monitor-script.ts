/**
 * 网页监控面板：按 human + room 保存 URL，并用 iframe 加载。
 *
 * 与文件面板共用一个右侧槽位但 DOM/状态完全独立：打开一个会关闭另一个。
 * 只在打开面板、切房或手动刷新时调用 `network_room_monitor_get`，不轮询；
 * 关闭、切房、回首页把 iframe 置为 about:blank 卸载文档。URL 不写
 * localStorage，也不进入 console/日志；iframe 不使用 innerHTML/srcdoc。
 */
export const CHAT_MONITOR_SCRIPT = `
const MONITOR_OPEN_KEY = 'agent-network-monitor-open';
const monitorPaneElement = document.getElementById('monitor-pane');
const monitorToggleButton = document.getElementById('monitor-toggle');
const monitorCloseButton = document.getElementById('monitor-close');
const monitorRefreshButton = document.getElementById('monitor-refresh');
const monitorBackdropElement = document.getElementById('monitor-backdrop');
const monitorForm = document.getElementById('monitor-form');
const monitorInput = document.getElementById('monitor-url');
const monitorSaveButton = document.getElementById('monitor-save');
const monitorClearButton = document.getElementById('monitor-clear');
const monitorStatusElement = document.getElementById('monitor-status');
const monitorErrorElement = document.getElementById('monitor-error');
const monitorErrorTextElement = document.getElementById('monitor-error-text');
const monitorRetryButton = document.getElementById('monitor-retry');
const monitorEmptyElement = document.getElementById('monitor-empty');
const monitorFrame = document.getElementById('monitor-frame');
const monitorExternalLink = document.getElementById('monitor-external');
const monitorMixedHint = document.getElementById('monitor-mixed');

let monitorDesktopOpen = readMonitorPreference();
let monitorOverlayOpen = false;
let monitorActiveRoomId = null;
let monitorEpoch = 0;
let monitorLoadAbort = null;
let monitorRequestSeq = 0;
let monitorLoaded = false;
let monitorLoadedRoomId = null;
let monitorUrl = null;
let monitorUpdatedAt = null;
let monitorBusy = false;
let monitorFocusBeforeOpen = null;
let monitorLastDesktopLayout = isMonitorDesktop();

function readMonitorPreference() {
  try {
    return localStorage.getItem(MONITOR_OPEN_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function writeMonitorPreference(open) {
  try {
    localStorage.setItem(MONITOR_OPEN_KEY, open ? '1' : '0');
  } catch (error) {
    // 隐私模式禁用存储时只影响记忆，不影响本次开关。
  }
}

function isMonitorDesktop() {
  return window.matchMedia('(min-width: 1200px)').matches;
}

function isMonitorMobile() {
  return window.matchMedia('(max-width: 759px)').matches;
}

function monitorVisible() {
  return Boolean(monitorPaneElement && !monitorPaneElement.hidden);
}

function monitorEpochCurrent(roomId, epoch) {
  return monitorActiveRoomId === roomId && monitorEpoch === epoch;
}

function monitorSafeUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch (error) {
    return null;
  }
}

function monitorHostLabel(url) {
  try {
    return new URL(url).hostname || '网页内容';
  } catch (error) {
    return '网页内容';
  }
}

function setMonitorStatus(text, options) {
  if (!monitorStatusElement) return;
  const settings = options || {};
  monitorStatusElement.textContent = text || '';
  monitorStatusElement.classList.toggle('error', Boolean(settings.error));
}

function clearMonitorError() {
  if (monitorErrorElement) monitorErrorElement.hidden = true;
  if (monitorErrorTextElement) monitorErrorTextElement.textContent = '';
}

function showMonitorError(text) {
  if (monitorErrorTextElement) monitorErrorTextElement.textContent = text;
  if (monitorErrorElement) monitorErrorElement.hidden = false;
  setMonitorStatus('');
}

function updateMonitorButtons() {
  if (monitorSaveButton) monitorSaveButton.disabled = monitorBusy;
  if (monitorClearButton) monitorClearButton.disabled = monitorBusy;
  if (monitorRefreshButton) monitorRefreshButton.disabled = monitorBusy;
}

function unloadMonitorFrame() {
  if (!monitorFrame) return;
  try {
    monitorFrame.src = 'about:blank';
  } catch (error) {
    // 某些浏览器在卸载中拒绝赋值；iframe 仍会随面板隐藏。
  }
  monitorFrame.hidden = true;
}

function resetMonitorState() {
  monitorUrl = null;
  monitorUpdatedAt = null;
  monitorLoaded = false;
  monitorLoadedRoomId = null;
  if (monitorLoadAbort) monitorLoadAbort.abort();
  monitorLoadAbort = null;
  if (monitorInput) monitorInput.value = '';
  unloadMonitorFrame();
  if (monitorEmptyElement) monitorEmptyElement.hidden = false;
  if (monitorExternalLink) {
    monitorExternalLink.href = '#';
    monitorExternalLink.setAttribute('aria-disabled', 'true');
  }
  if (monitorMixedHint) monitorMixedHint.hidden = true;
  clearMonitorError();
  setMonitorStatus('');
  updateMonitorButtons();
}

function applyMonitorUrl(value, options) {
  const settings = options || {};
  const safe = monitorSafeUrl(value);
  monitorUrl = safe;
  if (monitorInput) monitorInput.value = safe || '';
  if (!safe) {
    unloadMonitorFrame();
    if (monitorEmptyElement) monitorEmptyElement.hidden = false;
    if (monitorExternalLink) {
      monitorExternalLink.href = '#';
      monitorExternalLink.setAttribute('aria-disabled', 'true');
    }
    if (monitorMixedHint) monitorMixedHint.hidden = true;
    if (monitorFrame) monitorFrame.title = '网页内容';
    return;
  }
  if (monitorEmptyElement) monitorEmptyElement.hidden = true;
  if (monitorFrame) {
    monitorFrame.hidden = false;
    monitorFrame.title = '网页内容 · ' + monitorHostLabel(safe);
    if (monitorFrame.src !== safe) {
      monitorFrame.src = safe;
    } else if (settings.forceReload) {
      monitorFrame.src = 'about:blank';
      requestAnimationFrame(function () {
        if (monitorFrame && monitorUrl === safe && monitorVisible()) monitorFrame.src = safe;
      });
    }
  }
  if (monitorExternalLink) {
    monitorExternalLink.href = safe;
    monitorExternalLink.setAttribute('aria-disabled', 'false');
  }
  if (monitorMixedHint) {
    monitorMixedHint.hidden = !(location.protocol === 'https:' && safe.indexOf('http://') === 0);
  }
}

function renderMonitorResult(monitor, options) {
  const settings = options || {};
  if (!monitor || !monitor.url) {
    monitorUpdatedAt = null;
    applyMonitorUrl(null);
    return;
  }
  monitorUpdatedAt = monitor.updated_at || null;
  applyMonitorUrl(monitor.url, { forceReload: settings.forceReload === true });
}

function syncMonitorChrome() {
  if (!monitorPaneElement) return;
  const onRoom = document.body.classList.contains('page-room');
  const desktop = isMonitorDesktop();
  const mobile = isMonitorMobile();
  const overlayOpen = !desktop && monitorOverlayOpen;
  const visible = onRoom && (desktop ? monitorDesktopOpen : overlayOpen);
  monitorPaneElement.hidden = !visible;
  if (monitorBackdropElement) {
    monitorBackdropElement.hidden = !(onRoom && !desktop && !mobile && overlayOpen);
  }
  document.body.classList.toggle('monitor-page-open', onRoom && mobile && overlayOpen);
  document.body.classList.toggle('monitor-drawer-open', onRoom && !desktop && !mobile && overlayOpen);
  if (monitorToggleButton) {
    monitorToggleButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
    monitorToggleButton.classList.toggle('active', visible);
  }
  if (monitorCloseButton) {
    const mobilePage = onRoom && isMonitorMobile();
    monitorCloseButton.textContent = mobilePage ? '返回' : '关闭';
    monitorCloseButton.setAttribute('aria-label', mobilePage ? '返回聊天' : '关闭网页监控');
  }
  if (!onRoom) monitorOverlayOpen = false;
  if (!visible) {
    if (monitorLoadAbort) {
      monitorLoadAbort.abort();
      monitorLoadAbort = null;
    }
    monitorLoaded = false;
    monitorRequestSeq += 1;
    unloadMonitorFrame();
  }
}

function restoreMonitorFocus() {
  const target = monitorFocusBeforeOpen && monitorFocusBeforeOpen.isConnected
    ? monitorFocusBeforeOpen
    : monitorToggleButton;
  monitorFocusBeforeOpen = null;
  if (!target) return;
  requestAnimationFrame(function () {
    if (target.focus) target.focus();
  });
}

function toggleMonitorPane() {
  if (!activeRoomId) return;
  const willOpen = isMonitorDesktop() ? !monitorDesktopOpen : !monitorOverlayOpen;
  if (willOpen) {
    if (filesVisible()) closeFilesPane({ restoreFocus: false });
    monitorFocusBeforeOpen = document.activeElement;
    if (!isMonitorDesktop() && document.activeElement && document.activeElement.blur) {
      document.activeElement.blur();
    }
  }
  if (isMonitorDesktop()) {
    monitorDesktopOpen = willOpen;
    writeMonitorPreference(monitorDesktopOpen);
  } else {
    monitorOverlayOpen = willOpen;
  }
  syncMonitorChrome();
  if (willOpen) {
    ensureMonitorLoaded(activeRoomId);
    if (isMonitorMobile() && monitorCloseButton) {
      requestAnimationFrame(function () {
        if (monitorVisible()) monitorCloseButton.focus();
      });
    }
  } else {
    monitorLoaded = false;
    restoreMonitorFocus();
  }
}

function closeMonitorPane(options) {
  const settings = options || {};
  const wasVisible = monitorVisible();
  if (isMonitorDesktop()) {
    monitorDesktopOpen = false;
    writeMonitorPreference(false);
  } else {
    monitorOverlayOpen = false;
  }
  monitorLoaded = false;
  syncMonitorChrome();
  if (wasVisible && settings.restoreFocus !== false) restoreMonitorFocus();
}

function activateMonitorRoom(roomId) {
  if (!roomId) return;
  if (monitorActiveRoomId === roomId) {
    syncMonitorChrome();
    if (monitorVisible()) {
      if (filesVisible()) closeFilesPane({ restoreFocus: false });
      ensureMonitorLoaded(roomId);
    }
    return;
  }
  monitorEpoch += 1;
  if (monitorLoadAbort) monitorLoadAbort.abort();
  monitorLoadAbort = null;
  monitorActiveRoomId = roomId;
  if (!isMonitorDesktop()) monitorOverlayOpen = false;
  resetMonitorState();
  syncMonitorChrome();
  if (monitorVisible()) {
    if (filesVisible()) closeFilesPane({ restoreFocus: false });
    ensureMonitorLoaded(roomId);
  }
}

function deactivateMonitorRoom() {
  monitorEpoch += 1;
  if (monitorLoadAbort) monitorLoadAbort.abort();
  monitorLoadAbort = null;
  monitorActiveRoomId = null;
  monitorOverlayOpen = false;
  resetMonitorState();
  syncMonitorChrome();
}

function ensureMonitorLoaded(roomId) {
  if (!roomId || !monitorVisible() || monitorActiveRoomId !== roomId) return;
  if (monitorLoaded && monitorLoadedRoomId === roomId) return;
  loadMonitor(roomId, {}).catch(function () {});
}

async function loadMonitor(roomId, options) {
  const settings = options || {};
  if (!monitorVisible() || monitorActiveRoomId !== roomId) return;
  if (monitorLoadAbort) monitorLoadAbort.abort();
  const controller = new AbortController();
  monitorLoadAbort = controller;
  const epoch = monitorEpoch;
  const requestSeq = ++monitorRequestSeq;
  if (settings.silent !== true) setMonitorStatus('正在读取…');
  try {
    await ensureIdentity();
    if (!monitorEpochCurrent(roomId, epoch) || requestSeq !== monitorRequestSeq) return;
    const result = await callTool(
      'network_room_monitor_get',
      { room_id: roomId },
      undefined,
      controller.signal
    );
    if (!monitorEpochCurrent(roomId, epoch) || requestSeq !== monitorRequestSeq) return;
    if (!monitorVisible()) return;
    clearMonitorError();
    const monitor = result && result.monitor ? result.monitor : null;
    renderMonitorResult(monitor, { forceReload: settings.forceReload === true });
    monitorLoaded = true;
    monitorLoadedRoomId = roomId;
    setMonitorStatus(monitor ? (settings.refresh ? '已刷新。' : '') : '');
  } catch (error) {
    if (isAbortError(error) || !monitorEpochCurrent(roomId, epoch) || requestSeq !== monitorRequestSeq) {
      return;
    }
    if (error && (error.code === 'NOT_MEMBER' || error.code === 'NOT_FOUND')) {
      renderMonitorResult(null);
    }
    showMonitorError('读取网页地址失败：' + errorMessage(error));
  } finally {
    if (monitorLoadAbort === controller) monitorLoadAbort = null;
  }
}

async function commitMonitor(url, options) {
  if (!activeRoomId || monitorBusy) return false;
  const settings = options || {};
  const roomId = activeRoomId;
  const epoch = monitorEpoch;
  monitorBusy = true;
  updateMonitorButtons();
  clearMonitorError();
  setMonitorStatus(settings.refresh ? '正在更新…' : '正在保存…');
  try {
    await ensureIdentity();
    const result = await callTool('network_room_monitor_set', {
      request_id: requestId('monitor'),
      room_id: roomId,
      url: url
    });
    if (!monitorEpochCurrent(roomId, epoch)) return false;
    const monitor = result && result.monitor ? result.monitor : null;
    renderMonitorResult(monitor, { forceReload: true });
    setMonitorStatus(url ? '已保存；其他设备打开或刷新后会同步。' : '已清除。');
    return true;
  } catch (error) {
    if (isAbortError(error) || !monitorEpochCurrent(roomId, epoch)) return false;
    showMonitorError((url ? '保存失败：' : '清除失败：') + errorMessage(error));
    return false;
  } finally {
    monitorBusy = false;
    updateMonitorButtons();
  }
}

async function saveMonitor() {
  if (!activeRoomId || monitorBusy) return;
  const raw = monitorInput ? monitorInput.value.trim() : '';
  if (!raw) {
    await commitMonitor(null);
    return;
  }
  const safe = monitorSafeUrl(raw);
  if (!safe) {
    showMonitorError('网址格式无效：只允许 http 或 https。');
    return;
  }
  await commitMonitor(safe);
}

async function clearMonitor() {
  if (!activeRoomId || monitorBusy) return;
  const hasValue = Boolean(monitorUrl) || Boolean(monitorInput && monitorInput.value.trim());
  if (!hasValue) {
    setMonitorStatus('');
    return;
  }
  if (!window.confirm('清除此会话的网址？其他设备也会同步清除。')) return;
  await commitMonitor(null);
}

function refreshMonitor() {
  if (!activeRoomId || monitorBusy) return;
  loadMonitor(activeRoomId, { forceReload: true, refresh: true }).catch(function () {});
}

if (monitorToggleButton) monitorToggleButton.addEventListener('click', toggleMonitorPane);
if (monitorCloseButton) monitorCloseButton.addEventListener('click', function () { closeMonitorPane(); });
if (monitorBackdropElement) {
  monitorBackdropElement.addEventListener('click', function () { closeMonitorPane(); });
}
if (monitorForm) {
  monitorForm.addEventListener('submit', function (event) {
    event.preventDefault();
    saveMonitor().catch(function () {});
  });
}
if (monitorClearButton) monitorClearButton.addEventListener('click', function () { clearMonitor().catch(function () {}); });
if (monitorRefreshButton) monitorRefreshButton.addEventListener('click', refreshMonitor);
if (monitorRetryButton) {
  monitorRetryButton.addEventListener('click', function () {
    if (!activeRoomId) return;
    loadMonitor(activeRoomId, { forceReload: true }).catch(function () {});
  });
}
if (monitorExternalLink) {
  monitorExternalLink.addEventListener('click', function (event) {
    if (monitorExternalLink.getAttribute('aria-disabled') === 'true') event.preventDefault();
  });
}
document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape') return;
  if (monitorOverlayOpen && monitorVisible()) closeMonitorPane();
});
window.addEventListener('resize', function () {
  const desktop = isMonitorDesktop();
  if (desktop === monitorLastDesktopLayout) return;
  monitorLastDesktopLayout = desktop;
  monitorOverlayOpen = false;
  syncMonitorChrome();
  if (monitorVisible() && activeRoomId) ensureMonitorLoaded(activeRoomId);
});
window.addEventListener('pagehide', unloadMonitorFrame);
`;
