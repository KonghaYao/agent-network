/**
 * Memory 抽屉样式。
 *
 * 桌面端为右侧抽屉，移动端为全屏 sheet；颜色沿用应用页的微信式 CSS
 * 变量，暗色模式由 `prefers-color-scheme` 自动切换。所有卡片使用
 * `box-sizing: border-box` 与 `overflow-wrap: anywhere`，避免长正文、
 * hash 或房间标题造成横向溢出。
 */
export const MEMORY_STYLE = `
  .memory-drawer { position: fixed; inset: 0; width: 100vw; height: 100dvh;
    max-width: 100vw; max-height: 100dvh; margin: 0; padding: 0; border: 0;
    background: transparent; color: var(--wx-text); overflow: hidden; }
  .memory-drawer::backdrop { background: rgb(0 0 0 / 32%); }
  .memory-card { position: absolute; top: 0; right: 0; display: flex;
    flex-direction: column; width: min(480px, 100vw); height: 100%;
    box-sizing: border-box; background: var(--wx-panel);
    border-left: 1px solid var(--wx-line); box-shadow: var(--wx-shadow);
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom); }
  .memory-head { flex: 0 0 auto; display: flex; align-items: center; gap: 4px;
    padding: 12px 10px 10px 14px; border-bottom: 1px solid var(--wx-line); }
  .memory-heading { flex: 1 1 auto; min-width: 0; }
  .memory-heading h2 { margin: 0; font-size: 16px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .memory-subtitle { margin: 3px 0 0; color: var(--wx-muted); font-size: 11px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .memory-icon-btn { flex: 0 0 auto; width: 44px; height: 44px; padding: 0;
    border: 0; border-radius: 8px; background: transparent; color: var(--wx-muted);
    font-size: 20px; line-height: 1; cursor: pointer; }
  .memory-icon-btn:hover { background: var(--wx-hover); color: var(--wx-text); }
  .memory-icon-btn:focus-visible { outline: 2px solid var(--wx-green); outline-offset: -2px; }
  .memory-state { margin: 0; padding: 8px 14px; color: var(--wx-muted);
    font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  .memory-state:empty { display: none; }
  .memory-state.is-error { color: var(--wx-danger-text); }
  .memory-state.is-ok { color: var(--wx-green); }
  .memory-body { flex: 1 1 auto; min-height: 0; overflow-y: auto;
    overscroll-behavior: contain; }
  .memory-capability { padding: 12px 14px; border-bottom: 1px solid var(--wx-line);
    overflow-wrap: anywhere; }
  .memory-capability-head { display: flex; align-items: center; gap: 6px;
    flex-wrap: wrap; margin-bottom: 6px; }
  .memory-capability-head h3 { margin: 0; font-size: 14px; font-weight: 600; }
  .memory-capability p { margin: 6px 0 0; color: var(--wx-muted);
    font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
  .memory-chip-row { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
  .memory-chip { display: inline-flex; align-items: center; max-width: 100%;
    box-sizing: border-box; padding: 2px 7px; border-radius: 9px;
    background: var(--wx-search); color: var(--wx-muted); font-size: 10.5px;
    line-height: 16px; overflow-wrap: anywhere; }
  .memory-chip.good { background: rgb(7 193 96 / 12%); color: var(--wx-green); }
  .memory-chip.warn { background: rgb(217 119 6 / 14%); color: #b45309; }
  .memory-chip.danger { background: var(--wx-danger-tint); color: var(--wx-danger-text); }
  .memory-chip.info { background: rgb(87 107 149 / 12%); color: var(--wx-link); }
  .memory-stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr));
    gap: 6px; margin-top: 10px; }
  .memory-stat { min-width: 0; padding: 7px 8px; border-radius: 8px;
    background: var(--wx-bg); box-sizing: border-box; }
  .memory-stat strong { display: block; font-size: 16px; font-weight: 600; }
  .memory-stat span { display: block; margin-top: 1px; color: var(--wx-muted);
    font-size: 10.5px; overflow-wrap: anywhere; }
  .memory-tabs { display: flex; flex-wrap: wrap; gap: 4px; padding: 8px 10px;
    border-bottom: 1px solid var(--wx-line); }
  .memory-tabs[hidden] { display: none; }
  .memory-tab { min-height: 36px; padding: 5px 10px; border: 1px solid transparent;
    border-radius: 999px; background: var(--wx-search); color: var(--wx-text);
    font-size: 12px; cursor: pointer; }
  .memory-tab:hover { background: var(--wx-hover); }
  .memory-tab[aria-pressed="true"] { background: var(--wx-green);
    border-color: var(--wx-green); color: #fff; }
  .memory-tab:focus-visible { outline: 2px solid var(--wx-green); outline-offset: 2px; }
  .memory-panel { padding: 12px 14px 22px; }
  .memory-panel[hidden] { display: none; }
  .memory-panels[hidden] { display: none; }
  .memory-form { display: flex; flex-direction: column; gap: 8px; margin: 0 0 10px; }
  .memory-field { display: flex; flex-direction: column; gap: 4px;
    color: var(--wx-muted); font-size: 11.5px; min-width: 0; }
  .memory-field input, .memory-field select { width: 100%; max-width: 100%;
    box-sizing: border-box; padding: 8px 9px; border: 1px solid var(--wx-line);
    border-radius: 8px; background: var(--wx-panel); color: var(--wx-text);
    font-size: 13px; }
  .memory-field input::placeholder { color: var(--wx-muted); }
  .memory-submit { align-self: flex-start; min-height: 40px; padding: 7px 16px; }
  .memory-small-btn { min-height: 36px; padding: 5px 10px; font-size: 12px; }
  .memory-page-btn { display: block; width: 100%; min-height: 40px; margin-top: 8px;
    border: 1px solid var(--wx-line); border-radius: 8px; background: var(--wx-panel);
    color: var(--wx-link); font-size: 12px; cursor: pointer; }
  .memory-page-btn[hidden] { display: none; }
  .memory-toolbar { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px;
    margin: 0 0 8px; }
  .memory-toolbar .memory-field { flex: 1 1 160px; }
  .memory-result { display: flex; flex-direction: column; gap: 8px; }
  .memory-list { display: flex; flex-direction: column; gap: 0; margin: 0; }
  .memory-row { display: flex; flex-direction: column; gap: 4px; box-sizing: border-box;
    width: 100%; min-height: 44px; padding: 10px 8px; border: 0;
    border-bottom: 1px solid var(--wx-line); border-radius: 6px;
    background: transparent; color: inherit; text-align: left; cursor: pointer; }
  .memory-row:hover, .memory-row:focus-visible { background: var(--wx-hover); }
  .memory-row[aria-current="true"] { background: var(--wx-hover);
    outline: 1px solid var(--wx-link); }
  .memory-row:focus-visible { outline: 2px solid var(--wx-green); outline-offset: -2px; }
  .memory-row.memory-row-static { cursor: default; }
  .memory-row-top { display: flex; align-items: center; gap: 6px; min-width: 0;
    flex-wrap: wrap; }
  .memory-row-title { flex: 1 1 auto; min-width: 0; font-size: 13px;
    font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .memory-row-meta { display: flex; flex-wrap: wrap; gap: 3px 8px; color: var(--wx-muted);
    font-size: 11px; overflow-wrap: anywhere; }
  .memory-row-preview { color: var(--wx-text); font-size: 12px; line-height: 1.45;
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .memory-row-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 3px; }
  .memory-action { min-height: 36px; padding: 4px 10px; border: 1px solid var(--wx-line);
    border-radius: 7px; background: var(--wx-panel); color: var(--wx-link);
    font-size: 12px; cursor: pointer; }
  .memory-action.danger { border-color: var(--wx-danger); color: var(--wx-danger-text);
    background: var(--wx-danger-tint); }
  .memory-action:focus-visible { outline: 2px solid var(--wx-green); outline-offset: 2px; }
  .memory-empty { margin: 0; padding: 18px 6px; color: var(--wx-muted);
    font-size: 12px; line-height: 1.6; text-align: center; overflow-wrap: anywhere; }
  .memory-detail { margin-top: 10px; padding: 10px; border: 1px solid var(--wx-line);
    border-radius: 8px; background: var(--wx-bg); overflow-wrap: anywhere; }
  .memory-detail[hidden] { display: none; }
  .memory-detail-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
    margin-bottom: 8px; }
  .memory-detail-head h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .memory-detail-meta { color: var(--wx-muted); font-size: 11px; line-height: 1.5;
    overflow-wrap: anywhere; }
  .memory-text { margin: 8px 0 0; padding: 8px; border-radius: 6px;
    background: var(--wx-panel); color: var(--wx-text); font-size: 13px;
    line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere;
    word-break: break-word; max-height: 320px; overflow-y: auto; }
  .memory-note { margin: 8px 0; padding: 8px 10px; border-left: 3px solid var(--wx-link);
    background: color-mix(in srgb, var(--wx-link) 8%, transparent);
    color: var(--wx-muted); font-size: 11.5px; line-height: 1.55;
    overflow-wrap: anywhere; }
  .memory-block { margin-top: 16px; }
  .memory-block-head { display: flex; align-items: center; gap: 8px;
    justify-content: space-between; }
  .memory-block-head h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .memory-confirm { margin: 8px 0; padding: 10px; border: 1px solid var(--wx-danger);
    border-radius: 8px; background: var(--wx-danger-tint); }
  .memory-confirm p { margin: 0 0 8px; color: var(--wx-text); font-size: 12px;
    line-height: 1.55; overflow-wrap: anywhere; }
  .memory-confirm-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .memory-operation { margin-top: 18px; padding: 10px; border: 1px solid var(--wx-line);
    border-radius: 8px; background: var(--wx-bg); overflow-wrap: anywhere; }
  .memory-operation[hidden] { display: none; }
  .memory-operation h3 { margin: 0 0 6px; font-size: 13px; font-weight: 600; }
  .memory-operation dl { display: grid; grid-template-columns: auto 1fr;
    gap: 3px 10px; margin: 0; font-size: 11.5px; }
  .memory-operation dt { color: var(--wx-muted); }
  .memory-operation dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
  .memory-host-info { margin-bottom: 4px; }
  .memory-steps { margin: 8px 0 0; padding-left: 18px; color: var(--wx-muted);
    font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  .memory-steps li { margin-bottom: 3px; }
  .memory-error-card { margin: 0; padding: 12px; border: 1px solid var(--wx-line);
    border-radius: 8px; background: var(--wx-bg); color: var(--wx-muted);
    font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
  .memory-error-card strong { display: block; margin-bottom: 4px;
    color: var(--wx-text); font-size: 13px; }
  .memory-error-card.is-disabled { border-color: var(--wx-line); }
  .memory-error-card.is-danger { border-color: var(--wx-danger);
    background: var(--wx-danger-tint); color: var(--wx-danger-text); }
  .memory-error-card.is-danger strong { color: var(--wx-danger-text); }
  @media (max-width: 759px) {
    .memory-card { width: 100%; border-left: 0; }
    .memory-panel { padding-bottom: calc(22px + env(safe-area-inset-bottom)); }
    .memory-tabs { gap: 3px; }
    .memory-tab { flex: 1 1 auto; padding-left: 6px; padding-right: 6px; }
  }
`;
