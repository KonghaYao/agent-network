/** Mobile touch targets and full-name visibility for high-use IM flows. */
export const MOBILE_UX_STYLE = `
  /* 建群与添加成员共用选择器：固定列布局，头像不再被全局 .avatar 的 40px 撑破。 */
  #group-contacts .contact-choice,
  #members-contacts .contact-choice {
    display: grid; grid-template-columns: 18px 22px minmax(0, 1fr) auto;
    grid-template-areas: "check avatar name kind" ". . note .";
    align-items: start; gap: 3px 6px; min-height: 44px;
  }
  #group-contacts .contact-choice > input,
  #members-contacts .contact-choice > input {
    grid-area: check; width: 18px; height: 18px; margin: 2px 0 0;
  }
  #group-contacts .contact-choice > .contact-avatar,
  #members-contacts .contact-choice > .contact-avatar {
    grid-area: avatar; align-self: start;
    width: 22px; height: 22px; font-size: 10px; line-height: 1;
  }
  #group-contacts .contact-choice > .contact-name,
  #members-contacts .contact-choice > .contact-name {
    grid-area: name; align-self: center; min-width: 0; max-width: none;
    overflow: visible; text-overflow: clip; white-space: normal;
    overflow-wrap: anywhere; line-height: 1.35;
  }
  #group-contacts .contact-choice > .contact-note,
  #members-contacts .contact-choice > .contact-note {
    grid-area: note; min-width: 0; max-width: none; margin: 0;
    overflow: visible; text-overflow: clip; white-space: normal;
    overflow-wrap: anywhere; line-height: 1.3;
  }
  #group-contacts .contact-choice > .contact-kind,
  #members-contacts .contact-choice > .contact-kind {
    grid-area: kind; align-self: center; justify-self: end;
    margin-left: 0; white-space: nowrap;
  }

  @media (max-width: 759px) {
    .brand-row .icon-btn { width: 44px; height: 44px; }
    #room-search { height: 44px; font-size: 16px; }
    .room-filter button { height: 44px; font-size: 13px; }

    .chat-head { align-content: center; }
    .chat-id { flex: 1 1 calc(100% - 52px); min-width: 0; }
    .chat-head-actions { flex: 1 1 100%; justify-content: flex-end;
      flex-wrap: wrap; gap: 2px; }
    .back { width: 44px; height: 44px; }
    .copy-group-info { width: 44px; height: 44px; }
    .monitor-toggle { height: 44px; }
    .files-toggle { height: 44px; }
    .send-btn, .attach-btn { min-width: 44px; min-height: 44px; }
    .composer-main textarea { min-height: 44px; }

    #group-modal { padding: 0; place-items: stretch; }
    #group-modal .modal-card { width: 100%; height: 100dvh; max-height: 100dvh;
      border-radius: 0; display: flex; flex-direction: column;
      padding: calc(16px + env(safe-area-inset-top)) 16px
        calc(16px + env(safe-area-inset-bottom)); }
    #group-form { display: flex; flex: 1 1 auto; min-height: 0; flex-direction: column; }
    #group-contacts { flex: 1 1 auto; min-height: 0; max-height: none; }
    #group-form .modal-actions { flex: 0 0 auto; }

    #members-modal { padding: 0; place-items: stretch; }
    #members-modal .members-card { width: 100%; height: 100dvh; max-height: 100dvh;
      border-radius: 0; padding: calc(12px + env(safe-area-inset-top)) 14px
        calc(12px + env(safe-area-inset-bottom)); }
    .members-columns { grid-template-columns: minmax(0, 1fr); }
    .members-card .contact-list, .members-card .member-roster {
      max-height: min(24dvh, 200px); }
    .members-card .contact-note { max-width: none; }
    .members-head { margin-bottom: 8px; }
    .members-close, .member-menu-toggle { width: 44px; height: 44px; }
    .member-picker-search, .group-profile input, .group-profile button,
    .members-actions button, #group-modal .field input, #group-form .modal-actions button {
      min-height: 44px; }
    .member-picker-search, .members-card .member-picker-search,
    .group-profile input, #group-modal .field input { font-size: 16px; }
    .members-actions { margin-top: auto; }

    .modal-actions button, .contact-search-controls button, .contact-link-actions button,
    .contact-search-confirm-actions button { min-height: 44px; }
    .field input, .field select, .field textarea,
    .contact-search-controls input, .contact-search-confirm textarea,
    .contact-policy-field select { min-height: 44px; font-size: 16px; }
    .contact-modal-card { padding: calc(16px + env(safe-area-inset-top)) 16px
      calc(16px + env(safe-area-inset-bottom)); }
    .files-head-actions button { min-width: 44px; min-height: 44px; }
    .files-drop { min-height: 44px; }
    .monitor-toolbar { flex-wrap: wrap; }
    #monitor-url { flex: 1 1 100%; height: 44px; font-size: 16px; }
    .monitor-actions { width: 100%; justify-content: flex-end; gap: 4px; }
    .monitor-icon { width: 44px; height: 44px; }

    /* 群管理动作是常用的触控入口，确保文本本身有完整的 44px 点击高度。 */
    #add-members:not([hidden]), #room-announcement-edit:not([hidden]) {
      min-width: 44px; min-height: 44px; padding: 0 10px; border-radius: 8px;
      display: inline-flex; align-items: center; justify-content: center;
    }

    /* 已在群成员的姓名同样完整显示，角色和行内菜单留在右侧独立列。 */
    .members-card .member-roster-item {
      display: grid; grid-template-columns: 24px minmax(0, 1fr) auto;
      grid-template-areas: "avatar name actions" ". role actions";
      align-items: start; gap: 3px 6px;
    }
    .members-card .member-roster-item > .member-avatar { grid-area: avatar; }
    .members-card .member-roster-item > .member-roster-name {
      grid-area: name; min-width: 0; overflow: visible; text-overflow: clip;
      white-space: normal; overflow-wrap: anywhere; line-height: 1.35;
    }
    .members-card .member-roster-item > .member-roster-role {
      grid-area: role; margin: 0; white-space: normal;
    }
    .members-card .member-roster-item > .member-roster-actions {
      grid-area: actions; align-self: center;
    }
  }
`;
