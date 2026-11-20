/** 群头部置顶区；与公告并存，不进入消息流，也不改变时间线顺序。 */
export const MODERATION_STYLE = `
  .pinned-messages { flex: 0 0 auto; padding: 2px 12px 4px;
    background: var(--wx-sidebar); border-bottom: 1px solid var(--wx-line); }
  .pinned-head { display: flex; align-items: center; gap: 6px; min-height: 26px; }
  .pinned-title { font-size: 11px; font-weight: 600; color: var(--wx-muted); }
  .pinned-count { min-width: 16px; padding: 0 5px; border-radius: 999px;
    background: var(--wx-search); color: var(--wx-muted); font-size: 10px;
    line-height: 16px; text-align: center; }
  .pinned-toggle { position: relative; margin-left: auto; padding: 2px 6px;
    border: 0; background: none; color: var(--wx-link); font-size: 11px; line-height: 1.4;
    cursor: pointer; }
  .pinned-toggle:hover { background: var(--wx-hover); }
  .pinned-toggle::after { content: ""; position: absolute; left: 0; right: 0;
    top: 50%; height: 44px; transform: translateY(-50%); }
  .pinned-list { list-style: none; margin: 0; padding: 0;
    display: flex; flex-direction: column; }
  .pinned-list[hidden] { display: none; }
  .pinned-item { display: flex; align-items: center; gap: 4px; min-width: 0; }
  .pinned-locate { flex: 1 1 auto; min-width: 0; display: flex; align-items: baseline;
    gap: 6px; padding: 4px 6px; border: 0; border-radius: 4px; background: none;
    color: var(--wx-text); font: inherit; font-size: 12px; line-height: 20px;
    text-align: left; cursor: pointer; }
  .pinned-locate:hover { background: var(--wx-hover); }
  .pinned-sender { flex: 0 1 auto; max-width: 34%; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; color: var(--wx-muted); }
  .pinned-preview { flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .pinned-time { flex: 0 0 auto; color: var(--wx-muted); font-size: 11px; }
  .pinned-unpin { flex: 0 0 auto; padding: 3px 8px; border: 0; border-radius: 4px;
    background: none; color: var(--wx-link); font-size: 11px; line-height: 18px;
    cursor: pointer; }
  .pinned-unpin:hover:not(:disabled) { background: var(--wx-hover); }
  .pinned-unpin:disabled { opacity: .55; cursor: not-allowed; }
  /* 暗色沿用 Lenso 语义变量；置顶区不需要单独覆盖颜色。 */
  @media (max-width: 759px) {
    .pinned-messages { padding: 0 8px 2px; }
    .pinned-head { min-height: 34px; }
    /* 触摸目标至少 44px；行高变高时隐藏置顶时间，优先保留发送者与预览。 */
    .pinned-locate, .pinned-unpin { min-height: 44px; }
    .pinned-locate { padding: 8px 6px; }
    .pinned-unpin { padding: 8px; }
    .pinned-time { font-size: 10px; }
    .pinned-sender { max-width: 32%; }
  }
`;
