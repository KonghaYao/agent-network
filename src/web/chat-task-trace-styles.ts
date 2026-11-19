/**
 * 消息式 Task 摘要行、Trace 抽屉与“只看任务”搜索样式。
 *
 * 颜色全部取自聊天区 CSS 变量，暗色模式自动跟随；触控目标不小于 44px。
 */
export const TASK_TRACE_STYLE = `
  .msg-task-bar-slot { margin: 8px 0; min-width: 0; width: 100%; max-width: 100%; }
  .msg-task-bar-slot[hidden] { display: none; }
  .msg.mine .msg-task-bar-slot { margin-left: auto; }
  .msg-task-bar-slot [data-task-surface='summary'] { min-width: 0; max-width: 100%; padding: 0 !important;
    border: 0; border-radius: 12px !important; background: var(--wx-panel) !important;
    box-shadow: var(--wx-shadow) !important; overflow: hidden; }
  .task-bar.task-bar { display: grid; grid-template-columns: auto 1fr auto;
    align-items: center; gap: 8px; box-sizing: border-box; width: 100%; min-width: 0;
    height: auto; min-height: 64px; max-width: 100%; padding: 16px !important;
    border: 0; border-radius: 12px !important; background: transparent !important; box-shadow: none !important;
    font-size: 13px !important; line-height: 19px !important; white-space: normal;
    color: var(--wx-text); text-align: left; cursor: pointer; overflow-wrap: anywhere; }
  .task-bar:focus-visible { outline: 2px solid var(--wx-link); outline-offset: -2px; }
  .task-bar-icon { grid-column: 1; grid-row: 1; display: inline-flex; width: 18px; height: 18px;
    align-items: center; justify-content: center; color: var(--lenso-tint-text);
    font-size: 12px; line-height: 16px; font-weight: 700; }
  .task-bar-avatars { grid-column: 2; grid-row: 1; display: inline-flex; align-items: center;
    min-width: 0; max-width: 100%; height: 20px; overflow: hidden; }
  .task-bar-avatars [data-lenso-slot='avatar-group'] { display: flex; align-items: center; overflow: hidden; }
  .task-bar-avatars [data-lenso-slot='avatar'] { flex: 0 0 20px; width: 20px !important;
    height: 20px !important; border-radius: 50% !important; }
  .task-bar-more { display: inline-flex; flex: 0 0 auto; align-items: center; margin-left: 4px; }
  .task-bar-more [data-lenso-slot^='badge'] { width: auto !important; height: 18px !important;
    padding: 0 4px !important; border: 0; border-radius: 999px !important;
    font-size: 11px !important; line-height: 14px !important; letter-spacing: .02em;
    background: var(--wx-search) !important; box-shadow: none !important; }
  .task-bar-preview { grid-column: 1 / -1; grid-row: 2; min-width: 0;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; white-space: normal; overflow-wrap: anywhere; font-size: 13px; line-height: 19px; }
  .task-bar-count { grid-column: 3; grid-row: 1; color: var(--wx-muted); white-space: nowrap; }
  .task-bar-count [data-lenso-slot^='badge'] { font-size: 12px !important; line-height: 16px !important;
    width: auto !important; padding: 0 !important; border: 0; background: transparent !important;
    box-shadow: none !important; color: var(--wx-muted) !important; } }
  .task-bar-states { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
  .task-status-badge { display: inline-flex; align-self: center; padding: 4px 8px;
    font-size: 11px; line-height: 14px; letter-spacing: .02em;
    border: 0; border-radius: 6px; color: var(--task-status-text);
    background: var(--task-status-fill); --task-status-text: var(--lenso-status-info-text);
    --task-status-fill: var(--lenso-control-tint-subtle-fill); }
  .task-status-badge [data-lenso-slot^='badge'] { width: auto !important; padding: 0 !important; border: 0;
    border-radius: inherit !important; color: inherit !important; background: transparent !important;
    box-shadow: none !important; font-size: 11px !important; line-height: 14px !important; letter-spacing: .02em; }
  .task-status-badge[data-task-status='pending'] { --task-status-text: var(--lenso-status-warning-text);
    --task-status-fill: var(--lenso-control-status-warning-soft-fill); }
  .task-status-badge:is([data-task-status='done'], [data-task-status='completed']) {
    --task-status-text: var(--lenso-status-success-text);
    --task-status-fill: var(--lenso-control-status-success-soft-fill); }
  .task-status-badge[data-task-status='failed'] { --task-status-text: var(--wx-danger-text);
    --task-status-fill: var(--lenso-control-status-error-soft-fill); }

  /* 搜索“只看任务”：与普通搜索结果共用弹窗，不改变普通搜索路径。 */
  .message-search-filter { display: inline-flex; align-items: center; gap: 6px;
    min-height: 44px; margin: -6px 0 10px; color: var(--wx-text); font-size: 13px;
    cursor: pointer; }
  .message-search-filter input { width: 18px; height: 18px; margin: 0; }
  /* Lenso Checkbox 根是 button；保留 44px 命中区并去掉原生按钮外观。 */
  .message-search-filter[data-lenso-slot='checkbox'] { padding: 0; border: 0;
    background: transparent; color: var(--wx-text); font-size: 13px;
    font-weight: 400; }
  .task-search-result { display: flex; align-items: flex-start; gap: 8px;
    box-sizing: border-box; width: 100%; min-height: 44px; padding: 10px;
    border: 0; border-top: 1px solid var(--wx-line); background: transparent;
    color: inherit; text-align: left; cursor: pointer; }
  .task-search-result:hover, .task-search-result:focus-visible { background: var(--wx-hover); }
  .task-search-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .task-search-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .task-search-preview { flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 600; }
  .task-search-count { flex: 0 0 auto; color: var(--wx-muted); font-size: 11px; }
  .task-search-hit { color: var(--wx-muted); font-size: 12px; line-height: 1.45;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* Trace 抽屉：桌面右侧，移动端全屏 sheet。 */
  .task-trace-drawer { position: fixed; inset: 0; width: 100vw; height: 100dvh;
    max-width: 100vw; max-height: 100dvh; margin: 0; padding: 0; border: 0;
    background: transparent; color: var(--wx-text); overflow: hidden; }
  .task-trace-drawer::backdrop { background: rgb(0 0 0 / 32%); }
  .task-trace-card { position: absolute; top: 0; right: 0; display: flex;
    flex-direction: column; width: min(420px, 100vw); height: 100%;
    box-sizing: border-box; background: var(--wx-panel);
    border: 0; border-radius: 16px 0 0 16px; box-shadow: var(--wx-shadow);
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom); }
  /* Lenso Drawer 的 side 内容自带边缘 margin / 24px 内距；Trace 要求右侧
     560px 且贴边满高，这里接管壳几何，与 S11 Memory 抽屉同一模式。 */
  .task-trace-drawer[data-task-trace-shell='lenso'] { position: relative !important;
    inset: 0 !important; display: flex; flex-direction: column; box-sizing: border-box;
    width: min(560px, 100vw) !important; height: 100% !important;
    max-width: 100vw; max-height: 100%; margin: 0 !important;
    padding: env(safe-area-inset-top) 16px env(safe-area-inset-bottom);
    border: 0; border-radius: 16px 0 0 16px;
    background: var(--wx-panel) !important; color: var(--wx-text); overflow: hidden;
    box-shadow: var(--wx-shadow); }
  #task-trace-drawer #task-trace-title { margin: 0 0 16px; padding-right: 36px;
    font-size: 14px; line-height: 20px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-trace-head { flex: 0 0 auto; display: flex; align-items: flex-start;
    gap: 8px; padding: 16px; border-bottom: 1px solid var(--wx-line); }
  .task-trace-heading { flex: 1 1 auto; min-width: 0; }
  .task-trace-heading h2 { margin: 0; font-size: 14px; line-height: 20px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-trace-meta { margin: 4px 0 0; color: var(--wx-muted); font-size: 12px; line-height: 16px; }
  .task-trace-close { flex: 0 0 auto; width: 44px; height: 44px; padding: 0;
    border: 0; border-radius: 8px; background: transparent; color: var(--wx-muted);
    font-size: 22px; line-height: 1; cursor: pointer; }
  .task-trace-close:hover { background: var(--wx-hover); color: var(--wx-text); }
  .task-trace-participants { flex: 0 0 auto; display: flex; flex-wrap: wrap;
    align-items: center; gap: 8px; padding: 8px 0; min-height: 28px; }
  .task-trace-participants:empty { display: none; }
  .task-trace-participant-name { color: var(--wx-muted); font-size: 12px; line-height: 16px;
    max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #task-trace-drawer [data-task-trace-toolbar] { flex: 0 0 auto; display: flex; align-items: center;
    justify-content: space-between; gap: 8px !important; min-height: 32px; padding: 8px 0 !important;
    background: transparent !important; border: 0; border-radius: 0 !important; box-shadow: none !important; }
  #task-trace-drawer [data-task-trace-toolbar] .link-btn { height: 32px; min-height: 32px;
    font-size: 13px !important; line-height: 19px !important; border-radius: 8px !important; }
  #task-trace-status { color: var(--wx-muted); font-size: 12px; line-height: 16px; overflow-wrap: anywhere; }
  #task-trace-drawer :is(.task-trace-page, #task-trace-close) { flex: 0 0 auto;
    box-sizing: border-box; height: 36px; min-height: 36px; padding: 0 12px !important; gap: 8px !important;
    border: 1px solid var(--wx-line); border-radius: 8px !important; background: var(--wx-panel) !important;
    color: var(--wx-link); font-size: 13px !important; line-height: 19px !important; box-shadow: none; cursor: pointer; }
  .task-trace-page { margin: 0 0 8px; }
  .task-trace-page[hidden] { display: none; }
  .task-trace-items { flex: 1 1 auto; min-height: 0; overflow-y: auto;
    padding: 0 0 8px; overscroll-behavior: contain; }
  .task-trace-item { display: flex; flex-direction: column; gap: 4px;
    box-sizing: border-box; width: 100%; min-height: 44px; padding: 12px 8px;
    border: 0; background: transparent;
    color: inherit; text-align: left; cursor: pointer; border-radius: 10px; }
  .task-trace-item:hover, .task-trace-item:focus-visible { background: var(--wx-hover); }
  .task-trace-item.is-focus { background: color-mix(in srgb, var(--wx-link) 12%, transparent);
    outline: 1px solid var(--wx-link); }
  .task-trace-item.is-recalled { cursor: default; color: var(--wx-muted); }
  /* 条目内部按列排布；显式覆盖 Lenso Button 根节点的水平居中。 */
  .task-trace-items .task-trace-item { display: flex; flex-direction: column;
    justify-content: flex-start; width: 100%; padding: 12px 8px !important; gap: 4px !important;
    border-radius: 10px !important; background: transparent !important; text-align: left; }
  .task-trace-items .task-trace-item.is-focus { background: color-mix(in srgb, var(--wx-link) 12%, transparent) !important; }
  .task-trace-item-head { display: grid; grid-template-columns: minmax(0, 1fr) auto auto;
    align-items: center; gap: 8px; min-width: 0; font-size: 12px; line-height: 16px; color: var(--wx-muted); }
  .task-trace-sender { flex: 0 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; font-weight: 600;
    color: var(--wx-text); }
  .task-trace-time { grid-column: 3; grid-row: 1; white-space: nowrap; }
  .task-trace-role { grid-column: 2; grid-row: 1; padding: 4px 8px;
    border-radius: 6px; background: var(--wx-search); color: var(--wx-muted);
    font-size: 11px; line-height: 14px; letter-spacing: .02em; }
  .task-trace-role-root { color: var(--wx-link); }
  .task-trace-role-reference { color: var(--wx-green); }
  .task-trace-preview { color: var(--wx-text); font-size: 13px; line-height: 19px;
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .task-trace-note { color: var(--wx-muted); font-size: 12px; line-height: 16px; }
  .task-trace-empty { margin: 0; padding: 32px 16px; color: var(--wx-muted);
    font-size: 13px; text-align: center; }

  .task-trace-drawer :is(h2, p, span, button, pre, code),
  .task-trace-card { min-width: 0; max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
  .task-trace-drawer .task-trace-item { height: auto; white-space: normal; align-items: stretch; }
  .task-trace-drawer :is(pre, code) { white-space: pre-wrap; }
  .task-trace-items { overflow-x: hidden; }
  .task-trace-preview { width: 100%; white-space: normal; }

  @media (max-width: 759px) {
    .task-trace-card { width: 100%; border-left: 0; }
    .task-trace-drawer[data-task-trace-shell='lenso'] { width: 100vw !important;
      padding: calc(12px + env(safe-area-inset-top)) 12px
        calc(12px + env(safe-area-inset-bottom)); border-radius: 0; }
    #task-trace-drawer :is(.task-trace-page, #task-trace-close, [data-task-trace-toolbar] .link-btn) {
      height: 44px; min-height: 44px; }
    .task-bar.task-bar { min-height: 44px; padding: 12px !important; }
    .task-search-result { min-height: 44px; }
    .task-trace-item { min-height: 44px; }
  }
`;
