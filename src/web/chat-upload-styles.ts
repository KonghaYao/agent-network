/**
 * 输入框左侧附件按钮与待发送文件 chips 样式。
 *
 * 按钮 38px 与发送按钮同高，`align-self: flex-end` 让 textarea 增长时按钮仍贴底；
 * 命中区用 `::after` 扩到 44px，不改变视觉盒。chip 在正文上方按行换行，
 * 超量时纵向滚动，390px 下不产生横向溢出；颜色全部来自 Lenso token。
 */
export const UPLOAD_STYLE = `
  .attach-btn { position: relative; flex: 0 0 auto; align-self: flex-end;
    width: 38px; height: 38px; min-width: 38px; min-height: 38px; max-height: 38px;
    padding: 0; border: 0; border-radius: var(--lenso-shape-field);
    background: var(--lenso-control-fill); color: var(--lenso-tint-text);
    font-size: 22px; line-height: 1; display: grid; place-items: center;
    touch-action: manipulation; }
  .attach-btn:hover { background: var(--lenso-fill-secondary); }
  .attach-btn.busy { opacity: .6; cursor: progress; }
  .attach-btn[aria-busy="true"] { cursor: progress; }
  .attach-btn::after { content: ""; position: absolute; left: 50%; top: 50%;
    width: 44px; height: 44px; transform: translate(-50%, -50%); }

  .composer { position: relative; }
  .attach-menu { position: absolute; left: 16px; bottom: calc(100% - 2px); z-index: var(--app-z-attach);
    min-width: 148px; padding: 6px; border: 1px solid var(--lenso-separator);
    border-radius: var(--lenso-shape-content-2xl); background: var(--lenso-background-tertiary);
    box-shadow: var(--lenso-overlay-shadow); }
  .attach-menu[hidden] { display: none; }
  .attach-menu-item { display: flex; width: 100%; align-items: center; padding: 8px 10px;
    border: 0; border-radius: var(--lenso-shape-content-md); background: none;
    color: var(--lenso-label-primary); font-size: 13px; line-height: 20px; text-align: left;
    cursor: pointer; touch-action: manipulation; }
  .attach-menu-item:hover, .attach-menu-item:focus { background: var(--lenso-fill-tertiary); }

  .composer-files { display: flex; flex-wrap: wrap; gap: 6px; max-height: 88px;
    overflow-y: auto; }
  .composer-files[hidden] { display: none; }
  .composer-file { display: flex; align-items: center; gap: 6px; min-width: 0;
    min-height: 44px; max-width: 100%; padding: 4px 5px 4px 4px;
    border: 1px solid var(--lenso-separator);
    border-radius: var(--lenso-shape-content-2xl); background: var(--lenso-control-field-fill); }
  .composer-file-badge { flex: 0 0 auto; width: 28px; height: 28px;
    border-radius: var(--lenso-shape-content-md); display: grid; place-items: center;
    background: var(--lenso-control-fill); color: var(--lenso-label-secondary);
    font-size: 9px; font-weight: 600; letter-spacing: .2px; }
  .composer-file .composer-file-thumb { flex: 0 0 auto; display: block;
    width: 48px; height: 48px; min-width: 48px; max-width: 48px;
    min-height: 48px; max-height: 48px; margin: 0; padding: 0; border: 0;
    border-radius: var(--lenso-shape-content-md); overflow: hidden;
    background: var(--lenso-control-fill); cursor: zoom-in; }
  .composer-file .composer-file-thumb img { display: block; width: 100%; height: 100%;
    object-fit: cover; }
  .composer-file .composer-file-thumb:focus-visible { outline: 2px solid var(--lenso-focus-ring);
    outline-offset: 1px; }
  .composer-file-main { min-width: 0; display: flex; flex-direction: column; }
  .composer-file-name { max-width: min(180px, 46vw); overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; font-size: 12px;
    color: var(--lenso-label-primary); }
  .composer-file-meta { font-size: 10px; color: var(--lenso-label-secondary);
    white-space: nowrap; }
  .composer-file .composer-file-remove { position: relative; flex: 0 0 auto;
    width: 22px; height: 22px; min-width: 22px; max-width: 22px;
    min-height: 22px; max-height: 22px; padding: 0; border: 0;
    border-radius: 999px; background: transparent; color: var(--lenso-label-secondary);
    font-size: 16px; line-height: 1; display: grid; place-items: center; }
  .composer-file .composer-file-remove::after { content: ""; position: absolute;
    left: 50%; top: 50%; width: 44px; height: 44px; transform: translate(-50%, -50%); }
  .composer-file .composer-file-remove:hover { background: var(--lenso-fill-tertiary);
    color: var(--lenso-label-primary); }
  .composer-file .composer-file-remove:disabled { opacity: .45; cursor: progress; }
`;
