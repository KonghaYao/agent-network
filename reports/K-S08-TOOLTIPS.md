# K/S08：原生提示迁移

## 范围与实现

- 基线：`e48cdf1e925e40c8297184109dab5ca1b81bac34`（创建 worktree 时核对 origin/main）。
- 工作区：`agent-network-worktrees/lenso-tooltip`；分支：`feat/lenso-tooltip`。
- 只改前端与测试，没有后端、schema、依赖版本或部署改动。
- 新适配器：`src/web/app/lenso-tooltip.tsx`，138 行。
- API：`<Tooltip as={Button | Link | Avatar | 'span' | 'div' | 'a' | 'button'} hint={text} delay={500} side="top" {...原宿主属性} />`。原 ref、id、class、role、点击及菜单事件透传；不增加布局节点，不改变 CSS 命中区。
- 只从现有 `lenso-runtime.ts` 获取动态模块，不静态引入 `@lenso/ui`。

### 核对过的 Lenso 0.11.4 API

依据安装依赖的 `@lenso/ui/dist/components/tooltip/tooltip.d.ts` 与 `@ui-sdk/core/dist/components/tooltip/tooltip.d.ts`：

- `Tooltip.Root` / `Trigger` / `Content` / `Arrow`；没有独立 `Tooltip.Portal`。
- Root 支持 `open`、`onOpenChange`、`delay`、`closeDelay`、`toggleable`。
- Content 支持 `anchor`、`side`、`sideOffset`、`collisionPadding`、`container`；Content 内建 portal。
- 适配器使用受控 Root + Content 的公开 anchor，不将原节点替换为 SDK Trigger，避免与已有 ContextMenu/Popover 争用长按、ref 和焦点。
- 500ms 定时由适配器管理，覆盖 hover 与 focus，避免 SDK 跨提示 warm-up 跳过延迟；离开、失焦、Esc、按下、点击、contextmenu、pointercancel、滚动、窗口失焦关闭。清理定时与监听。
- 从交互开始（包含等待延迟）持有现有 `useBackendLease`；fallback 打开期间不升级，下一轮交互可升级。关闭态重新选择 backend，避免父确认框归还焦点后再次重挂按钮。
- fallback 使用原生 title；Lenso 路径移除 title；可访问名不依赖 title。
- 可访问名完全由调用方决定：适配器**永不**根据 hint 或 children 补 `aria-label`，也不做 DOM 文本探测。内容型宿主保留自身由内容派生的名称，Lenso 打开时提示只写入 `aria-describedby`（fallback 由原生 title 提供描述）；图标型宿主必须在调用处显式提供 `aria-label`。49 处宿主已逐一核对：图标按钮均已有显式名称，内容型宿主均保留文本，无需回填。
- 单例控制：模块级 claim/release，不生成全局 DOM；新的 hover/focus 先关闭旧提示，确保同一时刻最多一个 tooltip，滚动、Esc、失焦与卸载继续清理。
- SDK 默认使用 native popover top layer，单纯降低 z-index 不够。Content 的局部 ref 在 microtask 中退出 native popover 并移除该节点的 popover 属性，保留 Lenso 内容、定位和 body portal；z-index 使用 `--app-z-portal-local-menu`（99999），低于 Lenso Modal 100000。没有全局选择器或 DOM 扫描。
- touch / `(hover: none)` 不打开自绘提示，点击和长按不改变原动作。

## title 盘点表

位置为基线行号，路径均以 `src/web/` 为根。通过内容搜索 `title=` 盘点；表中以 JSX 实例计数，不按运行时列表条目数计数。

### 已迁移：49 处、26 个消费文件

