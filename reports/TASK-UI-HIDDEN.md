# 暂停任务创建 UI

状态：READY_FOR_REVIEW

## 变更

- 新增 Web 端开关 `TASK_CREATION_UI_ENABLED = false`。
- 隐藏群头部“新建任务”按钮与创建任务表单入口。
- 消息不再生成“转为任务”按钮；已有任务卡片/来源任务链接仍正常显示。
- 保留“我的任务”列表、任务详情、接受/进度/阻塞/转交/提交/验收/取消/重试/交接包等查看与操作。
- 后端 `network_task_*` 工具、任务状态机、迁移与事件不变。

## 验证

- `bun run typecheck`：通过
- `bun scripts/verify-q04.ts`：175 项通过（Q04 改为 MCP 建任务后验证 UI）
- `bun run test:web`：2212 项通过
- `bun run test:ux`：8 套件通过
- `bun scripts/verify-isolated.ts protocol`：1003 项通过

## 限制

- 这是临时产品开关；恢复时把 `TASK_CREATION_UI_ENABLED` 改回 `true` 并恢复测试。
- “我的任务”面板仍显示；若连任务查看 UI 也要撤下，需要另行确认。
