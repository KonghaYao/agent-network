# UI-WAVE-3：转为任务入口统一 hover 显示与切房展开守卫

- 状态：READY_FOR_REVIEW
- 基线：`fb538d2`（docs(reports): 记录长历史分片与会话列表分页验收）
- 实现提交（结果 SHA）：`08f856c`（fix(web): 转为任务入口统一 hover 显示）
- 分支：`fix/webots-parity-pack`
- 部署：未部署。按约定由主控执行发布。

## 改动

### A. 人类与 Agent 消息的「转为任务」统一收起

- `src/web/chat-styles.ts`
  - 删除仅针对 `[data-sender-kind="agent"]` 的收起规则，改为所有 `.msg` 的
    `.msg-task-convert` 默认 `opacity: 0` + `pointer-events: none`。
  - `.msg:hover`、`.msg:focus-within` 与按钮的 `:focus-visible` 时恢复
    `opacity: 1` + `pointer-events: auto`。
  - `@media (hover: none)`：人类消息入口保持可见且可点击；Agent 入口维持
    `display: none`，与触屏没有可靠 hover 的既有策略一致。
- `src/web/chat-render-script.ts`
  - 仅更新发送方标记处的注释：任务入口统一在悬停或聚焦时显示。
- 点击行为、权限判定、来源任务表单与 `taskConvertButton` 均未改动；
  人类与 Agent 仍调用同一个 `openTaskCreate({ sourceMessageId, title })`。

### B. 手动「展开全文」的切房守卫

- `src/web/chat-render-script.ts`
  - 点击展开时捕获 `activeRoomId` 与 `roomEpoch`。
  - `readMessage` 返回后、`renderMessageBody` 返回后以及失败分支应用结果前，
    统一检查 `isActiveRoom(capturedRoomId, capturedEpoch)`、展开按钮与气泡的
    `isConnected`。
  - 切房或消息区重建后的旧响应直接丢弃，不再覆盖新房间的 `statusElement`、
    气泡正文、文件卡片或展开按钮；也不写入旧的展开缓存。

## 测试

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run test:web` | 通过，2132 项（基线 2119） |
| `bun scripts/verify-q04.ts` | `Q04 PASS checks=176` |
| `bun run test:protocol` | 通过，991 项 |

新增/调整的浏览器断言覆盖：

- 桌面 1280×800：人类消息「转为任务」默认 `opacity: 0` 且
  `pointer-events: none`；Agent 保持默认收起。
- 人类消息 hover 后显示，点击仍打开带来源提示的任务表单；移出后收起。
- 键盘聚焦人类任务入口时显示；Agent 的 hover/键盘路径保持通过。
- 触屏 390×844（`hover: none`）：人类入口常显、可点击并打开来源任务表单；
  Agent 入口仍隐藏；消息任务入口不横向溢出。
- 手动展开请求延迟期间切到另一个房间，释放为失败响应后，新房间的
  `#status` 与 `#messages` 均保持不变，旧消息不串入新房间。
- `scripts/lib/q04-tasks.ts` 从人类消息建任务前先 hover，确保入口在
  桌面默认收起后仍可点击；Q04 计数保持 176。
- Q04 运行重新生成了 `reports/evidence/q04/` 下的证据截图，已随实现提交。

## 桌面与触屏结果

- 桌面（hover 可用）：人类与 Agent 消息入口均默认收起，悬停或键盘焦点进入
  后显示；点击/回车可打开同一来源任务表单。
- 触屏（`hover: none`）：人类消息入口常显并可直接点击；Agent 入口维持隐藏，
  不提供无法稳定触发的隐藏按钮。

## 限制

- 触屏 Agent 消息仍不能从消息入口创建任务，这是本次保持不变的产品策略；
  人类消息入口已保留，不存在无法从用户消息创建任务的问题。
- 桌面收起态按钮仍保留在 Tab 顺序中（`opacity: 0` 不影响键盘聚焦），
  聚焦后通过 `:focus-within` 显示；与既有 Agent 行为一致。
- 触屏验收为 Chromium `390×844` + `hasTouch` 模拟，未覆盖真机。
- 协议验收使用本 worktree 临时实例（`PUBLIC_ORIGIN=http://127.0.0.1:8792`），
  跑完后已停止；未部署、未创建 PR。
