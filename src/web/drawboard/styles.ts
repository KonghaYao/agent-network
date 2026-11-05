/**
 * 画板覆盖层样式随独立 bundle 注入，只在打开画板后存在。
 *
 * 不写入首屏 CSS：Fabric 与画板 UI 都是按需加载，关闭时连同 `<style>` 一起移除。
 * 颜色沿用应用页 CSS 变量，暗色模式复用同一套变量；移动端铺满视口。
 */
export const DRAWBOARD_STYLE = `
  .db-overlay { position: fixed; inset: 0; z-index: 80; display: flex;
    align-items: center; justify-content: center; padding: 16px;
    background: rgb(0 0 0 / 58%); }
  .db-shell { display: flex; flex-direction: column; width: min(1200px, 100%);
    height: min(840px, 100%); min-height: 0; overflow: hidden;
    background: var(--wx-panel, #fff); color: var(--wx-text, #1a1a1a);
    border: 1px solid var(--wx-line, #e5e5e5); border-radius: 10px;
    box-shadow: 0 20px 70px rgb(0 0 0 / 35%); }
  .db-toolbar { flex: 0 0 auto; display: flex; flex-wrap: wrap; gap: 8px;
    align-items: center; padding: 9px 12px; border-bottom: 1px solid var(--wx-line, #e5e5e5);
    background: var(--wx-panel, #fff); }
  .db-group { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
  .db-btn { min-width: 44px; height: 32px; padding: 0 9px; border: 1px solid var(--wx-line, #e5e5e5);
    border-radius: 5px; background: var(--wx-panel, #fff); color: var(--wx-text, #1a1a1a);
    font-size: 12px; line-height: 30px; cursor: pointer; touch-action: manipulation; }
  .db-btn:hover { background: var(--wx-hover, #f2f2f2); }
  .db-btn.is-active { border-color: var(--wx-green, #07c160); color: var(--wx-green, #07c160);
    background: color-mix(in srgb, var(--wx-green, #07c160) 12%, transparent); }
  .db-btn:disabled { opacity: .45; cursor: not-allowed; }
  .db-btn.db-primary { border-color: var(--wx-green, #07c160); background: var(--wx-green, #07c160);
    color: #fff; }
  .db-btn.db-primary:hover:not(:disabled) { filter: brightness(.94); }
  .db-btn.db-danger { color: var(--wx-danger, #fa5151); }
  .db-swatch { width: 26px; height: 26px; padding: 0; border: 2px solid transparent;
    border-radius: 50%; background: var(--db-color); cursor: pointer;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%); touch-action: manipulation; }
  .db-swatch[aria-pressed="true"] { border-color: var(--wx-text, #1a1a1a);
    box-shadow: 0 0 0 2px var(--wx-panel, #fff) inset; }
  .db-width { display: inline-flex; align-items: center; gap: 6px; font-size: 12px;
    color: var(--wx-muted, #999); white-space: nowrap; }
  .db-width input { width: 84px; accent-color: var(--wx-green, #07c160); }
  .db-spacer { flex: 1 1 auto; }
  .db-stage { flex: 1 1 auto; min-height: 0; display: flex; align-items: center;
    justify-content: center; padding: 12px; overflow: hidden; background: #f4f4f4; }
  .db-stage .canvas-container { max-width: 100%; max-height: 100%; }
  .db-stage canvas { max-width: 100%; max-height: 100%; touch-action: none; }
  .db-stage .lower-canvas { background: #fff; }
  .db-status { flex: 0 0 auto; margin: 0; padding: 6px 12px; font-size: 12px;
    color: var(--wx-danger, #fa5151); background: var(--wx-panel, #fff); }
  .db-status[hidden] { display: none; }
  @media (max-width: 760px) {
    .db-overlay { padding: 0; }
    .db-shell { width: 100%; height: 100dvh; border: 0; border-radius: 0; }
    .db-toolbar { gap: 6px; padding: 7px 8px; }
    .db-btn { min-width: 38px; height: 30px; padding: 0 7px; font-size: 11px;
      line-height: 28px; }
    .db-swatch { width: 24px; height: 24px; }
    .db-width input { width: 64px; }
    .db-stage { padding: 0; }
  }
  @media (prefers-color-scheme: dark) {
    .db-shell, .db-toolbar, .db-status { background: var(--wx-panel, #2b2b2b); }
    .db-stage { background: #191919; }
    .db-btn { background: var(--wx-panel, #2b2b2b); color: var(--wx-text, #e5e5e5); }
    .db-btn:hover { background: var(--wx-hover, #333); }
    .db-btn.is-active { background: rgb(7 193 96 / 16%); }
  }
`;