| 文件 | 元素 / 原基线行号 | 数量 | 结论 |
|---|---|---:|---|
| features/sidebar/RoomRow.tsx | 会话链接 48、离线点 65 | 2 | Tooltip；链接和 img role 保留 |
| features/sidebar/SidebarAccount.tsx | 编辑 177、归档 232、退出 247 | 3 | Tooltip；原 aria-label 保留 |
| features/sidebar/Sidebar.tsx | 建群 179、未读徽标 231、stream 状态 346 | 3 | Tooltip；未读读屏汇总及 status role 保留 |
| features/sidebar/AccountMenu.tsx | 账号菜单触发器 137 | 1 | Tooltip；Menu 事件透传 |
| features/sidebar/ContactRequestsButton.tsx | 好友申请入口 22 | 1 | Tooltip；动态数量名称保留 |
| features/panels/MonitorPane.tsx | 保存 112、清除 125、外链风险说明 142、刷新 158、关闭 172 | 5 | Tooltip；完整安全文案保留 |
| features/panels/FilesPane.tsx | 关闭 290、文件名 407 | 2 | Tooltip；原布局与名称保留 |
| features/panels/MemoryDialog.tsx | 刷新 493、关闭 504 | 2 | Tooltip；44px 原内联样式不变 |
| features/chat/ChatMessage.tsx | 气泡完整时间 519 | 1 | Tooltip；正文与业务动作不改 |
| features/chat/Composer.tsx | 图片预览 217、文件名 236、移除 248、添加附件 705 | 4 | Tooltip；IME / textarea 不改 |
| features/chat/MessageFileCard.tsx | 图片预览 225、文件名 245 | 2 | Tooltip |
| features/chat/Timeline.tsx | 推断下线 201、发送错误 278 | 2 | Tooltip；空 hint 不生成内容 |
| features/memory/AgentAvatarMenu.tsx | 头像菜单说明 47 | 1 | Tooltip；Radix 菜单本身不改 |
| features/memory/fenix/components/Constellation.tsx | 全屏按钮 329 | 1 | Tooltip；canvas 虚拟节点提示另见未覆盖项 |
| features/memory/fenix/components/MemoryVisualizationShell.tsx | 侧栏开关 40 | 1 | Tooltip |
| features/memory/fenix/components/data-view-table.tsx | 实体 119、标签 138 | 2 | Tooltip；继续用 maskSecrets |
| features/memory/fenix/components/data-view-timeline.tsx | 缩小 126、放大 140 | 2 | Tooltip |
| features/overlays/AnnouncementPopover.tsx | 公告触发器 27 | 1 | Tooltip；Popover 不改 |
| features/overlays/ArchiveAgentsDialog.tsx | 关闭 99、名称 133 | 2 | Tooltip |
| features/overlays/MembersDialog.tsx | 设管理员 459、撤管理员 471、移除 483 | 3 | Tooltip；权限、请求及原位反馈不改 |
| features/overlays/RoomMenu.tsx | 会话菜单触发器 121 | 1 | Tooltip |
| features/tasks/RoomTaskDock.tsx | dock 开关 281 | 1 | Tooltip |
| features/tasks/TaskListItem.tsx | 询问进度 74、完成/禁用原因 89 | 2 | Tooltip；原 disabled 和 describedby 不改 |
| features/tasks/TaskSummaryBar.tsx | 参与者头像 101 | 1 | Tooltip |
| features/tasks/TaskPreviewPopover.tsx | 参与者头像 198 | 1 | Tooltip；业务 hover/pinned 状态不改 |
| pages/ChatPage.tsx | 搜索 605、网页监控 628 | 2 | Tooltip |

### 保留：不是悬浮提示

