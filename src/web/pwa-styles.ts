/**
 * PWA 安装引导与品牌字标样式。
 *
 * 只影响新增的 guided 界面和侧栏文字标；不改变现有布局、输入框或桌面
 * 双栏规则。安装引导复用 `spa-dialog-content` 的弹窗宿主样式。
 */
export const PWA_STYLE = `
  /* 品牌字标：用户确认使用绿色 logo；主题色仍保持蓝色。 */
  .brand-row h1 { color: #07c160; }

  .install-guide-card { width: min(420px, calc(100vw - 32px)); box-sizing: border-box;
    max-height: min(80dvh, 680px); overflow-y: auto; }
  .install-guide-title { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
  .install-guide-lead { margin: 0 0 16px; color: var(--wx-muted, #666);
    font-size: 13px; line-height: 1.7; }
  .install-guide-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
    margin: 0 0 12px; }
  .install-guide-actions button, .install-guide-actions a { min-height: 36px; }
  .install-guide-link { display: inline-flex; align-items: center; min-height: 44px;
    color: var(--wx-link, #576b95); font-size: 13px; text-decoration: none; }
  .install-guide-link:hover { text-decoration: underline; }
  .install-guide-secondary { color: var(--wx-muted, #666); }
  .install-guide-status { margin: 0 0 12px; padding: 8px 10px; border-radius: 6px;
    background: var(--wx-panel, #f7f7f7); color: var(--wx-text, #1a1a1a);
    font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  .install-guide-status[data-kind="error"] { color: var(--wx-danger, #e5484d); }
  .install-guide-status[hidden] { display: none; }
  .install-guide-steps { margin: 0 0 16px; padding: 0 0 0 20px;
    color: var(--wx-muted, #666); font-size: 13px; line-height: 1.8; }
  .install-guide-steps[hidden] { display: none; }
  .install-guide-inline { width: min(420px, 100%); margin: 0 auto; }
  .install-guide-inline .install-guide-card { width: 100%; box-shadow: none;
    border: 1px solid var(--wx-line, #e5e5e5); }
  .account-guest-actions { gap: 4px 14px; }
  .account-guest-actions a.account-scan { display: inline-flex; align-items: center;
    height: 22px; color: var(--wx-link, #576b95); font-size: 12px;
    text-decoration: none; }
  .account-guest-actions a.account-scan:hover { text-decoration: underline; }
  @media (max-width: 759px) {
    .install-guide-card { width: 100%; }
    .install-guide-actions { flex-direction: column; align-items: stretch; }
    .install-guide-actions > * { width: 100%; }
  }
`;
