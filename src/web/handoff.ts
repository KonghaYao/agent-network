/**
 * 手机扫码入口：把当前浏览器身份通过 URL fragment 交给手机。
 *
 * token 只出现在 `#t=` 之后；浏览器不会把 fragment 发给服务端，因此
 * 二维码不经过任何服务端端点，也不引入新工具、密钥或数据库状态。
 * 代价是二维码本身就是长期凭据：任何看到二维码的人都能获得同一身份。
 */

import { LIMITS } from '../contracts/limits';

/**
 * 左下角用户区块：头像、名称、新建 Agent、配对设备与已归档入口。
 *
 * 已归档入口只是一个图标按钮，打开轻量浮层；不再提供 Agents 管理弹窗。
 * 本地注册表仍由“新建 Agent”写入，并供 direct Agent 会话右键提示词复用。
 */
export function deviceHandoffAccount(): string {
  return `<div class="account" id="account">
    <span class="account-avatar" id="account-avatar" aria-hidden="true">?</span>
    <div class="account-main">
      <div class="account-name-row">
        <span class="account-name" id="account-name">未登录</span>
        <button class="account-edit" id="account-rename" type="button"
          aria-label="编辑姓名" title="编辑姓名"
          aria-haspopup="dialog" aria-controls="me-rename-modal" aria-expanded="false" hidden>
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M4 20h4l10-10-4-4L4 16z"></path>
            <path d="M13.5 6.5l4 4"></path>
          </svg>
        </button>
      </div>
      <div class="account-actions">
        <button class="account-scan" id="new-agent" type="button"
          aria-haspopup="dialog" aria-controls="new-agent-modal" aria-expanded="false">新建 Agent</button>
        <button class="account-scan" id="device-handoff" type="button"
          aria-haspopup="dialog" aria-controls="handoff-modal" aria-expanded="false">配对设备</button>
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
 * 只清除当前身份的凭据与本机缓存；其他已保存的本地身份保留，可在退出页
 * 或账号区显式切换回来。不调用服务端，也不吊销 token。
 */
export function logoutDialog(): string {
  return `<div class="modal" id="logout-modal" hidden>
  <div class="modal-card logout-card" role="dialog" aria-modal="true" aria-labelledby="logout-title">
    <h2 id="logout-title">退出登录</h2>
    <p class="logout-warning">本机将清除当前身份的登录凭据、草稿队列与已保存的 Agent 连接提示词；其他已保存身份不受影响。当前 token 仍然有效，其他设备也不受影响。</p>
    <p class="logout-hint">只在本机退出，不调用服务端，也不会吊销 token。退出后会显示分享链接引导；需要继续使用时可显式切换到本机其他身份、创建新身份或重新配对。</p>
    <div class="row modal-actions logout-actions">
      <button id="logout-cancel" type="button" aria-label="取消退出登录">取消</button>
      <button class="danger" id="logout-confirm" type="button" aria-label="确认退出登录">退出登录</button>
    </div>
  </div>
</div>`;
}

/**
 * 修改本人姓名弹窗：输入框只提交到 self-only 工具，不接收 actor_id。
 *
 * 保存成功后页面原地更新显示名，不重新加载房间或凭据。
 */
export function meRenameDialog(): string {
  return `<div class="modal" id="me-rename-modal" hidden>
  <div class="modal-card me-rename-card" role="dialog" aria-modal="true"
    aria-labelledby="me-rename-title">
    <h2 id="me-rename-title">修改姓名</h2>
    <form id="me-rename-form">
      <label class="field">姓名
        <input id="me-rename-input" maxlength="${LIMITS.actorNameMax}" autocomplete="off"
          placeholder="输入新的姓名" aria-describedby="me-rename-hint" required>
      </label>
      <p class="me-rename-hint" id="me-rename-hint">姓名会显示给你自己和与你协作的成员，最多 ${LIMITS.actorNameMax} 个字符。</p>
      <p id="me-rename-error" class="form-error" role="alert"></p>
      <div class="row modal-actions">
        <button id="me-rename-cancel" type="button">取消</button>
        <button class="primary" id="me-rename-save" type="submit">保存</button>
      </div>
    </form>
  </div>
</div>`;
}

/**
 * 配对设备弹窗。
 *
 * 二维码只包含 `location.origin + '/pair#c=' + challenge`；挑战 5 分钟有效、
 * 一次性、需已登录设备明确确认。旧长期 token 入口收进折叠的“旧方式”，
 * 明确标注风险，不再作为默认按钮文案。
 */
export function deviceHandoffDialog(): string {
  return `<div class="modal" id="handoff-modal" hidden>
  <div class="modal-card handoff-card" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
    <h2 id="handoff-title">配对设备</h2>
    <p class="handoff-hint" id="handoff-hint">用另一台设备扫描二维码，或输入 12 位配对码。二维码只包含 5 分钟一次性挑战，不包含你的登录 token。</p>
    <div class="handoff-actions handoff-actions-top">
      <button class="primary" id="pairing-create" type="button">生成配对码</button>
      <button id="pairing-refresh" type="button">刷新待确认</button>
    </div>
    <div class="handoff-qr-wrap" id="pairing-qr-wrap" hidden>
      <canvas id="handoff-qr" role="img" aria-label="一次性设备配对挑战二维码"></canvas>
      <p class="pairing-code" id="pairing-code"></p>
      <p class="handoff-hint" id="pairing-expiry"></p>
    </div>
    <section class="pairing-section" aria-labelledby="pairing-list-title">
      <h3 id="pairing-list-title">待确认的新设备</h3>
      <p class="pairing-empty" id="pairing-list-empty">暂无待确认设备</p>
      <ul class="pairing-list" id="pairing-list"></ul>
    </section>
    <p class="pairing-status" id="pairing-status" role="status"></p>
    <p class="handoff-warning">只在核对设备名称、平台与确认码一致后批准。配对码和确认码都不是登录凭据；任何看到配对码的人仍需要你明确确认。</p>
    <details class="legacy-token-details" id="legacy-token-details">
      <summary>旧方式（长期凭据）</summary>
      <p class="handoff-warning">旧 <code>/#t=</code> 链接把长期 token 放在 URL fragment 中，任何看到链接或截图的人都能获得该身份。仅用于升级旧链接；切换前会再次显示原身份与目标身份并要求确认。</p>
      <label class="field">旧链接或 token
        <input id="legacy-token-input" autocomplete="off" spellcheck="false"
          placeholder="https://…/#t=… 或直接粘贴 token" aria-describedby="legacy-token-hint">
      </label>
      <p class="handoff-hint" id="legacy-token-hint">不会自动覆盖当前身份；确认后原身份仍保存在本机身份列表。</p>
      <button id="legacy-token-use" type="button">检查旧长期凭据</button>
    </details>
    <div class="handoff-actions">
      <button id="handoff-copy" type="button" disabled>复制配对链接</button>
      <button class="primary" id="handoff-close" type="button">关闭</button>
    </div>
  </div>
</div>`;
}

/** 旧长期凭据确认弹窗：明确显示原身份、目标身份与风险，确认后才切换。 */
export function legacyTokenDialog(): string {
  return `<div class="modal" id="legacy-token-modal" hidden>
  <div class="modal-card handoff-card legacy-token-card" role="dialog" aria-modal="true"
    aria-labelledby="legacy-token-title">
    <h2 id="legacy-token-title">旧方式（长期凭据）</h2>
    <p class="handoff-warning">这是一个长期身份 token，不是一次性配对挑战。任何看到链接、截图或浏览器历史的人都能以该身份操作。确认前不会切换，也不会覆盖当前身份。</p>
    <dl class="legacy-token-identities">
      <dt>当前身份</dt><dd id="legacy-token-original">读取中…</dd>
      <dt>目标身份</dt><dd id="legacy-token-target">读取中…</dd>
    </dl>
    <p class="pairing-status" id="legacy-token-status" role="status"></p>
    <div class="handoff-actions">
      <button id="legacy-token-cancel" type="button">取消</button>
      <button class="danger" id="legacy-token-confirm" type="button" disabled>确认切换</button>
    </div>
  </div>
</div>`;
}

/**
 * 在页面主脚本之前执行：只捕获 `#t=` 中的旧 token 并清掉 hash。
 *
 * 不在这里写入 localStorage，也不自动切换身份；主脚本会显示“旧方式
 * （长期凭据）”确认弹窗，用户确认后才保存 token。
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
  window.__agentNetworkLegacyToken = token;
  try {
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  } catch (error) {
    // 清 hash 失败时 token 仍留在地址栏；主脚本不会自动采纳，用户可取消。
  }
})();
`;

/** 追加到应用页样式表；二维码保持白底，暗色模式下仍可扫描。 */
export const DEVICE_HANDOFF_STYLE = `
  .account { display: flex; align-items: center; gap: 10px; padding: 4px 4px 8px; }
  .account-avatar { flex: 0 0 auto; width: 36px; height: 36px; border-radius: 50%;
    background: #5b8def; color: #fff; display: grid; place-items: center;
    font-size: 15px; font-weight: 500; }
  .account-main { flex: 1 1 auto; min-width: 0; }
  .account-name-row { display: flex; align-items: center; gap: 2px; min-width: 0; }
  .account-name { display: block; flex: 0 1 auto; min-width: 0; font-size: 13px;
    font-weight: 500; color: var(--wx-text, #333);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .account-edit { flex: 0 0 auto; width: 20px; height: 20px; padding: 0; border: 0;
    border-radius: 4px; background: none; color: var(--wx-muted, #999);
    display: grid; place-items: center; cursor: pointer; }
  .account-edit:hover { background: var(--wx-hover, #ececec); color: var(--wx-text, #333); }
  .account-edit[hidden] { display: none; }
  .account-edit svg { width: 14px; height: 14px; fill: none; stroke: currentColor;
    stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
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
  .me-rename-card { width: min(400px, 100%); box-sizing: border-box; }
  .me-rename-hint { margin: 0 0 12px; font-size: 12px; color: var(--wx-muted, #666);
    line-height: 1.6; }
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
  .handoff-card { width: min(380px, 100%); text-align: center; max-height: calc(100dvh - 32px);
    overflow-y: auto; }
  .handoff-card h2 { margin-bottom: 6px; }
  .handoff-actions-top { margin-bottom: 12px; }
  .handoff-actions-top button { flex: 1 1 auto; height: 38px; }
  .pairing-section { margin: 12px 0; padding-top: 10px; border-top: 1px solid var(--wx-line, #e5e5e5); }
  .pairing-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; text-align: left; }
  .pairing-empty { margin: 0 0 6px; font-size: 12px; color: var(--wx-muted, #666); text-align: left; }
  .pairing-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .pairing-item { border: 1px solid var(--wx-line, #e5e5e5); border-radius: 6px;
    padding: 8px 10px; text-align: left; background: var(--wx-sidebar, #f7f7f7); }
  .pairing-item-main { font-size: 13px; overflow-wrap: anywhere; }
  .pairing-item-meta { font-size: 12px; color: var(--wx-muted, #666); margin-top: 2px;
    overflow-wrap: anywhere; }
  .pairing-item-code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--wx-text, #333); }
  .pairing-item-actions { display: flex; gap: 8px; margin-top: 8px; }
  .pairing-item-actions button { flex: 1 1 auto; height: 32px; padding: 4px 8px; font-size: 12px; }
  .pairing-item-actions button.danger { background: var(--wx-danger, #c0392b);
    border-color: var(--wx-danger, #c0392b); color: #fff; }
  .pairing-code { margin: 8px 0 2px; font: 600 18px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 1px; color: var(--wx-text, #1a1a1a); }
  .pairing-status { min-height: 1.6em; margin: 6px 0 10px; font-size: 12px;
    color: var(--wx-link, #576b95); text-align: left; overflow-wrap: anywhere; }
  .pairing-status[data-error] { color: var(--wx-danger, #c0392b); }
  .pairing-status[data-success] { color: #15803d; }
  .legacy-token-details { text-align: left; }
  .legacy-token-details .field { display: block; margin: 8px 0; font-size: 12px; }
  .legacy-token-details input { width: 100%; height: 34px; margin-top: 4px;
    border: 1px solid var(--wx-line, #e5e5e5); border-radius: 4px; padding: 0 8px;
    background: var(--wx-input, #fff); color: var(--wx-text, #333); font: 12px/1.4 inherit; }
  .legacy-token-card { text-align: left; }
  .legacy-token-identities { margin: 10px 0 4px; }
  .legacy-token-identities dd { overflow-wrap: anywhere; }
  .legacy-token-card button.danger { background: var(--wx-danger, #c0392b);
    border-color: var(--wx-danger, #c0392b); color: #fff; }
  .local-identities { display: grid; gap: 6px; margin-top: 8px; }
  .local-identities-title { margin: 0; font-size: 12px; color: var(--wx-muted, #666); }
  .local-identities .local-identity { width: 100%; }
  .handoff-qr-wrap { display: grid; place-items: center; margin: 10px 0 12px; padding: 8px;
    border: 1px solid var(--wx-line, #e5e5e5); border-radius: 6px; background: #fff; }
  .handoff-qr-wrap[hidden] { display: none; }
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
