/**
 * 右侧面板拖拽岛的 vanilla 桥接层。
 *
 * 页面外壳、文件面板、网页监控仍是 vanilla；这里只动态导入独立
 * `/assets/chat-resizer.js`，把 React root 挂到分隔条容器上。
 * 加载失败时保留 CSS 默认 50/50，不影响聊天、文件或监控。
 */
export const CHAT_RESIZER_SCRIPT = `
let resizerLoadStarted = false;

function mountPaneResizer() {
  const host = document.getElementById('pane-resizer');
  if (!host || resizerLoadStarted) return;
  resizerLoadStarted = true;
  import(RESIZER_ASSET_URL).then(function (module) {
    if (!module || typeof module.mountPaneResizer !== 'function') return;
    module.mountPaneResizer(host);
  }).catch(function () {
    // 只记录资源路径，不输出 token 或面板内容。
    console.warn('pane resizer unavailable: ' + RESIZER_ASSET_URL);
  });
}

mountPaneResizer();
`;
