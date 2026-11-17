export const MESSAGE_ACTIONS_STYLE = `
  .message-action-menu { position: fixed; z-index: var(--app-z-message-menu); min-width: 140px; padding: 6px;
    background: var(--wx-panel); color: var(--wx-text); border: 1px solid var(--wx-line);
    border-radius: 8px; box-shadow: var(--lenso-surface-shadow); }
  .message-action-menu button { min-height: 40px; }
  .message-actions-trigger { display: inline-flex; align-items: center; justify-content: center;
    min-width: 32px; min-height: 24px; color: var(--wx-muted); background: transparent;
    border: 0; cursor: pointer; padding: 0 8px; }
  .message-actions-trigger:focus-visible, .message-actions-trigger:hover { background: var(--wx-hover); }
  .message-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
  .message-actions button, .reply-reference { border: 0; background: transparent;
    color: var(--wx-muted); cursor: pointer; font: inherit; font-size: 12px; padding: 5px 8px; }
  .message-actions button:hover, .message-actions button:focus-visible { background: var(--wx-hover); }
  .reply-reference { box-sizing: border-box; display: -webkit-box; max-width: 100%;
    margin: 6px 0 0; padding: 4px 8px; text-align: left; overflow: hidden;
    text-overflow: ellipsis; overflow-wrap: anywhere; -webkit-box-orient: vertical;
    -webkit-line-clamp: 2; border-left: 3px solid var(--wx-line); border-radius: 4px;
    background: var(--wx-hover); color: var(--wx-muted); }
  .reply-reference:hover, .reply-reference:focus-visible {
    background: var(--wx-active); color: var(--wx-text); }
  .composer-reply { display: flex; align-items: center; gap: 8px; padding: 6px 12px;
    box-sizing: border-box; width: 100%; background: var(--lenso-control-fill);
    border: 1px solid var(--lenso-separator); border-radius: var(--lenso-shape-content-2xl);
    font-size: 12px; }
  .composer-reply[hidden] { display: none; }
  .composer-reply span { flex: 1; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .composer-reply button { position: relative; min-width: 44px; min-height: 36px;
    border: 0; background: transparent; color: inherit; cursor: pointer; }
  .composer-reply button::after { content: ""; position: absolute; left: 50%; top: 50%;
    width: 44px; height: 44px; transform: translate(-50%, -50%); }
  .forward-modal { width: min(480px, calc(100vw - 32px)); max-height: 80dvh;
    overflow: auto; border: 1px solid var(--wx-line); border-radius: 12px;
    color: var(--wx-text); background: var(--wx-chat-bg, var(--wx-panel)); }
  .forward-modal::backdrop { background: var(--lenso-scrim); }
  .forward-modal h2 { font-size: 16px; }
  .forward-modal input { width: 100%; box-sizing: border-box; padding: 10px; }
  .forward-rooms { display: grid; gap: 6px; margin: 12px 0; }
  .forward-rooms button { justify-content: flex-start; text-align: left; min-height: 44px; overflow-wrap: anywhere; }
  .forward-preview { max-height: 120px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .forward-modal footer { display: flex; gap: 8px; justify-content: flex-end; }
  .room-preference-hint { color: var(--wx-muted); font-size: 11px; padding: 4px 12px; margin: 0; }
  @media (max-width: 759px) { .message-actions-trigger { min-width: 44px; min-height: 44px; } .message-actions button, .reply-reference { min-height: 44px; }
    .message-actions { gap: 0; } }
`;
