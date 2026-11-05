/**
 * 左下角退出登录：只清除本机凭据与本地 Agent 注册表，不调用服务端。
 *
 * 服务端只保存 token 摘要，退出不会吊销 token；其他设备与已经发给 Agent 的
 * 连接提示词仍然有效。`agent-network-logged-out` 是非敏感的本机 UI 状态，
 * 用来在退出后显示分享链接/连接提示词引导，而不是立刻自动注册新身份。
 *
 * 由 `chatClientScript` 拼进主脚本共享作用域；与 `chat-stream-script.ts`
 * 的 `stopActorStream` 配合，在跳转前断开 SSE 并清空重连/补读定时器。
 */
export const CHAT_LOGOUT_SCRIPT = `
const LOGGED_OUT_KEY = 'agent-network-logged-out';
// 搜索确认后，只有这两个 key 与凭据/会话相关。
// agent-network-files-open 与 agent-network-room-filter 是 UI 偏好，退出时保留。
const LOGOUT_CREDENTIAL_KEYS = ['agent-network-token', 'agent-network-agents-v1'];

function isLoggedOut() {
  try {
    return window.localStorage.getItem(LOGGED_OUT_KEY) === '1';
  } catch (error) {
    return false;
  }
}

function setLoggedOut(value) {
  try {
    if (value) window.localStorage.setItem(LOGGED_OUT_KEY, '1');
    else window.localStorage.removeItem(LOGGED_OUT_KEY);
  } catch (error) {
    // localStorage 不可用时仍允许退出；下次打开可能重新自动注册。
  }
}

function clearLoggedOutState() {
  setLoggedOut(false);
}

/** 无 token 或已退出时不显示入口；token 存在时显示。 */
function syncLogoutVisibility() {
  const button = document.getElementById('logout');
  if (!button) return;
  let hasToken = false;
  try {
    hasToken = Boolean(window.localStorage.getItem('agent-network-token'));
  } catch (error) {
    hasToken = false;
  }
  button.hidden = !hasToken || isLoggedOut();
}

(function () {
  'use strict';
  var button = document.getElementById('logout');
  var modal = document.getElementById('logout-modal');
  var confirmButton = document.getElementById('logout-confirm');
  var cancelButton = document.getElementById('logout-cancel');
  if (!button || !modal || !confirmButton || !cancelButton) return;
  var opener = null;
  var busy = false;

  function closeDialog() {
    if (busy) return;
    modal.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (opener && opener.focus) opener.focus();
    opener = null;
  }

  function openDialog() {
    if (busy || button.hidden) return;
    opener = document.activeElement;
    modal.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    // 默认聚焦“取消”，避免误按 Enter 直接退出。
    cancelButton.focus();
  }

  button.addEventListener('click', openDialog);
  cancelButton.addEventListener('click', closeDialog);
  modal.addEventListener('click', function (event) {
    if (event.target === modal) closeDialog();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) closeDialog();
  });
  confirmButton.addEventListener('click', function () {
    if (busy) return;
    busy = true;
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    // 先断开 SSE 与重连/补读定时器，避免退出瞬间用旧 token 重连。
    if (typeof stopActorStream === 'function') stopActorStream();
    for (var index = 0; index < LOGOUT_CREDENTIAL_KEYS.length; index += 1) {
      try {
        window.localStorage.removeItem(LOGOUT_CREDENTIAL_KEYS[index]);
      } catch (error) {
        // 单个 key 删除失败不应阻止退出；继续清理其余 key。
      }
    }
    try {
      for (var sessionIndex = window.sessionStorage.length - 1; sessionIndex >= 0; sessionIndex -= 1) {
        var sessionKey = window.sessionStorage.key(sessionIndex);
        if (sessionKey && sessionKey.indexOf('agent-network-') === 0) {
          window.sessionStorage.removeItem(sessionKey);
        }
      }
    } catch (error) {
      // sessionStorage 不可用不影响退出。
    }
    // 不调用服务端、不吊销 token；只在本机留下非敏感的退出状态。
    setLoggedOut(true);
    window.location.replace('/');
  });
})();

syncLogoutVisibility();
`;
