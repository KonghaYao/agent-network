/**
 * 房间文件模块样式：桌面右栏、平板抽屉、移动端全屏页与预览弹窗。
 *
 * 断点与聊天页保持一致：>=1200 三栏、760–1199 抽屉、<760 全屏。
 * 面板显隐由 `hidden` 属性控制，布局只负责尺寸与定位。
 */
export const FILES_STYLE = `
  .files-toggle { flex: 0 0 auto; height: 32px; padding: 0 10px; border: 0;
    background: transparent; color: var(--wx-link); font-size: 13px; }
  .files-toggle:hover, .files-toggle.active { background: var(--wx-hover); }

  .files-pane { flex: 0 0 300px; width: 300px; min-width: 0; max-width: 300px;
    min-height: 0; display: flex; flex-direction: column;
    background: var(--wx-sidebar); border-left: 1px solid var(--wx-line); }
  .files-pane[hidden] { display: none; }
  body.page-home .files-pane { display: none; }
  .files-head { flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
    gap: 8px; min-height: 56px; padding: 0 12px; border-bottom: 1px solid var(--wx-line); }
  .files-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .files-head-actions { display: flex; align-items: center; gap: 6px; }
  .files-head-actions button { padding: 5px 9px; font-size: 12px; }
  .files-close { border: 0; background: transparent; color: var(--wx-link); }
  .files-close:hover { background: var(--wx-hover); }

  .files-drop { flex: 0 0 auto; margin: 10px 12px 4px; padding: 12px 10px;
    border: 1px dashed var(--wx-line); border-radius: 8px; text-align: center;
    color: var(--wx-muted); font-size: 12px; line-height: 1.6; cursor: pointer; }
  .files-drop:hover, .files-drop.dragover { border-color: var(--wx-green); background: var(--wx-hover); }
  .files-drop-icon { display: block; font-size: 20px; line-height: 1; margin-bottom: 4px;
    color: var(--wx-green); }

  .files-progress { flex: 0 0 auto; margin: 6px 12px 0; }
  .files-progress[hidden] { display: none; }
  .files-progress-text { margin: 0 0 4px; font-size: 11px; color: var(--wx-muted);
    overflow-wrap: anywhere; }
  .files-progress progress { width: 100%; height: 5px; accent-color: var(--wx-green); }
  .files-status { margin: 6px 12px 0; font-size: 12px; color: var(--wx-muted);
    line-height: 1.5; overflow-wrap: anywhere; }
  .files-status:empty { display: none; }
  .files-status.error { color: var(--wx-unread); }
  .files-bind-retry { display: block; margin: 6px 12px 0; font-size: 12px; }
  .files-bind-retry[hidden] { display: none; }
  .files-error { margin: 8px 12px 0; padding: 8px 10px; border-radius: 6px;
    background: var(--wx-bg); border: 1px solid var(--wx-line); }
  .files-error[hidden] { display: none; }
  .files-error p { margin: 0 0 8px; font-size: 12px; color: var(--wx-unread);
    overflow-wrap: anywhere; }
  .files-error button { font-size: 12px; }

  .files-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; list-style: none;
    margin: 0; padding: 4px 8px 12px; }
  .file-item { padding: 9px 8px; border-radius: 6px; }
  .file-item + .file-item { border-top: 1px solid var(--wx-line); }
  .file-item:hover { background: var(--wx-hover); }
  .file-row { display: flex; align-items: flex-start; gap: 9px; min-width: 0; }
  .file-thumb { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 6px;
    display: grid; place-items: center; overflow: hidden; background: var(--wx-search);
    color: var(--wx-muted); font-size: 11px; font-weight: 600; }
  .file-thumb img { width: 100%; height: 100%; object-fit: cover; }
  .file-main { flex: 1 1 auto; min-width: 0; }
  .file-name { display: block; font-size: 13px; color: var(--wx-text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-meta { display: block; margin-top: 3px; font-size: 11px; color: var(--wx-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin: 4px 0 0 49px; }
  .file-action { border: 0; background: none; padding: 2px 4px; margin: 0;
    color: var(--wx-link); font-size: 12px; text-decoration: none; }
  .file-action:hover { background: var(--wx-hover); }
  .file-action.danger { color: var(--wx-unread); }
  .file-skeleton { display: flex; align-items: center; gap: 9px; padding: 9px 8px; }
  .file-skeleton .skeleton-avatar { width: 40px; height: 40px; border-radius: 6px; }
  .file-skeleton-lines { flex: 1 1 auto; display: flex; flex-direction: column; gap: 7px; }
  .file-skeleton-lines span { display: block; height: 9px; border-radius: 4px;
    background: var(--wx-line); animation: skeleton-pulse 1.3s ease-in-out infinite; }
  .file-skeleton-lines span:first-child { width: 62%; }
  .file-skeleton-lines span:last-child { width: 42%; }
  .files-empty { margin: auto 16px; padding: 28px 0; text-align: center;
    color: var(--wx-muted); font-size: 12px; }
  .files-empty[hidden] { display: none; }
  .files-more { flex: 0 0 auto; align-self: center; margin: 0 0 12px; padding: 4px 10px;
    border: 0; background: transparent; color: var(--wx-link); font-size: 12px; }
  .files-more[hidden] { display: none; }

  .files-backdrop { position: fixed; inset: 0; z-index: 23; background: rgb(0 0 0 / 40%); }
  .files-backdrop[hidden] { display: none; }

  .file-preview { position: fixed; inset: 0; z-index: 40; display: grid;
    place-items: center; padding: 16px; background: rgb(0 0 0 / 58%); }
  .file-preview[hidden] { display: none; }
  .file-preview-card { width: min(900px, 100%); max-height: min(90dvh, 900px);
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--wx-panel); color: var(--wx-text); border-radius: 10px;
    box-shadow: var(--wx-shadow); }
  .file-preview-head { flex: 0 0 auto; display: flex; align-items: center; gap: 10px;
    padding: 10px 14px; border-bottom: 1px solid var(--wx-line); }
  .file-preview-id { flex: 1 1 auto; min-width: 0; }
  .file-preview-head h2 { margin: 0; font-size: 14px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-preview-meta { margin: 2px 0 0; font-size: 11px; color: var(--wx-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-preview-body { flex: 1 1 auto; min-height: 0; overflow: auto;
    display: grid; place-items: center; background: var(--wx-bg); padding: 8px; }
  .file-preview-body img { max-width: 100%; max-height: 72dvh; }
  .file-preview-body iframe { width: 100%; height: 70dvh; border: 0; background: #fff; }
  .file-preview-body pre { width: 100%; align-self: stretch; margin: 0; padding: 10px;
    max-height: 70dvh; overflow: auto; background: var(--wx-panel); color: var(--wx-text);
    font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space: pre-wrap; overflow-wrap: anywhere; }
  .file-preview-body audio, .file-preview-body video { width: min(100%, 720px); }
  .file-preview-note { margin: 0; padding: 24px 16px; text-align: center;
    color: var(--wx-muted); font-size: 13px; line-height: 1.7; }
  .file-preview-foot { flex: 0 0 auto; display: flex; justify-content: flex-end;
    padding: 8px 14px; border-top: 1px solid var(--wx-line); }
  .file-preview-foot a { color: var(--wx-link); font-size: 13px; }
  .file-preview-foot a[hidden] { display: none; }

  .files-list::-webkit-scrollbar, .file-preview-body::-webkit-scrollbar { width: 6px; }
  .files-list::-webkit-scrollbar-thumb, .file-preview-body::-webkit-scrollbar-thumb {
    background: rgb(0 0 0 / 14%); border-radius: 3px; }
  @media (prefers-color-scheme: dark) {
    .files-list::-webkit-scrollbar-thumb, .file-preview-body::-webkit-scrollbar-thumb {
      background: rgb(255 255 255 / 16%); }
  }

  @media (min-width: 760px) and (max-width: 1199px) {
    .files-pane { position: fixed; top: 0; right: 0; bottom: 0; z-index: 24;
      width: 320px; min-width: 320px; max-width: 320px; height: 100dvh;
      box-shadow: -8px 0 28px rgb(0 0 0 / 22%); }
  }

  @media (min-width: 1200px) {
    .files-backdrop { display: none !important; }
  }

  @media (max-width: 759px) {
    .files-pane { position: fixed; inset: 0; z-index: 30; width: 100%;
      min-width: 0; max-width: none; height: 100dvh; border-left: 0;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom); }
    .files-pane[hidden] { display: none; }
    .files-backdrop { display: none !important; }
    body.files-page-open .chat-pane,
    body.files-page-open .sidebar { display: none; }
    .files-head { min-height: 56px; }
    .files-drop { padding: 16px 10px; }
    .file-preview { padding: 0; }
    .file-preview-card { width: 100%; max-height: 100dvh; min-height: 100dvh;
      border-radius: 0; }
    .file-preview-body { padding: 0; }
    .file-preview-body iframe { height: 76dvh; }
  }
`;
