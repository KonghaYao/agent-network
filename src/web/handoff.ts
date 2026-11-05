/**
 * 手机扫码入口：把当前浏览器身份通过 URL fragment 交给手机。
 *
 * token 只出现在 `#t=` 之后；浏览器不会把 fragment 发给服务端，因此
 * 二维码不经过任何服务端端点，也不引入新工具、密钥或数据库状态。
 * 代价是二维码本身就是长期凭据：任何看到二维码的人都能获得同一身份。
 */

/**
 * 左下角用户区块：头像、名称、新建 Agent、手机扫码与已归档入口。
 *
 * 已归档入口只是一个图标按钮，打开轻量浮层；不再提供 Agents 管理弹窗。
 * 本地注册表仍由“新建 Agent”写入，并供 direct Agent 会话右键提示词复用。
 */
export function deviceHandoffAccount(): string {
  return `<div class="account" id="account">
    <span class="account-avatar" id="account-avatar" aria-hidden="true">?</span>
    <div class="account-main">
      <span class="account-name" id="account-name">未登录</span>
      <div class="account-actions">
        <button class="account-scan" id="new-agent" type="button"
          aria-haspopup="dialog" aria-controls="new-agent-modal" aria-expanded="false">新建 Agent</button>
        <button class="account-scan" id="device-handoff" type="button"
          aria-haspopup="dialog" aria-controls="handoff-modal" aria-expanded="false">手机扫码</button>
        <button class="account-icon" id="archived-agents" type="button"
          aria-label="已归档 Agents" title="已归档 Agents"
          aria-haspopup="dialog" aria-controls="archive-popover" aria-expanded="false">
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 7h16v3H4z"></path>
            <path d="M6 10v9h12v-9"></path>
            <path d="M10 13h4"></path>
          </svg>
        </button>
        <button class="account-icon" id="logout" type="button"
          aria-label="退出登录" title="退出登录"
          aria-haspopup="dialog" aria-controls="logout-modal" aria-expanded="false" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14 4h5v16h-5"></path>
            <path d="M10 8l4 4-4 4"></path>
            <path d="M14 12H4"></path>
          </svg>
        </button>
      </div>
    </div>
  </div>`;
}

/**
 * 退出登录确认弹窗。
 *
 * 只清除本机凭据与 Agents 注册表；明确告知 token 仍然有效、其他设备不受影响。
 * 不提供“吊销 token”选项，也不调用服务端。
 */
export function logoutDialog(): string {
  return `<div class="modal" id="logout-modal" hidden>
  <div class="modal-card logout-card" role="dialog" aria-modal="true" aria-labelledby="logout-title">
    <h2 id="logout-title">退出登录</h2>
    <p class="logout-warning">本机将清除登录凭据与已保存的 Agent 连接提示词；当前 token 仍然有效，其他设备不受影响。</p>
    <p class="logout-hint">只在本机退出，不调用服务端，也不会吊销 token。退出后本机显示分享链接引导；需要继续使用时可创建新身份、重新扫码或打开 Agent 分享链接。</p>
    <div class="row modal-actions logout-actions">
      <button id="logout-cancel" type="button" aria-label="取消退出登录">取消</button>
      <button class="danger" id="logout-confirm" type="button" aria-label="确认退出登录">退出登录</button>
    </div>
  </div>
</div>`;
}

/** 扫码弹窗；不显示“已扫码”，服务端无感知。 */
export function deviceHandoffDialog(): string {
  return `<div class="modal" id="handoff-modal" hidden>
  <div class="modal-card handoff-card" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
    <h2 id="handoff-title">手机扫码</h2>
    <p class="handoff-hint" id="handoff-hint">用手机相机扫描二维码，手机将以当前身份进入会话列表。</p>
    <div class="handoff-qr-wrap">
      <canvas id="handoff-qr" role="img" aria-label="包含当前登录凭据的二维码"></canvas>
    </div>
    <p class="handoff-warning">二维码包含当前身份的完整登录凭据，请勿截图或分享。任何人看到二维码都能以你的身份操作；凭据泄露后需在服务端撤销该 token。</p>
    <p class="handoff-hint">二维码在凭据被撤销前一直可用；页面不会显示“已扫码”状态。</p>
    <div class="handoff-actions">
      <button id="handoff-copy" type="button" disabled>复制扫码内容</button>
      <button class="primary" id="handoff-close" type="button">关闭</button>
    </div>
  </div>
</div>`;
}

