# UI-WAVE-1：成员操作下拉与 Agent 消息阅读收敛

- 状态：READY_FOR_REVIEW
- 基线：`ad2eb3f`（docs(groups): 说明 Agent 入群规则与验收）
- 实现提交（结果 SHA）：`b950782`（fix(web): 成员操作下拉与 Agent 消息阅读收敛）
- 分支：`fix/webots-parity-pack`
- 部署：未部署。按约定由主控执行发布。

## 改动

### A. 成员行单个 icon + 下拉菜单

- `src/web/chat-members-script.ts`
  - 每个可操作成员行只渲染一个 `.member-menu-toggle`（`⋯`，`aria-label="成员操作"`、
    `title="成员操作"`、`aria-haspopup="menu"`、`aria-expanded`）。
  - `.member-menu` 默认 `hidden`，项使用 `role="menuitem"`，按服务端 `member.actions`
    以原顺序生成「设为管理员 / 撤销管理员 / 转让群主 / 移出群聊」。
  - 点击 toggle 打开/关闭；点击行外、Esc、滚动、窗口 resize、刷新重建成员列表或关闭弹窗
    都会收起；同一时间只保留一个菜单。
  - Esc 在菜单打开时只收菜单并把焦点还给 toggle，不关闭整个成员弹窗。
  - `membersBusy` 禁用 toggle 与菜单项；owner transfer 锁定项保留 `data.locked`；
    无可操作权限的成员行不渲染 toggle。
  - 复用原有 `submitMemberRole` / `submitOwnerTransfer` / `submitMemberRemoval` 与错误出口，
    服务端授权未改。
- `src/web/chat-styles.ts`
  - 新增 `.member-menu-toggle`、`.member-menu`、`.member-menu-item` 样式。
  - 菜单 `position: fixed`，按视口左右夹取；下方空间不足时翻到行上方，390px 不横向溢出。

### B. 「转为任务」按发送方收敛

- `src/web/chat-render-script.ts`：消息节点写入 `data-sender-kind="agent|human"`。
- `src/web/chat-styles.ts`：
  - 人类消息的 `.msg-task-convert` 保持常显。
  - Agent 消息默认 `opacity: 0` + `pointer-events: none`，在 `.msg:hover` /
    `:focus-within` / 按钮 `:focus-visible` 时显示；键盘 Tab 可聚焦并触发。
  - `@media (hover: none)` 下 Agent 消息不渲染该入口，只保留人类消息入口
    （避免触屏上存在无法稳定发现、仍可误触的隐藏按钮）。
- 点击行为、`openTaskCreate`、任务创建工具契约均未改。

### C. Agent block 自动展开

- `src/contracts/limits.ts`：新增 `webAgentAutoExpandBytes: 16 * 1024`。
- `src/web/chat-script.ts`：把阈值注入浏览器脚本。
- `src/web/chat-render-script.ts`：
  - `messageItem` 对 Agent、已截断且 `body_bytes <= 16384` 的消息隐藏「展开全文」，
    异步 `readMessage` 后直接渲染全文；成功后写入 `expandedMessageBodies`。
  - 读取失败、或 Markdown bundle 失败时回退显示「展开全文」，可手动重试。
  - 同一 `message_id` 的自动读取共享一个 Promise，避免刷新重建时重复并发请求。
  - 应用结果前检查节点仍连接；房间切换/刷新重建后的旧节点丢弃结果。
  - 文件卡片继续使用 `mountMessageFiles(..., existing)` 原地更新，不重复创建。
  - 超过 16KiB 的 Agent 消息与人类消息保持原「展开全文」行为。
  - 自动展开不调用已读接口，不改变消息顺序；高度变化沿用现有 Markdown/滚动补偿路径。

### 测试

- `scripts/verify-web.ts`
  - 成员行只有一个 toggle、菜单默认隐藏、menu/menuitem 语义、权限顺序、
    点击/Enter/方向键/Esc/外部点击/滚动关闭、同一时间只开一个、390px 不溢出。
  - 设管理员、撤销管理员、转让（含锁定项）改走菜单项；管理员的可见操作仍只有移除。
  - Agent 消息「转为任务」默认收起、hover 显示、键盘聚焦与 Enter 可用、点击仍打开来源表单；
    触屏上下文验证人类入口保留、Agent 入口隐藏。
  - 长 Agent 消息自动展开且无「展开全文」、同消息只读取一次；原 16KiB 以上的 Agent
    与人类长消息仍显示按钮；自动读取失败回退按钮，解除故障后可手动展开。
- `scripts/lib/q04-groups.ts`：任免管理员、移除成员、转让群主改走成员菜单，并增加重开重试。

## 验证

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run test:web` | 通过，2086 项（基线 2051） |
| `bun scripts/verify-q04.ts` | `Q04 PASS checks=176` |
| `bun run test:protocol` | 通过，991 项 |

`test:protocol` 使用临时 `DATA_DIR` 启动本地 8792 实例，验收后已停止服务。
Q04 重新生成的 `reports/evidence/q04/*.png` 已恢复到 HEAD，未纳入本次提交以避免二进制噪声。

## 限制与说明

- 触屏（`hover: none`）选择“Agent 消息不显示转为任务入口，人类消息保留”。触屏用户若需要
  从 Agent 消息建任务，仍可通过任务面板新建；服务端任务契约未改。
- 菜单打开后 150ms 内的滚动事件会被忽略，用于避开浏览器为聚焦/点击产生的首次程序化滚动；
  之后的用户滚动仍会收起菜单。
- 自动展开阈值按服务端返回的 `body_bytes` 判断，不是页面预览字节数；16KiB 以上 Agent 消息
  仍需手动展开。
- Markdown bundle 失败时自动展开会显示完整纯文本并保留「展开全文」按钮，不会把消息标记为
  已缓存展开，避免 bundle 恢复后无法重试。
- 未改服务端授权、任务创建、通知或数据库；本轮仅网页脚本、样式、阈值与验收片段。
