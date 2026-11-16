/**
 * 房间浮动 Task dock、行预览与完成确认的样式。
 *
 * 全部取自聊天区 CSS 变量，暗色模式自动跟随；dock 绝对定位在 composer
 * 容器上方，不占文档流、不推移消息或输入框。z-index 低于 Dialog，高于
 * 消息流；`jump-latest` 保持原位并盖在面板之上，始终可点击。
 */
export const TASK_DOCK_STYLE = `
  .task-dock-slot { position: absolute; left: 16px; right: 16px;
    bottom: calc(100% + 8px); z-index: 4; display: flex; flex-direction: column;
    align-items: flex-start; min-width: 0; max-width: 420px; }
  /* 无输入区（只读归档）时补上底部安全区。 */
  .composer-area:not(:has(.composer)) .task-dock-slot {
    bottom: calc(100% + 8px + env(safe-area-inset-bottom)); }
  .task-dock { box-sizing: border-box; display: flex; flex-direction: column;
    width: 100%; min-width: 0; max-height: min(50dvh, 460px);
    border: 1px solid var(--wx-line); border-radius: 10px; background: var(--wx-panel);
    box-shadow: 0 8px 24px rgb(0 0 0 / 14%); overflow: hidden; }
  .task-dock.is-collapsed { width: auto; max-width: 100%; }
  .task-dock-head { flex: 0 0 auto; display: flex; align-items: center; }
  .task-dock-toggle { flex: 1 1 auto; display: flex; align-items: center; gap: 8px;
    min-height: 44px; min-width: 0; padding: 6px 10px; border: 0; border-radius: 0;
    background: transparent; color: var(--wx-text); text-align: left; cursor: pointer; }
  .task-dock-toggle:hover { background: var(--wx-hover); }
  .task-dock-toggle:focus-visible { outline: 2px solid var(--wx-link); outline-offset: -2px; }
  .task-dock-title { flex: 0 0 auto; font-size: 13px; font-weight: 600; }
  .task-dock-count { flex: 0 0 auto; display: inline-flex; align-items: center;
    justify-content: center; min-width: 20px; height: 20px; padding: 0 6px;
    box-sizing: border-box; border-radius: 10px; background: var(--wx-search);
    color: var(--wx-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .task-dock-count--unknown { color: var(--wx-muted); letter-spacing: 1px; }
  .task-dock-caret { margin-left: auto; color: var(--wx-muted); font-size: 11px;
    line-height: 1; transition: transform .15s ease; }
  .task-dock.is-collapsed .task-dock-caret { transform: rotate(-90deg); }
  .task-dock-body { flex: 1 1 auto; display: flex; flex-direction: column;
    min-height: 0; overflow: hidden; border-top: 1px solid var(--wx-line); }
  .task-dock-body[hidden] { display: none; }
  .task-dock-list { flex: 1 1 auto; min-height: 0; margin: 0;
    padding: 0; overflow-y: auto; overscroll-behavior: contain; list-style: none; }
  .task-dock-status { margin: 0; padding: 12px;
    color: var(--wx-muted); font-size: 12px; text-align: center; }
  .task-dock-empty { display: flex; flex-direction: column; align-items: center;
    gap: 4px; margin: 0; padding: 12px; color: var(--wx-muted);
    font-size: 12px; text-align: center; }
  .task-dock-empty-close { min-width: 88px; min-height: 44px; padding: 0 14px;
    border: 1px solid var(--wx-line); border-radius: 999px; background: var(--wx-panel);
    color: var(--wx-link); font-size: 12px; cursor: pointer; }
  .task-dock-empty-close:hover { background: var(--wx-hover); }
  .task-dock-empty-close:focus-visible { outline: 2px solid var(--wx-link);
    outline-offset: 2px; }
  .task-dock-error { display: flex; flex-wrap: wrap; align-items: center;
    justify-content: center; gap: 8px; padding: 10px 12px; color: var(--wx-unread);
    font-size: 12px; line-height: 1.5; text-align: center; }
  .task-dock-error button, .task-dock-foot-status button { min-height: 44px;
    padding: 0 12px; font-size: 12px; }
  .task-dock-item { display: flex; align-items: stretch; gap: 2px; min-width: 0;
    border-top: 1px solid var(--wx-line); }
  .task-dock-item:first-child { border-top: 0; }
  .task-dock-item-trigger { flex: 1 1 auto; min-width: 0; display: flex;
    flex-direction: column; align-items: stretch; gap: 4px; min-height: 56px;
    padding: 8px 10px; border: 0; border-radius: 0; background: transparent;
    color: var(--wx-text); text-align: left; cursor: pointer; }
  .task-dock-item-trigger:hover { background: var(--wx-hover); }
  .task-dock-item-trigger:focus-visible { outline: 2px solid var(--wx-link);
    outline-offset: -2px; }
  .task-dock-preview { display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden; font-size: 12.5px;
    line-height: 1.45; overflow-wrap: anywhere; }
  .task-dock-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
    color: var(--wx-muted); font-size: 11px; line-height: 1.3; }
  .task-dock-avatars { display: inline-flex; align-items: center; padding-left: 4px; }
  .task-dock-item-actions { flex: 0 0 auto; display: flex; align-items: center;
    padding: 6px 6px 6px 0; }
  .task-dock-complete { min-width: 52px; min-height: 44px; padding: 0 10px;
    border: 1px solid var(--wx-line); border-radius: 6px; background: var(--wx-panel);
    color: var(--wx-link); font-size: 12px; cursor: pointer; }
  .task-dock-complete:hover:not(:disabled) { background: var(--wx-hover); }
  .task-dock-complete:focus-visible { outline: 2px solid var(--wx-link);
    outline-offset: 2px; }
  .task-dock-complete:disabled { color: var(--wx-muted); cursor: not-allowed;
    opacity: .72; }
  .task-dock-more { align-self: center; min-height: 44px; min-width: 112px;
    margin: 2px auto 8px; padding: 0 14px; border: 1px solid var(--wx-line);
    border-radius: 999px; background: var(--wx-panel); color: var(--wx-link);
    font-size: 12px; cursor: pointer; }
  .task-dock-more:hover:not(:disabled) { background: var(--wx-hover); }
  .task-dock-more:disabled { color: var(--wx-muted); cursor: progress; }
  .task-dock-foot-status { display: flex; flex-wrap: wrap; align-items: center;
    justify-content: center; gap: 8px; margin: 0; padding: 8px 12px 10px;
    color: var(--wx-muted); font-size: 11px; line-height: 1.45; text-align: center; }

  /* 预览浮层由 Portal 挂到 body，自带颜色与限高。 */
  .task-preview-popover { z-index: 40; box-sizing: border-box;
    width: min(380px, calc(100vw - 24px)); max-height: min(58dvh, 420px);
    overflow-y: auto; padding: 12px; border: 1px solid var(--wx-line);
    border-radius: 10px; background: var(--wx-panel); color: var(--wx-text);
    box-shadow: var(--wx-shadow); font-size: 12px; }
  .task-preview-head { display: flex; align-items: baseline; justify-content: space-between;
    gap: 10px; }
  .task-preview-sender { min-width: 0; font-size: 13px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-preview-time { flex: 0 0 auto; color: var(--wx-muted); font-size: 11px; }
  .task-preview-text { margin: 8px 0 0; font-size: 13px; line-height: 1.55;
    white-space: pre-wrap; overflow-wrap: anywhere; }
  .task-preview-meta { margin: 6px 0 0; color: var(--wx-muted); font-size: 11px; }
  .task-preview-recents { margin-top: 10px; padding-top: 8px;
    border-top: 1px solid var(--wx-line); }
  .task-preview-section { margin: 0 0 4px; color: var(--wx-muted); font-size: 11px; }
  .task-preview-recent-list { list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 2px; }
  .task-preview-recent { display: flex; flex-direction: column; gap: 3px;
    box-sizing: border-box; width: 100%; min-height: 44px; padding: 7px 8px;
    border: 0; border-radius: 6px; background: transparent; color: var(--wx-text);
    text-align: left; cursor: pointer; }
  .task-preview-recent:hover, .task-preview-recent:focus-visible {
    background: var(--wx-hover); }
  .task-preview-recent.is-recalled { color: var(--wx-muted); }
  .task-preview-recent-head { display: flex; align-items: baseline; gap: 8px; }
  .task-preview-recent-sender { min-width: 0; font-size: 12px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .task-preview-recent-time { margin-left: auto; flex: 0 0 auto;
    color: var(--wx-muted); font-size: 10px; }
  .task-preview-recent-text { display: -webkit-box; -webkit-line-clamp: 2;
    -webkit-box-orient: vertical; overflow: hidden; font-size: 12px;
    line-height: 1.45; overflow-wrap: anywhere; }
  .task-preview-empty { margin: 4px 0 0; color: var(--wx-muted); font-size: 12px; }
  .task-preview-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
  .task-preview-all { min-height: 44px; padding: 0 12px; border: 1px solid var(--wx-line);
    border-radius: 6px; background: var(--wx-panel); color: var(--wx-link);
    font-size: 12px; cursor: pointer; }
  .task-preview-all:hover { background: var(--wx-hover); }

  .task-complete-dialog { width: min(380px, 100%); box-sizing: border-box; }
  .task-complete-message { margin: 0 0 12px; line-height: 1.65;
    overflow-wrap: anywhere; }
  .task-complete-error { margin: 0 0 12px; color: var(--wx-unread); font-size: 12px;
    line-height: 1.5; overflow-wrap: anywhere; }

  /* 「回到底部」保持原位，靠 chat-styles 的更高 z-index 盖在浮动面板之上。 */
  @media (max-width: 759px) {
    .task-dock-slot { left: 8px; right: 8px; bottom: calc(100% + 6px);
      max-width: none; }
    .task-preview-popover { width: calc(100vw - 20px);
      max-height: min(52dvh, 360px); }
  }
`;
