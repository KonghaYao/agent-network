# Lenso 原生控件盘点与豁免清单

| 字段 | 值 |
|---|---|
| 状态 | `READY_FOR_REVIEW` |
| 分支 | `feat/lenso-r` |
| 复验基线 | `163d640`（R：剩余表单控件迁移） |
| 实现提交 | 本文件所在提交（见 `git log -1`） |
| 范围 | `src/web` 中由表单适配器直接渲染的原生控件；不含 fenix 内嵌 UI、独立 drawboard bundle 的工具栏按钮与 canvas |

## PairPage label 迁移

`PairPage` 是 `src/web/app/main.tsx` 中的懒加载 CSR 路由，渲染在 `Providers` 的 `ThemeScope` 内，Lenso 可用，因此原 `PairPage.tsx:298` 的 `<label className="field">` 已迁移：

- `src/web/pages/PairPage.tsx:298-299`：`<div className="field">` + `<Label htmlFor="pair-challenge">12 位配对码</Label>`，`Input#pair-challenge` 保持原有 id、属性与事件。
- Lenso 就绪时 label 带 `data-lenso-slot="label"`，Lenso 未就绪/加载失败时为原生 `<label>` 并带 `data-lenso-slot="label-fallback"`；两种状态的 `for`/`htmlFor`、可访问名“12 位配对码”与点击聚焦行为一致。
- `tests/e2e/lenso-forms.spec.ts` 新增 `Pair Lenso/fallback` 用例，复用 `labelled()` 断言 label 文本、slot、可访问名与点击聚焦。

## 完整豁免清单

| # | 类别 | 代码位置 | 处置 |
|---|---|---|---|
| 1 | PairPage 原生 `<label className="field">` | 原 `src/web/pages/PairPage.tsx:298` | **已迁移为 Lenso `Label`**，不再属于豁免；见上节 |
| 2 | 画板粗细 `<label class="db-width">` + 原生 `<input type="range">` | `src/web/drawboard/entry.ts:72-74`，豁免说明见 `:56-60` | 保留原生。drawboard 是独立 bundle 的画板能力节点，不接入 Lenso 控件；盘点时不得按未迁移表单统计 |
| 3 | 会话加载骨架的 disabled 原生 `<textarea id="body">` | `src/web/pages/ChatPage.tsx:826-831`，豁免说明见 `:814-815` | 保留原生。与 `Composer` 的 `#body` 同一契约，仅占位、不可交互；接入 Lenso 会引入第二个 textarea 实现并改变骨架高度/焦点契约 |
| 4 | 剪贴板回退 `document.createElement('textarea')` | `src/web/lib/files.ts:190`，说明见 `:188-189` | 不渲染。只在内存中挂载一次用于 `execCommand('copy')`，不进入界面渲染树，不属于 UI 控件盘点范围 |

## 盘点口径与其余原生节点

R 的“4 个豁免”按**表单适配器直接渲染的可见控件**计数。以下节点不在此口径内，但仍在此登记，避免后续盘点按 `grep '<input|<textarea|<label'` 误判：

| 节点 | 代码位置 | 说明 |
|---|---|---|
| Composer 编辑区 `<textarea id="body">` | `src/web/features/chat/Composer.tsx:777` | Ariakit Combobox 的 `render` 目标，承载 IME、@ 提及、1–4 行自适应与草稿契约；组件 JSDoc 已声明“textarea 不替换”，不属于表单适配范围 |
| 隐藏文件选择 `<input type="file" hidden>` | `src/web/features/chat/Composer.tsx:724`、`src/web/features/panels/FilesPane.tsx:298` | 隐藏、由按钮/拖拽触发，不渲染可见控件 |
| 画板工具栏按钮与 canvas | `src/web/drawboard/entry.ts:60-83` | 独立 bundle 的原生能力节点；与第 2 项同一豁免 |
| 错误边界刷新按钮 / Modal 关闭按钮 / 上下文菜单项 | `src/web/app/main.tsx:65`、`src/web/features/overlays/Modal.tsx:129`、`src/web/app/lenso-context-menu.tsx:249` | 结构或 fallback 渲染槽位，不是待迁移表单控件 |
| fenix 记忆视图 UI 原语 | `src/web/features/memory/fenix/` | 内嵌第三方 UI 原语，沿用自身组件体系，不在本分支 Lenso 迁移范围 |

## 验证

| 检查 | 结果 |
|---|---|
| `bun run typecheck` | 通过 |
| 定向 Playwright：`lenso-forms`、`components`、`entries`、`panels`、`lenso-overlays` | `96 passed`（含新增 `Pair Lenso/fallback` 2 项） |
| 完整 `bunx playwright test` | `273 passed`（R 基线 271 + 新增 2，无 flake 复跑） |
| `bun run test:web` | `浏览器验收通过 240 项` |
| `bun run test:web:a11y` | `可访问性基线: 11 项检查通过` |
| `bun run test:spa-shell` | `spa shell checks passed: 68` |
| `bun run test:units` | 6 个脚本全部通过，退出码 0 |
| `bun run test:lenso-primitives` | `Lenso 展示原语探针通过：211 项检查` |
| `bun run build:web` + `bun scripts/measure-web-entry.ts` | 入口 `assets/main-BPreu7lL.js` = 724,624 B，低于硬限 972,800 B |
| `git diff --check` | 无输出 |
