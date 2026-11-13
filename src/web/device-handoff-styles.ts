/**
 * 账号区块、配对/设备交接弹窗、退出与改名弹窗的共享样式。
 *
 * 这些选择器由 React 组件继续使用（`DeviceHandoffDialog`、`AccountMenu`、
 * `LogoutDialog`、`MeRenameDialog`），因此从旧壳中独立出来保留。
 */

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
  /* legacy 账号铅笔固定 #999/#8c8c8c；SPA 的 --wx-muted 为对比度调整过，
     不能套用到该装饰图标，否则与 legacy 观感不一致。 */
  .account-edit { flex: 0 0 auto; width: 20px; height: 20px; padding: 0; border: 0;
    border-radius: 4px; background: none; color: #999;
    display: grid; place-items: center; cursor: pointer; }
  @media (prefers-color-scheme: dark) { .account-edit { color: #8c8c8c; } }
  .account-edit:hover { background: var(--wx-hover, #ececec); color: var(--wx-text, #333); }
  .account-edit[hidden] { display: none; }
  .account-edit svg { width: 14px; height: 14px; fill: none; stroke: currentColor;
    stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  /* 三个文字按钮与单个归档图标在 280–320px 侧栏与 390px 移动端允许换行。 */
  .account-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px;
    margin-top: 1px; }
  .account-actions[hidden] { display: none; }
  /* legacy 基础样式对 button 应用 font: inherit；SPA 壳没有该重置，
     账号文字入口需显式继承，否则浏览器表单控件会回退到 Arial 并改变宽度。 */
  .account-scan { padding: 0; border: 0; background: none; font: inherit;
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
