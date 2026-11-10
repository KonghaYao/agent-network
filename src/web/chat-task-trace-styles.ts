/**
 * 消息式 Task 摘要行、Trace 抽屉与“只看任务”搜索样式。
 *
 * 颜色全部取自聊天区 CSS 变量，暗色模式自动跟随；触控目标不小于 44px。
 */
export const TASK_TRACE_STYLE = `
  /* 起点消息的紧凑摘要行：icon · 参与 Agent · 短文本 · N 消息。 */
  .msg-task-bar-slot { margin: 0 0 6px; max-width: 100%; }
  .msg-task-bar-slot[hidden] { display: none; }
  .msg.mine .msg-task-bar-slot { margin-left: auto; }
  .task-bar { display: flex; align-items: center; gap: 8px; box-sizing: border-box;
    width: 100%; min-height: 44px; max-width: 100%; padding: 5px 10px;
    border: 1px solid var(--wx-line); border-radius: 10px; background: var(--wx-panel);
    color: var(--wx-text); text-align: left; cursor: pointer; }
  .task-bar:hover, .task-bar:focus-visible { background: var(--wx-hover); }
  .task-bar:focus-visible { outline: 2px solid var(--wx-link); outline-offset: 2px; }
  .task-bar-pending { cursor: progress; color: var(--wx-muted); }
  .task-bar-failed { color: var(--wx-danger); cursor: pointer; }
  .task-bar-icon { flex: 0 0 auto; display: inline-flex; width: 18px; height: 18px;
    align-items: center; justify-content: center; }
  .task-bar-icon svg { display: block; width: 18px; height: 18px; }
  .task-bar-avatars { flex: 0 0 auto; display: inline-flex; align-items: center;
    padding-left: 4px; }
  .task-avatar { width: 20px; height: 20px; margin-left: -6px; border-radius: 50%;
    font-size: 9px; font-weight: 500; box-sizing: border-box;
    box-shadow: 0 0 0 2px var(--wx-panel); }
  .task-avatar:first-child { margin-left: 0; }
  .task-avatar.avatar-icon .avatar-img { padding: 12%; }
  .task-bar-more { flex: 0 0 auto; display: inline-flex; align-items: center;
    justify-content: center; min-width: 20px; height: 20px; margin-left: -6px;
    padding: 0 4px; border-radius: 10px; background: var(--wx-search);
    color: var(--wx-muted); font-size: 10px; line-height: 1; box-sizing: border-box;
    box-shadow: 0 0 0 2px var(--wx-panel); }
  .task-bar-preview { flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
  .task-bar-count { flex: 0 0 auto; color: var(--wx-muted); font-size: 11px;
    white-space: nowrap; }
  .task-bar-meta { flex: 0 0 auto; color: var(--wx-muted); font-size: 11px;
    white-space: nowrap; }
  .task-bar-skeleton { flex: 1 1 auto; height: 12px; border-radius: 4px;
    background: var(--wx-line); animation: skeleton-pulse 1.3s ease-in-out infinite; }

  /* 搜索“只看任务”：与普通搜索结果共用弹窗，不改变普通搜索路径。 */
  .message-search-filter { display: inline-flex; align-items: center; gap: 6px;
    min-height: 44px; margin: -6px 0 10px; color: var(--wx-text); font-size: 13px;
    cursor: pointer; }
  .message-search-filter input { width: 18px; height: 18px; margin: 0; }
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
    border-left: 1px solid var(--wx-line); box-shadow: var(--wx-shadow);
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom); }
  .task-trace-head { flex: 0 0 auto; display: flex; align-items: flex-start;
    gap: 8px; padding: 12px 14px 8px; border-bottom: 1px solid var(--wx-line); }
  .task-trace-heading { flex: 1 1 auto; min-width: 0; }
  .task-trace-heading h2 { margin: 0; font-size: 15px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-trace-meta { margin: 3px 0 0; color: var(--wx-muted); font-size: 11px; }
  .task-trace-close { flex: 0 0 auto; width: 44px; height: 44px; padding: 0;
    border: 0; border-radius: 8px; background: transparent; color: var(--wx-muted);
    font-size: 22px; line-height: 1; cursor: pointer; }
  .task-trace-close:hover { background: var(--wx-hover); color: var(--wx-text); }
  .task-trace-participants { flex: 0 0 auto; display: flex; flex-wrap: wrap;
    align-items: center; gap: 4px; padding: 8px 14px; min-height: 28px; }
  .task-trace-participants:empty { display: none; }
  .task-trace-participants .task-avatar { width: 24px; height: 24px; font-size: 10px;
    box-shadow: 0 0 0 2px var(--wx-panel); }
  .task-trace-participant-name { color: var(--wx-muted); font-size: 11px;
    max-width: 96px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-trace-toolbar { flex: 0 0 auto; display: flex; align-items: center;
    justify-content: space-between; gap: 8px; min-height: 32px; padding: 0 14px 6px; }
  .task-trace-toolbar .link-btn { min-height: 44px; }
  #task-trace-status { color: var(--wx-muted); font-size: 12px; overflow-wrap: anywhere; }
  .task-trace-page { flex: 0 0 auto; min-height: 44px; margin: 0 14px 6px;
    border: 1px solid var(--wx-line); border-radius: 8px; background: var(--wx-panel);
    color: var(--wx-link); font-size: 12px; cursor: pointer; }
  .task-trace-page[hidden] { display: none; }
  .task-trace-items { flex: 1 1 auto; min-height: 0; overflow-y: auto;
    padding: 0 6px 8px; overscroll-behavior: contain; }
  .task-trace-item { display: flex; flex-direction: column; gap: 4px;
    box-sizing: border-box; width: 100%; min-height: 44px; padding: 9px 8px;
    border: 0; border-bottom: 1px solid var(--wx-line); background: transparent;
    color: inherit; text-align: left; cursor: pointer; border-radius: 6px; }
  .task-trace-item:hover, .task-trace-item:focus-visible { background: var(--wx-hover); }
  .task-trace-item.is-focus { background: color-mix(in srgb, var(--wx-link) 12%, transparent);
    outline: 1px solid var(--wx-link); }
  .task-trace-item.is-recalled { cursor: default; color: var(--wx-muted); }
  .task-trace-item-head { display: flex; align-items: center; gap: 6px; min-width: 0;
    font-size: 11px; color: var(--wx-muted); }
  .task-trace-sender { flex: 0 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; font-weight: 600;
    color: var(--wx-text); }
  .task-trace-time { flex: 0 0 auto; }
  .task-trace-role { flex: 0 0 auto; margin-left: auto; padding: 1px 6px;
    border-radius: 9px; background: var(--wx-search); color: var(--wx-muted);
    font-size: 10px; line-height: 16px; }
  .task-trace-role-root { color: var(--wx-link); }
  .task-trace-role-reference { color: var(--wx-green); }
  .task-trace-preview { color: var(--wx-text); font-size: 13px; line-height: 1.45;
    overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .task-trace-note { color: var(--wx-muted); font-size: 10px; }
  .task-trace-empty { margin: 0; padding: 32px 16px; color: var(--wx-muted);
    font-size: 13px; text-align: center; }

  @media (max-width: 759px) {
    .task-trace-card { width: 100%; border-left: 0; }
    .task-trace-close { width: 44px; height: 44px; }
    .task-bar { min-height: 44px; }
    .task-search-result { min-height: 44px; }
    .task-trace-item { min-height: 44px; }
  }
`;
