/**
 * `+` 附件菜单与画板加载桥接。
 *
 * 菜单只负责选择“上传文件 / 画板”：文件入口复用隐藏的
 * `#composer-file-input`，画板入口按需动态导入 `/assets/chat-drawboard.js`。
 * Fabric 与画板样式都不进入首屏；加载失败显示可重试的整页提示，不产生上传。
 * 画板导出 File 后交给 `insertAttachFiles`，与粘贴/拖拽共用同一上传与 chip 链路。
 * 本片段不读取 token，也不把文件内容写入日志。
 */
export const CHAT_DRAWBOARD_SCRIPT = `
const attachMenu = document.getElementById('attach-menu');
const attachMenuFile = document.getElementById('attach-menu-file');
const attachMenuDraw = document.getElementById('attach-menu-draw');
const attachMenuItems = [attachMenuFile, attachMenuDraw].filter(function (item) { return Boolean(item); });

let drawboardModulePromise = null;
let drawboardOpening = false;
let drawboardRequestSeq = 0;
let drawboardRetrySalt = 0;
let drawboardLoadingOverlay = null;
let drawboardErrorOverlay = null;

function attachMenuIsOpen() {
  return Boolean(attachMenu && !attachMenu.hidden);
}

function menuItemAt(index) {
  if (attachMenuItems.length === 0) return null;
  return attachMenuItems[(index + attachMenuItems.length) % attachMenuItems.length];
}

function openAttachMenu(focusFirst) {
  if (!attachMenu || !attachFileButton) return;
  attachMenu.hidden = false;
  attachFileButton.setAttribute('aria-expanded', 'true');
  if (focusFirst) {
    const first = menuItemAt(0);
    if (first) first.focus();
  }
}

function closeAttachMenu(restoreFocus) {
  if (!attachMenu || !attachFileButton) return;
  const wasOpen = !attachMenu.hidden;
  attachMenu.hidden = true;
  attachFileButton.setAttribute('aria-expanded', 'false');
  if (restoreFocus && wasOpen) attachFileButton.focus();
}

function toggleAttachMenu() {
  if (attachMenuIsOpen()) closeAttachMenu(true);
  else openAttachMenu(true);
}

function drawboardAssetUrl(forceRetry) {
  if (!forceRetry) return DRAWBOARD_ASSET_URL;
  drawboardRetrySalt += 1;
  const separator = DRAWBOARD_ASSET_URL.indexOf('?') >= 0 ? '&' : '?';
  return DRAWBOARD_ASSET_URL + separator + 'r=' + drawboardRetrySalt;
}

/** 成功只请求一次；重试时换 query 绕过浏览器的失败缓存。 */
function loadDrawboardModule(forceRetry) {
  if (!drawboardModulePromise || forceRetry) {
    const url = drawboardAssetUrl(forceRetry);
    drawboardModulePromise = import(url).then(function (module) {
      if (!module || typeof module.openDrawboard !== 'function') {
        throw new Error('invalid drawboard bundle');
      }
      return module;
    }).catch(function (error) {
      drawboardModulePromise = null;
      throw error;
    });
  }
  return drawboardModulePromise;
}

function closeDrawboardLoading() {
  if (!drawboardLoadingOverlay) return;
  drawboardLoadingOverlay.remove();
  drawboardLoadingOverlay = null;
  document.removeEventListener('keydown', onDrawboardLoadingKeydown, true);
}

function onDrawboardLoadingKeydown(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  drawboardRequestSeq += 1;
  drawboardOpening = false;
  closeDrawboardLoading();
  if (attachFileButton) attachFileButton.focus();
}

function showDrawboardLoading() {
  if (drawboardLoadingOverlay) return;
  const overlay = document.createElement('div');
  overlay.className = 'drawboard-fallback';
  overlay.setAttribute('data-drawboard-fallback', 'loading');
  overlay.innerHTML = '<div class="drawboard-fallback-card" role="dialog" aria-modal="true" ' +
    'aria-label="画板加载中"><p class="drawboard-fallback-title">正在加载画板…</p>' +
    '<p class="drawboard-fallback-text">首次打开需要加载绘图组件。</p></div>';
  document.body.append(overlay);
  drawboardLoadingOverlay = overlay;
  document.addEventListener('keydown', onDrawboardLoadingKeydown, true);
}

function closeDrawboardError() {
  if (!drawboardErrorOverlay) return;
  drawboardErrorOverlay.remove();
  drawboardErrorOverlay = null;
  document.removeEventListener('keydown', onDrawboardErrorKeydown, true);
}

function onDrawboardErrorKeydown(event) {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopPropagation();
  closeDrawboardError();
  if (attachFileButton) attachFileButton.focus();
}

function showDrawboardError() {
  if (drawboardErrorOverlay) return;
  const overlay = document.createElement('div');
  overlay.className = 'drawboard-fallback';
  overlay.setAttribute('data-drawboard-fallback', 'error');
  overlay.innerHTML = '<div class="drawboard-fallback-card" role="dialog" aria-modal="true" ' +
    'aria-label="画板加载失败"><p class="drawboard-fallback-title">画板加载失败</p>' +
    '<p class="drawboard-fallback-text">无法加载绘图组件，请检查网络后重试。</p>' +
    '<div class="drawboard-fallback-actions">' +
    '<button type="button" class="primary" id="drawboard-retry">重试</button>' +
    '<button type="button" id="drawboard-error-close">关闭</button></div></div>';
  document.body.append(overlay);
  drawboardErrorOverlay = overlay;
  const retry = overlay.querySelector('#drawboard-retry');
  const close = overlay.querySelector('#drawboard-error-close');
  if (retry) {
    retry.addEventListener('click', function () {
      closeDrawboardError();
      void openDrawboard(true);
    });
  }
  if (close) {
    close.addEventListener('click', function () {
      closeDrawboardError();
      if (attachFileButton) attachFileButton.focus();
    });
  }
  document.addEventListener('keydown', onDrawboardErrorKeydown, true);
  if (retry && typeof retry.focus === 'function') retry.focus();
}

/**
 * 打开画板；创建 Fabric 实例后模块自行管理覆盖层生命周期。
 * 导出成功时只把 File 交给上传链路，不自动发送消息。
 */
async function openDrawboard(forceRetry) {
  if (!composerUploadReady()) {
    setDropStatus('请先打开一个会话再使用画板。');
    return;
  }
  if (drawboardOpening) return;
  drawboardOpening = true;
  const request = ++drawboardRequestSeq;
  showDrawboardLoading();
  try {
    const module = await loadDrawboardModule(Boolean(forceRetry));
    if (request !== drawboardRequestSeq) return;
    closeDrawboardLoading();
    module.openDrawboard({
      onInsert: function (file) {
        insertAttachFiles([file]);
      }
    });
  } catch (error) {
    if (request !== drawboardRequestSeq) return;
    closeDrawboardLoading();
    showDrawboardError();
  } finally {
    if (request === drawboardRequestSeq) drawboardOpening = false;
  }
}

if (attachFileButton) {
  attachFileButton.addEventListener('click', function (event) {
    event.stopPropagation();
    toggleAttachMenu();
  });
}

if (attachMenu && attachMenuFile) {
  attachMenuFile.addEventListener('click', function () {
    closeAttachMenu(false);
    if (!composerUploadReady()) {
      setDropStatus('请先打开一个会话再上传文件。');
      return;
    }
    attachFileInput.click();
  });
}

if (attachMenu && attachMenuDraw) {
  attachMenuDraw.addEventListener('click', function () {
    closeAttachMenu(false);
    void openDrawboard(false);
  });
}

if (attachMenu) {
  attachMenu.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAttachMenu(true);
      return;
    }
    if (event.key === 'Tab') {
      closeAttachMenu(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' &&
        event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const current = attachMenuItems.indexOf(document.activeElement);
    let next = current;
    if (event.key === 'ArrowDown') next = current + 1;
    else if (event.key === 'ArrowUp') next = current - 1;
    else if (event.key === 'Home') next = 0;
    else next = attachMenuItems.length - 1;
    const item = menuItemAt(next);
    if (item) item.focus();
  });
}

document.addEventListener('pointerdown', function (event) {
  if (!attachMenuIsOpen()) return;
  const target = event.target;
  if (attachMenu && target instanceof Node && attachMenu.contains(target)) return;
  if (attachFileButton && target === attachFileButton) return;
  closeAttachMenu(false);
});

document.addEventListener('keydown', function (event) {
  if (event.key !== 'Escape' || !attachMenuIsOpen()) return;
  event.preventDefault();
  closeAttachMenu(true);
});
`;
