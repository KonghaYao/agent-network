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

  .monitor-head { flex: 0 0 auto; display: flex; align-items: center;
    justify-content: space-between; gap: 8px; min-height: 56px; padding: 0 12px;
    border-bottom: 1px solid var(--wx-line); }
  .monitor-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .monitor-head-actions { display: flex; align-items: center; gap: 6px; }
  .monitor-head-actions button { padding: 5px 9px; font-size: 12px; }
  .monitor-close, .monitor-refresh { border: 0; background: transparent; color: var(--wx-link); }
  .monitor-close:hover, .monitor-refresh:hover { background: var(--wx-hover); }

  .monitor-form { flex: 0 0 auto; padding: 10px 12px 0; }
  .monitor-field { display: block; }
  .monitor-label { display: block; margin-bottom: 5px; font-size: 11px; color: var(--wx-muted); }
  #monitor-url { width: 100%; height: 32px; padding: 0 10px; box-sizing: border-box;
    border: 1px solid var(--wx-line); border-radius: 4px; background: var(--wx-panel);
    color: var(--wx-text); font: inherit; font-size: 13px; }
  .monitor-form-actions { display: flex; gap: 6px; margin-top: 7px; }
  .monitor-form-actions button { padding: 5px 10px; font-size: 12px; }

  .monitor-status { margin: 7px 12px 0; font-size: 12px; color: var(--wx-muted);
    line-height: 1.5; overflow-wrap: anywhere; }
  .monitor-status:empty { display: none; }
  .monitor-status.error { color: var(--wx-unread); }
  .monitor-error { margin: 8px 12px 0; padding: 8px 10px; border-radius: 6px;
    background: var(--wx-bg); border: 1px solid var(--wx-line); }
  .monitor-error[hidden] { display: none; }
  .monitor-error p { margin: 0 0 8px; font-size: 12px; color: var(--wx-unread);
    overflow-wrap: anywhere; }
  .monitor-error button { font-size: 12px; }

  .monitor-frame-wrap { position: relative; flex: 1 1 auto; min-height: 0;
    margin: 10px 12px; overflow: hidden; border: 1px solid var(--wx-line);
    border-radius: 6px; background: #fff; }
  .monitor-frame { position: absolute; inset: 0; display: block; width: 100%;
    height: 100%; border: 0; background: #fff; }
  .monitor-frame[hidden] { display: none; }
  .monitor-empty { position: absolute; inset: 0; margin: 0; padding: 28px 18px;
    display: grid; place-items: center; text-align: center;
    color: var(--wx-muted); font-size: 12px; line-height: 1.7; }
  .monitor-empty[hidden] { display: none; }

  .monitor-foot { flex: 0 0 auto; padding: 0 12px 12px; }
  .monitor-external { display: inline-block; color: var(--wx-link); font-size: 12px; }
  .monitor-external[aria-disabled="true"] { color: var(--wx-muted); cursor: default; }
  .monitor-hint { margin: 6px 0 0; font-size: 11px; line-height: 1.6; color: var(--wx-muted); }
  .monitor-hint[hidden] { display: none; }

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
    .monitor-head { min-height: 56px; }
    #monitor-url { font-size: 16px; }
    .monitor-frame-wrap { margin: 8px 10px; }
    .monitor-form { padding: 8px 10px 0; }
    .monitor-status, .monitor-error { margin-left: 10px; margin-right: 10px; }
    .monitor-foot { padding: 0 10px 10px; }
  }
`;
