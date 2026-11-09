export const MESSAGE_ACTIONS_STYLE = `
  .message-action-menu { position: fixed; z-index: 100; min-width: 140px; padding: 6px;
    background: var(--wx-panel); color: var(--wx-text); border: 1px solid var(--wx-line);
    border-radius: 8px; box-shadow: 0 6px 24px #0003; }
  .message-action-menu button { min-height: 40px; }
  .message-actions-trigger { display: inline-flex; align-items: center; justify-content: center;
    min-width: 32px; min-height: 24px; color: var(--wx-muted); background: transparent;
    border: 0; cursor: pointer; padding: 0 8px; }
  .message-actions-trigger:focus-visible, .message-actions-trigger:hover { background: var(--wx-hover); }
  .message-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .message-actions button, .reply-reference { border: 0; background: transparent;
    color: var(--wx-muted); cursor: pointer; font: inherit; font-size: 12px; padding: 5px 8px; }
  .message-actions button:hover, .message-actions button:focus-visible { background: var(--wx-hover); }
  .reply-reference { display: block; text-align: left; border-left: 3px solid var(--wx-line);
    margin: 6px 0 0; overflow-wrap: anywhere; }
  .composer-reply { display: flex; align-items: center; gap: 8px; padding: 6px 12px;
    background: var(--wx-hover); border-radius: 6px; font-size: 12px; }
  .composer-reply[hidden] { display: none; }
  .composer-reply span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .composer-reply button { min-width: 44px; min-height: 36px; border: 0;
    background: transparent; color: inherit; cursor: pointer; }
  .forward-modal { width: min(480px, calc(100vw - 32px)); max-height: 80dvh;
    overflow: auto; border: 1px solid var(--wx-line); border-radius: 12px;
    color: var(--wx-text); background: var(--wx-chat-bg, var(--wx-panel)); }
  .forward-modal::backdrop { background: #0006; }
  .forward-modal h2 { font-size: 16px; }
  .forward-modal input { width: 100%; box-sizing: border-box; padding: 10px; }
  .forward-rooms { display: grid; gap: 6px; margin: 12px 0; }
  .forward-rooms button { text-align: left; min-height: 44px; overflow-wrap: anywhere; }
  .forward-preview { max-height: 120px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .forward-modal footer { display: flex; gap: 8px; justify-content: flex-end; }
  .room-preference-hint { color: var(--wx-muted); font-size: 11px; padding: 4px 12px; margin: 0; }
  .unread.muted { background: var(--wx-muted); }
  .room-pref-label { font-size: 10px; color: var(--wx-muted); margin-inline: 4px; white-space: nowrap; }
  @media (max-width: 759px) { .message-actions-trigger { min-width: 44px; min-height: 44px; } .message-actions button, .reply-reference { min-height: 44px; }
    .message-actions { gap: 0; } }
`;
