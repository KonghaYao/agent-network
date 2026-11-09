/**
 * 网页监控面板样式：桌面 420px 第三栏、平板抽屉、移动端全屏。
 *
 * 与文件面板互斥但 DOM/状态独立；断点与聊天页一致：
 * >=1200 三栏、760–1199 抽屉、<760 全屏。暗色只换页面 chrome，
 * iframe 内容由目标站点决定，不强制反色。
 */
export const MONITOR_STYLE = `
  .monitor-toggle { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 4px;
    height: 32px; padding: 0 8px; border: 0; background: transparent;
    color: var(--wx-link); font-size: 13px; }
  .monitor-toggle:hover, .monitor-toggle.active { background: var(--wx-hover); }
  .monitor-toggle svg { width: 16px; height: 16px; fill: none;
    stroke: currentColor; stroke-width: 1.7; }

  .monitor-pane { flex: 0 0 420px; width: 420px; min-width: 0; max-width: 420px;
    min-height: 0; display: flex; flex-direction: column;
    background: var(--wx-sidebar); border-left: 1px solid var(--wx-line); }
  .monitor-pane[hidden] { display: none; }
  body.page-home .monitor-pane { display: none; }

  .monitor-toolbar { position: relative; flex: 0 0 auto; display: flex; align-items: center;
    gap: 6px; min-width: 0; padding: 8px 10px; border-bottom: 1px solid var(--wx-line); }
  .monitor-title { flex: 0 0 auto; margin: 0; font-size: 12px; font-weight: 600;
    color: var(--wx-muted); white-space: nowrap; }
  #monitor-url { flex: 1 1 0; width: auto; min-width: 0; height: 30px; padding: 0 8px;
    box-sizing: border-box; border: 1px solid var(--wx-line); border-radius: 4px;
    background: var(--wx-panel); color: var(--wx-text); font: inherit; font-size: 13px; }
  .monitor-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 2px; }
  .monitor-icon { flex: 0 0 auto; display: inline-flex; align-items: center;
    justify-content: center; width: 30px; height: 30px; padding: 0; border: 0;
    border-radius: 4px; background: transparent; color: var(--wx-muted);
    text-decoration: none; cursor: pointer; }
  .monitor-icon:hover { background: var(--wx-hover); color: var(--wx-text); }
  .monitor-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor;
    stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .monitor-icon.primary { background: var(--wx-green); color: #fff; }
  .monitor-icon.primary:hover { background: var(--wx-green-strong); color: #fff; }
  /* 主按钮上的 Kubai 图标以白色为底色；内部勾选改用绿色，避免白底白勾。 */
  .monitor-icon.primary .kubai-icon { --ki-e: var(--wx-green-strong); --ki-w: var(--wx-green); }
  .monitor-icon:disabled { opacity: .45; cursor: default; }
  .monitor-icon[aria-disabled="true"] { background: transparent; color: var(--wx-muted);
    opacity: .45; cursor: default; }
  .monitor-icon[aria-disabled="true"]:hover { background: transparent; color: var(--wx-muted); }

  .monitor-status { flex: 0 0 auto; min-width: 0; margin: 4px 10px 0; font-size: 11px;
    line-height: 1.4; color: var(--wx-muted); white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  .monitor-status:empty { display: none; }
  .monitor-status.error { color: var(--wx-unread); }
  .monitor-error { flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    min-width: 0; margin: 4px 10px 0; padding: 4px 8px; border-radius: 4px;
    background: var(--wx-panel); border: 1px solid var(--wx-line); }
  .monitor-error[hidden] { display: none; }
  .monitor-error p { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 11px;
    line-height: 1.4; color: var(--wx-unread); overflow-wrap: anywhere; }
  .monitor-error button { flex: 0 0 auto; padding: 2px 8px; font-size: 11px; }

  .monitor-hint { flex: 0 0 auto; min-width: 0; margin: 2px 10px 0; font-size: 11px;
    line-height: 1.4; color: var(--wx-muted); white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; }
  .monitor-hint[hidden] { display: none; }

  .monitor-frame-wrap { position: relative; flex: 1 1 auto; min-height: 0;
    margin: 8px 10px 10px; overflow: hidden; border: 1px solid var(--wx-line);
    border-radius: 6px; background: #fff; }
  .monitor-frame { position: absolute; inset: 0; display: block; width: 100%;
    height: 100%; border: 0; background: #fff; }
  .monitor-frame[hidden] { display: none; }
  .monitor-empty { position: absolute; inset: 0; margin: 0; padding: 0 12px;
    display: grid; place-items: center; text-align: center;
    color: var(--wx-muted); font-size: 12px; line-height: 1.4; }
  .monitor-empty[hidden] { display: none; }

  .monitor-backdrop { position: fixed; inset: 0; z-index: 23; background: rgb(0 0 0 / 40%); }
  .monitor-backdrop[hidden] { display: none; }

  @media (min-width: 760px) and (max-width: 1199px) {
    .monitor-pane { position: fixed; top: 0; right: 0; bottom: 0; z-index: 24;
      width: 420px; min-width: 420px; max-width: 420px; height: 100dvh;
      box-shadow: -8px 0 28px rgb(0 0 0 / 22%); }
  }

  @media (min-width: 1200px) {
    .monitor-backdrop { display: none !important; }
    /* 与文件栏共用分隔条和比例变量；默认 50/50，不再固定 20%。 */
    .chat-pane { flex: 1 1 auto; min-width: 320px; }
    .monitor-pane { flex: 0 0 calc((100% - 300px - var(--pane-resizer-width)) * var(--right-pane-ratio, 0.5));
      width: calc((100% - 300px - var(--pane-resizer-width)) * var(--right-pane-ratio, 0.5));
      min-width: 280px;
      max-width: calc(100% - 300px - var(--pane-resizer-width) - 320px);
      box-sizing: border-box; }
  }

  @media (max-width: 759px) {
    .monitor-pane { position: fixed; inset: 0; z-index: 30; width: 100%;
      min-width: 0; max-width: none; height: 100dvh; border-left: 0;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom); }
    .monitor-pane[hidden] { display: none; }
    .monitor-backdrop { display: none !important; }
    body.monitor-page-open .chat-pane,
    body.monitor-page-open .sidebar { display: none; }
    .monitor-toolbar { padding: 8px 10px; }
    #monitor-url { font-size: 16px; }
    .monitor-status, .monitor-error, .monitor-hint {
      margin-left: 10px; margin-right: 10px;
    }
  }

  @media (max-width: 480px) {
    /* 窄屏把标题移出视觉流，优先把宽度让给地址框；aria-labelledby 仍可读出标题。 */
    .monitor-title { position: absolute; width: 1px; height: 1px; margin: -1px;
      padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  }
`;
