/**
 * 配对设备弹窗与左下角账号区块。
 *
 * 二维码只包含 `location.origin + '/pair#c=' + challenge`；挑战 5 分钟有效、
 * 一次性，不包含登录 token。已登录设备仍须核对设备名称、平台与确认码后
 * 明确批准，新设备才能兑换独立 credential。
 */

import { LIMITS } from '../contracts/limits';
import { kubaiIcon } from './icons';

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
          ${kubaiIcon('account-edit', { size: 14 })}
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
          ${kubaiIcon('archived-agents', { size: 16 })}
        </button>
        <button class="account-icon" id="logout" type="button"
          aria-label="退出登录" title="退出登录"
          aria-haspopup="dialog" aria-controls="logout-modal" aria-expanded="false" hidden>
          ${kubaiIcon('logout', { size: 16 })}
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
 * 打开即自动生成 5 分钟一次性挑战：左栏二维码、12 位短码与链接操作，
 * 右栏状态与待确认设备。二维码只包含 `location.origin + '/pair#c=' + challenge`，
 * 不含登录 token；仍须已登录设备核对设备名称、平台与确认码后明确批准。
 */
export function deviceHandoffDialog(): string {
  return `<div class="modal" id="handoff-modal" hidden>
  <div class="modal-card handoff-card" role="dialog" aria-modal="true" aria-labelledby="handoff-title">
    <h2 id="handoff-title">配对设备</h2>
    <p class="handoff-hint" id="handoff-hint">用另一台设备扫描或输入 12 位配对码。</p>
    <div class="handoff-columns">
      <section class="handoff-col handoff-col-code" aria-label="配对码">
        <div class="handoff-qr-wrap" id="pairing-qr-wrap" hidden>
          <canvas id="handoff-qr" role="img" aria-label="一次性设备配对挑战二维码"></canvas>
          <p class="pairing-code" id="pairing-code"></p>
          <p class="handoff-expiry" id="pairing-expiry"></p>
        </div>
        <div class="handoff-actions handoff-code-actions">
          <button class="primary" id="pairing-create" type="button">重新生成</button>
          <button id="handoff-copy" type="button" disabled>复制链接</button>
        </div>
        <button class="handoff-retry" id="pairing-retry" type="button" hidden>重试</button>
      </section>
      <section class="handoff-col handoff-col-status" aria-label="设备确认">
        <p class="pairing-status" id="pairing-status" role="status"></p>
        <section class="pairing-section" aria-labelledby="pairing-list-title">
          <div class="pairing-section-head">
            <h3 id="pairing-list-title">待确认的新设备</h3>
            <button class="pairing-refresh" id="pairing-refresh" type="button">刷新</button>
          </div>
          <p class="pairing-empty" id="pairing-list-empty">暂无待确认设备</p>
          <ul class="pairing-list" id="pairing-list"></ul>
        </section>
        <p class="handoff-warning">只在核对设备名称/平台/确认码后批准；请勿截图或分享配对码。</p>
      </section>
    </div>
    <div class="handoff-actions handoff-footer">
      <button id="handoff-close" type="button">关闭</button>
    </div>
  </div>
</div>`;
}

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
  .handoff-card { box-sizing: border-box; width: min(720px, 100%);
    max-height: calc(100dvh - 32px); display: flex; flex-direction: column;
    overflow: hidden; text-align: left; }
  .handoff-card h2 { margin: 0 0 4px; }
  .handoff-hint { margin: 0 0 14px; font-size: 12px; color: var(--wx-muted, #555);
    line-height: 1.6; }
  /* 桌面两栏：左栏二维码/短码，右栏状态与待确认设备；<760px 单栏堆叠。 */
  .handoff-columns { display: grid; grid-template-columns: minmax(0, 260px) minmax(0, 1fr);
    gap: 18px; align-items: start; min-height: 0; overflow-y: auto; }
  .handoff-col { min-width: 0; }
  .handoff-col-code { display: flex; flex-direction: column; gap: 10px; }
  .handoff-qr-wrap { display: grid; place-items: center; gap: 6px; margin: 0; padding: 10px;
    border: 1px solid var(--wx-line, #e5e5e5); border-radius: 8px; background: #fff; }
  .handoff-qr-wrap[hidden] { display: none; }
  #handoff-qr { display: block; width: min(224px, 100%); height: auto; background: #fff;
    image-rendering: pixelated; }
  #handoff-qr[hidden] { display: none; }
  .pairing-code { margin: 2px 0 0; font: 600 19px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    letter-spacing: 1px; color: var(--wx-text, #1a1a1a); text-align: center;
    overflow-wrap: anywhere; }
  .handoff-expiry { margin: 0; font-size: 11px; line-height: 1.5; color: var(--wx-muted, #666);
    text-align: center; }
  .handoff-code-actions { display: flex; gap: 8px; }
  .handoff-code-actions button { flex: 1 1 0; min-width: 0; height: 38px; padding: 0 8px; }
  .handoff-retry { width: 100%; height: 38px; }
  .handoff-retry[hidden] { display: none; }
  .pairing-section { margin: 0; padding-top: 0; border-top: 0; }
  .pairing-section-head { display: flex; align-items: center; justify-content: space-between;
    gap: 10px; margin-bottom: 8px; }
  .pairing-section h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .pairing-refresh { flex: 0 0 auto; height: 28px; padding: 0 10px; font-size: 12px; }
  .pairing-empty { margin: 0 0 6px; font-size: 12px; color: var(--wx-muted, #666); }
  .pairing-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .pairing-item { border: 1px solid var(--wx-line, #e5e5e5); border-radius: 6px;
    padding: 8px 10px; background: var(--wx-sidebar, #f7f7f7); }
  .pairing-item-main { font-size: 13px; overflow-wrap: anywhere; }
  .pairing-item-meta { font-size: 12px; color: var(--wx-muted, #666); margin-top: 2px;
    overflow-wrap: anywhere; }
  .pairing-item-code { font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--wx-text, #333); }
  .pairing-item-actions { display: flex; gap: 8px; margin-top: 8px; }
  .pairing-item-actions button { flex: 1 1 auto; height: 32px; padding: 4px 8px; font-size: 12px; }
  .pairing-item-actions button.danger { background: var(--wx-danger, #c0392b);
    border-color: var(--wx-danger, #c0392b); color: #fff; }
  .pairing-status { min-height: 1.6em; margin: 0 0 10px; font-size: 12px;
    color: var(--wx-link, #576b95); overflow-wrap: anywhere; }
  .pairing-status[data-error] { color: var(--wx-danger, #c0392b); }
  .pairing-status[data-success] { color: #15803d; }
  .local-identities { display: grid; gap: 6px; margin-top: 8px; }
  .local-identities-title { margin: 0; font-size: 12px; color: var(--wx-muted, #666); }
  .local-identities .local-identity { width: 100%; }
  .handoff-warning { margin: 12px 0 0; padding: 8px 10px; border-radius: 4px;
    background: #fff7ed; color: #9a3412; font-size: 12px; line-height: 1.6;
    overflow-wrap: anywhere; }
  .handoff-actions { display: flex; gap: 8px; }
  .handoff-footer { flex: 0 0 auto; justify-content: flex-end; margin-top: 14px; }
  .handoff-footer button { flex: 0 0 auto; min-width: 96px; height: 38px; }
  #handoff-copy[disabled] { opacity: 0.5; cursor: not-allowed; }
  @media (max-width: 759px) {
    #handoff-modal { padding: 0; place-items: stretch; }
    .handoff-card { box-sizing: border-box; width: 100%; height: 100dvh;
      max-height: 100dvh; border-radius: 0; display: flex; flex-direction: column;
      overflow: hidden; padding: calc(16px + env(safe-area-inset-top)) 16px
        calc(16px + env(safe-area-inset-bottom)); }
    .handoff-card h2, .handoff-hint { flex: 0 0 auto; }
    .handoff-columns { flex: 1 1 auto; min-height: 0; overflow-y: auto;
      grid-template-columns: minmax(0, 1fr); align-content: start; gap: 12px; }
    .handoff-footer { flex: 0 0 auto; margin-top: 12px; }
    .handoff-code-actions button, .handoff-retry, .pairing-refresh,
    .pairing-item-actions button, .handoff-footer button { min-height: 44px; }
    .handoff-col-status { min-width: 0; }
    .pairing-item-actions button { min-width: 0; }
  }
  @media (prefers-color-scheme: dark) {
    .handoff-warning { background: #3a2a1a; color: #fdba74; }
  }
`;
