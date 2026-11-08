/**
 * 应用页（会话列表 + 聊天区）的全部内联样式。
 *
 * 视觉基线是微信桌面端：浅灰页面、白色气泡、自己为 `#95ec69` 绿气泡、
 * 会话项 64px、消息头像 36px。颜色集中为 CSS 变量，暗色模式只换变量。
 */
export const APP_STYLE = `
  :root {
    --wx-green: #07c160;
    --wx-green-strong: #06ad56;
    --wx-bg: #ededed;
    --wx-sidebar: #f7f7f7;
    --wx-panel: #ffffff;
    --wx-line: #e5e5e5;
    --wx-text: #1a1a1a;
    --wx-muted: #999999;
    --wx-hover: #ececec;
    --wx-active: #e3e3e3;
    --wx-bubble: #ffffff;
    --wx-mine: #95ec69;
    --wx-mine-text: #111111;
    --wx-unread: #fa5151;
    --wx-danger: #c0392b;
    --wx-danger-strong: #a93226;
    --wx-link: #576b95;
    --wx-search: #e6e6e6;
    --wx-shadow: 0 12px 32px rgb(0 0 0 / 14%);
    /* 右侧面板与聊天区之间分隔条的宽度；拖拽岛只改比例，不改这里。 */
    --pane-resizer-width: 6px;
    /* 桌面端右栏占比，默认一半一半；拖拽岛按 localStorage 覆盖。 */
    --right-pane-ratio: 0.5;
    /* 品牌图标统一浅色底：单色 SVG 以 currentColor 编码，<img> 中会渲染为黑色。 */
    --wx-avatar-icon-bg: #f2f3f5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --wx-bg: #191919;
      --wx-sidebar: #2b2b2b;
      --wx-panel: #2b2b2b;
      --wx-line: #333333;
      --wx-text: #e5e5e5;
      --wx-muted: #8c8c8c;
      --wx-hover: #333333;
      --wx-active: #404040;
      --wx-bubble: #2c2c2c;
      --wx-search: #3a3a3a;
      --wx-shadow: 0 12px 32px rgb(0 0 0 / 45%);
    }
  }

  body.wide { background: var(--wx-bg); color: var(--wx-text);
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue",
      "Microsoft YaHei", sans-serif; font-size: 14px; line-height: 1.45;
    -webkit-font-smoothing: antialiased; }
  main { display: flex; min-height: 0; }

  button { border-radius: 4px; border: 1px solid var(--wx-line); background: var(--wx-panel);
    color: var(--wx-text); padding: 7px 14px; font-size: 13px; cursor: pointer; }
  button:hover { background: var(--wx-hover); }
  button.primary { background: var(--wx-green); border-color: var(--wx-green); color: #fff; }
  button.primary:hover { background: var(--wx-green-strong); border-color: var(--wx-green-strong); }
  button:disabled { opacity: .55; cursor: not-allowed; }
  button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible,
  summary:focus-visible { outline: 2px solid var(--wx-green); outline-offset: 2px; }

  .sidebar { flex: 0 0 300px; width: 300px; min-width: 280px; max-width: 320px;
    display: flex; flex-direction: column; min-height: 0;
    background: var(--wx-sidebar); border-right: 1px solid var(--wx-line); }
  .sidebar-head { flex: 0 0 auto; padding: 16px 12px 10px; }
  .brand-row { display: flex; align-items: center; justify-content: space-between;
    gap: 8px; padding: 0 4px 12px; }
  .brand-row h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: .2px; }
  .icon-btn { flex: 0 0 auto; width: 28px; height: 28px; padding: 0; border: 0;
    background: transparent; color: var(--wx-text); font-size: 22px; line-height: 1;
    display: grid; place-items: center; }
  .icon-btn:hover { background: var(--wx-hover); }
  .icon-btn svg { width: 18px; height: 18px; display: block; fill: none;
    stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .search-box { position: relative; display: block; }
  .search-icon { position: absolute; left: 8px; top: 50%; width: 15px; height: 15px;
    transform: translateY(-50%); fill: none; stroke: var(--wx-muted); stroke-width: 1.8;
    pointer-events: none; }
  #room-search { width: 100%; height: 30px; padding: 0 10px 0 28px; border: 0;
    border-radius: 4px; background: var(--wx-search); color: var(--wx-text);
    font: inherit; font-size: 13px; }
  #room-search::placeholder { color: var(--wx-muted); }
  #room-search::-webkit-search-cancel-button { -webkit-appearance: none; }

  .room-filter { display: flex; gap: 2px; margin-top: 8px; padding: 2px;
    background: var(--wx-search); border-radius: 6px; }
  .room-filter button { flex: 1 1 0; min-width: 0; height: 26px; padding: 0 8px;
    border: 0; border-radius: 4px; background: transparent; color: var(--wx-muted);
    font-size: 12px; }
  .room-filter button:hover { background: var(--wx-hover); color: var(--wx-text); }
  .room-filter button[aria-selected="true"] { background: var(--wx-panel);
    color: var(--wx-text); font-weight: 600; box-shadow: 0 1px 2px rgb(0 0 0 / 8%); }

  .sidebar-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  .room-list { list-style: none; margin: 0; padding: 2px 8px 12px; }
  .room-list li { margin: 0; }
  .room-item { position: relative; display: flex; align-items: center; gap: 10px;
    height: 64px; padding: 0 8px; border-radius: 6px; color: inherit; text-decoration: none;
    touch-action: pan-y; -webkit-touch-callout: none; }
  .room-item:hover { background: var(--wx-hover); }
  .room-item.active { background: var(--wx-active); }
  .room-main { flex: 1 1 auto; min-width: 0; }
  .room-top { display: flex; align-items: center; gap: 6px; }
  .room-name { flex: 1 1 auto; min-width: 0; font-size: 14px; color: var(--wx-text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .room-time { flex: 0 0 auto; margin-left: auto; font-size: 11px; color: var(--wx-muted); }
  .room-task-badge { flex: 0 0 auto; padding: 0 5px; border-radius: 8px;
    background: var(--wx-search); color: var(--wx-muted); font-size: 10px;
    line-height: 16px; white-space: nowrap; }
  .room-preview { margin-top: 3px; font-size: 12px; color: var(--wx-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 会话右键/长按菜单：固定定位，靠近指针并限制在视口内。 */
  /* 固定宽度：安全提示是长段落，shrink-to-fit 会把菜单撑满整屏并挡住聊天区。 */
  .room-menu { position: fixed; z-index: 26; width: 260px;
    max-width: calc(100vw - 16px); box-sizing: border-box; padding: 6px;
    border-radius: 8px; background: var(--wx-panel); border: 1px solid var(--wx-line);
    box-shadow: var(--wx-shadow); }
  .room-menu[hidden] { display: none; }
  .room-menu-item { display: block; width: 100%; box-sizing: border-box;
    padding: 9px 10px; border: 0; border-radius: 4px; background: transparent;
    color: var(--wx-text); font: inherit; font-size: 13px; text-align: left;
    white-space: nowrap; }
  .room-menu-item:hover, .room-menu-item:focus-visible { background: var(--wx-hover); }
  /* 危险动作：红底白字；hover 更深，focus 用文字色轮廓，disabled 浅红底深红字。 */
  .room-menu-item.danger { background: var(--wx-danger); color: #fff; }
  .room-menu-item.danger:hover, .room-menu-item.danger:focus-visible {
    background: var(--wx-danger-strong); }
  .room-menu-item.danger:focus-visible { outline: 2px solid var(--wx-text); outline-offset: 2px; }
  .room-menu-item.danger:disabled { opacity: 1; background: #f6d5d5; color: #7f1d1d;
    cursor: not-allowed; }
  .room-menu-item[hidden] { display: none; }
  .room-menu-status { margin: 4px 0 0; padding: 0 10px 2px; font-size: 12px;
    color: var(--wx-green); }
  .room-menu-status[hidden] { display: none; }
  .room-menu-status.error { color: var(--wx-unread); }
  /* 停用后待处理工作：数量摘要 + 可折叠的未完成任务，空态单独一行。 */
  .room-menu-stopped { margin: 4px 0 0; padding: 6px 10px 4px;
    border-top: 1px solid var(--wx-line); font-size: 12px; line-height: 1.5;
    color: var(--wx-text); }
  .room-menu-stopped[hidden] { display: none; }
  .room-menu-stopped-summary { margin: 0; overflow-wrap: anywhere; }
  .room-menu-stopped-details { margin-top: 4px; color: var(--wx-muted); }
  .room-menu-stopped-details[hidden] { display: none; }
  .room-menu-stopped-details summary { cursor: pointer; color: var(--wx-text); }
  .room-menu-stopped-tasks { margin: 4px 0 0; padding-left: 18px;
    max-height: 132px; overflow-y: auto; }
  .room-menu-stopped-tasks li { margin: 2px 0; overflow-wrap: anywhere; }
  .room-menu-stopped-empty { margin: 4px 0 0; color: var(--wx-muted); }
  .room-menu-stopped-empty[hidden] { display: none; }
  /* 已归档 Agents：账号区图标上方的轻量浮层，不是全屏弹窗。 */
  .archive-popover { position: fixed; z-index: 30; box-sizing: border-box;
    width: min(320px, calc(100vw - 16px)); max-height: min(60vh, calc(100vh - 16px));
    display: flex; flex-direction: column; padding: 10px; border-radius: 8px;
    background: var(--wx-panel); border: 1px solid var(--wx-line);
    box-shadow: var(--wx-shadow); }
  .archive-popover[hidden] { display: none; }
  .archive-popover-head { flex: 0 0 auto; display: flex; align-items: center;
    justify-content: space-between; gap: 8px; padding: 2px 2px 8px; }
  .archive-popover-head h2 { margin: 0; font-size: 14px; font-weight: 600; }
  .archive-popover-close { flex: 0 0 auto; width: 26px; height: 26px; padding: 0;
    border: 0; background: transparent; color: var(--wx-muted); font-size: 18px;
    line-height: 1; }
  .archive-popover-close:hover { background: var(--wx-hover); color: var(--wx-text); }
  .archive-popover-status { flex: 0 0 auto; margin: 0 2px 6px; font-size: 12px;
    line-height: 1.5; color: var(--wx-muted); overflow-wrap: anywhere; }
  .archive-popover-status[hidden] { display: none; }
  .archive-popover-status.error { color: var(--wx-unread); }
  .archive-popover-list { flex: 1 1 auto; min-height: 0; overflow-y: auto;
    list-style: none; margin: 0; padding: 0; }
  .archive-item { display: flex; align-items: center; gap: 8px; padding: 6px 2px; }
  .archive-avatar { width: 32px; height: 32px; border-radius: 6px; font-size: 13px; }
  .archive-name { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--wx-text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .archive-restore { flex: 0 0 auto; padding: 4px 10px; font-size: 12px; }
  .archive-popover-empty { flex: 0 0 auto; margin: 0; padding: 18px 8px;
    color: var(--wx-muted); font-size: 13px; text-align: center; }
  .archive-popover-empty[hidden] { display: none; }
  /* 归档/恢复反馈：轻量、不可点击，不遮挡输入区操作。 */
  .toast { position: fixed; z-index: 50; left: 50%; bottom: calc(24px + env(safe-area-inset-bottom));
    transform: translateX(-50%); max-width: calc(100vw - 32px); box-sizing: border-box;
    padding: 8px 14px; border-radius: 6px; background: rgb(0 0 0 / 78%);
    color: #fff; font-size: 13px; line-height: 1.5; text-align: center;
    overflow-wrap: anywhere; pointer-events: none; }
  .toast[hidden] { display: none; }
  .avatar-wrap { position: relative; flex: 0 0 auto; display: block; width: 40px; height: 40px; }
  .unread { position: absolute; top: -1px; right: -1px; width: 9px; height: 9px;
    border-radius: 50%; background: var(--wx-unread); box-sizing: content-box;
    border: 2px solid var(--wx-sidebar); }
  /* 侧栏只标离线：灰色圆点位于右下，在线/未知不渲染，与右上未读点分离。 */
  .presence-dot { position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px;
    border-radius: 50%; box-sizing: content-box; background: var(--wx-muted);
    border: 2px solid var(--wx-sidebar); }
  .presence-dot.offline { background: var(--wx-muted); }
  .room-item:hover .unread, .room-item:hover .presence-dot { border-color: var(--wx-hover); }
  .room-item.active .unread, .room-item.active .presence-dot { border-color: var(--wx-active); }
  .list-hint { margin: 0; padding: 32px 20px; color: var(--wx-muted); font-size: 13px;
    line-height: 1.7; text-align: center; overflow-wrap: anywhere; }
  .list-hint[hidden] { display: none; }
  .list-retry { display: block; margin: 0 auto 16px; font-size: 12px; }
  .list-retry[hidden] { display: none; }

  /* 首屏会话骨架：只占位，不阻塞交互；数据到达后 renderRooms 覆盖。 */
  .room-skeleton { display: flex; align-items: center; gap: 10px; height: 64px; padding: 0 8px; }
  .skeleton-avatar { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 50%;
    background: var(--wx-line); animation: skeleton-pulse 1.3s ease-in-out infinite; }
  .skeleton-lines { flex: 1 1 auto; display: flex; flex-direction: column; gap: 7px; }
  .skeleton-lines span { display: block; height: 10px; border-radius: 4px;
    background: var(--wx-line); animation: skeleton-pulse 1.3s ease-in-out infinite; }
  .skeleton-lines span:first-child { width: 46%; }
  .skeleton-lines span:last-child { width: 78%; }
  @keyframes skeleton-pulse { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }

  .avatar { flex: 0 0 auto; width: 40px; height: 40px; border-radius: 50%;
    display: grid; place-items: center; overflow: hidden; color: #fff;
    font-size: 16px; font-weight: 500; }
  .avatar-grid { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr;
    gap: 1px; border-radius: 6px; background: var(--wx-line); }
  .avatar-cell { display: grid; place-items: center; width: 100%; height: 100%;
    font-size: 10px; line-height: 1; color: #fff; }
  /* 品牌图标：容器保留首字供图片失败时回退，img 覆盖并遮住首字。 */
  .avatar-icon { position: relative; background: var(--wx-avatar-icon-bg); color: #1f2329; }
  .avatar-icon .avatar-img { position: absolute; inset: 0; box-sizing: border-box;
    width: 100%; height: 100%; padding: 14%; border-radius: inherit;
    background: var(--wx-avatar-icon-bg); object-fit: contain; display: block; }

  .sidebar-foot { flex: 0 0 auto; padding: 8px 12px calc(10px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--wx-line); background: var(--wx-sidebar); }

  .chat-pane { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex;
    flex-direction: column; background: var(--wx-bg); }
  /* 可拖拽分隔条：默认隐藏，仅桌面端且右侧面板打开时由下方媒体查询显示。 */
  .pane-resizer { display: none; flex: 0 0 var(--pane-resizer-width);
    width: var(--pane-resizer-width); align-self: stretch; position: relative;
    z-index: 6; touch-action: none; }
  .pane-resizer-handle { display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; cursor: col-resize; touch-action: none; outline: none; }
  .pane-resizer-handle::before { content: ""; width: 1px; height: 100%;
    background: var(--wx-line); transition: background-color .12s, width .12s; }
  .pane-resizer-handle:hover::before,
  .pane-resizer-handle:focus-visible::before,
  .pane-resizer-handle.dragging::before {
    width: 2px; background: var(--wx-green); }
  .pane-resizer-handle:focus-visible { outline: 2px solid var(--wx-green);
    outline-offset: -2px; }
  /* 壳同时包含空状态与聊天面板，由 body class 决定桌面端显示哪一个。 */
  body.page-home .chat-pane:not(.empty-pane) { display: none; }
  body.page-room .empty-pane { display: none; }
  .chat-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    min-height: 56px; padding: 0 16px; background: var(--wx-sidebar);
    border-bottom: 1px solid var(--wx-line); position: relative; }
  .back { display: none; flex: 0 0 auto; align-items: center; justify-content: center;
    width: 36px; height: 36px; margin-left: -8px; border-radius: 6px;
    color: inherit; text-decoration: none; }
  .back:hover { background: var(--wx-hover); }
  .back svg { width: 22px; height: 22px; fill: none; stroke: var(--wx-text); stroke-width: 2; }
  .chat-id { flex: 1 1 auto; min-width: 0; }
  .title-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .title-row h2 { margin: 0; font-size: 16px; font-weight: 600; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .chat-id .muted { margin: 1px 0 0; font-size: 11px; color: var(--wx-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chat-id .muted[hidden] { display: none; }
  .link-btn { flex: 0 0 auto; border: 0; background: none; padding: 2px 4px;
    color: var(--wx-link); font-size: 12px; }
  .link-btn:hover { background: var(--wx-hover); }
  .link-btn[hidden] { display: none; }
  .copy-group-info { flex: 0 0 auto; display: inline-flex; align-items: center;
    justify-content: center; width: 32px; height: 32px; padding: 0; border: 0;
    border-radius: 6px; background: none; color: var(--wx-text); }
  .copy-group-info:hover { background: var(--wx-hover); }
  .copy-group-info:disabled { opacity: 0.55; }
  .copy-group-info[hidden] { display: none; }
  .copy-group-info svg { width: 17px; height: 17px; fill: none;
    stroke: currentColor; stroke-width: 1.8; }
  .rename-form { flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
    padding: 8px 12px; background: var(--wx-sidebar); border-bottom: 1px solid var(--wx-line); }
  .rename-form[hidden] { display: none; }
  .rename-form input { flex: 1 1 auto; min-width: 0; height: 32px; padding: 0 10px;
    border: 1px solid var(--wx-line); border-radius: 4px; background: var(--wx-panel);
    color: var(--wx-text); font: inherit; font-size: 13px; }

  /* 房间任务：头部一行进度，hover/focus/点击展开同一浮层。 */
  .task-toggle { flex: 0 0 auto; display: inline-flex; align-items: center;
    height: 28px; padding: 0 10px; border: 1px solid var(--wx-line);
    border-radius: 14px; background: var(--wx-panel); color: var(--wx-muted);
    font-size: 12px; line-height: 1; white-space: nowrap; }
  .task-toggle:hover, .task-toggle[aria-expanded="true"] {
    background: var(--wx-hover); color: var(--wx-text); }
  .task-toggle[hidden] { display: none; }
  .task-popover { position: absolute; z-index: 24; top: calc(100% - 2px);
    right: 12px; width: min(360px, calc(100vw - 24px));
    max-height: min(60vh, 420px); box-sizing: border-box;
    display: flex; flex-direction: column; padding: 10px;
    border-radius: 8px; background: var(--wx-panel); border: 1px solid var(--wx-line);
    box-shadow: var(--wx-shadow); }
  .task-popover[hidden] { display: none; }
  .task-popover-head { flex: 0 0 auto; display: flex; align-items: center;
    justify-content: space-between; gap: 8px; padding: 0 2px 8px; }
  .task-popover-head h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .task-popover-close { flex: 0 0 auto; width: 26px; height: 26px; padding: 0;
    border: 0; background: transparent; color: var(--wx-muted); font-size: 18px;
    line-height: 1; }
  .task-popover-close:hover { background: var(--wx-hover); color: var(--wx-text); }
  .task-list { flex: 1 1 auto; min-height: 0; overflow-y: auto;
    list-style: none; margin: 0; padding: 0; }
  .task-item { padding: 8px 6px; border-top: 1px solid var(--wx-line);
    border-radius: 4px; }
  .task-item:first-child { border-top: 0; }
  .task-item[role="button"] { cursor: pointer; }
  .task-item[role="button"]:hover, .task-item[role="button"]:focus-visible {
    background: var(--wx-hover); outline: none; }
  .task-item-top { display: flex; align-items: flex-start; gap: 8px; }
  .task-desc { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--wx-text);
    overflow-wrap: anywhere; }
  .task-status { flex: 0 0 auto; padding: 1px 6px; border-radius: 8px;
    background: var(--wx-search); color: var(--wx-muted); font-size: 10px;
    line-height: 16px; white-space: nowrap; }
  .task-status.offered, .task-status.submitted { color: var(--wx-link); }
  .task-status.claimed { color: var(--wx-link); }
  .task-status.done { color: var(--wx-green); }
  .task-status.failed, .task-status.blocked { color: var(--wx-danger); }
  .task-status.cancelled { color: var(--wx-muted); text-decoration: line-through; }
  .task-meta { margin-top: 2px; font-size: 11px; color: var(--wx-muted);
    overflow-wrap: anywhere; }
  .task-result { margin: 4px 0 0; font-size: 12px; color: var(--wx-text);
    overflow-wrap: anywhere; }
  .task-result.failed { color: var(--wx-danger); }
  .task-popover-empty { flex: 0 0 auto; margin: 0; padding: 18px 8px;
    font-size: 12px; color: var(--wx-muted); text-align: center; }
  .task-popover-empty[hidden] { display: none; }
  .task-list-wide { max-height: min(62dvh, 520px); }
  .task-modal-card { width: min(640px, 100%); box-sizing: border-box; }
  .task-modal-card h2 { margin: 0; }
  .task-modal-head { display: flex; align-items: center; justify-content: space-between;
    gap: 10px; margin-bottom: 12px; }
  .task-source-hint { margin: 0 0 10px; font-size: 12px; line-height: 1.6; }
  .task-source-hint[hidden] { display: none; }
  .task-form-row { display: flex; gap: 10px; }
  .task-form-row .field { flex: 1 1 0; min-width: 0; }
  .field select, .field textarea { display: block; box-sizing: border-box;
    width: 100%; margin-top: 6px; padding: 6px 10px; border: 1px solid var(--wx-line);
    border-radius: 4px; background: var(--wx-bg); color: var(--wx-text);
    font: inherit; font-size: 13px; }
  .field textarea { resize: vertical; line-height: 1.6; }
  .task-detail-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr);
    gap: 8px 14px; margin: 0 0 14px; font-size: 13px; }
  .task-detail-grid dt { color: var(--wx-muted); }
  .task-detail-grid dd { margin: 0; color: var(--wx-text); overflow-wrap: anywhere; }
  .task-detail-grid dd.task-long-text { white-space: pre-wrap; line-height: 1.6; }
  .task-detail-grid dd .link-btn { padding: 0; }
  .task-attachment { display: block; color: var(--wx-link); overflow-wrap: anywhere; }
  .task-detail-actions { display: flex; flex-direction: column; gap: 8px; }
  .task-detail-actions:empty { display: none; }
  .task-detail-actions .modal-actions { justify-content: flex-start; }
  .task-offer-select, .task-cancel-reason { min-width: 0; height: 30px;
    padding: 0 8px; border: 1px solid var(--wx-line); border-radius: 4px;
    background: var(--wx-bg); color: var(--wx-text); font: inherit; font-size: 12px; }
  .task-cancel-reason { flex: 1 1 140px; }
  .task-status-hint { color: var(--wx-muted); line-height: 1.6; }
  .task-block-reason { color: var(--wx-danger); }
  .task-progress { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .task-progress-bar { height: 6px; border-radius: 3px; overflow: hidden;
    background: var(--wx-search); }
  .task-progress-fill { height: 100%; border-radius: 3px;
    background: var(--wx-green); transition: width 0.2s ease; }
  .task-progress-meta { font-size: 11px; color: var(--wx-muted);
    overflow-wrap: anywhere; }
  .task-progress-note { font-size: 12px; line-height: 1.6;
    white-space: pre-wrap; overflow-wrap: anywhere; }
  .task-progress-history { list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 6px; }
  .task-progress-history li { padding-top: 6px; border-top: 1px solid var(--wx-line); }
  .task-progress-history li:first-child { padding-top: 0; border-top: 0; }
  .task-progress-history-head { font-size: 12px; color: var(--wx-text); }
  .task-progress-percent-input { flex: 0 0 88px; }
  .task-progress-summary { color: var(--wx-link); }
  .task-transfer-panel { display: flex; flex-direction: column; gap: 8px;
    padding-top: 10px; border-top: 1px solid var(--wx-line); font-size: 12px; }
  .task-transfer-title { margin: 0; font-size: 12px; font-weight: 600;
    color: var(--wx-muted); }
  .task-transfer-list { list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 8px; }
  .task-transfer-item { display: flex; flex-direction: column; gap: 4px;
    padding: 8px 10px; border: 1px solid var(--wx-line); border-radius: 6px;
    background: var(--wx-search); }
  .task-transfer-head { display: flex; align-items: center; gap: 8px;
    justify-content: space-between; overflow-wrap: anywhere; }
  .task-transfer-meta { font-size: 11px; color: var(--wx-muted);
    overflow-wrap: anywhere; }
  .task-transfer-note { line-height: 1.6; white-space: pre-wrap;
    overflow-wrap: anywhere; }
  .task-transfer-badge { flex: 0 0 auto; padding: 1px 6px; border-radius: 9px;
    font-size: 11px; background: var(--wx-bg); color: var(--wx-muted); }
  .task-transfer-badge-pending { color: var(--wx-link); }
  .task-transfer-badge-accepted { color: var(--wx-green); }
  .task-transfer-badge-rejected, .task-transfer-badge-expired {
    color: var(--wx-danger); }
  .task-transfer-actions { justify-content: flex-start; }
  .task-transfer-reason { flex: 1 1 120px; }
  .task-transfer-propose { display: flex; flex-wrap: wrap; gap: 8px;
    align-items: center; }
  .task-transfer-note-input { flex: 1 1 160px; }
  .task-transfer-empty { margin: 0; color: var(--wx-muted); }
  .task-transfer-error { min-height: 1.2em; margin: 0; color: var(--wx-unread);
    font-size: 12px; overflow-wrap: anywhere; }
  .task-handoff-panel { display: flex; flex-direction: column; gap: 8px;
    padding-top: 10px; border-top: 1px solid var(--wx-line); font-size: 12px; }
  .task-handoff-title { margin: 0; font-size: 12px; font-weight: 600;
    color: var(--wx-muted); }
  .task-handoff-versions { display: flex; flex-wrap: wrap; gap: 6px;
    align-items: center; }
  .task-handoff-version-label { color: var(--wx-muted); }
  .task-handoff-version { padding: 1px 8px; border: 1px solid var(--wx-line);
    border-radius: 9px; background: var(--wx-bg); color: var(--wx-muted);
    font-size: 11px; cursor: pointer; }
  .task-handoff-version-active { color: var(--wx-link);
    border-color: var(--wx-link); }
  .task-handoff-pack-meta { font-size: 11px; color: var(--wx-muted);
    overflow-wrap: anywhere; }
  .task-handoff-readiness { padding: 4px 8px; border-radius: 6px;
    background: var(--wx-search); overflow-wrap: anywhere; }
  .task-handoff-readiness-ready { color: var(--wx-green); }
  .task-handoff-readiness-incomplete { color: var(--wx-danger); }
  .task-handoff-block { display: flex; flex-direction: column; gap: 4px; }
  .task-handoff-block-title { font-weight: 600; color: var(--wx-text); }
  .task-handoff-block-text { line-height: 1.6; white-space: pre-wrap;
    overflow-wrap: anywhere; }
  .task-handoff-list, .task-handoff-items, .task-handoff-requests {
    list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 4px; }
  .task-handoff-items { gap: 8px; }
  .task-handoff-item { display: flex; flex-direction: column; gap: 4px;
    padding: 8px 10px; border: 1px solid var(--wx-line); border-radius: 6px;
    background: var(--wx-search); }
  .task-handoff-item-missing, .task-handoff-item-omitted {
    border-style: dashed; }
  .task-handoff-item-head { display: flex; align-items: center; gap: 8px;
    justify-content: space-between; overflow-wrap: anywhere; }
  .task-handoff-item-meta, .task-handoff-item-reason {
    font-size: 11px; color: var(--wx-muted); overflow-wrap: anywhere; }
  .task-handoff-item-text { line-height: 1.6; overflow-wrap: anywhere; }
  .task-handoff-badge { flex: 0 0 auto; padding: 1px 6px; border-radius: 9px;
    font-size: 11px; background: var(--wx-bg); color: var(--wx-muted); }
  .task-handoff-badge-available { color: var(--wx-green); }
  .task-handoff-badge-missing { color: var(--wx-danger); }
  .task-handoff-badge-omitted { color: var(--wx-muted); }
  .task-handoff-actions { justify-content: flex-start; }
  .task-handoff-file { color: var(--wx-link); }
  .task-handoff-request-form { display: flex; flex-wrap: wrap; gap: 8px;
    align-items: flex-start; }
  .task-handoff-request-note { flex: 1 1 180px; resize: vertical; }
  .task-handoff-error { min-height: 1.2em; margin: 0; color: var(--wx-unread);
    font-size: 12px; overflow-wrap: anywhere; }
  .msg-task-progress { flex: 0 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; color: var(--wx-muted);
    font-size: 11px; }
  .msg-task-slot { margin-top: 4px; }
  .msg-task-slot[hidden] { display: none; }
  .mine .msg-task-slot { text-align: right; }
  .msg-task-card, .msg-task-link { display: inline-flex; align-items: center;
    gap: 6px; max-width: 100%; padding: 5px 8px; border-radius: 6px;
    border: 1px solid var(--wx-line); background: var(--wx-panel);
    color: var(--wx-text); font-size: 12px; }
  .msg-task-title { min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; }
  .msg-task-link { color: var(--wx-muted); }
  .msg-task-open { flex: 0 0 auto; padding: 0 4px; border: 0; background: transparent;
    color: var(--wx-link); font-size: 12px; cursor: pointer; }
  .msg-task-convert { padding: 0 4px; border: 0; background: transparent;
    color: var(--wx-muted); font-size: 11px; cursor: pointer; }
  .msg-task-convert:hover { color: var(--wx-link); }
  /* 人类与 Agent 消息的任务入口一致：默认收起，悬停或键盘焦点进入时出现。 */
  .msg .msg-task-convert { opacity: 0; pointer-events: none; }
  .msg .msg-task-convert:focus-visible { opacity: 1; pointer-events: auto; }
  .msg:hover .msg-task-convert,
  .msg:focus-within .msg-task-convert {
    opacity: 1; pointer-events: auto; }
  @media (hover: none) {
    /* 触屏没有可靠的 hover：保留人类消息入口，Agent 入口维持隐藏。 */
    .msg[data-sender-kind="human"] .msg-task-convert { opacity: 1; pointer-events: auto; }
    .msg[data-sender-kind="agent"] .msg-task-convert { display: none; }
  }
  .msg.task-message-flash .bubble { outline: 2px solid var(--wx-link);
    outline-offset: 2px; }
  .task-submission-version { flex: 0 0 auto; padding: 1px 6px; border-radius: 8px;
    background: var(--wx-hover); color: var(--wx-muted); font-size: 11px;
    font-weight: 600; }
  .task-submission-version.pending { color: var(--wx-link);
    background: color-mix(in srgb, var(--wx-link) 12%, transparent); }
  .task-submission-time { color: var(--wx-muted); font-size: 11px; }
  .task-submission-history { list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 6px; }
  .task-submission-history li { padding-top: 6px; border-top: 1px solid var(--wx-line); }
  .task-submission-history li:first-child { padding-top: 0; border-top: 0; }
  .task-submission-history-head { font-size: 12px; color: var(--wx-text); }
  .task-submission-history-summary { margin-top: 2px; font-size: 11px;
    color: var(--wx-muted); white-space: pre-wrap; overflow-wrap: anywhere; }
  .task-submission-history-review { margin-top: 2px; font-size: 11px;
    color: var(--wx-danger); white-space: pre-wrap; overflow-wrap: anywhere; }
  .task-submit-section { margin: 0 0 10px; padding: 0; border: 0; }
  .task-submit-section legend { display: block; margin: 0 0 4px; padding: 0;
    font-size: 12px; font-weight: 600; color: var(--wx-text); }
  .task-submit-materials { list-style: none; margin: 6px 0 0; padding: 0;
    max-height: 190px; overflow-y: auto; border: 1px solid var(--wx-line);
    border-radius: 6px; }
  .task-submit-material { display: flex; align-items: center; gap: 8px;
    padding: 5px 6px; border-top: 1px solid var(--wx-line); }
  .task-submit-material:first-child { border-top: 0; }
  .task-submit-material-choice { flex: 1 1 auto; min-width: 0;
    display: flex; align-items: center; gap: 6px; font-size: 12px; }
  .task-submit-material-name { flex: 0 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .task-submit-material-meta { flex: 0 0 auto; color: var(--wx-muted);
    font-size: 11px; }
  .task-submit-material-label { flex: 0 0 132px; width: 132px; height: 28px;
    box-sizing: border-box; }
  .task-submit-links { display: flex; flex-direction: column; gap: 6px; }
  .task-submit-link-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .task-submit-link-row input { flex: 1 1 112px; min-width: 0; height: 28px;
    box-sizing: border-box; }
  .task-submit-link-url { flex-basis: 190px; }
  .task-review-checklist { list-style: none; margin: 6px 0 0; padding: 0;
    max-height: 220px; overflow-y: auto; border: 1px solid var(--wx-line);
    border-radius: 6px; }
  .task-review-item { display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 6px; border-top: 1px solid var(--wx-line); }
  .task-review-item:first-child { border-top: 0; }
  .task-review-check { flex: 1 1 auto; min-width: 0; display: flex;
    align-items: flex-start; gap: 6px; font-size: 12px; }
  .task-review-item-text { min-width: 0; overflow-wrap: anywhere; }
  .task-review-note { flex: 0 0 180px; width: 180px; height: 28px;
    box-sizing: border-box; }
  .task-reviewer-select { flex: 0 1 160px; min-width: 0; }
  .task-review-warning { color: var(--wx-unread); font-size: 11px; }
  .task-submission-history-checklist { margin-top: 2px; font-size: 11px;
    color: var(--wx-muted); overflow-wrap: anywhere; }
  .task-submission-history-checklist.failed { color: var(--wx-danger); }

  .chat-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column;
    position: relative; background: var(--wx-bg); }
  /* 细加载条：只提示“正在取新房间”，不覆盖内容、不阻塞操作。 */
  .chat-loading { position: absolute; top: 0; left: 0; right: 0; height: 2px;
    overflow: hidden; z-index: 4; }
  .chat-loading[hidden] { display: none; }
  .chat-loading::after { content: ""; display: block; width: 42%; height: 100%;
    background: var(--wx-green); animation: chat-loading-slide 1.1s ease-in-out infinite; }
  @keyframes chat-loading-slide { 0% { transform: translateX(-110%); }
    100% { transform: translateX(260%); } }
  .chat-skeleton { padding: 22px 20px; }
  .chat-skeleton[hidden] { display: none; }
  .skeleton-row { display: flex; align-items: flex-end; gap: 10px; margin-bottom: 20px; }
  .skeleton-row.mine { flex-direction: row-reverse; }
  .skeleton-row .skeleton-avatar { border-radius: 6px; }
  .skeleton-bubble { width: min(46%, 260px); height: 42px; border-radius: 4px;
    background: var(--wx-line); animation: skeleton-pulse 1.3s ease-in-out infinite; }
  .chat-error { margin: 0; padding: 26px 20px; text-align: center; color: var(--wx-muted); }
  .chat-error[hidden] { display: none; }
  .chat-error p { margin: 0 0 12px; color: var(--wx-unread); font-size: 13px;
    overflow-wrap: anywhere; }
  .chat-error-actions { display: flex; align-items: center; justify-content: center; gap: 14px; }
  .chat-error-actions a { color: var(--wx-link); font-size: 12px; }
  /* 实时连接持续失败时只在侧栏显示一个点；详细状态在 title/aria-label。 */
  .stream-dot { display: block; width: 6px; height: 6px; margin: 0 4px 6px auto;
    border-radius: 50%; background: #d69e2e; }
  .stream-dot[data-state="stopped"] { background: var(--wx-danger); }
  .stream-dot[hidden] { display: none; }
  /* 内联在消息流顶部，随消息一起滚动；加载态、失败与到底提示共用同一行。 */
  .history-pager { display: flex; flex-wrap: wrap; align-items: center;
    justify-content: center; gap: 4px 8px; max-width: 100%; min-width: 0;
    margin: 0 0 8px; padding: 0; list-style: none; }
  .history-pager[hidden] { display: none; }
  #older { max-width: 100%; margin: 0; padding: 4px 12px;
    border: 1px solid var(--wx-line); border-radius: 999px;
    background: var(--wx-panel); color: var(--wx-link); font-size: 11px;
    box-shadow: var(--wx-shadow); white-space: nowrap; }
  #older[hidden] { display: none; }
  #older[aria-busy="true"]::before { content: ""; display: inline-block;
    width: 10px; height: 10px; margin-right: 6px; vertical-align: -1px;
    border: 1.5px solid currentColor; border-right-color: transparent;
    border-radius: 50%; animation: history-spin 0.8s linear infinite; }
  @keyframes history-spin { to { transform: rotate(360deg); } }
  .history-status { max-width: 100%; padding: 5px 8px; color: var(--wx-muted);
    font-size: 11px; line-height: 16px; text-align: center;
    overflow-wrap: anywhere; }
  .history-status[hidden] { display: none; }
  .messages { flex: 1 1 auto; min-height: 0; overflow-y: auto; list-style: none;
    margin: 0; padding: 12px 20px 18px;
    overflow-anchor: none; overscroll-behavior: contain; scrollbar-gutter: stable; }
  /* 消息末尾的 1px 观察点：只参与 IntersectionObserver，不占视觉空间。 */
  .messages-end { height: 1px; margin: 0; padding: 0; list-style: none; }
  .jump-latest { position: absolute; left: 50%; z-index: 5;
    bottom: calc(70px + env(safe-area-inset-bottom)); transform: translateX(-50%);
    display: inline-flex; align-items: center; gap: 4px; max-width: calc(100% - 32px);
    padding: 7px 14px; border: 1px solid var(--wx-line); border-radius: 999px;
    background: var(--wx-panel); color: var(--wx-link); font-size: 12px;
    line-height: 1.2; white-space: nowrap; box-shadow: var(--wx-shadow); }
  .jump-latest[hidden] { display: none; }
  .jump-latest:hover { background: var(--wx-hover); }
  .msg-time { margin: 10px 0; text-align: center; font-size: 11px; color: var(--wx-muted); }
  .msg-time span { padding: 2px 7px; border-radius: 3px; background: rgb(0 0 0 / 4%); }
  /* 系统行：上下线时间线与投递回执共用，居中、无头像/气泡。 */
  .msg-system { display: flex; justify-content: center; margin: 10px 0; list-style: none; }
  .msg-system span { max-width: 88%; padding: 2px 8px; border-radius: 3px;
    background: rgb(0 0 0 / 4%); color: var(--wx-muted); font-size: 11px;
    text-align: center; overflow-wrap: anywhere; }
  .msg { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 18px; min-width: 0; }
  .msg.mine { flex-direction: row-reverse; }
  .msg-avatar { flex: 0 0 auto; width: 36px; height: 36px; border-radius: 6px;
    display: grid; place-items: center; overflow: hidden; color: #fff;
    font-size: 14px; font-weight: 500; }
  /* 气泡列保留右侧留白，约占消息区 82%；短消息仍由内容决定宽度，不强制拉满。 */
  .msg-content { display: flex; flex-direction: column; align-items: flex-start;
    min-width: 0; max-width: min(82%, calc(100% - 72px)); }
  .msg.mine .msg-content { align-items: flex-end; }
  .msg-sender { max-width: 100%; margin: 0 0 4px 2px; font-size: 11px; color: var(--wx-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bubble { position: relative; max-width: 100%; padding: 9px 12px; border-radius: 4px;
    background: var(--wx-bubble); color: var(--wx-text); font-size: 14.5px; line-height: 1.5;
    white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
  .bubble::before { content: ""; position: absolute; top: 12px; width: 0; height: 0;
    border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
  .msg:not(.mine) .bubble::before { left: -6px; border-right: 6px solid var(--wx-bubble); }
  .msg.mine .bubble { background: var(--wx-mine); color: var(--wx-mine-text); }
  .msg.mine .bubble::before { right: -6px; border-left: 6px solid var(--wx-mine); }
  .mention { color: var(--wx-link); }
  .msg.mine .mention { color: #2f6b45; }
  .msg .expand { margin-top: 4px; border: 0; background: none; padding: 0;
    color: var(--wx-link); font-size: 12px; }
  .msg .expand[hidden] { display: none; }
  /* 回执紧贴消息下方，外观与上下线系统行一致。 */
  .msg.has-receipt { margin-bottom: 6px; }
  .msg-receipt { margin-top: 0; }
  .msg-receipt.stale span { color: #b26a00; }
  /* 本地发送意图：只展示状态，不进入时间线排序与未读；失败时提供重试。 */
  .msg-outbox { gap: 6px; align-items: center; flex-wrap: wrap; }
  .msg-outbox span { color: var(--wx-muted); }
  .msg-outbox button { border: 0; padding: 2px 5px; border-radius: 3px;
    background: transparent; color: var(--wx-link); font-size: 11px; cursor: pointer; }
  .msg-outbox button:hover { background: var(--wx-hover); }
  .msg-outbox .outbox-dismiss { color: var(--wx-muted); }

  .mention-picker { position: absolute; left: 16px; bottom: 74px; z-index: 5;
    min-width: 190px; max-width: min(320px, calc(100% - 32px)); max-height: 220px;
    overflow-y: auto; padding: 6px; background: var(--wx-panel);
    border: 1px solid var(--wx-line); border-radius: 8px; box-shadow: var(--wx-shadow); }
  .mention-picker[hidden] { display: none; }
  .mention-picker .list-hint { padding: 8px; }
  .mention-item { display: flex; width: 100%; align-items: center; gap: 8px;
    padding: 7px 8px; border: 0; background: none; border-radius: 4px;
    text-align: left; font-size: 13px; color: inherit; }
  .mention-item:hover, .mention-item:focus { background: var(--wx-hover); }
  .mention-kind { margin-left: auto; font-size: 11px; color: var(--wx-muted); }

  .composer { flex: 0 0 auto; display: flex; align-items: flex-end; gap: 8px;
    padding: 8px 16px calc(8px + env(safe-area-inset-bottom));
    background: var(--wx-sidebar); border-top: 1px solid var(--wx-line); }
  .composer-main { flex: 1 1 auto; min-width: 0; display: flex;
    flex-direction: column; gap: 6px; }
  .composer-main textarea { width: 100%; flex: 1 1 auto; min-width: 0; min-height: 38px; max-height: 96px;
    padding: 8px 10px; border: 1px solid var(--wx-line); border-radius: 4px;
    background: var(--wx-panel); color: var(--wx-text); font: inherit;
    font-size: 14px; line-height: 22px; resize: none; overflow-y: auto; }
  .send-btn { flex: 0 0 auto; height: 38px; min-width: 64px; padding: 0 14px;
    border: 0; border-radius: 4px; font-size: 13px; }
  #status { min-height: 0; margin: 0; font-size: 12px; color: var(--wx-unread); }
  #status:empty { display: none; }
  #status:not(:empty) { padding: 6px 16px 0; }
  /* 拖拽覆盖层只做提示；pointer-events:none 保证不阻塞聊天区操作。 */
  .composer-drop { position: absolute; inset: 8px; z-index: 6; display: grid;
    place-content: center; gap: 4px; box-sizing: border-box; padding: 16px;
    border: 2px dashed var(--wx-green); border-radius: 10px;
    background: rgb(7 193 96 / 10%); text-align: center; pointer-events: none; }
  .composer-drop[hidden] { display: none; }
  .composer-drop-title { font-size: 15px; font-weight: 600; color: var(--wx-green); }
  .composer-drop-hint { font-size: 12px; color: var(--wx-muted); }

  .empty-pane { align-items: center; justify-content: center; }
  .empty { padding: 24px; text-align: center; }
  .empty-art { position: relative; width: 92px; height: 64px; margin: 0 auto 18px; }
  .empty-bubble { position: absolute; width: 52px; height: 38px; border-radius: 10px;
    background: var(--wx-panel); box-shadow: 0 2px 8px rgb(0 0 0 / 6%); }
  .empty-bubble.left { left: 0; top: 6px; }
  .empty-bubble.right { right: 0; top: 22px; background: var(--wx-mine); }
  .empty-title { margin: 0 0 6px; font-size: 15px; color: var(--wx-text); }
  .empty-hint { margin: 0; font-size: 12px; color: var(--wx-muted); }

  .modal { position: fixed; inset: 0; z-index: 30; display: grid; place-items: center;
    padding: 16px; background: rgb(0 0 0 / 42%); }
  .modal[hidden] { display: none; }
  .modal-card { width: min(420px, 100%); max-height: min(82dvh, 680px); overflow-y: auto;
    background: var(--wx-panel); color: var(--wx-text); border-radius: 10px;
    padding: 20px; box-shadow: var(--wx-shadow); }
  .modal-card h2 { margin: 0 0 14px; font-size: 17px; font-weight: 600; }
  .field { display: block; font-size: 12px; color: var(--wx-muted); }
  .field input { display: block; width: 100%; height: 36px; margin-top: 6px; padding: 0 10px;
    border: 1px solid var(--wx-line); border-radius: 4px; background: var(--wx-bg);
    color: var(--wx-text); font: inherit; font-size: 14px; }
  .picker-label { margin: 14px 0 6px; font-size: 12px; color: var(--wx-muted); }
  .contact-list { display: flex; flex-direction: column; gap: 2px; max-height: 240px;
    overflow-y: auto; margin: 0 0 8px; }
  .members-card { width: min(680px, 100%); display: flex; flex-direction: column; }
  .members-head { flex: 0 0 auto; display: flex; align-items: center;
    justify-content: space-between; gap: 10px; margin-bottom: 12px; }
  .members-head h2 { margin: 0; }
  .members-close { flex: 0 0 auto; width: 30px; height: 30px; padding: 0;
    border: 0; background: transparent; color: var(--wx-muted);
    font-size: 20px; line-height: 1; }
  .members-close:hover { background: var(--wx-hover); color: var(--wx-text); }
  .members-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 12px; align-items: stretch; }
  .members-column { min-width: 0; display: flex; flex-direction: column;
    border: 1px solid var(--wx-line); border-radius: 8px; overflow: hidden;
    background: var(--wx-bg); }
  .members-column-head { flex: 0 0 auto; display: flex; align-items: center;
    justify-content: space-between; gap: 8px; padding: 8px 10px;
    border-bottom: 1px solid var(--wx-line); background: var(--wx-panel); }
  .members-column-head h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .members-count { flex: 0 0 auto; min-width: 22px; padding: 1px 7px;
    border-radius: 999px; background: var(--wx-search); color: var(--wx-muted);
    font-size: 11px; text-align: center; }
  .member-roster { list-style: none; margin: 0; padding: 4px;
    max-height: min(46dvh, 360px); overflow-y: auto; }
  .member-roster-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
    border-radius: 6px; font-size: 13px; }
  .member-roster-item:hover { background: var(--wx-hover); }
  .member-avatar { flex: 0 0 auto; width: 24px; height: 24px; border-radius: 5px;
    font-size: 11px; }
  .member-roster-name { min-width: 0; flex: 1 1 auto; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .member-roster-role { flex: 0 0 auto; margin-left: auto; font-size: 11px;
    color: var(--wx-muted); }
  .member-roster-actions { flex: 0 0 auto; display: flex; gap: 4px; }
  .member-menu-toggle { width: 24px; height: 24px; padding: 0; border: 1px solid var(--wx-line);
    border-radius: 4px; background: var(--wx-panel); color: var(--wx-text);
    font-size: 15px; line-height: 1; cursor: pointer; }
  .member-menu-toggle:hover:not(:disabled) { background: var(--wx-hover); }
  .member-menu-toggle:disabled { opacity: 0.5; cursor: default; }
  /* 行内只保留一个 icon；菜单固定定位并按视口夹取，避免被滚动容器裁切。 */
  .member-menu { position: fixed; z-index: 36; min-width: 132px; padding: 4px;
    border: 1px solid var(--wx-line); border-radius: 8px; background: var(--wx-panel);
    box-shadow: var(--wx-shadow); }
  .member-menu[hidden] { display: none; }
  .member-menu-item { display: block; width: 100%; padding: 6px 10px; border: 0;
    border-radius: 5px; background: transparent; color: var(--wx-text); font-size: 12px;
    line-height: 1.5; text-align: left; white-space: nowrap; cursor: pointer; }
  .member-menu-item:hover:not(:disabled), .member-menu-item:focus-visible {
    background: var(--wx-hover); }
  .member-menu-item.danger { color: var(--wx-unread); }
  .member-menu-item:disabled { opacity: 0.5; cursor: default; }
  .member-action { padding: 2px 6px; border: 1px solid var(--wx-line); border-radius: 4px;
    background: var(--wx-panel); color: var(--wx-text); font-size: 11px; line-height: 1.5; }
  .member-action:hover:not(:disabled) { background: var(--wx-hover); }
  .member-action.danger { color: var(--wx-unread); }
  .member-action:disabled { opacity: 0.5; cursor: default; }
  .members-card .contact-list { margin: 0; padding: 4px;
    max-height: min(46dvh, 360px); }
  .contact-choice { display: flex; align-items: center; gap: 9px; padding: 8px;
    border-radius: 4px; font-size: 14px; }
  .members-card .contact-choice { gap: 8px; padding: 7px 8px; font-size: 13px;
    border: 1px solid transparent; cursor: pointer; }
  .members-card .contact-avatar { flex: 0 0 auto; width: 24px; height: 24px;
    border-radius: 5px; font-size: 11px; }
  .contact-choice:hover { background: var(--wx-hover); }
  .members-card .contact-choice.selected { background: rgb(7 193 96 / 12%);
    border-color: rgb(7 193 96 / 35%); }
  .contact-choice input { flex: 0 0 auto; width: 16px; height: 16px;
    accent-color: var(--wx-green); }
  .contact-kind { flex: 0 0 auto; margin-left: auto; font-size: 11px;
    color: var(--wx-muted); }
  .members-card .contact-choice > span:not(.contact-kind) { min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .members-empty { margin: 0; padding: 18px 10px; color: var(--wx-muted);
    font-size: 12px; line-height: 1.6; text-align: center; }
  .members-empty[hidden] { display: none; }
  .members-actions { align-items: center; }
  .members-selection { margin-right: auto; font-size: 12px; color: var(--wx-muted); }
  /* 建群与添加成员共用成员选择器：搜索、分页、类型、备注与多选高亮。 */
  .member-picker-toolbar { display: flex; align-items: center; gap: 8px;
    margin: 0 0 6px; }
  .member-picker-search { flex: 1 1 auto; min-width: 0; box-sizing: border-box;
    padding: 7px 10px; border: 1px solid var(--wx-line); border-radius: 6px;
    background: var(--wx-search); color: var(--wx-text); font-size: 13px; }
  .member-picker-search:focus { outline: 2px solid rgb(7 193 96 / 35%);
    outline-offset: 1px; }
  .members-column .member-picker-search { flex: 0 0 auto; margin: 6px 8px 0; }
  .member-picker-more { flex: 0 0 auto; align-self: center; margin: 6px 0;
    padding: 4px 10px; border: 1px solid var(--wx-line); border-radius: 999px;
    background: var(--wx-panel); color: var(--wx-text); font-size: 12px; }
  .member-picker-more:hover:not(:disabled) { background: var(--wx-hover); }
  .member-picker-more[hidden] { display: none; }
  .contact-name { flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .contact-note { flex: 0 1 auto; max-width: 40%; font-size: 11px;
    color: var(--wx-muted); overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; }
  .members-transfer { flex: 0 0 auto; margin: 6px; padding: 8px 10px;
    border: 1px solid rgb(7 193 96 / 35%); border-radius: 6px;
    background: rgb(7 193 96 / 8%); }
  .members-transfer[hidden] { display: none; }
  .members-transfer-title { margin: 0 0 4px; font-size: 12px; font-weight: 600; }
  .members-transfer-line { margin: 0 0 2px; font-size: 12px; line-height: 1.5;
    overflow-wrap: anywhere; }
  .members-transfer-meta { margin: 0; font-size: 11px; color: var(--wx-muted); }
  .members-transfer-actions { display: flex; flex-wrap: wrap; gap: 6px;
    margin-top: 6px; }
  .members-invited { flex: 0 0 auto; border-top: 1px solid var(--wx-line);
    padding: 4px; }
  .members-invited-title { display: flex; align-items: center; gap: 6px;
    margin: 4px 6px; font-size: 12px; color: var(--wx-muted); }
  .member-invited-item { opacity: 0.85; }
  .member-invited-item:hover { background: transparent; }
  /* 邀请链接与入群申请：明文链接只保存在内存，列表只显示状态与次数。 */
  .members-invites, .members-requests { margin-top: 10px; border: 1px solid var(--wx-line);
    border-radius: 8px; overflow: hidden; background: var(--wx-bg); }
  .members-invites[hidden], .members-requests[hidden] { display: none; }
  .members-invite-hint { margin: 0; padding: 6px 10px; font-size: 11px;
    line-height: 1.6; color: var(--wx-muted); border-bottom: 1px solid var(--wx-line); }
  .members-invite-form { display: flex; flex-wrap: wrap; align-items: center;
    gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--wx-line); }
  .members-invite-form label { display: flex; align-items: center; gap: 4px;
    font-size: 12px; color: var(--wx-muted); }
  .members-invite-form input { width: 64px; box-sizing: border-box; padding: 4px 6px;
    border: 1px solid var(--wx-line); border-radius: 4px; background: var(--wx-search);
    color: var(--wx-text); font-size: 12px; }
  .members-invite-form button { padding: 4px 10px; border: 1px solid var(--wx-line);
    border-radius: 4px; background: var(--wx-panel); color: var(--wx-text);
    font-size: 12px; }
  .members-invite-form button:hover:not(:disabled) { background: var(--wx-hover); }
  .members-invite-form button:disabled { opacity: 0.5; cursor: default; }
  .members-invite-share { padding: 8px 10px; border-bottom: 1px solid var(--wx-line);
    background: rgb(7 193 96 / 8%); }
  .members-invite-share[hidden], .members-invite-qr[hidden] { display: none; }
  .members-invite-url { margin: 0 0 6px; font-size: 11px; line-height: 1.5;
    color: var(--wx-text); overflow-wrap: anywhere; }
  .members-invite-share .row { gap: 6px; }
  .members-invite-share button { padding: 3px 8px; border: 1px solid var(--wx-line);
    border-radius: 4px; background: var(--wx-panel); color: var(--wx-text);
    font-size: 11px; }
  .members-invite-share button:hover { background: var(--wx-hover); }
  .members-invite-qr { margin-top: 8px; text-align: center; }
  .members-invite-qr canvas { width: 160px; height: 160px; max-width: 100%;
    border-radius: 4px; background: #fff; }
  .members-invite-qr .muted { margin: 4px 0 0; font-size: 11px; }
  .members-invites .member-roster, .members-requests .member-roster {
    max-height: min(28dvh, 220px); }
  .member-invite-item .member-roster-role, .member-request-item .member-roster-role {
    flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; text-align: right; }
  .room-announcement { margin: 8px 16px 0; padding: 8px 12px; border-radius: 6px;
    border: 1px solid var(--wx-line); background: var(--wx-panel); color: var(--wx-text);
    font-size: 12px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
  .room-announcement[hidden] { display: none; }
  .room-archive-banner { margin: 8px 16px 0; padding: 8px 12px; border-radius: 6px;
    border: 1px solid #e6c36a; background: #fff8e1; color: #7a5b00;
    font-size: 12px; line-height: 1.6; }
  .room-archive-banner[hidden] { display: none; }
  .composer[hidden] { display: none; }
  .announcement-card { width: min(520px, 100%); box-sizing: border-box; }
  .announcement-input { display: block; box-sizing: border-box; width: 100%;
    min-height: 140px; padding: 8px 10px; border: 1px solid var(--wx-line);
    border-radius: 4px; background: var(--wx-bg); color: var(--wx-text);
    font: inherit; font-size: 13px; line-height: 1.6; resize: vertical; }
  .announcement-input[readonly] { color: var(--wx-muted); }
  .form-error { min-height: 1.2em; margin: 0 0 8px; color: var(--wx-unread);
    font-size: 12px; overflow-wrap: anywhere; }
  .modal-actions { justify-content: flex-end; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }

  .transfer-card { width: min(520px, 100%); box-sizing: border-box; max-height: 82vh;
    overflow: auto; }
  .transfer-section { margin: 14px 0 0; padding-top: 10px; border-top: 1px solid var(--wx-line); }
  .transfer-section h3 { margin: 0 0 8px; font-size: 14px; }
  .transfer-search { width: 100%; box-sizing: border-box; margin-bottom: 6px; }
  .transfer-list { list-style: none; margin: 6px 0 0; padding: 0; max-height: 180px;
    overflow: auto; }
  .transfer-list li { margin: 4px 0; font-size: 13px; line-height: 1.5; word-break: break-word; }
  .transfer-successor { display: flex; gap: 8px; align-items: center; cursor: pointer; }
  .transfer-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
  .transfer-actions button[hidden] { display: none; }
  .transfer-token { width: 100%; box-sizing: border-box; font-family: monospace; }
  .new-agent-card { width: min(440px, 100%); box-sizing: border-box; }
  .new-agent-card .field input { box-sizing: border-box; }
  .new-agent-warning { margin: 12px 0; padding: 8px 10px; border-radius: 4px;
    background: #fff7ed; color: #9a3412; font-size: 12px; line-height: 1.6;
    text-align: left; overflow-wrap: anywhere; }
  .new-agent-result { margin: 4px 0 12px; padding: 10px; border-radius: 6px;
    background: var(--wx-bg); border: 1px solid var(--wx-line); }
  .new-agent-result[hidden] { display: none; }
  #new-agent-url, #new-agent-share, #new-agent-skill-url {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .new-agent-copy { margin: 6px 0 12px; }
  .new-agent-hint { margin: 0; font-size: 12px; color: var(--wx-muted); line-height: 1.6; }
  .new-agent-prompt { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--wx-line); }
  .new-agent-prompt .new-agent-warning { margin: 0 0 10px; }
  .new-agent-prompt-text { display: block; box-sizing: border-box; width: 100%;
    min-height: 168px; max-height: 320px; margin-top: 6px; padding: 8px 10px;
    border: 1px solid var(--wx-line); border-radius: 4px; background: var(--wx-bg);
    color: var(--wx-text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
    word-break: break-all; resize: vertical; }
  @media (prefers-color-scheme: dark) {
    .new-agent-warning { background: #3a2a1a; color: #fdba74; }
  }

  .messages::-webkit-scrollbar, .sidebar-list::-webkit-scrollbar,
  .mention-picker::-webkit-scrollbar, .contact-list::-webkit-scrollbar,
  .member-roster::-webkit-scrollbar { width: 6px; }
  .messages::-webkit-scrollbar-thumb, .sidebar-list::-webkit-scrollbar-thumb,
  .mention-picker::-webkit-scrollbar-thumb, .contact-list::-webkit-scrollbar-thumb,
  .member-roster::-webkit-scrollbar-thumb {
    background: rgb(0 0 0 / 14%); border-radius: 3px; }
  @media (prefers-color-scheme: dark) {
    .messages::-webkit-scrollbar-thumb, .sidebar-list::-webkit-scrollbar-thumb,
    .mention-picker::-webkit-scrollbar-thumb, .contact-list::-webkit-scrollbar-thumb,
    .member-roster::-webkit-scrollbar-thumb {
      background: rgb(255 255 255 / 16%); }
    .msg-time span { background: rgb(255 255 255 / 7%); }
    .msg-system span { background: rgb(255 255 255 / 7%); }
    .msg-receipt.stale span { color: #e0a458; }
  }

  @media (min-width: 1200px) {
    /* 文件/监控面板打开时显示分隔条；没有右栏、平板抽屉与移动端都不显示。 */
    body.page-room:has(#files-pane:not([hidden]), #monitor-pane:not([hidden])) .pane-resizer {
      display: block;
    }
  }

  @media (max-width: 759px) {
    .sidebar { flex: 0 0 100%; width: 100%; max-width: none; min-width: 0;
      border-right: 0; }
    .chat-pane { width: 100%; }
    body.page-home .chat-pane { display: none; }
    body.page-room .sidebar { display: none; }
    body.page-room .back { display: inline-flex; }
    .sidebar-head { padding: calc(10px + env(safe-area-inset-top)) 12px 8px; }
    /* 窄屏头部允许换行：标题行保留可点击宽度，操作按钮落到第二行，
       避免标题内的按钮溢出后被右侧图标按钮覆盖。 */
    .chat-head { flex-wrap: wrap; row-gap: 4px;
      min-height: calc(56px + env(safe-area-inset-top));
      padding-top: calc(6px + env(safe-area-inset-top));
      padding-bottom: 6px; }
    .chat-id { flex: 1 1 160px; min-width: 160px; }
    .messages { padding: 10px 12px 14px; }
    .jump-latest { bottom: calc(64px + env(safe-area-inset-bottom)); }
    .composer { padding: 8px 10px calc(8px + env(safe-area-inset-bottom)); }
    .composer textarea { font-size: 16px; }
    .composer-drop { inset: 6px; }
    .mention-picker { left: 10px; bottom: 64px; }
    /* 双栏添加成员在窄屏压缩间距与头像，仍保持左右可读且不横向溢出。 */
    .members-card { padding: 14px; }
    .members-columns { gap: 8px; }
    .members-column-head { padding: 6px 8px; }
    .members-column-head h3 { font-size: 12px; }
    .members-card .contact-list, .members-card .member-roster {
      max-height: min(50dvh, 320px); }
    .members-card .contact-avatar, .members-card .member-avatar {
      width: 22px; height: 22px; }
    .members-card .contact-choice, .members-card .member-roster-item {
      gap: 6px; padding: 6px; }
    .members-card .contact-kind { display: none; }
    .members-card .contact-note { max-width: 34%; font-size: 10px; }
    .members-card .member-picker-search { font-size: 12px; }
    .members-card .member-roster-role { font-size: 10px; }
    .members-actions { gap: 8px; }
    .members-selection { flex: 1 1 100%; margin-right: 0; }
    /* 移动端浮层占满头部下方宽度，避免横向溢出；点击展开、Esc/外部关闭。 */
    .task-popover { left: 8px; right: 8px; width: auto; max-height: 50vh; }
  }

  /* 好友申请入口与弹窗；单侧收藏不在群成员候选里，这里只处理双向关系。 */
  #contact-requests { position: relative; }
  .request-badge { position: absolute; top: -5px; right: -5px; min-width: 16px;
    height: 16px; padding: 0 4px; border-radius: 8px; background: var(--wx-unread);
    color: #ffffff; font-size: 10px; line-height: 16px; text-align: center;
    pointer-events: none; }
  .contact-policy { margin: 10px 0 12px; padding: 10px; border: 1px solid var(--wx-line);
    border-radius: 10px; background: var(--wx-sidebar); }
  .contact-policy .field { margin: 0; }
  .contact-request-list { list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; gap: 8px; max-height: 45vh; overflow: auto; }
  .contact-request-item { display: flex; justify-content: space-between; gap: 10px;
    padding: 10px; border: 1px solid var(--wx-line); border-radius: 10px; }
  .contact-request-main { min-width: 0; }
  .contact-request-title { margin: 0; font-weight: 600; }
  .contact-request-message { margin: 4px 0 0; color: var(--wx-muted); font-size: 13px;
    word-break: break-word; }
  .contact-request-meta { margin: 4px 0 0; font-size: 12px; color: var(--wx-muted); }
  .contact-request-actions { display: flex; flex: 0 0 auto; gap: 6px; align-items: flex-start; }
  .contact-request-empty { padding: 12px 0; color: var(--wx-muted); font-size: 13px; }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-avatar, .skeleton-lines span, .skeleton-bubble { animation: none; }
    .chat-loading::after { animation: none; width: 100%; }
    #older[aria-busy="true"]::before { animation: none; }
  }
`;
