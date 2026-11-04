/**
 * Agents 管理弹窗样式。
 *
 * 只使用应用页已有的 `--wx-*` 变量；归档是中性状态，不使用红色。
 * 390px 下条目的操作按钮换行到第二行，卡片保持在视口内。
 */
export const AGENTS_STYLE = `
  .agents-card { width: min(480px, 100%); box-sizing: border-box; }
  .agents-head { display: flex; align-items: center; justify-content: space-between;
    gap: 10px; margin-bottom: 10px; }
  .agents-head h2 { margin: 0; font-size: 17px; font-weight: 600; }
  .agents-toggle { flex: 0 0 auto; padding: 5px 10px; font-size: 12px; }
  .agents-hint { margin: 0 0 8px; font-size: 12px; color: var(--wx-muted);
    line-height: 1.6; overflow-wrap: anywhere; }
  .agents-note { min-height: 1.2em; margin: 0 0 6px; font-size: 12px;
    color: var(--wx-muted); overflow-wrap: anywhere; }
  .agents-note:empty { display: none; }
  .agents-list { list-style: none; margin: 0 0 8px; padding: 0;
    max-height: min(45dvh, 380px); overflow-y: auto; }
  .agents-list:empty { display: none; }
  .agents-item { display: flex; align-items: flex-start; gap: 10px; padding: 10px 4px;
    border-bottom: 1px solid var(--wx-line); }
  .agents-item:last-child { border-bottom: 0; }
  .agents-avatar { width: 32px; height: 32px; font-size: 13px; }
  .agents-item-main { flex: 1 1 180px; min-width: 0; }
  .agents-item-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .agents-item-name { min-width: 0; font-size: 14px; font-weight: 500;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agents-badge { flex: 0 0 auto; padding: 1px 6px; border-radius: 8px;
    background: var(--wx-hover); color: var(--wx-muted); font-size: 10px; }
  .agents-item-meta { margin: 2px 0 0; font-size: 11px; color: var(--wx-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agents-item-actions { display: flex; flex-wrap: wrap; justify-content: flex-end;
    gap: 6px; margin-left: auto; }
  .agents-item-actions button { min-height: 32px; padding: 4px 10px; font-size: 12px; }
  .agents-section-title { margin: 12px 0 6px; font-size: 12px; color: var(--wx-muted); }
  .agents-empty { margin: 8px 0 12px; font-size: 12px; color: var(--wx-muted);
    line-height: 1.6; overflow-wrap: anywhere; }
  .agents-empty[hidden], #agents-archived-section[hidden] { display: none; }

  @media (max-width: 759px) {
    .agents-card { padding: 16px; }
    .agents-item-actions { width: 100%; margin-left: 0; }
    .agents-item-actions button { flex: 1 1 auto; }
  }
`;
