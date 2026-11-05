/**
 * 输入框左侧附件按钮样式。
 *
 * 38px 与发送按钮同高，`align-self: flex-end` 让 textarea 增长时按钮仍贴底；
 * 颜色全部沿用 `APP_STYLE` 的 CSS 变量，暗色模式不需要额外分支。
 */
export const UPLOAD_STYLE = `
  .attach-btn { flex: 0 0 auto; align-self: flex-end; width: 38px; height: 38px;
    min-width: 38px; padding: 0; border: 1px solid var(--wx-line); border-radius: 4px;
    background: var(--wx-panel); color: var(--wx-muted); font-size: 22px; line-height: 1;
    display: grid; place-items: center; touch-action: manipulation; }
  .attach-btn:hover { background: var(--wx-hover); color: var(--wx-text); }
  .attach-btn.busy { opacity: .6; cursor: progress; }
  .attach-btn[aria-busy="true"] { cursor: progress; }
`;
