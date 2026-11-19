/**
 * 网页监控面板样式：桌面 420px 第三栏、平板抽屉、移动端全屏。
 *
 * 与文件面板互斥但 DOM/状态独立；断点与聊天页一致：
 * >=1200 三栏、760–1199 抽屉、<760 全屏。暗色只换页面 chrome，
 * iframe 内容由目标站点决定，不强制反色。
 */
export const MONITOR_STYLE = `
  .monitor-toggle { position: relative; flex: 0 0 auto; display: inline-flex;
    align-items: center; gap: 4px; }
  .monitor-toggle:not([data-lenso-slot]) { height: 32px; padding: 0 8px; border: 0;
    background: transparent; color: var(--wx-link); font-size: 13px; }
  .monitor-toggle:hover, .monitor-toggle.active { background: var(--wx-hover); }
  .monitor-toggle::after { content: ""; position: absolute; left: 0; right: 0;
    top: 50%; height: 44px; transform: translateY(-50%); }
  .monitor-toggle svg { width: 16px; height: 16px; fill: none;
    stroke: currentColor; stroke-width: 1.7; }

  .monitor-pane { flex: 0 0 var(--app-monitor-width); width: var(--app-monitor-width);
    min-width: 0; max-width: var(--app-monitor-width);
    min-height: 0; display: flex; flex-direction: column;
    background: var(--wx-sidebar); border-left: 1px solid var(--wx-line); }
  .monitor-pane[hidden] { display: none; }
  body.page-home .monitor-pane { display: none; }

  .monitor-toolbar { position: relative; flex: 0 0 auto; min-width: 0;
    padding: 8px 12px; border-bottom: 1px solid var(--wx-line); }
  /* 两行工具栏：第一行地址+保存，第二行其余操作；清掉 Lenso Toolbar 自带材质。 */
  .monitor-toolbar > [data-lenso-slot^='toolbar'] { display: flex !important;
    flex-direction: column !important; align-items: stretch !important;
    gap: 8px !important; width: 100% !important; padding: 0 !important;
    border: 0 !important; border-radius: 0 !important;
    background: transparent !important; box-shadow: none !important; }
  .monitor-row { display: flex; align-items: center; gap: 8px; width: 100%;
    min-width: 0; }
  .monitor-row-actions { flex-wrap: wrap; justify-content: flex-end; }
  .monitor-title { flex: 0 0 auto; margin: 0; font-size: 12px; line-height: 16px;
    font-weight: 600; color: var(--wx-muted); white-space: nowrap; }
  #monitor-url { flex: 1 1 160px; width: auto; min-width: 0; height: 36px;
    padding: 0 12px; box-sizing: border-box; border: 0; border-radius: 8px;
    background: var(--lenso-control-field-fill); color: var(--lenso-label-primary);
    font: inherit; font-size: 13px !important; line-height: 20px !important; }
  .monitor-icon { flex: 0 0 auto; display: inline-flex; align-items: center;
    justify-content: center; width: 44px !important; height: 44px !important;
    min-width: 44px !important; padding: 0 6px !important; border: 0;
    border-radius: 8px !important; background: transparent; color: var(--wx-muted);
    font-size: 13px; line-height: 20px; text-decoration: none; cursor: pointer; }
  .monitor-icon:hover { background: var(--wx-hover); color: var(--wx-text); }
  .monitor-icon svg { width: 16px; height: 16px; fill: none; stroke: currentColor;
    stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .monitor-icon.primary { background: var(--wx-green); color: var(--lenso-label-on-tint); }
  .monitor-icon.primary:hover { background: var(--wx-green-strong); color: var(--lenso-label-on-tint); }
  .monitor-icon:disabled { opacity: .45; cursor: default; }
  .monitor-icon[aria-disabled="true"] { background: transparent; color: var(--wx-muted);
    opacity: .45; cursor: default; }
  .monitor-icon[aria-disabled="true"]:hover { background: transparent; color: var(--wx-muted); }

  .monitor-status { flex: 0 0 auto; min-width: 0; margin: 4px 12px 0;
    font-size: 12px; line-height: 16px; color: var(--wx-muted);
    overflow-wrap: anywhere; }
  .monitor-status:empty { display: none; }
  .monitor-status.error { color: var(--wx-unread); }
  .monitor-error { flex: 0 0 auto; display: flex; align-items: flex-start; gap: 8px;
    min-width: 0; margin: 4px 12px 0; padding: 8px; border-radius: 8px;
    background: var(--wx-panel); border: 1px solid var(--wx-line); }
  .monitor-error[hidden] { display: none; }
  .monitor-error p { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 12px;
    line-height: 16px; color: var(--wx-unread); overflow-wrap: anywhere; }
  .monitor-error button { flex: 0 0 auto; min-height: 44px !important;
    min-width: 44px; padding: 0 12px; border-radius: 8px;
    font-size: 13px; line-height: 20px; }

  .monitor-hint { flex: 0 0 auto; min-width: 0; margin: 4px 12px 0;
    font-size: 12px; line-height: 16px; color: var(--wx-muted);
    overflow-wrap: anywhere; }
  .monitor-hint[hidden] { display: none; }

  #monitor-frame-wrap { box-shadow: none !important; }
  .monitor-frame { position: absolute; inset: 0; display: block; width: 100%;
    height: 100%; border: 0; background: #fff; }
  .monitor-frame[hidden] { display: none; }
  .monitor-empty { position: absolute; inset: 0; margin: 0; padding: 0 12px;
    display: grid; place-items: center; text-align: center;
    color: var(--wx-muted); font-size: 13px; line-height: 20px; }
  .monitor-empty[hidden] { display: none; }

  .monitor-backdrop { position: fixed; inset: 0; z-index: var(--app-z-pane-scrim);
    background: var(--lenso-scrim); }
  .monitor-backdrop[hidden] { display: none; }

  @media (min-width: 760px) and (max-width: 1199px) {
    .monitor-pane { position: fixed; top: 0; right: 0; bottom: 0; z-index: var(--app-z-pane);
      width: var(--app-monitor-width); min-width: var(--app-monitor-width);
      max-width: var(--app-monitor-width); height: 100dvh; border-left: 0;
      box-shadow: -8px 0 28px var(--lenso-scrim); }
  }

  @media (min-width: 1200px) {
    .monitor-backdrop { display: none !important; }
    /* 与文件栏共用分隔条和比例变量；默认 50/50，不再固定 20%。 */
    .chat-pane { flex: 1 1 auto; min-width: var(--app-chat-min); }
    .monitor-pane { flex: 0 0 calc((100% - var(--app-sidebar-width) - var(--pane-resizer-width)) * var(--right-pane-ratio, 0.5));
      width: calc((100% - var(--app-sidebar-width) - var(--pane-resizer-width)) * var(--right-pane-ratio, 0.5));
      min-width: var(--app-pane-min);
      max-width: calc(100% - var(--app-sidebar-width) - var(--pane-resizer-width) - var(--app-chat-min));
      box-sizing: border-box; }
  }

  @media (max-width: 759px) {
    .monitor-pane { position: fixed; inset: 0; z-index: var(--app-z-legacy-modal); width: 100%;
      min-width: 0; max-width: none; height: 100dvh; border-left: 0;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom); }
    .monitor-pane[hidden] { display: none; }
    .monitor-backdrop { display: none !important; }
    body.monitor-page-open .chat-pane,
    body.monitor-page-open .sidebar { display: none; }
    .monitor-toolbar { padding: 8px 12px; }
    #monitor-url { height: 44px !important; font-size: 16px !important; line-height: 24px !important; }
    .monitor-row-actions { justify-content: flex-start; }
    .monitor-status, .monitor-error, .monitor-hint {
      margin-left: 12px; margin-right: 12px;
    }
  }

  @media (max-width: 480px) {
    /* 窄屏把标题移出视觉流，优先把宽度让给地址框；aria-labelledby 仍可读出标题。 */
    .monitor-title { position: absolute; width: 1px; height: 1px; margin: -1px;
      padding: 0; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  }
`;
