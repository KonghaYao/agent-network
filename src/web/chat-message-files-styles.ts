/**
 * 消息正文文件卡片样式。
 *
 * 卡片位于 `.msg-content` 内、`.bubble` 外；宽度跟随气泡列，长文件名
 * 换行/省略而不撑出消息区。颜色全部来自 APP_STYLE 的 CSS 变量，暗色
 * 与移动端无需额外分支。
 */
export const MESSAGE_FILES_STYLE = `
  .msg-files { display: flex; flex-direction: column; gap: 6px;
    width: min(320px, 100%); max-width: 100%; min-width: 0; margin-top: 6px; }
  .msg.mine .msg-files { align-items: flex-end; }
  .msg-file { box-sizing: border-box; display: flex; flex-wrap: wrap;
    align-items: center; gap: 4px 9px; width: 100%; min-width: 0;
    padding: 8px 10px; border: 1px solid var(--wx-line); border-radius: 8px;
    background: var(--wx-panel); color: var(--wx-text); }
  .msg-file-kind { flex: 0 0 auto; width: 36px; height: 36px; border-radius: 7px;
    display: grid; place-items: center; background: var(--wx-search);
    color: var(--wx-link); font-size: 11px; font-weight: 600; letter-spacing: .2px; }
  .msg-file[data-loading="1"] .msg-file-kind { color: var(--wx-muted); }
  .msg-file-main { flex: 1 1 120px; min-width: 0; display: flex;
    flex-direction: column; gap: 2px; }
  .msg-file-name { display: -webkit-box; -webkit-box-orient: vertical;
    -webkit-line-clamp: 2; overflow: hidden; font-size: 13px; line-height: 1.35;
    overflow-wrap: anywhere; word-break: break-word; }
  .msg-file-size { min-height: 1em; font-size: 11px; line-height: 1.3;
    color: var(--wx-muted); overflow-wrap: anywhere; }
  .msg-file-size:empty { display: none; }
  .msg-file-actions { flex: 0 0 auto; display: flex; flex-wrap: wrap;
    align-items: center; gap: 2px; margin-left: auto; }
  .msg-file-action { border: 0; border-radius: 4px; background: none;
    padding: 3px 5px; margin: 0; color: var(--wx-link); font-size: 12px;
    line-height: 1.4; text-decoration: none; }
  .msg-file-action:hover { background: var(--wx-hover); }
  .msg-file.unavailable .msg-file-kind { color: var(--wx-muted); }

  @media (max-width: 759px) {
    .msg-files { width: 100%; max-width: 100%; }
    .msg-file { padding: 7px 8px; gap: 4px 7px; }
    .msg-file-kind { width: 32px; height: 32px; font-size: 10px; }
    .msg-file-main { flex-basis: 96px; }
    .msg-file-action { padding: 3px 4px; }
  }
`;
