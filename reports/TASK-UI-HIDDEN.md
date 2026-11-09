# 默认隐藏全部任务 UI

状态：READY_FOR_REVIEW

## 产品决定

- 生产默认隐藏全部任务相关 UI，而不是只隐藏“新建任务”。
- `TASK_UI_ENABLED = window.__TASK_UI_ENABLED === true`，默认 `false`；`TASK_CREATION_UI_ENABLED` 与总开关一致。
- 后端 `network_task_*` 工具、任务状态机、迁移与事件保留，未修改数据库 schema。

## 隐藏的入口与面板

- 群头部任务入口 `#task-toggle` 与房间任务浮层 `#task-popover`。
- 侧栏“我的任务” `#my-tasks` 与“我的任务”弹窗 `#my-tasks-modal`。
- “新建任务” `#task-create` 与创建弹窗 `#task-create-modal`。
- 消息“转为任务”入口 `.msg-task-convert`。
- 消息任务卡片与来源链接（`.msg-task-slot` 内的 `.msg-task-card` / `.msg-task-link`）。
- 任务详情 `#task-detail-modal`、提交成果 `#task-submit-modal`、验收通过 `#task-review-modal`；入口统一经 `openTaskDetail` 门控，关闭时无法打开。

## 实现要点

- `renderTaskRow()` 在开关关闭时同步隐藏 `#task-toggle`、`#my-tasks` 与任务浮层。
- `#my-tasks` 在服务端 HTML 上默认带 `hidden`，任务脚本初始化时按开关同步，避免首页尚未打开房间、`renderTaskRow()` 未运行时状态遗漏。
- `.icon-btn[hidden] { display: none; }`：`.icon-btn` 的 author 级 `display: grid` 会覆盖浏览器对 `[hidden]` 的 `display: none`，这是“我的任务按钮仍可见”的根因。
- 关闭时 `openTaskPopover`、`openTaskDetail`、`openMyTasks`、`openTaskCreate`、`loadTaskSummary`、`loadRoomTasks`、`loadMyTasks`、`syncTaskCardMarkers`、`taskConvertButton` 直接返回。
- `window.__TASK_UI_ENABLED = true` 只用于测试宿主（`scripts/verify-web.ts` 的 `makeContext`），生产页面不设置。

## 门禁结果

- `bun run typecheck`：通过
- `bun scripts/verify-q04.ts`：Q04 PASS checks=146
- `bun run test:web`：2215 项通过
- `bun run test:ux`：8 套件通过
- `bun scripts/verify-isolated.ts protocol`：1003 项通过
- `git diff --check`：无输出

## 测试与证据

- Q04 改为 `runTaskUiHiddenAcceptance`：默认页面断言 `#task-toggle`、`#my-tasks`、`#task-create` 隐藏，`.msg-task-convert` 计数为 0，可见任务卡片为 0。
- `verify-web.ts` 的 `makeContext` 注入 `window.__TASK_UI_ENABLED = true`，旧任务 UI 用例继续覆盖；新增默认上下文断言全部任务入口隐藏。
- `reports/evidence/q04` 中由本次运行重新生成的截图已更新；历史任务验收截图不属于当前 UI，已还原、未纳入本次提交。
- 旧 `runTaskAcceptance` 保留，当前未由 `verify-q04.ts` 调用，供恢复任务 UI 时复用。

## 限制

- 这是产品级默认隐藏，不是权限收紧；直接调用 MCP `network_task_*` 仍然可用。
- 恢复 UI 时需要生产宿主设置 `window.__TASK_UI_ENABLED = true`（或调整默认值），并恢复 Q04 对 `runTaskAcceptance` 的调用。
- 会话列表加载仍会调用一次 `network_task_summary` 维护内部 summary 状态，不渲染任何可见任务 UI，也不额外轮询。