/**
 * 在页面主脚本之前执行：采纳 `#t=` 中的 token 并清掉 hash。
 *
 * 必须先于会话列表加载执行，因此由 `renderAppPage` 放在 `<main>` 开头，
 * 解析到该 `<script>` 时立即运行。
 */
export const HANDOFF_ADOPT_SCRIPT = `
(function () {
  'use strict';
  var hash = window.location.hash || '';
  if (hash.indexOf('#t=') !== 0) return;
  var token;
  try {
    token = decodeURIComponent(hash.slice(3));
  } catch (error) {
    return;
  }
  if (!token || token.length > 512 || token.trim() !== token) return;
  try {
    window.localStorage.setItem('agent-network-token', token);
    // 扫码/分享链接即重新登录；清除本机“已退出”引导状态。
    window.localStorage.removeItem('agent-network-logged-out');
  } catch (error) {
    return;
  }
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch (error) {
    // 清 hash 失败不影响身份采纳；下次打开会再次写入同一 token。
  }
})();
`;

/** 弹窗控制：从 localStorage 读 token，现场生成二维码，不请求服务端。 */
export const HANDOFF_CONTROLLER_SCRIPT = `
(function () {
  'use strict';
  var TOKEN_KEY = 'agent-network-token';
  var button = document.getElementById('device-handoff');
  var modal = document.getElementById('handoff-modal');
  var canvas = document.getElementById('handoff-qr');
  var closeButton = document.getElementById('handoff-close');
  var copyButton = document.getElementById('handoff-copy');
  var hint = document.getElementById('handoff-hint');
  if (!button || !modal || !canvas || !closeButton || !copyButton || !hint) return;
  var opener = null;
  var copyUrl = null;
  var copyResetTimer = null;

  function resetCopyButton() {
    if (copyResetTimer) {
      clearTimeout(copyResetTimer);
      copyResetTimer = null;
    }
    copyButton.textContent = '复制扫码内容';
  }

  function closeDialog() {
    modal.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (opener && opener.focus) opener.focus();
  }

  function openDialog() {
    var token = null;
    try {
      token = window.localStorage.getItem(TOKEN_KEY);
    } catch (error) {
      token = null;
    }
    resetCopyButton();
    if (!token) {
      copyUrl = null;
      copyButton.disabled = true;
      canvas.hidden = true;
      hint.textContent = '浏览器身份正在初始化，请稍后再试；若持续失败，刷新页面重试。';
    } else {
      var url = window.location.origin + '/#t=' + encodeURIComponent(token);
      copyUrl = url;
      copyButton.disabled = false;
      try {
        window.agentNetworkQr.draw(canvas, url);
        canvas.hidden = false;
        hint.textContent = '用手机相机扫描二维码，手机将以当前身份进入会话列表。';
      } catch (error) {
        canvas.hidden = true;
        hint.textContent = '二维码生成失败：' + (error && error.message ? error.message : String(error));
      }
    }
    opener = document.activeElement;
    modal.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    closeButton.focus();
  }

  function fallbackCopy(text, onSuccess, onFailure) {
    try {
      legacyCopyText(text);
      onSuccess();
    } catch (error) {
      onFailure(error);
    }
  }

  function copyText(text, onSuccess, onFailure) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      fallbackCopy(text, onSuccess, onFailure);
      return;
    }
    try {
      navigator.clipboard.writeText(text).then(onSuccess, function () {
        fallbackCopy(text, onSuccess, onFailure);
      });
    } catch (error) {
      fallbackCopy(text, onSuccess, onFailure);
    }
  }

  button.addEventListener('click', openDialog);
  closeButton.addEventListener('click', closeDialog);
  copyButton.addEventListener('click', function () {
    if (!copyUrl || copyButton.disabled) return;
    copyText(copyUrl, function () {
      // 只反馈复制动作，不把凭据写入页面文本。
      hint.textContent = '扫码内容已复制到剪贴板；该链接即长期凭据，请勿分享或截图。';
      copyButton.textContent = '已复制';
      copyResetTimer = setTimeout(resetCopyButton, 1500);
    }, function (error) {
      resetCopyButton();
      hint.textContent = '复制失败：' + (error && error.message ? error.message : String(error)) +
        '；请检查浏览器剪贴板权限后重试。';
    });
  });
  modal.addEventListener('click', function (event) {
    if (event.target === modal) closeDialog();
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !modal.hidden) closeDialog();
  });
})();
`;

