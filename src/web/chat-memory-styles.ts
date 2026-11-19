/**
 * Memory 抽屉样式。
 *
 * 桌面端为右侧抽屉，移动端为全屏 sheet；颜色沿用应用页的微信式 CSS
 * 变量，暗色模式由 `prefers-color-scheme` 自动切换。所有卡片使用
 * `box-sizing: border-box` 与 `overflow-wrap: anywhere`，避免长正文、
 * hash 或房间标题造成横向溢出。
 */
export const MEMORY_STYLE = `
  .memory-drawer { margin: 0; padding: 0; border: 0; color: var(--wx-text);
    box-shadow: none !important; }
  .memory-drawer[data-memory-shell='radix'] { position: fixed; inset: 0; width: 100vw; height: 100dvh;
    max-width: 100vw; max-height: 100dvh; background: transparent; overflow: hidden; }
  /* Lenso Drawer 给 side 内容加 8/12px 边缘 margin 并把高度扣掉两侧 inset；
     应用抽屉要求贴边满高，因此统一清零 margin 并用 100% 高度填满 viewport。 */
  .memory-drawer[data-memory-shell='lenso'] { position: relative; inset: 0; width: min(480px, 100vw) !important;
    height: 100% !important; max-width: 100vw; max-height: 100%; margin: 0 !important;
    background: transparent; overflow: hidden; border-radius: 0 !important; }
  .spa-drawer-overlay { position: fixed; inset: 0; z-index: var(--app-z-memory-overlay);
    background: rgb(0 0 0 / 32%); }
  .memory-drawer::backdrop { background: rgb(0 0 0 / 32%); }
  /* 唯一可见表面：贴边 1px separator，不再叠加 Drawer 自带阴影。 */
  .memory-card { position: absolute; top: 0; right: 0; display: flex;
    flex-direction: column; width: min(480px, 100vw); height: 100%;
    box-sizing: border-box; background: var(--wx-panel);
    border: 0; border-left: 1px solid var(--wx-line); box-shadow: none;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom); }
  .memory-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    padding: 12px 12px 12px 16px; border-bottom: 1px solid var(--wx-line); }
  .memory-heading { flex: 1 1 auto; min-width: 0; }
  .memory-heading h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .memory-subtitle { margin: 2px 0 0; color: var(--wx-muted); font-size: 12px;
    line-height: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .memory-icon-btn { flex: 0 0 auto; width: 44px; height: 44px; padding: 0;
    border: 0; border-radius: 8px; background: transparent; color: var(--wx-muted);
    font-size: 20px; line-height: 1; cursor: pointer; }
  .memory-icon-btn:hover { background: var(--wx-hover); color: var(--wx-text); }
  .memory-icon-btn:focus-visible { outline: 2px solid var(--wx-green); outline-offset: -2px; }
  .memory-state { margin: 0; padding: 8px 16px; color: var(--wx-muted);
    font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
  .memory-state:empty { display: none; }
  .memory-state.is-error { color: var(--wx-danger-text); }
  .memory-state.is-ok { color: var(--wx-green); }
  .memory-body { flex: 1 1 auto; min-height: 0; overflow-y: auto;
    overscroll-behavior: contain; }
  .memory-capability { padding: 16px; border-bottom: 1px solid var(--wx-line);
    overflow-wrap: anywhere; }
  .memory-capability-head { display: flex; align-items: center; gap: 8px;
    flex-wrap: wrap; margin-bottom: 8px; }
  .memory-capability-head h3 { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; }
  .memory-capability p { margin: 8px 0 0; color: var(--wx-muted);
    font-size: 14px; line-height: 22px; overflow-wrap: anywhere; }
  .memory-chip-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  /* 外层只负责排列；内层 Lenso chip/badge 独占一次内距与一次背景。 */
  .memory-chip { display: inline-flex; align-items: center; max-width: 100%;
    min-width: 0; box-sizing: border-box; padding: 0; border: 0;
    border-radius: 0; background: none; color: inherit;
    font-size: inherit; line-height: inherit; overflow-wrap: anywhere; }
  .memory-chip > [data-lenso-slot^='chip'],
  .memory-chip > [data-lenso-slot^='badge'] {
    display: inline-flex !important; align-items: center !important;
    box-sizing: border-box; max-width: 100% !important; min-height: 20px !important;
    padding: 2px 4px !important; border-radius: 4px !important;
    background: var(--wx-search) !important; color: var(--wx-muted) !important;
    font-size: 12px !important; line-height: 16px !important; font-weight: 400 !important;
    letter-spacing: normal !important; white-space: normal !important;
    overflow-wrap: anywhere !important; }
  .memory-chip > [data-lenso-slot^='badge'] { height: 20px !important; }
  .memory-chip.good > [data-lenso-slot^='chip'],
  .memory-chip.good > [data-lenso-slot^='badge'] {
    background: var(--lenso-control-status-success-soft-fill) !important;
    color: var(--lenso-status-success-text) !important; }
  .memory-chip.warn > [data-lenso-slot^='chip'],
  .memory-chip.warn > [data-lenso-slot^='badge'] {
    background: var(--lenso-control-status-warning-soft-fill) !important;
    color: var(--lenso-status-warning-text) !important; }
  .memory-chip.danger > [data-lenso-slot^='chip'],
  .memory-chip.danger > [data-lenso-slot^='badge'] {
    background: var(--wx-danger-tint) !important; color: var(--wx-danger-text) !important; }
  .memory-chip.info > [data-lenso-slot^='chip'],
  .memory-chip.info > [data-lenso-slot^='badge'] {
    background: var(--lenso-control-tint-subtle-fill) !important;
    color: var(--lenso-status-info-text) !important; }
  .memory-stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
    gap: 8px; margin-top: 12px; }
  .memory-stat { min-width: 0; padding: 7px 8px; border-radius: 8px;
    background: var(--wx-bg); box-sizing: border-box; }
  .memory-stat strong { display: block; font-size: 16px; line-height: 24px;
    font-weight: 600; font-variant-numeric: tabular-nums; }
  .memory-stat span { display: block; margin-top: 2px; color: var(--wx-muted);
    font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
  .memory-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 10px;
    width: 100%; align-self: stretch; box-sizing: border-box;
    border-bottom: 1px solid var(--wx-line); }
  .memory-tabs[hidden] { display: none; }
  .memory-panels { width: 100%; align-self: stretch; min-width: 0; }
  /* Lenso Tabs 会覆盖根 className；用稳定的 data-memory-tab 属性承载本地 tab
     视觉。StyleX 用高特异性选择器保护属性，因此与现有 Select 覆盖一致使用
     !important，确保本地尺寸/颜色和选中态不被 Lenso 指示层覆盖。 */
  #memory-drawer #memory-tabs [data-memory-tab] { position: relative; z-index: 4 !important;
    width: auto !important; min-width: 0 !important; height: 36px !important;
    min-height: 36px !important; padding: 5px 10px !important;
    border: 1px solid transparent !important; border-radius: 999px !important;
    background: var(--wx-search) !important; color: var(--wx-text) !important;
    font-size: 12px !important; font-weight: 400 !important; cursor: pointer; }
  #memory-drawer #memory-tabs [data-memory-tab]:hover { background: var(--wx-hover) !important; }
  #memory-drawer #memory-tabs [data-memory-tab][aria-selected="true"] {
    background: var(--wx-green) !important; border-color: var(--wx-green) !important;
    color: var(--lenso-label-on-tint) !important; }
  #memory-drawer[data-memory-shell='lenso'] #memory-tabs [data-memory-tab] { color: var(--wx-text) !important; }
  #memory-drawer[data-memory-shell='lenso'] #memory-tabs [data-memory-tab][aria-selected="true"] {
    background: var(--wx-green) !important; background-color: var(--wx-green) !important;
    color: #1f2937 !important; }
  #memory-drawer #memory-tabs [data-memory-tab]:focus-visible {
    outline: 2px solid var(--wx-green) !important; outline-offset: 2px !important; }
  .memory-panel { padding: 16px 16px 24px; }
  .memory-panel[hidden] { display: none; }
  .memory-panels[hidden] { display: none; }
  .memory-form { display: flex; flex-direction: column; gap: 12px; margin: 0 0 12px; }
  .memory-field { display: flex; flex-direction: column; gap: 4px;
    color: var(--wx-muted); font-size: 12px; line-height: 16px; min-width: 0; }
  .memory-field input:not([data-lenso-slot]), .memory-field select { width: 100%; max-width: 100%;
    box-sizing: border-box; min-height: 36px; padding: 7px 12px; border: 1px solid var(--wx-line);
    border-radius: 8px; background: var(--wx-panel); color: var(--wx-text);
    font-size: 13px; line-height: 20px; }
  .memory-field input:not([data-lenso-slot])::placeholder { color: var(--wx-muted); }
  .memory-field [data-lenso-slot="select-trigger"] { width: 100% !important; max-width: 100%;
    min-height: 36px !important; padding: 7px 12px !important; border: 1px solid var(--wx-line) !important;
    border-radius: 8px !important; background: var(--wx-panel) !important;
    color: var(--wx-text) !important; font-family: inherit !important; font-size: 13px !important;
    font-weight: 400 !important; line-height: 20px !important; letter-spacing: normal !important; }
  .memory-submit { align-self: flex-start; min-height: 44px !important; padding: 0 16px; }
  .memory-small-btn { min-height: 44px !important; padding: 0 12px;
    border-radius: 8px; font-size: 13px; line-height: 20px; }
  .memory-page-btn { display: block; width: 100%; min-height: 44px; margin-top: 8px;
    border: 1px solid var(--wx-line); border-radius: 8px; background: var(--wx-panel);
    color: var(--wx-link); font-size: 13px; line-height: 20px; cursor: pointer; }
  .memory-page-btn[hidden] { display: none; }
  .memory-toolbar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px;
    margin: 0 0 8px; }
  .memory-toolbar .memory-field { flex: 1 1 160px; }
  .memory-result { display: flex; flex-direction: column; gap: 8px; }
  .memory-list { display: flex; flex-direction: column; gap: 0; margin: 0; }
  /* 列表只由 item 之间的 1px separator 区分，不把每行做成独立卡片。 */
  .memory-list > [data-lenso-slot^='surface'] { padding: 0 !important; border: 0 !important;
    border-radius: 0 !important; background: transparent !important; box-shadow: none !important; }
  .memory-list-item + .memory-list-item { border-top: 1px solid var(--wx-line); }
  .memory-row { display: flex; flex-direction: column; gap: 4px; box-sizing: border-box;
    width: 100% !important; min-height: 44px !important; padding: 10px 8px; border: 0;
    border-radius: 8px; background: transparent; color: inherit;
    text-align: left; cursor: pointer; }
  .memory-row:hover, .memory-row:focus-visible { background: var(--wx-hover); }
  .memory-row[aria-current="true"] { background: var(--wx-hover);
    outline: 1px solid var(--wx-link); }
  .memory-row:focus-visible { outline: 2px solid var(--wx-green); outline-offset: -2px; }
  .memory-row.memory-row-static { cursor: default; }
  .memory-row-top { display: flex; align-items: center; gap: 8px; min-width: 0;
    flex-wrap: wrap; }
  .memory-row-title { flex: 1 1 auto; min-width: 0; font-size: 14px; line-height: 22px;
    font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .memory-row-meta { display: flex; flex-wrap: wrap; gap: 4px 8px; color: var(--wx-muted);
    font-size: 12px; line-height: 16px; overflow-wrap: anywhere;
    font-variant-numeric: tabular-nums; }
  .memory-row-preview { color: var(--wx-text); font-size: 13px; line-height: 20px;
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .memory-row-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .memory-action { min-height: 44px; padding: 0 12px; border: 1px solid var(--wx-line);
    border-radius: 8px; background: var(--wx-panel); color: var(--wx-link);
    font-size: 13px; line-height: 20px; cursor: pointer; }
  .memory-action.danger { border-color: var(--wx-danger); color: var(--wx-danger-text);
    background: var(--wx-danger-tint); }
  .memory-action:focus-visible { outline: 2px solid var(--wx-green); outline-offset: 2px; }
  .memory-empty { margin: 0; padding: 18px 6px; color: var(--wx-muted);
    font-size: 13px; line-height: 20px; text-align: center; overflow-wrap: anywhere; }
  .memory-detail { margin-top: 12px; padding: 12px; border: 1px solid var(--wx-line);
    border-radius: 8px; background: var(--wx-bg); overflow-wrap: anywhere; }
  .memory-detail[hidden] { display: none; }
  .memory-detail-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    margin-bottom: 8px; }
  .memory-detail-head h3 { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; }
  .memory-detail-meta { color: var(--wx-muted); font-size: 12px; line-height: 16px;
    overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
  .memory-text { margin: 8px 0 0; padding: 8px; border-radius: 8px;
    background: var(--wx-panel); color: var(--wx-text); font-size: 13px;
    line-height: 20px; white-space: pre-wrap; overflow-wrap: anywhere;
    word-break: break-word; max-height: 320px; overflow-y: auto; }
  .memory-note { margin: 8px 0; padding: 8px 12px; border-left: 3px solid var(--wx-link);
    background: color-mix(in srgb, var(--wx-link) 8%, transparent);
    color: var(--wx-muted); font-size: 12px; line-height: 16px;
    overflow-wrap: anywhere; }
  .memory-block { margin-top: 16px; }
  .memory-block-head { display: flex; align-items: center; gap: 8px;
    justify-content: space-between; }
  .memory-block-head h3 { margin: 0; font-size: 14px; line-height: 22px; font-weight: 600; }
  .memory-confirm { margin: 8px 0; padding: 12px; border: 1px solid var(--wx-danger);
    border-radius: 8px; background: var(--wx-danger-tint); }
  .memory-confirm p { margin: 0 0 8px; color: var(--wx-text); font-size: 13px;
    line-height: 20px; overflow-wrap: anywhere; }
  .memory-confirm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .memory-operation { margin-top: 16px; padding: 12px; border: 1px solid var(--wx-line);
    border-radius: 8px; background: var(--wx-bg); overflow-wrap: anywhere; }
  .memory-operation[hidden] { display: none; }
  .memory-operation h3 { margin: 0 0 8px; font-size: 14px; line-height: 22px; font-weight: 600; }
  .memory-operation dl { display: grid; grid-template-columns: auto 1fr;
    gap: 4px 12px; margin: 0; font-size: 12px; line-height: 16px; }
  .memory-operation dt { color: var(--wx-muted); }
  .memory-operation dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .memory-host-info { margin-bottom: 4px; }
  .memory-steps { margin: 8px 0 0; padding-left: 18px; color: var(--wx-muted);
    font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
  .memory-steps li { margin-bottom: 4px; }
  .memory-error-card { margin: 0; padding: 12px; border: 1px solid var(--wx-line);
    border-radius: 8px; background: var(--wx-bg); color: var(--wx-muted);
    font-size: 13px; line-height: 20px; overflow-wrap: anywhere; }
  .memory-error-card strong { display: block; margin-bottom: 4px;
    color: var(--wx-text); font-size: 14px; line-height: 22px; }
  .memory-error-card.is-disabled { border-color: var(--wx-line); }
  .memory-error-card.is-danger { border-color: var(--wx-danger);
    background: var(--wx-danger-tint); color: var(--wx-danger-text); }
  .memory-error-card.is-danger strong { color: var(--wx-danger-text); }
  @media (max-width: 759px) {
    .memory-drawer[data-memory-shell='lenso'] { inset: 0; width: 100% !important; height: 100% !important; }
    .memory-card { width: 100%; border-left: 0; }
    .memory-panel { padding-bottom: calc(22px + env(safe-area-inset-bottom)); }
    .memory-tabs { gap: 4px; }
    .memory-field input:not([data-lenso-slot]), .memory-field select,
    .memory-field [data-lenso-slot="select-trigger"] {
      font-size: 16px !important; line-height: 24px !important; min-height: 44px !important; }
    #memory-drawer #memory-tabs [data-memory-tab] { flex: 1 1 auto !important;
      padding-left: 6px !important; padding-right: 6px !important; }
  }
`;
