/**
 * 个人看板的独立样式：入口、浮窗、三列、详情、快速跳转与返回断点按钮。
 *
 * 只消费 `--wx-*` / `--app-*` token；三列 accent 用暖色/中性/品牌绿区分，
 * 暗色通过 color-mix 跟随面板与文字 token，不写第二套品牌色。
 */

export const FOCUS_STYLE = `
  :root {
    --focus-needs: #c07a2c;
    --focus-tracking: #52669d;
    --focus-done: var(--wx-green);
  }
  [data-theme='dark'] {
    --focus-needs: #e0a45c;
    --focus-tracking: #93a8dc;
  }

  /* 侧栏入口：沿用账号文字入口的高度与换行，不新增说明段落。 */
  .focus-entry { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 6px; padding: 0 4px 2px; }
  .focus-entry-link { display: inline-flex; align-items: center; gap: 6px; min-height: 32px;
    padding: 0 2px; border: 0; background: none; color: var(--wx-link); font: inherit;
    font-size: 12px; font-weight: 600; cursor: pointer; }
  .focus-entry-link svg { width: 14px; height: 14px; fill: none; stroke: currentColor;
    stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; flex: none; }
  .focus-entry-link:hover { text-decoration: underline; }
  .focus-entry-link:focus-visible { outline: 2px solid var(--wx-green); outline-offset: 2px; border-radius: 4px; }
  .focus-entry-link[data-enabled='1'] { color: var(--wx-text); }
  .focus-entry-link[data-enabled='1'] svg { color: var(--wx-green); }
  .focus-entry-count { min-width: 18px; padding: 1px 5px; border-radius: 999px;
    background: color-mix(in srgb, var(--focus-needs) 16%, var(--wx-panel));
    color: var(--focus-needs); font-size: 10px; font-weight: 700; line-height: 1.4;
    text-align: center; font-variant-numeric: tabular-nums; }
  @media (pointer: coarse) {
    .focus-entry-link { min-height: 44px; }
  }

  /* 浮窗：覆盖聊天但保留轮廓；桌面居中，移动端近全屏留边距。 */
  .spa-dialog-content.focus-board-card,
  .spa-dialog-content.focus-board-card[data-lenso-slot='modal-popup'] {
    width: min(90vw, 1480px);
    height: min(88dvh, 960px);
    max-height: min(88dvh, 960px);
    overflow: hidden;
    padding: 18px 20px 12px;
    display: flex;
    flex-direction: column;
    border-radius: var(--app-radius-xl);
    background: var(--wx-panel);
    color: var(--wx-text);
  }
  .focus-board-card h2 { flex: none; margin: 0; padding: 0 160px 0 0; font-size: 18px;
    font-weight: 700; letter-spacing: -0.3px; color: var(--wx-text); }
  .focus-board-actions { position: absolute; top: 12px; right: 48px; display: flex;
    align-items: center; gap: 8px; }
  .focus-quick-trigger { display: inline-flex; align-items: center; gap: 6px; min-height: 32px;
    padding: 0 10px; border: 1px solid var(--wx-line); border-radius: 8px;
    background: var(--wx-panel); color: var(--wx-text); font: inherit; font-size: 12px;
    cursor: pointer; white-space: nowrap; }
  .focus-quick-trigger:hover { background: var(--wx-hover); }
  .focus-quick-trigger:focus-visible { outline: 2px solid var(--wx-green); outline-offset: 2px; }
  .focus-quick-trigger svg { width: 14px; height: 14px; fill: none; stroke: currentColor;
    stroke-width: 1.7; stroke-linecap: round; }
  .focus-quick-trigger kbd { padding: 1px 5px; border-radius: 4px; background: var(--wx-active);
    color: var(--wx-muted); font: inherit; font-size: 10px; }

  .focus-board { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
    position: relative; }
  .focus-board-sub { flex: none; margin: 2px 0 10px; color: var(--wx-muted); font-size: 12px; }
  .focus-tabs { flex: none; display: flex; align-items: center; gap: 2px; width: fit-content;
    padding: 3px; border-radius: 9px; background: var(--wx-active); }
  .focus-tabs button { display: inline-flex; align-items: center; gap: 6px; min-height: 30px;
    padding: 0 10px; border: 0; border-radius: 7px; background: transparent;
    color: var(--wx-muted); font: inherit; font-size: 12px; cursor: pointer; }
  .focus-tabs button b { font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .focus-tabs button.is-active { background: var(--wx-panel); color: var(--wx-text);
    font-weight: 650; box-shadow: 0 1px 4px rgb(0 0 0 / 10%); }
  .focus-tabs button:focus-visible { outline: 2px solid var(--wx-green); outline-offset: 1px; }
  .focus-mobile-tabs { display: flex; gap: 4px; margin-top: 10px; overflow-x: auto; }
  .focus-mobile-tabs button { flex: 1 1 0; min-height: 44px; padding: 0 8px;
    border: 1px solid var(--wx-line); border-radius: 8px; background: transparent;
    color: var(--wx-muted); font: inherit; font-size: 12px; white-space: nowrap; }
  .focus-mobile-tabs button b { margin-left: 4px; font-variant-numeric: tabular-nums; }
  .focus-mobile-tabs button.is-active { color: var(--wx-text); border-color: currentColor;
    background: var(--wx-hover); font-weight: 650; }
  .focus-mobile-tabs button[data-lane='needs_me'].is-active { color: var(--focus-needs); }
  .focus-mobile-tabs button[data-lane='tracking'].is-active { color: var(--focus-tracking); }
  .focus-mobile-tabs button[data-lane='done'].is-active { color: var(--focus-done); }

  .focus-board-work { flex: 1 1 auto; min-height: 0; display: flex; gap: 16px; margin-top: 12px; }
  .focus-board-main { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .focus-board-work.has-detail .focus-board-main { min-width: 320px; }

  .focus-lanes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px; min-height: 0; flex: 1 1 auto; }
  .focus-lane { --focus-accent: var(--focus-needs);
    border: 1px solid var(--wx-line); border-radius: 12px; background: var(--wx-bg);
    display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .focus-lane[data-lane='tracking'] { --focus-accent: var(--focus-tracking); }
  .focus-lane[data-lane='done'] { --focus-accent: var(--focus-done); }
  .focus-lane-head { flex: none; display: flex; align-items: center; gap: 7px; padding: 12px 12px 10px; }
  .focus-lane-head h3 { margin: 0; font-size: 14px; font-weight: 650; letter-spacing: -0.2px; }
  .focus-lane-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--focus-accent); flex: none; }
  .focus-lane-count { padding: 1px 6px; border-radius: 6px; background: var(--wx-active);
    color: var(--wx-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .focus-lane-cards { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    display: flex; flex-direction: column; gap: 8px; padding: 0 9px 12px; scrollbar-gutter: stable; }
  .focus-lane-empty { margin: 0; padding: 22px 8px; border: 1px dashed var(--wx-line);
    border-radius: 9px; color: var(--wx-muted); font-size: 12px; text-align: center; line-height: 1.6; }

  .focus-card { display: flex; flex-direction: column; border: 1px solid var(--wx-line);
    border-radius: 10px; background: var(--wx-panel); box-shadow: var(--wx-shadow);
    overflow: hidden; flex: none; }
  .focus-card:hover { border-color: color-mix(in srgb, var(--focus-accent, var(--wx-green)) 45%, var(--wx-line)); }
  .focus-card-body { display: flex; flex-direction: column; gap: 7px; width: 100%;
    padding: 12px 11px 8px; border: 0; border-radius: 0; background: transparent;
    color: var(--wx-text); font: inherit; text-align: left; cursor: pointer; }
  .focus-card-body:hover { background: var(--wx-hover); }
  .focus-card-body:focus-visible { outline: 2px solid var(--wx-green); outline-offset: -2px; }
  .focus-card-title { font-size: 15px; font-weight: 650; line-height: 1.45;
    letter-spacing: -0.2px; overflow-wrap: anywhere; }
  .focus-card-next { display: flex; align-items: flex-start; gap: 4px; color: var(--wx-muted);
    font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
  .focus-card-next svg { width: 14px; height: 14px; flex: none; margin-top: 2px; fill: none;
    stroke: var(--focus-accent, var(--wx-green)); stroke-width: 1.8; stroke-linecap: round; }
  .focus-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .focus-chip { display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px;
    border-radius: 5px; font-size: 10px; line-height: 1.5; overflow-wrap: anywhere; }
  .focus-chip--wait { background: var(--wx-active); color: var(--wx-muted); }
  .focus-chip--due { background: color-mix(in srgb, var(--focus-needs) 12%, var(--wx-panel));
    color: color-mix(in srgb, var(--focus-needs) 82%, var(--wx-text)); }
  .focus-card-meta { display: flex; align-items: center; gap: 8px; margin-top: 2px;
    color: var(--wx-muted); font-size: 10px; font-variant-numeric: tabular-nums; }
  .focus-card-meta time { margin-left: auto; }
  .focus-card-foot { display: flex; align-items: center; gap: 8px; padding: 5px 8px 6px;
    border-top: 1px solid var(--wx-line); }
  .focus-card-action { display: inline-flex; align-items: center; justify-content: center;
    min-height: 32px; padding: 0 8px; border: 0; border-radius: 6px; background: transparent;
    color: var(--wx-link); font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
  .focus-card-action:hover { background: var(--wx-hover); }
  .focus-card-action:focus-visible { outline: 2px solid var(--wx-green); outline-offset: 1px; }
  .focus-card-action:disabled { color: var(--wx-muted); cursor: default; opacity: 0.65; }
  .focus-card-archived { margin-left: auto; color: var(--wx-muted); font-size: 10px; }
  .focus-card--restricted { border-style: dashed; }
  .focus-card-locked { display: flex; flex-direction: column; gap: 3px; padding: 14px 11px 10px; }
  .focus-card-locked-title { margin: 0; font-size: 13px; font-weight: 650; color: var(--wx-muted); }
  .focus-card-locked-hint { margin: 0; color: var(--wx-muted); font-size: 11px; }
  .focus-archive-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(240px, 100%), 1fr));
    gap: 10px; align-content: start; overflow-y: auto; padding-bottom: 8px; }

  .focus-state { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 10px; min-height: 160px; padding: 32px 16px;
    color: var(--wx-muted); font-size: 13px; text-align: center; line-height: 1.65; }
  .focus-state p { margin: 0; }
  .focus-state-hint { font-size: 11px; }
  .focus-retry, .focus-enable-button { min-height: 36px; padding: 0 14px;
    border: 1px solid var(--wx-line); border-radius: 8px; background: var(--wx-panel);
    color: var(--wx-text); font: inherit; font-size: 12px; cursor: pointer; }
  .focus-retry:hover { background: var(--wx-hover); }
  .focus-retry:focus-visible, .focus-enable-button:focus-visible {
    outline: 2px solid var(--wx-green); outline-offset: 2px; }
  .focus-enable-button { border-color: transparent; background: var(--wx-green);
    color: var(--lenso-label-on-tint); font-weight: 600; }
  .focus-enable-button:disabled { opacity: 0.65; cursor: default; }
  .focus-card-skeleton { display: block; height: 116px; border-radius: 10px;
    background: linear-gradient(90deg, var(--wx-active), var(--wx-hover), var(--wx-active));
    background-size: 200% 100%; animation: focus-shimmer 1.3s ease-in-out infinite; }
  @keyframes focus-shimmer { 0% { background-position: 0 0; } 100% { background-position: -200% 0; } }

  /* 详情：桌面并排，手机替换整块列表。 */
  .focus-detail { flex: 0 0 min(380px, 34%); min-width: 300px; min-height: 0;
    display: flex; flex-direction: column; border-left: 1px solid var(--wx-line);
    padding-left: 16px; }
  .focus-detail-head { flex: none; display: flex; align-items: center; gap: 8px; min-height: 34px; }
  .focus-detail-back, .focus-detail-close { display: inline-flex; align-items: center;
    justify-content: center; gap: 4px; min-height: 32px; border: 0; border-radius: 6px;
    background: transparent; color: var(--wx-muted); font: inherit; font-size: 12px; cursor: pointer; }
  .focus-detail-back svg, .focus-detail-close svg { width: 16px; height: 16px; fill: none;
    stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
  .focus-detail-back:hover, .focus-detail-close:hover { background: var(--wx-hover); color: var(--wx-text); }
  .focus-detail-back:focus-visible, .focus-detail-close:focus-visible {
    outline: 2px solid var(--wx-green); outline-offset: 1px; }
  .focus-detail-close { margin-left: auto; width: 32px; }
  .focus-column-chip { padding: 2px 7px; border-radius: 5px; font-size: 10px; font-weight: 650;
    background: var(--wx-active); color: var(--wx-muted); }
  .focus-column-chip--needs_me { color: var(--focus-needs);
    background: color-mix(in srgb, var(--focus-needs) 12%, var(--wx-panel)); }
  .focus-column-chip--tracking { color: var(--focus-tracking);
    background: color-mix(in srgb, var(--focus-tracking) 12%, var(--wx-panel)); }
  .focus-column-chip--done { color: var(--focus-done);
    background: color-mix(in srgb, var(--focus-done) 12%, var(--wx-panel)); }
  .focus-detail-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 8px 2px 8px 0;
    scrollbar-gutter: stable; }
  .focus-detail-title { margin: 4px 0 8px; font-size: 18px; font-weight: 700;
    line-height: 1.45; letter-spacing: -0.4px; overflow-wrap: anywhere; }
  .focus-detail-next { margin: 0 0 12px; font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
  .focus-detail-label { display: block; margin-bottom: 2px; color: var(--wx-muted); font-size: 10px; }
  .focus-detail-facts { display: flex; flex-wrap: wrap; gap: 8px 18px; margin: 0 0 12px; }
  .focus-detail-facts div { min-width: 0; }
  .focus-detail-facts dt { color: var(--wx-muted); font-size: 10px; }
  .focus-detail-facts dd { margin: 1px 0 0; font-size: 12px; overflow-wrap: anywhere; }
  .focus-detail-summary { margin: 0 0 14px; padding: 10px 11px; border-radius: 8px;
    background: var(--wx-hover); color: var(--wx-text); font-size: 12px; line-height: 1.7;
    overflow-wrap: anywhere; }
  .focus-evidence h4 { margin: 0 0 7px; font-size: 12px; font-weight: 650; color: var(--wx-muted); }
  .focus-evidence-list { list-style: none; margin: 0; padding: 0; display: flex;
    flex-direction: column; gap: 7px; }
  .focus-evidence-item { border: 1px solid var(--wx-line); border-radius: 8px; padding: 8px 9px;
    background: var(--wx-bg); }
  .focus-evidence-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px;
    color: var(--wx-muted); font-size: 10px; }
  .focus-evidence-sender { color: var(--wx-text); font-weight: 650; font-size: 11px; }
  .focus-evidence-room { overflow-wrap: anywhere; }
  .focus-evidence-latest { padding: 0 4px; border-radius: 4px; color: var(--focus-done);
    background: color-mix(in srgb, var(--focus-done) 12%, var(--wx-panel)); }
  .focus-evidence-time { margin-left: auto; font-variant-numeric: tabular-nums; }
  .focus-evidence-excerpt { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
    overflow: hidden; margin: 5px 0 0; color: var(--wx-text); font-size: 12px; line-height: 1.6;
    overflow-wrap: anywhere; }
  .focus-evidence-actions { display: flex; justify-content: flex-end; margin-top: 3px; }
  .focus-evidence-gone { color: var(--wx-muted); font-size: 10px; }
  .focus-revisions { margin: 14px 0 6px; border-top: 1px solid var(--wx-line); padding-top: 9px; }
  .focus-revisions summary { color: var(--wx-muted); font-size: 11px; cursor: pointer;
    min-height: 32px; display: flex; align-items: center; }
  .focus-revisions ol { list-style: none; margin: 4px 0 0; padding: 0; display: flex;
    flex-direction: column; gap: 5px; font-size: 11px; color: var(--wx-muted); }
  .focus-revisions li { display: flex; gap: 6px; flex-wrap: wrap; }
  .focus-revision-version { font-variant-numeric: tabular-nums; }
  .focus-revision-reason { color: var(--wx-text); }
  .focus-revisions time { margin-left: auto; }
  .focus-detail-foot { flex: none; display: flex; justify-content: flex-end;
    padding: 8px 0 2px; border-top: 1px solid var(--wx-line); }
  .focus-archive-button { min-height: 36px; padding: 0 14px; border: 1px solid var(--wx-line);
    border-radius: 8px; background: var(--wx-panel); color: var(--wx-danger-text);
    font: inherit; font-size: 12px; cursor: pointer; }
  .focus-archive-button:hover { background: var(--wx-danger-tint); }
  .focus-archive-button:focus-visible { outline: 2px solid var(--wx-danger); outline-offset: 2px; }
  .focus-archive-button:disabled { opacity: 0.55; cursor: default; }
  .focus-detail-state { padding: 18px 4px; color: var(--wx-muted); font-size: 12px; line-height: 1.65; }
  .focus-detail-state p { margin: 0 0 8px; }
  .focus-detail-muted { margin: 0; color: var(--wx-muted); font-size: 11px; }

  .focus-notice { flex: none; min-height: 18px; margin: 6px 2px 0; color: var(--focus-done);
    font-size: 11px; line-height: 18px; }
  .focus-notice.is-error { color: var(--wx-danger-text); }

  /* 快速跳转：面板覆盖在工作区上方，输入框自动聚焦。 */
  .focus-quick { position: absolute; z-index: var(--app-z-popover); top: 0; right: 0;
    width: min(560px, calc(100% - 24px)); max-height: calc(100% - 8px);
    display: flex; flex-direction: column; border: 1px solid var(--wx-line);
    border-radius: 12px; background: var(--wx-panel); box-shadow: var(--wx-shadow);
    overflow: hidden; }
  .focus-quick-inputbar { display: flex; align-items: center; gap: 8px; padding: 8px 8px 8px 11px;
    border-bottom: 1px solid var(--wx-line); }
  .focus-quick-icon { width: 16px; height: 16px; flex: none; fill: none; stroke: var(--wx-muted);
    stroke-width: 1.7; stroke-linecap: round; }
  .focus-quick-inputbar input { flex: 1 1 auto; min-width: 0; height: 34px; padding: 0;
    border: 0; background: transparent; color: var(--wx-text); font: inherit; font-size: 14px; }
  .focus-quick-inputbar input:focus { outline: none; }
  .focus-quick-inputbar input::placeholder { color: var(--wx-muted); }
  .focus-quick-close { width: 32px; height: 32px; flex: none; display: grid; place-items: center;
    border: 0; border-radius: 6px; background: transparent; color: var(--wx-muted); cursor: pointer; }
  .focus-quick-close:hover { background: var(--wx-hover); }
  .focus-quick-close svg { width: 16px; height: 16px; fill: none; stroke: currentColor;
    stroke-width: 1.8; stroke-linecap: round; }
  .focus-quick-status { margin: 0; padding: 6px 12px 0; color: var(--wx-muted); font-size: 10px;
    min-height: 18px; }
  .focus-quick-results { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 4px 6px 8px;
    scrollbar-gutter: stable; }
  .focus-quick-group { margin: 6px 6px 3px; color: var(--wx-muted); font-size: 10px; font-weight: 650; }
  .focus-quick-row { display: flex; width: 100%; padding: 8px 9px; border: 0; border-radius: 7px;
    background: transparent; color: var(--wx-text); font: inherit; text-align: left; cursor: pointer; }
  .focus-quick-row.is-selected { background: var(--wx-active); }
  .focus-quick-row:focus-visible { outline: 2px solid var(--wx-green); outline-offset: -2px; }
  .focus-quick-row-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .focus-quick-row-title { font-size: 12px; font-weight: 600; line-height: 1.5;
    overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .focus-quick-row-sub { color: var(--wx-muted); font-size: 10px; line-height: 1.45;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .focus-quick-hint { margin: 0; padding: 6px 12px 8px; border-top: 1px solid var(--wx-line);
    color: var(--wx-muted); font-size: 10px; }

  /* 返回断点：轻量浮动按钮，避开标题与 jump-latest。 */
  #focus-return { position: absolute; top: 10px; right: 16px; z-index: var(--app-z-float);
    display: inline-flex; align-items: center; min-height: 32px; padding: 0 12px;
    border: 1px solid var(--wx-line); border-radius: 999px; background: var(--wx-panel);
    color: var(--wx-link); font: inherit; font-size: 12px; box-shadow: var(--wx-shadow);
    cursor: pointer; white-space: nowrap; }
  #focus-return:hover { background: var(--wx-hover); }
  #focus-return:focus-visible { outline: 2px solid var(--wx-green); outline-offset: 2px; }

  @media (max-width: 759px) {
    .spa-dialog-content.focus-board-card,
    .spa-dialog-content.focus-board-card[data-lenso-slot='modal-popup'],
    .spa-dialog-content.focus-board-card[data-modal-shell] {
      inset: calc(8px + env(safe-area-inset-top)) 8px calc(8px + env(safe-area-inset-bottom));
      width: auto;
      height: auto;
      max-height: none;
      transform: none;
      border-radius: 16px;
      padding: 14px 12px 8px;
    }
    .focus-board-card h2 { padding-right: 96px; font-size: 17px; }
    .focus-board-actions { top: 10px; right: 44px; }
    .focus-quick-trigger { min-height: 44px; padding: 0 8px; }
    .focus-quick-trigger kbd { display: none; }
    .focus-board-sub { margin-bottom: 6px; }
    .focus-tabs button { min-height: 44px; }
    .focus-board-work { margin-top: 8px; }
    .focus-lanes { grid-template-columns: minmax(0, 1fr); }
    .focus-detail { flex: 1 1 auto; width: 100%; min-width: 0; border-left: 0; padding-left: 0; }
    .focus-detail-back, .focus-detail-close { min-height: 44px; }
    .focus-detail-close { width: 44px; }
    .focus-card-foot .focus-card-action { min-height: 44px; }
    .focus-archive-button, .focus-retry, .focus-enable-button { min-height: 44px; }
    .focus-quick { top: 0; left: 0; right: 0; width: 100%; max-height: 100%;
      border-radius: 12px; }
    .focus-quick-inputbar input { height: 44px; font-size: 16px; }
    .focus-quick-close { width: 44px; height: 44px; }
    .focus-quick-row { min-height: 44px; }
    #focus-return { top: 8px; right: 10px; min-height: 44px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .focus-card, .focus-card-body, .focus-card-skeleton, .focus-quick-row { transition: none; }
    .focus-card-skeleton { animation: none; }
  }
`;
