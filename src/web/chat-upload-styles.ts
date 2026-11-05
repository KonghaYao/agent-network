/**
 * 输入框左侧附件按钮与待发送文件 chips 样式。
 *
 * 按钮 38px 与发送按钮同高，`align-self: flex-end` 让 textarea 增长时按钮仍贴底；
 * chip 在正文上方按行换行，超量时纵向滚动，390px 下不产生横向溢出。
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

  .composer { position: relative; }
  .attach-menu { position: absolute; left: 16px; bottom: calc(100% - 2px); z-index: 8;
    min-width: 148px; padding: 6px; border: 1px solid var(--wx-line);
    border-radius: 8px; background: var(--wx-panel); box-shadow: var(--wx-shadow); }
  .attach-menu[hidden] { display: none; }
  .attach-menu-item { display: flex; width: 100%; align-items: center; padding: 8px 10px;
    border: 0; border-radius: 5px; background: none; color: var(--wx-text);
    font-size: 13px; line-height: 20px; text-align: left; cursor: pointer;
    touch-action: manipulation; }
  .attach-menu-item:hover, .attach-menu-item:focus { background: var(--wx-hover); }

  .composer-files { display: flex; flex-wrap: wrap; gap: 6px; max-height: 88px;
    overflow-y: auto; }
  .composer-files[hidden] { display: none; }
  .composer-file { display: flex; align-items: center; gap: 6px; min-width: 0;
    max-width: 100%; padding: 4px 5px 4px 4px; border: 1px solid var(--wx-line);
    border-radius: 6px; background: var(--wx-panel); }
  .composer-file-badge { flex: 0 0 auto; width: 28px; height: 28px; border-radius: 4px;
    display: grid; place-items: center; background: var(--wx-search);
    color: var(--wx-muted); font-size: 9px; font-weight: 600; letter-spacing: .2px; }
  .composer-file-main { min-width: 0; display: flex; flex-direction: column; }
  .composer-file-name { max-width: min(180px, 46vw); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; font-size: 12px;
    color: var(--wx-text); }
  .composer-file-meta { font-size: 10px; color: var(--wx-muted); white-space: nowrap; }
  .composer-file-remove { flex: 0 0 auto; width: 22px; height: 22px; padding: 0;
    border: 0; border-radius: 50%; background: transparent; color: var(--wx-muted);
    font-size: 16px; line-height: 1; display: grid; place-items: center; }
  .composer-file-remove:hover { background: var(--wx-hover); color: var(--wx-text); }
  .composer-file-remove:disabled { opacity: .45; cursor: progress; }
`;
