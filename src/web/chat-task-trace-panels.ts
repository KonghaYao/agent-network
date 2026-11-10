/**
 * 消息式 Task 的 Trace 抽屉静态骨架。
 *
 * 抽屉只在客户端按需填充；服务端只输出空壳，不读取房间或消息数据。
 * 移动端由 CSS 切为全屏 sheet，桌面端为右侧抽屉。
 */
export function taskTraceDrawer(): string {
  return `<dialog id="task-trace-drawer" class="task-trace-drawer" aria-label="Task Trace">
  <div class="task-trace-card">
    <header class="task-trace-head">
      <div class="task-trace-heading">
        <h2 id="task-trace-title">Task</h2>
        <p id="task-trace-meta" class="task-trace-meta"></p>
      </div>
      <button id="task-trace-close" class="task-trace-close" type="button"
        aria-label="关闭 Task Trace" title="关闭">×</button>
    </header>
    <div id="task-trace-participants" class="task-trace-participants" aria-label="参与 Agent"></div>
    <div class="task-trace-toolbar">
      <button id="task-trace-refresh" class="link-btn" type="button" hidden>有新消息，刷新</button>
      <span id="task-trace-status" role="status" aria-live="polite"></span>
    </div>
    <button id="task-trace-older" class="task-trace-page" type="button" hidden>加载更早</button>
    <div id="task-trace-items" class="task-trace-items" role="list"></div>
    <button id="task-trace-newer" class="task-trace-page" type="button" hidden>加载更晚</button>
  </div>
</dialog>`;
}
