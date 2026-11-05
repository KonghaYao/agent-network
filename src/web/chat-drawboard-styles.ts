/**
 * 画板加载中/加载失败的整页提示样式。
 *
 * 只占少量首屏 CSS：真正画板 UI 与 Fabric 在打开时由独立 bundle 注入。
 * 不包含任何凭据或用户内容，失败提示使用固定文案。
 */
export const DRAWBOARD_FALLBACK_STYLE = `
  .drawboard-fallback { position: fixed; inset: 0; z-index: 80; display: flex;
    align-items: center; justify-content: center; padding: 20px;
    background: rgb(0 0 0 / 58%); }
  .drawboard-fallback-card { width: min(360px, 100%); padding: 22px 20px;
    border: 1px solid var(--wx-line, #e5e5e5); border-radius: 10px;
    background: var(--wx-panel, #fff); color: var(--wx-text, #1a1a1a);
    box-shadow: 0 18px 60px rgb(0 0 0 / 35%); text-align: center; }
  .drawboard-fallback-title { margin: 0 0 8px; font-size: 15px; font-weight: 600; }
  .drawboard-fallback-text { margin: 0 0 16px; font-size: 13px; color: var(--wx-muted, #999);
    overflow-wrap: anywhere; }
  .drawboard-fallback-actions { display: flex; justify-content: center; gap: 8px; }
  .drawboard-fallback-actions button { height: 34px; padding: 0 14px;
    border: 1px solid var(--wx-line, #e5e5e5); border-radius: 5px;
    background: var(--wx-panel, #fff); color: var(--wx-text, #1a1a1a); cursor: pointer; }
  .drawboard-fallback-actions button.primary { border-color: var(--wx-green, #07c160);
    background: var(--wx-green, #07c160); color: #fff; }
  @media (prefers-color-scheme: dark) {
    .drawboard-fallback-card, .drawboard-fallback-actions button {
      background: var(--wx-panel, #2b2b2b); color: var(--wx-text, #e5e5e5);
    }
  }
`;
