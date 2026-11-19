/** Task 浮层只用实色表面；定位不参与消息和 composer 的文档流。 */
export const TASK_DOCK_STYLE = `
  .task-dock-slot { position: absolute; left: 16px; right: 16px;
    bottom: calc(100% + 8px); z-index: var(--app-z-float);
    min-width: 0; max-width: 420px; }
  .composer-area:not(:has(.composer)) .task-dock-slot {
    bottom: calc(100% + 8px + env(safe-area-inset-bottom)); }
  .task-dock { position: relative; width: 100%; min-width: 0; }
  /* Lenso 的 StyleX 以 important 输出材质/控件 token，仅在 Task 范围覆盖。 */
  #task-dock [data-task-surface='entry'] { width: fit-content; max-width: 100%; padding: 0 !important;
    border: 0; border-radius: 6px !important; background: transparent !important; box-shadow: none !important; }
  .task-dock-head { width: fit-content; max-width: 100%; }
  #task-dock .task-dock-toggle { display: flex; align-items: center;
    justify-content: flex-start; gap: 8px !important; box-sizing: border-box;
    height: 28px; min-height: 28px; min-width: 0; padding: 0 8px !important;
    border: 0; border-radius: 6px !important; background: transparent !important;
    color: var(--wx-muted) !important; font-size: 11px !important; line-height: 14px !important;
    text-align: left; cursor: pointer; box-shadow: none; }
  #task-dock-toggle .task-dock-title { font-size: 11px; line-height: 14px; letter-spacing: .02em; }
  .task-dock-title { flex: 0 0 auto; font-size: 14px; line-height: 20px; font-weight: 600; }
  .task-dock-count { display: inline-flex; flex: 0 0 auto; align-items: center; }
  #task-dock :is(.task-dock-count, [data-task-count]) [data-lenso-slot^='badge'],
  #task-dock [data-task-count] { height: 18px; min-width: 18px; padding: 0 4px;
    border: 0; border-radius: 999px; font-size: 11px !important; line-height: 14px !important;
    letter-spacing: .02em; font-variant-numeric: tabular-nums;
    background: var(--lenso-control-tint-subtle-fill) !important; box-shadow: none !important; }
  #task-dock .task-dock-count [data-lenso-slot^='badge'], #task-dock [data-task-count] {
    width: auto !important; height: 18px !important; padding: 0 4px !important;
    border-radius: 999px !important; }
  .task-dock-count--unknown { color: var(--wx-muted); }
  .task-dock-caret { display: inline-flex; align-items: center; justify-content: center;
    width: 14px; height: 14px; font-size: 11px; line-height: 14px;
    transition: transform .15s ease; }
  .task-dock.is-collapsed .task-dock-caret { transform: rotate(-90deg); }
  .task-dock-body { position: absolute; left: 0; right: 0; bottom: calc(100% + 8px);
    z-index: var(--app-z-float); display: flex; flex-direction: column;
    box-sizing: border-box; width: 100%; max-height: min(50dvh, 460px);
    border: 0; border-radius: 16px; background: var(--wx-panel);
    box-shadow: var(--wx-shadow); isolation: isolate; overflow: hidden; }
  #task-dock [data-task-surface='panel'] { display: flex; flex-direction: column;
    flex: 1 1 auto; min-height: 0; min-width: 0; padding: 0 !important; border: 0;
    gap: 0 !important; border-radius: inherit !important; background: var(--wx-panel) !important;
    box-shadow: none !important; overflow: hidden; }
  #task-dock [data-task-toolbar] { display: flex; flex: 0 0 auto; align-items: center;
    justify-content: flex-start; gap: 8px !important; min-height: 32px; padding: 16px !important;
    border: 0; background: transparent !important; box-shadow: none !important; }
  [data-task-divider][data-task-divider] { flex: 0 0 auto; width: 100%; height: 1px; min-height: 1px;
    margin: 0; padding: 0; border: 0; background: var(--wx-line); }
  /* 只在「回到最新」可见时抬高面板，两个浮层不相互遮挡。 */
  .chat-body:has(#task-dock[data-state='expanded']) #jump-latest {
    background: var(--wx-panel) !important; }
  @media (min-width: 760px) {
    .chat-body:has(#jump-latest:not([hidden])) .task-dock-body {
      bottom: calc(100% + 68px); }
  }
  .task-dock-body[hidden] { display: none; }
  #task-dock [data-task-list] { display: flex; flex-direction: column; gap: 8px !important;
    flex: 1 1 auto; min-width: 0; min-height: 0; margin: 0; padding: 16px !important;
    overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; list-style: none; }
  #task-dock .task-dock-item { display: flex; flex-direction: column;
    align-items: stretch; gap: 8px; min-width: 0; margin: 0; padding: 0;
    border: 0; border-radius: 0; background: transparent; box-shadow: none; }
  #task-dock .task-dock-item-trigger {
    display: flex; flex-direction: column; flex: 1 1 auto; align-items: stretch !important;
    justify-content: flex-start; gap: 8px !important; box-sizing: border-box;
    width: 100% !important; min-width: 0; height: auto; min-height: 44px; padding: 0 !important;
    border: 0; border-radius: 8px !important; background: transparent !important; color: var(--wx-text);
    font-size: 13px !important; line-height: 19px !important; text-align: left; white-space: normal;
    cursor: pointer; box-shadow: none !important; }
  .task-dock-preview { display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden; width: 100%; min-width: 0;
    font-size: 14px; line-height: 20px; font-weight: 500; overflow-wrap: anywhere; }
  .task-dock-meta { display: block; min-width: 0; color: var(--wx-muted);
    font-size: 12px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task-dock-item-actions { display: flex; width: 100%; flex-wrap: wrap;
    align-items: center; justify-content: flex-end; gap: 8px; padding: 0 0 8px; }
  .task-dock-item-actions > .task-status-badge { margin-right: auto; }
  #task-dock :is(.task-dock-ask, .task-dock-complete, .task-dock-more,
    .task-dock-empty-close, .task-dock-error button, .task-dock-foot-status button),
  .task-preview-popover :is(.task-preview-ask, .task-preview-all),
  #task-complete-dialog .spa-dialog-button {
    box-sizing: border-box; height: 36px; min-height: 36px; padding: 0 12px !important;
    border: 1px solid var(--wx-line); border-radius: 8px !important; background: var(--wx-panel) !important;
    color: var(--wx-text) !important; font-size: 13px !important; line-height: 19px !important; gap: 8px !important;
    box-shadow: none !important; cursor: pointer; }
  #task-dock .task-dock-item-actions :is(.task-dock-ask, .task-dock-complete) { height: 32px; min-height: 32px; }
  #task-dock .task-dock-complete { color: var(--lenso-label-on-tint) !important;
    border: 0; background: var(--app-prominent-fill) !important; }
  #task-dock button:disabled { color: var(--wx-muted); cursor: not-allowed; }
  #task-dock .task-dock-more { flex: 0 0 auto; align-self: center; margin: 8px 16px 16px; }
  .task-dock-status, .task-dock-empty, .task-dock-error, .task-dock-foot-status {
    margin: 0; padding: 16px; color: var(--wx-muted); font-size: 12px;
    line-height: 16px; text-align: center; }
  .task-dock-empty, .task-dock-error, .task-dock-foot-status { display: flex;
    flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; }
  .task-dock-empty { flex-direction: column; }
  .task-dock-error { color: var(--wx-unread); }
  #task-dock button:focus-visible, .task-preview-popover button:focus-visible {
    outline: 2px solid var(--wx-link); outline-offset: -2px; }

  /* 头尾不滚动，只有正文/最近回复滚动；无额外 Surface 嵌套。 */
  .task-preview-popover.task-preview-popover { display: flex; flex-direction: column;
    z-index: var(--app-z-dialog-overlay); box-sizing: border-box; width: 400px;
    max-width: calc(100vw - 24px);
    max-height: min(60vh, max(160px, calc(var(--available-height, 60vh) - 64px))) !important;
    padding: 0 !important; overflow: hidden;
    border: 0; border-radius: 12px !important; background: var(--wx-panel) !important; color: var(--wx-text) !important;
    box-shadow: var(--wx-shadow) !important; font-size: 13px !important; line-height: 19px !important; }
  .task-preview-head { display: flex; flex: 0 0 auto; align-items: baseline;
    justify-content: space-between; gap: 8px; padding: 16px 16px 0; }
  .task-preview-sender { flex: 1 1 auto; min-width: 0; font-size: 14px;
    line-height: 20px; font-weight: 600; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .task-preview-time, .task-preview-recent-time { flex: 0 0 auto;
    color: var(--wx-muted); font-size: 12px; line-height: 16px; white-space: nowrap; }
  .task-preview-meta { flex: 0 0 auto; margin: 4px 0 0; padding: 0 16px 16px;
    color: var(--wx-muted); font-size: 12px; line-height: 16px; }
  .task-preview-scroll { flex: 1 1 auto; min-height: 0; min-width: 0; padding: 16px;
    overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; }
  .task-preview-text { margin: 0 0 16px; font-size: 13px; line-height: 19px;
    white-space: pre-wrap; overflow-wrap: anywhere; }
  .task-preview-recents { padding-top: 16px; }
  .task-preview-section { margin: 0 0 8px; color: var(--wx-muted);
    font-size: 11px; line-height: 14px; letter-spacing: .02em; }
  .task-preview-recent-list { display: flex; flex-direction: column; gap: 12px;
    list-style: none; margin: 0; padding: 0; }
  .task-preview-popover .task-preview-recent { display: flex; flex-direction: column;
    align-items: stretch !important; justify-content: flex-start; gap: 4px !important; box-sizing: border-box;
    width: 100% !important; height: auto; min-height: 44px; padding: 0 !important; border: 0; border-radius: 8px !important;
    background: transparent !important; color: var(--wx-text); font-size: 13px !important; line-height: 19px !important;
    text-align: left; white-space: normal; box-shadow: none; cursor: pointer; }
  .task-preview-recent.is-recalled { color: var(--wx-muted); }
  .task-preview-recent-head { display: flex; width: 100%; align-items: baseline; gap: 8px; min-width: 0; }
  .task-preview-recent-sender { flex: 1 1 auto; min-width: 0; font-size: 12px;
    line-height: 16px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-preview-recent-text { display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden; width: 100%; min-width: 0;
    font-size: 13px; line-height: 19px; overflow-wrap: anywhere; }
  .task-preview-empty { margin: 0; color: var(--wx-muted); font-size: 12px; line-height: 16px; }
  .task-preview-actions { display: flex; flex: 0 0 auto; align-items: center;
    justify-content: flex-end; gap: 8px; padding: 16px; }
  .task-preview-popover .task-preview-all, #task-complete-dialog .primary {
    height: 40px; min-height: 40px; border: 0; background: var(--wx-green);
    color: #fff; }
  #task-complete-dialog { width: min(400px, calc(100vw - 24px)); box-sizing: border-box;
    max-height: 80dvh; padding: 16px; border: 0; border-radius: 12px;
    background: var(--wx-panel); box-shadow: var(--wx-shadow); overflow-x: hidden; overflow-y: auto; }
  #task-complete-title { margin: 0 0 12px; font-size: 14px; line-height: 20px; }
  .task-complete-message { margin: 0 0 16px; font-size: 13px; line-height: 19px; overflow-wrap: anywhere; }
  .task-complete-error { margin: 0 0 16px; color: var(--wx-unread);
    font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
  #task-complete-dialog .modal-actions { flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .task-dock :is(button, span, p), .task-preview-popover :is(button, span, p),
  .task-complete-dialog :is(p, h2, pre, code) { min-width: 0; max-width: 100%; overflow-wrap: anywhere; }
  .task-preview-popover :is(pre, code), .task-complete-dialog :is(pre, code) { white-space: pre-wrap; }

  @media (max-width: 759px) {
    .task-dock-slot { left: 8px; right: 8px; }
    /* 44px 命中区包住 28px chip，保留 chip 本身的统一尺寸。 */
    #task-dock [data-task-surface='entry'] { padding: 8px 0 !important; }
    #task-dock .task-dock-toggle::after { content: ''; position: absolute;
      inset: -8px 0; min-width: 44px; }
    #task-dock [data-task-list], #task-dock [data-task-toolbar] { padding: 12px !important; }
    .chat-body:has(#jump-latest:not([hidden])) .task-dock-body {
      bottom: calc(100% + 60px); }
    .task-preview-popover.task-preview-popover { width: min(92vw, 390px); }
    .task-preview-head { padding: 12px 12px 0; }
    .task-preview-meta { padding: 0 12px 12px; }
    .task-preview-scroll, .task-preview-actions { padding: 12px; }
    #task-dock .task-dock-item-actions :is(.task-dock-ask, .task-dock-complete),
    #task-dock :is(.task-dock-ask, .task-dock-complete, .task-dock-more,
      .task-dock-empty-close, .task-dock-error button, .task-dock-foot-status button),
    .task-preview-popover :is(.task-preview-ask, .task-preview-all),
    #task-complete-dialog .spa-dialog-button { height: 44px; min-height: 44px; }
    #task-complete-dialog { padding: 12px; }
  }
`;