| 文件 | 元素 | 保留原因 |
|---|---|---|
| features/panels/MonitorPane.tsx:224 | iframe title | iframe 的可访问名称，不应迁成提示 |
| features/panels/FilePreviewDialog.tsx:126 | PDF iframe title | 同上 |
| features/chat/ForwardDialog.tsx:119 | Modal title | 对话框可见标题正文 |
| features/overlays/AgentReissueDialog.tsx:49 | Modal title | 同上 |
| features/overlays/AnnouncementDialog.tsx:70 | Modal title | 同上 |
| features/overlays/ContactRequestsDialog.tsx:72 | Modal title | 同上 |
| features/overlays/GroupCreateDialog.tsx:120 | Modal title | 同上 |
| features/overlays/MeRenameDialog.tsx:67 | Modal title | 同上 |
| features/overlays/MembersDialog.tsx:337 | Modal title | 同上 |
| features/overlays/NewAgentDialog.tsx:164 | Modal title | 同上 |
| features/overlays/RenameAgentDialog.tsx:70 | Modal title | 同上 |
| features/overlays/RenameRoomDialog.tsx:70 | Modal title | 同上 |
| features/overlays/ReportDialog.tsx:73 | Modal title | 同上 |
| features/overlays/TransferDialog.tsx:214 | Modal title | 同上 |
| features/tasks/MessageSearchDialog.tsx:227/336 | 两个 Modal title | 搜索与上下文标题正文 |
| features/tasks/TaskTraceDialog.tsx:46 | Modal title | Task 标题正文 |
| features/memory/AgentMemoryDialog.tsx:110/117 | EmptyState title | 失败/未初始化可见说明正文 |
| features/memory/fenix/MemoriesPage.tsx:147 | EmptyState title | 空状态正文 |
| features/memory/fenix/components/DataView.tsx:161 | EmptyState title | 同上 |
| features/memory/fenix/components/EntitiesView.tsx:254/339 | EmptyState title | 同上 |
| features/memory/fenix/components/HindsightFailureNotice.tsx:60 | EmptyState title | 失败说明正文 |
| features/memory/fenix/components/MemoryDetailModal.tsx:70 | EmptyState title | 同上 |
| features/memory/fenix/components/data-view-table.tsx:181 | EmptyState title | 空状态正文 |
| features/memory/fenix/components/data-view-timeline.tsx:91 | EmptyState title | 同上 |
| pages/HomePage.tsx:94 | EmptyPane title | 首页空态正文 |

### 未覆盖 / 明确保留的提示

| 文件 | 元素 | 现状 / 原因 |
|---|---|---|
| drawboard/entry.ts:70 | 色板按钮原生 title（模板 1 处，运行时 5 色） | 保留。独立 Bun/Fabric bundle 的非 React 模板；与本适配器之间没有现成宿主/模块桥。本轮未改画板架构或 bundle 构建。它仍有 aria-label，不宣称全站 title 清零。 |
| features/memory/fenix/components/Constellation.tsx:335 起 | canvas 虚拟节点自绘提示 | 不是 title=；保留原自绘与掩码/防注入行为。本轮只迁全屏按钮的原生 title，不扩展到 canvas 命中检测架构。 |

## 行为证据与检查

新增 `tests/e2e/lenso-tooltips.spec.ts`，9 个场景：

1. hover 250ms 不出现、500ms 后出现，body portal，本地 z-index、非 native top layer，Esc 后不自行重开；Lenso 路径没有 title。
2. focus 打开、焦点不移动、blur 卸载；焦点仍在首个触发器时 hover 另一个，关闭旧提示且只存在 1 个 tooltip。
3. route abort 真实 `assets/index-*.js`；断言拦截数、title、无 Lenso 内容，按钮仍能打开建群框。
4. gate 延迟真实 index chunk；释放后其他控件升级，当前 fallback/title 不切换；离开再进入才走 Lenso。
5. 390×844、暗色、提示在视口内、页面不横向溢出、可访问名、建群交互。
6. 会话行完整内容名（未读、时间、预览）不被 hint 覆盖且 hint 只进入 `aria-describedby`；消息气泡没有 `aria-label`、aria snapshot 保留正文，hover 后时间只出现在 tooltip/`aria-describedby`，accessible name 保持为空；SidebarAccount 与好友申请图标按钮保留显式名称；监控五个提示保留显式 `aria-label`、完整安全说明、iframe title，确认框取消后还焦。
7. 延迟前离开取消；已打开后离开卸载。
8. 提示退出 native top layer；真实 Lenso Modal 打开后仍可填输入框。
9. hasTouch/isMobile/no-hover 点击不留下 tooltip，原动作与名称保持。

现有 `scripts/verify-web.ts` 的未读数量说明断言改读提示本身（fallback 的 title 或 Lenso 打开后的 tooltip 内容），不再依赖内容型宿主上的 `aria-label`；未删除 rooms/sidebar/monitor 的行为断言。

### 测试记录

最终 `bunx playwright test`：**298/298 通过（8.9 分钟，retries=0）**；首轮曾出现 1 次既有 `home.spec.ts:232` 44px 搜索命中区 flake（见下），隔离复跑与基线对照后重跑完整套件通过。`lenso-tooltips.spec.ts` 9/9。固定 dist 完成整轮，没有并行重建。其他检查：

