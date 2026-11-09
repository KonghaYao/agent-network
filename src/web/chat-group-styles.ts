/** Group settings and shared member-picker styles, inserted before responsive overrides. */
export const GROUP_STYLE = `
  .members-card { width: min(680px, 100%); display: flex; flex-direction: column;
    overflow: hidden; }
  #members-form { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
  .members-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  #members-form > .form-error { flex: 0 0 auto; margin-top: 8px; }
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
  .member-roster-item[hidden] { display: none; }
  .members-actions { flex: 0 0 auto; align-items: center; }
  #group-leave, #group-dissolve { color: var(--wx-danger); margin-right: auto; }
  .group-profile { flex: 0 0 auto; margin-bottom: 12px; }
  .group-profile label { font-size: 12px; color: var(--wx-muted); }
  #group-name-input { flex: 1; min-width: 0; width: 100%; padding: 7px 10px;
    border: 1px solid var(--wx-line); border-radius: 6px;
    background: var(--wx-search); color: var(--wx-text); }
  #group-profile-status { margin: 4px 0; font-size: 12px; color: var(--wx-muted); }
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
`;