/** 追加到应用页样式表；二维码保持白底，暗色模式下仍可扫描。 */
export const DEVICE_HANDOFF_STYLE = `
  .account { display: flex; align-items: center; gap: 10px; padding: 4px 4px 8px; }
  .account-avatar { flex: 0 0 auto; width: 36px; height: 36px; border-radius: 50%;
    background: #5b8def; color: #fff; display: grid; place-items: center;
    font-size: 15px; font-weight: 500; }
  .account-main { flex: 1 1 auto; min-width: 0; }
  .account-name { display: block; font-size: 13px; font-weight: 500; color: var(--wx-text, #333);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 三个文字按钮与单个归档图标在 280–320px 侧栏与 390px 移动端允许换行。 */
  .account-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px;
    margin-top: 1px; }
  .account-actions[hidden] { display: none; }
  .account-scan { padding: 0; border: 0; background: none;
    color: var(--wx-link, #576b95); font-size: 12px; cursor: pointer; }
  .account-scan:hover { text-decoration: underline; }
  .account-icon { flex: 0 0 auto; width: 22px; height: 22px; padding: 0; border: 0;
    border-radius: 4px; background: none; color: var(--wx-muted, #999);
    display: grid; place-items: center; cursor: pointer; }
  .account-icon:hover { background: var(--wx-hover, #ececec); color: var(--wx-text, #333); }
  .account-icon[hidden] { display: none; }
  .account-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor;
    stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .logout-card { width: min(400px, 100%); box-sizing: border-box; }
  .logout-warning { margin: 0 0 10px; padding: 10px; border-radius: 4px;
    background: #fff7ed; color: #9a3412; font-size: 13px; line-height: 1.6;
    overflow-wrap: anywhere; }
  .logout-hint { margin: 0 0 16px; font-size: 12px; color: var(--wx-muted, #666);
    line-height: 1.6; }
  .logout-actions { justify-content: flex-end; }
  /* 只作用于退出确认弹窗；避免全局 .danger 泄漏到会话菜单/文件操作。 */
  .logout-card button.danger { background: var(--wx-danger, #c0392b);
    border-color: var(--wx-danger, #c0392b); color: #fff; }
  .logout-card button.danger:hover { background: var(--wx-danger-strong, #a93226);
    border-color: var(--wx-danger-strong, #a93226); }
  .logout-card button.danger:focus-visible { outline: 2px solid var(--wx-text, #1a1a1a);
    outline-offset: 2px; }
  .logout-card button.danger:disabled { opacity: 1; background: #f6d5d5;
    border-color: #f6d5d5; color: #7f1d1d; cursor: not-allowed; }
  @media (prefers-color-scheme: dark) {
    .logout-warning { background: #3a2a1a; color: #fdba74; }
  }
  .handoff-card { width: min(340px, 100%); text-align: center; }
  .handoff-card h2 { margin-bottom: 6px; }
  .handoff-qr-wrap { display: grid; place-items: center; margin: 10px 0 12px; padding: 8px;
    border: 1px solid var(--wx-line, #e5e5e5); border-radius: 6px; background: #fff; }
  #handoff-qr { display: block; width: min(248px, 100%); height: auto; background: #fff;
    image-rendering: pixelated; }
  #handoff-qr[hidden] { display: none; }
  .handoff-hint { margin: 0 0 8px; font-size: 12px; color: var(--wx-muted, #555);
    line-height: 1.6; }
  .handoff-warning { margin: 0 0 12px; padding: 8px 10px; border-radius: 4px;
    background: #fff7ed; color: #9a3412; font-size: 12px; line-height: 1.6; text-align: left; }
  .handoff-actions { display: flex; gap: 8px; }
  .handoff-actions button { flex: 1 1 auto; height: 40px; }
  #handoff-copy[disabled] { opacity: 0.5; cursor: not-allowed; }
  @media (prefers-color-scheme: dark) {
    .handoff-warning { background: #3a2a1a; color: #fdba74; }
  }
`;