- `bun run typecheck` 通过。
- `bun run test:web`：240。
- `bun run test:web:a11y`：11；home/room/group-modal 均 critical=0、serious=0。
- `bun run test:spa-shell` / 最终固定产物 `bun scripts/verify-spa-shell.ts`：68。
- `bun run test:units`：通过，子组 216 / 407 / 112 / 156 / 27，文件元数据组通过。
- `bun run test:lenso-primitives`：211。
- `bun run test:memory-fenix-vendor` / 最终固定产物 `bun scripts/verify-memory-fenix-vendor.ts`：通过。
- `git diff --check`：通过。

### home.spec flake 对照

- 本轮完整套件首轮唯一失败：`home.spec.ts:232 keeps the 44px search hit area focusable`，点击 `.search-box` 左侧 padding 后 `document.activeElement.id` 为空。该用例不经过任何 Tooltip 宿主，失败点是既有 Lenso `SearchField` 升级与鼠标点击的竞态；同一源码重跑完整套件 298/298 通过。
- 当前分支隔离：`--repeat-each=3` 为 29/30（1 次同点失败）；仅跑该用例 `--repeat-each=30` 为 12/30。
- 基线 `e48cdf1`（独立 worktree 重建 dist）：同一 `--repeat-each=3` 为 30/30；同一 `--repeat-each=30` 为 24/30（6 次同点、同断言的失败）。基线也能复现，故不计入本次回归；未修改该用例或放宽断言。

### 失败归因记录

- 复验回归：`d961589` 用 hint 覆盖内容型可访问名，RoomRow 链接名称退化为“房间名（右键或长按…）”。`b256adb` 改为显式 `aria-label`/`aria-labelledby` 与内容文本优先，RoomRow 恢复为“未读 Audit Group HH:MM audit message body”。
- 二次复验回归：`b256adb` 的 `hasContentName` 只能看到 React children，`HumanBody`/`MarkdownIsland` 的文本在 props 中，消息气泡被误判为无文本并补上时间 `aria-label`。本次直接删除该启发式与 hint 回填，改为“调用方显式 aria-label”契约；气泡恢复无 `aria-label`、aria snapshot 保留正文，时间只进入 tooltip 的 `aria-describedby`。
- 双提示回归：同一时刻可能有 focus 与 hover 两个 tooltip。已加模块级单例 claim/release（不生成 DOM），新交互先关闭旧提示；e2e 在首个触发器保持焦点时 hover 第二个，断言只剩 1 个提示。
- 初轮完整运行发现本次新增问题：慢加载后 confirm 归还焦点时 Tooltip 沿用已结束 fallback lease，按钮再次升级导致丢焦。已修正关闭态 backend，并隔离复跑原失败用例通过。
- 初轮 NewAgent fallback 用例失败，隔离复跑通过；不据此宣布不存在 flake。
- 初轮完整运行期间错误地重建 dist，导致后半段旧 hash 资源不可用，出现 pagination/panels 连续失败；已主动中止，退出 130。该轮不作最终验收；最终完整运行固定产物，不再并行 build。
- 原始基线 `e48cdf1` 在独立 `/tmp/lenso-tooltip-baseline` worktree 构建后运行 `home.spec.ts`：10/10 通过。用户指出的既有 home flake 在本次基线运行未复现，不将其他失败自动归因于该 flake。
- 固定最终源码的首轮：297/298，原有 289 项全部通过、home 10/10。唯一失败为新增 Modal 层级测试在 Modal 打开后继续等待已经因失焦卸载的 tooltip；已改为允许卸载并检查所有残留提示均不在 top layer，专项复跑 9/9。
- 额外协议检查：默认本地端口没有服务，首次 ConnectionRefused；改用临时测试实例并匹配 PUBLIC_ORIGIN 后 `test:protocol` 957 项通过。额外 `test:acceptance` 在“关闭最后一个连接后成员显示离线”超时；未修改后端或放宽断言，该项不算通过。前端所要求的门禁独立记录。

## 入口预算

`bun run build:web` + `bun scripts/measure-web-entry.ts`：

- `assets/main-DjdGf14V.js`：730,163 B；静态 JS 闭包同为 730,163 B。
- 相对给定 727,722 B：+2,441 B。
- 硬限 972,800 B，余量 242,637 B。
- Lenso 为 dynamicImports 中的 `_index-BUIXRKcr.js`，未进入静态闭包。
- 没有 push，没有部署。
