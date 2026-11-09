/**
 * AI 消息 Markdown 样式。
 *
 * 不引入 Tailwind，全部使用 APP_STYLE 的微信风 CSS 变量；只覆盖气泡内
 * 的标题、列表、代码、表格、引用与链接，文件卡片仍在气泡外沿用原样式。
 * 移动端表格与代码块内部横向滚动，不撑破页面。
 */
export const MARKDOWN_STYLE = `
  .msg-markdown { display: block; width: 100%; max-width: 100%; min-width: 0;
    white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
  .msg-markdown > :first-child, .msg-markdown > div > :first-child { margin-top: 0; }
  .msg-markdown > :last-child, .msg-markdown > div > :last-child { margin-bottom: 0; }
  .msg-markdown p { margin: 0 0 8px; }
  .msg-markdown p:last-child { margin-bottom: 0; }
  .msg-markdown ul, .msg-markdown ol { margin: 0 0 8px; padding-left: 22px; }
  .msg-markdown li { margin: 0 0 3px; }
  .msg-markdown li > p { margin: 0; }
  .msg-markdown h1, .msg-markdown h2, .msg-markdown h3,
  .msg-markdown h4, .msg-markdown h5, .msg-markdown h6 {
    margin: 12px 0 6px; font-weight: 600; line-height: 1.35; }
  .msg-markdown h1 { font-size: 18px; }
  .msg-markdown h2 { font-size: 17px; }
  .msg-markdown h3 { font-size: 16px; }
  .msg-markdown h4, .msg-markdown h5, .msg-markdown h6 { font-size: 15px; }
  .msg-markdown blockquote { margin: 8px 0; padding: 2px 0 2px 10px;
    border-left: 3px solid var(--wx-line); color: var(--wx-muted); }
  .msg-markdown hr { margin: 12px 0; border: 0; border-top: 1px solid var(--wx-line); }
  .msg-markdown a { color: var(--wx-link); text-decoration: underline;
    text-underline-offset: 2px; }
  .msg.mine .msg-markdown a { color: #2f6b45; }
  .msg-markdown .md-link-blocked { color: inherit; text-decoration: line-through; }
  .msg-markdown .mention { color: var(--wx-link); font-weight: 500; }
  .msg.mine .msg-markdown .mention { color: #2f6b45; }
  .msg-markdown code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px; }
  .msg-markdown .md-code-inline { padding: 1px 4px; border-radius: 3px;
    background: var(--wx-search); color: var(--wx-text); white-space: pre-wrap;
    overflow-wrap: anywhere; }
  .msg-markdown .md-pre { box-sizing: border-box; max-width: 100%; margin: 8px 0;
    padding: 8px 10px; border-radius: 6px; background: var(--wx-search);
    overflow-x: auto; overflow-y: hidden; white-space: pre; overscroll-behavior-x: contain; }
  .msg-markdown .md-pre .md-code { display: block; min-width: max-content;
    padding: 0; background: none; color: var(--wx-text); white-space: pre; }
  .msg-markdown .md-table-wrap { box-sizing: border-box; width: 100%; max-width: 100%;
    margin: 8px 0; overflow-x: auto; -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain; }
  .msg-markdown .md-table { border-collapse: collapse; min-width: max-content;
    max-width: none; font-size: 13px; }
  .msg-markdown .md-table th, .msg-markdown .md-table td {
    padding: 5px 8px; border: 1px solid var(--wx-line); text-align: left;
    vertical-align: top; white-space: normal; overflow-wrap: anywhere; }
  .msg-markdown .md-table th { background: var(--wx-search); font-weight: 600; }
  .msg-markdown .md-table tr:nth-child(even) td { background: rgb(0 0 0 / 2%); }
  .msg-markdown .md-fallback { white-space: pre-wrap; overflow-wrap: anywhere; }
  .msg-markdown .md-fallback-note, .bubble .md-unavailable {
    display: block; margin-top: 4px; font-size: 11px; line-height: 1.4;
    color: var(--wx-muted); font-weight: 400; font-style: normal; }

  /* 大段 base64：紧凑区块，默认 3 行预览 + 渐隐；展开后限高滚动。 */
  .msg-base64 { box-sizing: border-box; max-width: 100%; margin: 8px 0;
    border: 1px solid var(--wx-line); border-radius: 8px; background: var(--wx-search);
    overflow: hidden; white-space: normal; }
  .msg-markdown .msg-base64 { width: 100%; }
  .msg-base64-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    border-bottom: 1px solid var(--wx-line); font-size: 12px; line-height: 1.4;
    color: var(--wx-muted); }
  .msg-base64-title { flex: 1 1 auto; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
  .msg-base64-actions { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; }
  .msg-base64-actions button { border: 0; background: none; padding: 0; cursor: pointer;
    color: var(--wx-link); font: inherit; font-size: 12px; line-height: 1.4; }
  .msg-base64-actions button:hover { text-decoration: underline; }
  .msg-base64-status { font-size: 11px; color: var(--wx-muted); }
  .msg-base64-body { position: relative; box-sizing: border-box; padding: 8px 10px;
    max-height: calc(18px * 3 + 16px); overflow: hidden; }
  .msg-base64-body pre { margin: 0; padding: 0; background: none; color: var(--wx-text);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12.5px; line-height: 18px; white-space: pre-wrap;
    overflow-wrap: anywhere; word-break: break-word; }
  .msg-base64-body::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0;
    height: 24px; pointer-events: none;
    background: linear-gradient(to bottom, transparent, var(--wx-search)); }
  .msg-base64.is-expanded .msg-base64-body { max-height: 240px; overflow: auto;
    overscroll-behavior: contain; }
  .msg-base64.is-expanded .msg-base64-body::after { display: none; }

  @media (prefers-color-scheme: dark) {
    .msg-markdown .md-table tr:nth-child(even) td { background: rgb(255 255 255 / 3%); }
  }

  @media (max-width: 759px) {
    .msg-markdown .md-pre { max-width: 100%; }
    .msg-markdown .md-table-wrap { max-width: 100%; }
  }
`;
