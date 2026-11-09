/** Mobile touch targets and full-name visibility for high-use IM flows. */
export const MOBILE_UX_STYLE = `
  /* 建群选择器在桌面和手机都允许长姓名换行；内容列不被固定行高裁切。 */
  #group-contacts .contact-choice {
    display: grid; grid-template-columns: 18px 22px minmax(0, 1fr);
    grid-template-areas: "check avatar name" ". . note";
    align-items: start; gap: 3px 6px; min-height: 44px;
  }
  #group-contacts .contact-choice > input {
    grid-area: check; width: 18px; height: 18px; margin: 2px 0 0;
  }
  #group-contacts .contact-choice > .contact-avatar { grid-area: avatar; align-self: start; }
  #group-contacts .contact-choice > .contact-name {
    grid-area: name; align-self: center; min-width: 0; max-width: none;
    overflow: visible; text-overflow: clip; white-space: normal;
    overflow-wrap: anywhere; line-height: 1.35;
  }
  #group-contacts .contact-choice > .contact-note {
    grid-area: note; min-width: 0; max-width: none; margin: 0;
    overflow: visible; text-overflow: clip; white-space: normal;
    overflow-wrap: anywhere; line-height: 1.3;
  }

  @media (max-width: 759px) {
    /* 群管理动作是常用的触控入口，确保文本本身有完整的 44px 点击高度。 */
    #add-members:not([hidden]), #room-announcement-edit:not([hidden]) {
      min-width: 44px; min-height: 44px; padding: 0 10px; border-radius: 8px;
      display: inline-flex; align-items: center; justify-content: center;
    }

    /* 成员候选卡片用姓名和备注两行布局；窄屏下名字完整换行，不靠 hover 才可读。 */
    .members-card .contact-choice {
      display: grid; grid-template-columns: 18px 22px minmax(0, 1fr);
      grid-template-areas: "check avatar name" ". . note";
      align-items: start; gap: 3px 6px; min-height: 44px;
    }
    .members-card .contact-choice > input {
      grid-area: check; width: 18px; height: 18px; margin: 2px 0 0;
    }
    .members-card .contact-choice > .contact-avatar {
      grid-area: avatar; align-self: start;
    }
    #members-contacts .contact-choice > .contact-name {
      grid-area: name; align-self: center; min-width: 0; max-width: none;
      overflow: visible; text-overflow: clip; white-space: normal;
      overflow-wrap: anywhere; line-height: 1.35;
    }
    #members-contacts .contact-choice > .contact-note {
      grid-area: note; min-width: 0; max-width: none; margin: 0;
      overflow: visible; text-overflow: clip; white-space: normal;
      overflow-wrap: anywhere; line-height: 1.3;
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
