/**
 * 画板加载中/加载失败的整页提示样式。
 *
 * 只占少量首屏 CSS：真正画板 UI 与 Fabric 在打开时由独立 bundle 注入。
 * 不包含任何凭据或用户内容，失败提示使用固定文案。
 */
export const DRAWBOARD_FALLBACK_STYLE = `
  .drawboard-fallback { position: fixed; inset: 0; z-index: var(--app-z-drawboard); display: flex;
    align-items: center; justify-content: center; width: auto; height: auto;
    max-width: none; max-height: none; margin: 0; border: 0;
    padding: 20px; background: var(--lenso-scrim); }
  .drawboard-fallback:not([open]) { display: none; }
  .drawboard-fallback::backdrop { background: transparent; }
  .drawboard-fallback-card { width: min(360px, 100%); padding: 22px 20px;
    border: 1px solid var(--lenso-separator); border-radius: 10px;
    background: var(--lenso-background-secondary); color: var(--lenso-label-primary);
    box-shadow: var(--lenso-surface-shadow); text-align: center; }
  .drawboard-fallback-title { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
  .drawboard-fallback-text { margin: 0 0 16px; font-size: 13px; color: var(--lenso-label-secondary);
    overflow-wrap: anywhere; }
  .drawboard-fallback-actions { display: flex; justify-content: center; gap: 8px; }
  .drawboard-fallback-actions button { height: 34px; padding: 0 14px;
    border: 1px solid var(--lenso-control-border); border-radius: 5px;
    background: var(--lenso-control-fill); color: var(--lenso-label-primary); cursor: pointer; }
  .drawboard-fallback-actions button.primary { border-color: var(--lenso-tint);
    background: var(--lenso-tint); color: var(--lenso-label-on-tint); }
`;
