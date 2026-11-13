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
    place-items: center; width: auto; height: auto; max-width: none; max-height: none;
    margin: 0; border: 0; padding: 16px; background: rgb(0 0 0 / 58%); color: inherit; }
  .file-preview:not([open]) { display: none; }
  .file-preview::backdrop { background: transparent; }
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
  .file-preview-markdown { box-sizing: border-box; align-self: stretch; justify-self: center;
    width: 100%; max-width: 760px; min-width: 0; background: var(--wx-panel);
    border: 1px solid var(--wx-line); border-radius: 8px; overflow: hidden; }
  .file-preview-md-toolbar { display: flex; justify-content: flex-end; padding: 4px 10px 0; }
  .file-preview-md-toolbar[hidden] { display: none; }
  .file-preview-md-toggle { border: 0; background: none; padding: 4px 6px; border-radius: 4px;
    color: var(--wx-link); font-size: 12px; line-height: 1.6; cursor: pointer; }
  .file-preview-md-toggle:hover { background: var(--wx-hover); }
  .file-preview-md-viewer { padding: 4px 18px 18px; min-width: 0; }
  .file-preview-md-viewer[hidden] { display: none; }
  .file-preview-md-viewer .msg-markdown { font-size: 14px; line-height: 1.75; }
  .file-preview-md-source[hidden] { display: none; }
  .file-preview-md-note { padding: 10px 16px; text-align: left;
    border-bottom: 1px solid var(--wx-line); }
  .file-preview-md-note[hidden] { display: none; }
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
    /* 聊天区与右侧文件栏默认 50/50，可拖动分隔条调整；宽度变量由 React 岛写入。 */
    .chat-pane { flex: 1 1 auto; min-width: 320px; }
    /* 右栏打开时为聊天头留出完整联系人标题与常用操作的空间。比例偏大时
       允许文件/监控栏收窄，并让聊天头换行；不要把标题压成几字宽。 */
    body.page-room:has(.files-pane:not([hidden])) .chat-head,
    body.page-room:has(#monitor-pane:not([hidden])) .chat-head {
      flex-wrap: wrap; row-gap: 4px; padding-top: 8px; padding-bottom: 8px; }
    body.page-room:has(.files-pane:not([hidden])) .chat-id,
    body.page-room:has(#monitor-pane:not([hidden])) .chat-id {
      flex: 1 1 220px; min-width: 220px; }
    body.page-room:has(.files-pane:not([hidden])) .title-row,
    body.page-room:has(#monitor-pane:not([hidden])) .title-row {
      flex-wrap: wrap; row-gap: 2px; }
    body.page-room:has(.files-pane:not([hidden])) .title-row h2,
    body.page-room:has(#monitor-pane:not([hidden])) .title-row h2 {
      flex: 1 1 120px; min-width: 120px; }
    /* 先减去 300px 会话栏、分隔条和 320px 聊天工作区，再按比例分配；
       分隔条仍可拖动，但文件/监控栏不会挤掉标题与聊天操作。 */
    .files-pane { flex: 0 0 calc((100% - 300px - var(--pane-resizer-width)) * var(--right-pane-ratio, 0.5));
      width: calc((100% - 300px - var(--pane-resizer-width)) * var(--right-pane-ratio, 0.5));
      min-width: 280px;
      max-width: calc(100% - 300px - var(--pane-resizer-width) - 320px);
      box-sizing: border-box; }
    body.page-room:has(#monitor-pane:not([hidden])) .monitor-pane {
      max-width: calc(100% - 300px - var(--pane-resizer-width) - 320px); }
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
    .file-preview-card { box-sizing: border-box; width: 100%; height: 100dvh;
      max-height: 100dvh; min-height: 100dvh; border-radius: 0;
      padding-top: env(safe-area-inset-top);
      padding-bottom: env(safe-area-inset-bottom); }
    .file-preview-head { min-height: 56px; padding: 6px 10px; }
    #file-preview-close { min-width: 44px; min-height: 44px; }
    .file-preview-foot a { min-height: 44px; display: inline-flex; align-items: center; }
    .file-preview-body { padding: 0; }
    .file-preview-body iframe { height: 76dvh; }
    .file-preview-markdown { max-width: none; border-left: 0; border-right: 0; border-radius: 0; }
    .file-preview-md-viewer { padding: 4px 12px 16px; }
  }
`;
