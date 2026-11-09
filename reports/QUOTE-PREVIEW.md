# 引用消息直接显示摘要

状态：READY_FOR_REVIEW

## 变更

- 引用块不再只显示“引用消息 · 查看上下文”。
- 目标消息已在当前时间线：直接显示“发送者：引用摘要”（120 字截断）。
- 目标未加载：调用 `network_message_context` 补取一次并缓存，成功后更新引用块；不可见/失败显示“引用消息不可见”。
- 点击引用块仍打开上下文对话框并定位原消息。
- 不改变 reply_to 发送、转发、撤回、历史边界与服务端契约。

## 验证

- `bun run typecheck`：通过
- `bun run test:ux`：8 套件、9 PASS、0 BUG/BLOCKED
- `bun run test:web`：2230 项通过
- `bun scripts/verify-q04.ts`：173 项通过
- `bun scripts/verify-isolated.ts protocol`：1003 项通过

## 限制

- 摘要最多 120 字；完整正文仍通过上下文/正文读取。
- 引用目标被撤回或超过历史边界时只显示不可见占位。
