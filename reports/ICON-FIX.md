# ICON-FIX · 左侧栏操作改用图标

| 字段 | 值 |
|---|---|
| 状态 | `READY_FOR_REVIEW` |
| 基线 SHA | `3eb0fe2`（`fix/webots-parity-pack`，已部署生产） |
| 修复提交 | `c066c76`（本报告为紧随其后的文档提交） |
| 触发 | 群内截图反馈：左侧栏顶部 `#contact-requests`（「友」）与 `#my-tasks`（「任」）应使用图标 |
| 影响范围 | 应用页侧栏品牌行；好友申请入口、我的任务入口、未读红点与 390px 列表页 |
| 迁移 | 无 |
| 部署 | 未执行；生产仍为 `3eb0fe2`，部署由主控完成 |

## 1. 改动

### 1.1 `src/web/chat-panels.ts`

- `#contact-requests`：文字「友」替换为双人联系人轮廓 SVG，保留 `id`、`type="button"`、`aria-label="好友申请"`、静态 `title="好友申请"`；`request-badge` 仍是按钮内子元素，未读时长由既有脚本更新。
- `#my-tasks`：文字「任」替换为剪贴板/清单 SVG，保留 `id`、`type="button"`、`aria-label="我的任务"`、`title="我的任务"`。
- 两个 SVG 均为 `viewBox="0 0 24 24"`、`aria-hidden="true"`、`focusable="false"`。
- `#new-group` 的「+」及行为未改动。

### 1.2 `src/web/chat-styles.ts`

- 新增 `.icon-btn svg`：`18px × 18px`、`display: block`、`fill: none`、`stroke: currentColor`、`stroke-width: 1.8`、`stroke-linecap/linejoin: round`。
- 删除 `#contact-requests` 已无作用的 `font-size: 12px`，保留 `position: relative`。
- `.request-badge` 保持 `position: absolute; top: -5px; right: -5px`，新增 `pointer-events: none`，红点不拦截按钮点击。
- `.icon-btn` 的 `28px × 28px` 点击区、hover 背景与 `#new-group` 的 22px「+」保持不变。

### 1.3 `scripts/verify-web.ts`

在既有好友申请流程中新增 35 项断言：

- 两个入口存在 `svg`、无直接文字子节点、`aria-hidden`；`aria-label` 与 `title` 保持。
- 计算样式：`18×18`、`display: block`、`fill: none`、`stroke` 等于按钮 `color`、`stroke-width: 1.8`、`linecap/linejoin: round`、按钮 `28×28`。
- 红点：有待处理申请时可见、计数为 1、`position: absolute`、`top/right` 为负、`pointer-events: none`、与按钮点击区相交。
- 点击 `#contact-requests` 仍打开好友申请弹窗并完成接受；点击 `#my-tasks` 打开我的任务面板并可关闭。
- 新增 390px 列表页上下文：页面不横向溢出、品牌行在视口内、两个图标均为 `18×18` 且完整可见。

## 2. 验证

| 命令 | 结果 |
|---|---|
| `bun run typecheck` | PASS |
| `bun run test:web` | PASS，2050 项（基线 2015，新增 35） |
| `bun scripts/verify-q04.ts` | PASS，176 项 |
| `bun run test:protocol` | PASS，991 项 |

`test:protocol` 需要已有服务，使用临时 `DATA_DIR` 启动本地实例（`http://127.0.0.1:8792`）后运行；验收结束已停止服务并确认端口关闭。

### 断言证据（节选）

```text
✓ 侧栏好友申请使用图标
✓ 好友申请图标保留 aria-label / title / aria-hidden
✓ 好友申请图标为 18×18
✓ 好友申请图标 display:block / fill:none / stroke-width 1.8 / 圆角线帽
✓ 好友申请按钮 28×28 点击区
✓ 好友申请红点可见 / 计数为 1 / 绝对定位 / 不拦截点击
✓ 好友申请红点位于图标右上角
✓ 好友申请红点仍属于按钮点击区
✓ 侧栏我的任务使用图标
✓ 我的任务图标保留 aria-label / title
✓ 我的任务图标为 18×18 / display:block / fill:none / stroke-width 1.8
✓ 我的任务按钮 28×28 点击区
✓ 点击我的任务图标打开任务面板
✓ 我的任务面板可关闭
✓ 390px 侧栏图标不横向溢出
✓ 390px 品牌行图标在视口内
✓ 390px 好友申请与任务图标 18×18 且完整可见
```

## 3. 文档与技能

已搜索 `README.md`、`docs/` 与 `src/mcp/skill.ts`：没有以「友」「任」描述这两个按钮的正文，因此未强行修改文档。工具契约、DOM id 与页面行为未变化。

## 4. 限制

- 未提交新截图；图标外观由 SVG 路径、计算样式与 390px 布局断言验证。`verify-q04` 运行会改写 `reports/evidence/q04/*.png`，已 `git restore` 回基线，未纳入提交。
- 未运行 `test:acceptance`；本次仅改静态 HTML/CSS 与浏览器验收，协议、Q04 与 Web 验收均通过。
- 未部署、未创建 PR；生产仍是 `3eb0fe2`。
