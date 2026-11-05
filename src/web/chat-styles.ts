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
  .search-box { position: relative; display: block; }
  .search-icon { position: absolute; left: 8px; top: 50%; width: 15px; height: 15px;
    transform: translateY(-50%); fill: none; stroke: var(--wx-muted); stroke-width: 1.8;
    pointer-events: none; }
  #room-search { width: 100%; height: 30px; padding: 0 10px 0 28px; border: 0;
    border-radius: 4px; background: var(--wx-search); color: var(--wx-text);
    font: inherit; font-size: 13px; }
  #room-search::placeholder { color: var(--wx-muted); }
  #room-search::-webkit-search-cancel-button { -webkit-appearance: none; }

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
  .room-preview { margin-top: 3px; font-size: 12px; color: var(--wx-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* 会话右键/长按菜单：固定定位，靠近指针并限制在视口内。 */
  .room-menu { position: fixed; z-index: 26; min-width: 208px;
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
  /* Agent 在线状态点：与未读点分居右下/右上，人类会话不渲染。 */
  .presence-dot { position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px;
    border-radius: 50%; box-sizing: content-box; background: var(--wx-muted);
    border: 2px solid var(--wx-sidebar); }
  .presence-dot.online { background: var(--wx-green); }
  .presence-dot.offline { background: var(--wx-muted); }
  .presence-dot.unknown { background: transparent; border-color: var(--wx-muted); }
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

  .sidebar-foot { flex: 0 0 auto; padding: 8px 12px calc(10px + env(safe-area-inset-bottom));
    border-top: 1px solid var(--wx-line); background: var(--wx-sidebar); }
  .service-info { margin-top: 4px; font-size: 11px; color: var(--wx-muted); }
  .service-info summary { cursor: pointer; }
  .service-info p { margin: 5px 0 0; }
  .service-info code { font-size: 11px; }

  .chat-pane { flex: 1 1 auto; min-width: 0; min-height: 0; display: flex;
    flex-direction: column; background: var(--wx-bg); }
  /* 壳同时包含空状态与聊天面板，由 body class 决定桌面端显示哪一个。 */
  body.page-home .chat-pane:not(.empty-pane) { display: none; }
  body.page-room .empty-pane { display: none; }
  .chat-head { flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    min-height: 56px; padding: 0 16px; background: var(--wx-sidebar);
    border-bottom: 1px solid var(--wx-line); }
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
  .rename-form { flex: 0 0 auto; display: flex; align-items: center; gap: 6px;
    padding: 8px 12px; background: var(--wx-sidebar); border-bottom: 1px solid var(--wx-line); }
  .rename-form[hidden] { display: none; }
  .rename-form input { flex: 1 1 auto; min-width: 0; height: 32px; padding: 0 10px;
    border: 1px solid var(--wx-line); border-radius: 4px; background: var(--wx-panel);
    color: var(--wx-text); font: inherit; font-size: 13px; }

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
  /* 固定在聊天区顶部，不随消息滚动；显示时给消息区留出顶部空间。 */
  #older { position: absolute; top: 8px; left: 50%; z-index: 4;
    transform: translateX(-50%); margin: 0; padding: 4px 12px;
    border: 1px solid var(--wx-line); border-radius: 999px;
    background: var(--wx-panel); color: var(--wx-link); font-size: 11px;
    box-shadow: var(--wx-shadow); white-space: nowrap; }
  #older[hidden] { display: none; }
  #older:not([hidden]) ~ .messages { padding-top: 40px; }
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
  .msg-content { display: flex; flex-direction: column; align-items: flex-start;
    min-width: 0; max-width: min(60%, 560px); }
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
  /* 回执紧贴消息下方，外观与上下线系统行一致。 */
  .msg.has-receipt { margin-bottom: 6px; }
  .msg-receipt { margin-top: 0; }
  .msg-receipt.stale span { color: #b26a00; }

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
  .composer textarea { flex: 1 1 auto; min-width: 0; min-height: 38px; max-height: 96px;
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
  .member-roster { list-style: none; margin: 0 0 8px; padding: 0;
    max-height: 180px; overflow-y: auto; }
  .member-roster-item { display: flex; align-items: center; gap: 8px; padding: 6px 8px;
    border-radius: 4px; font-size: 14px; }
  .member-roster-item + .member-roster-item { border-top: 1px solid var(--wx-line); }
  .member-roster-name { min-width: 0; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap; }
  .member-roster-role { flex: 0 0 auto; margin-left: auto; font-size: 11px;
    color: var(--wx-muted); }
  .contact-choice { display: flex; align-items: center; gap: 9px; padding: 8px;
    border-radius: 4px; font-size: 14px; }
  .contact-choice:hover { background: var(--wx-hover); }
  .contact-choice input { width: 16px; height: 16px; accent-color: var(--wx-green); }
  .contact-kind { margin-left: auto; font-size: 11px; color: var(--wx-muted); }
  .form-error { min-height: 1.2em; margin: 0 0 8px; color: var(--wx-unread);
    font-size: 12px; overflow-wrap: anywhere; }
  .modal-actions { justify-content: flex-end; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }

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

  @media (max-width: 759px) {
    .sidebar { flex: 0 0 100%; width: 100%; max-width: none; min-width: 0;
      border-right: 0; }
    .chat-pane { width: 100%; }
    body.page-home .chat-pane { display: none; }
    body.page-room .sidebar { display: none; }
    body.page-room .back { display: inline-flex; }
    .sidebar-head { padding: calc(10px + env(safe-area-inset-top)) 12px 8px; }
    .chat-head { min-height: calc(56px + env(safe-area-inset-top));
      padding-top: env(safe-area-inset-top); }
    .messages { padding: 10px 12px 14px; }
    .jump-latest { bottom: calc(64px + env(safe-area-inset-bottom)); }
    .msg-content { max-width: 74%; }
    .composer { padding: 8px 10px calc(8px + env(safe-area-inset-bottom)); }
    .composer textarea { font-size: 16px; }
    .composer-drop { inset: 6px; }
    .mention-picker { left: 10px; bottom: 64px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-avatar, .skeleton-lines span, .skeleton-bubble { animation: none; }
    .chat-loading::after { animation: none; width: 100%; }
  }
`;
