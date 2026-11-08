# PERF-WAVE-1-CLIENT：懒 Markdown、渲染构建与长列表布局隔离

- 状态：READY_FOR_REVIEW
- 基线：`8a72052`（docs(reports): 记录性能审查与第 1 波服务端基准）
- 结果 SHA：
  - `af0cbb3` perf(web): 懒 Markdown 与渲染构建优化
  - `e073499` fix(web): 合并旧 Agent 注册表修复群成员候选（同轮 P0）
- 分支：`fix/webots-parity-pack`
- 部署：未部署。按约定由主控执行发布；未建 PR。

## 1. 改动

### A. 渲染构建去强制布局

- `src/web/chat-render-script.ts`
  - `renderMessageList` 在 `DocumentFragment` 中构建完整消息列表，最后一次
    `replaceChildren(fragment)`；history-pager、时间胶囊、消息、outbox 行与
    `messages-end` 的 DOM 顺序和 id/class 不变。
  - `applyReceipt` 在 `!receipt.isConnected`（列表构建阶段）只写文本与
    `stale` class 后返回，不读 `getBoundingClientRect`、不调用
    `noteContentChanged`；入树后的异步回执更新仍保留原有锚点补偿。
  - `appendHistory` 返回 `{ first, last, lastTimestamp }`，为第 2 波增量 DOM
    的 prepend seam 复用；现有调用方行为不变。
  - `TextEncoder` 复用单实例；`fullTime` 按分钟缓存 Intl 结果；
    `mentionNames()` 在每次房间渲染/历史批次内只计算一次（`invalidateMentionNames`）。
  - 消息数超过 `LIMITS.webLongMessageListThreshold`（200）时给
    `#messages` 加 `messages--long`，见 C。
- `src/web/chat-tasks-script.ts`
  - 新增 `source_message_id -> task` 映射，替代每条消息 `roomTasks.find`。
  - 新增已渲染消息节点索引与 `taskMarkerVersion` 签名；`syncTaskCardMarkers`
    只处理新增 fragment 或签名变化的消息，未变化的消息不再
    `slot.replaceChildren()`。
  - 无任务且当前用户不能创建任务时直接返回；仍有“转为任务”入口时保持原行为。

### B. 可见区懒 Markdown

- `src/web/chat-markdown-script.ts`
  - 首屏与加载更早先走现有 `renderRichText` 纯文本；共享
    `IntersectionObserver`（root 为 `#messages`，`rootMargin: 0 0 300px 0`）
    在消息进入视口下方附近时入队。
  - 队列每帧最多 mount 2 条，避免 bundle resolve 后几十条 `flushSync` 串行。
  - 视口上方（含部分露出）的消息先保持纯文本，滚动后再升级；避免异步高度
    推走阅读锚点。已挂载的 root 在 `update` 路径复用同一 handle。
  - 纯文本快速路径：无 Markdown 结构、无已知成员 `@`、无裸 URL、无多行正文
    时不创建 Streamdown root；`@` 高亮仍由 `renderRichText` 完成。
  - 自动展开不再消耗用户手动展开的一次 bundle 重试机会；手动「展开全文」仍按
    原规则最多重试一次。
- `src/web/chat-scroll-script.ts`
  - 阅读锚点跳过可能在前插接缝被删除的 `.msg-time` 时间胶囊，改用稳定的消息
    节点；修复懒升级期间加载更早的锚点漂移。
- `src/web/chat-render-script.ts`
  - `weBots` 截断消息的自动展开仍即时挂载 Markdown；首屏列表传入 `element`
    只登记懒升级。

### C. 长列表布局隔离

- `src/contracts/limits.ts`：新增 `webLongMessageListThreshold: 200`。
- `src/web/chat-styles.ts`：
  - `.messages--long .msg { content-visibility: auto; contain-intrinsic-size: auto 88px; }`
  - `.messages--long .msg-time, .messages--long .msg-system` 使用 32px 估算。
  - 短会话不加类，避免滚动条估算变化。
- 现有 14c/14d、加载更早、pinned/unpinned、390px 断言全部通过；未观察到
  `content-visibility` 引起的锚点漂移，因此保留该项。

### D. 基准

- 新增 `scripts/verify-web-perf.ts`，复用 `scripts/verify-web.ts` 的
  `startServer` / `makeContext` / `rawTool` 与 `__mcpCalls` 观测。
- `package.json` 新增 `test:web:perf`；默认 500 条（70% Agent，含
  Markdown/代码/表格/@/链接），`PERF_WEB_MESSAGES=2000` 为手动档。
- 测量首屏与加载完全部历史后的 `.msg-markdown` root 数、`#messages *` 节点数、
  longtask 与每页“加载更早”耗时。

### P0 同轮修复：旧 Agent 注册表合并

见 §4。

## 2. 基准对比（本机 headless，500 条）

同一台机器、同一 fixture、同一脚本；基线为 `8a72052` 的 `git archive` 副本
（仅给 `verify-web.ts` 加测试导出与 `import.meta.main` 守卫，不改应用代码），
优化后为 `af0cbb3` 工作区。原始数字：
`/tmp/web-perf-baseline-500.json` 与 `reports/evidence/web-perf-after-500.json`
（后者为本次报告同目录证据，见提交）。

| 指标 | 基线 8a72052 | 优化后 af0cbb3 |
| --- | ---: | ---: |
| 首屏 50 条 `.msg-markdown` root | 35 | 2 |
| 首屏 `#messages *` 节点 | 601 | 399 |
| 500 条加载后 `.msg-markdown` root | 350 | 67 |
| 500 条加载后 `#messages *` 节点 | 5,956 | 4,143 |
| 加载完全部历史总耗时 | 4,319 ms | 3,925 ms |
| “加载更早”单页中位/最大 | 29 / 43 ms | 18 / 32 ms |
| longtask 数量 / 总时长 / 最大 | 0 / 0 / 0 | 0 / 0 / 0 |

结论：

- 首屏 root 数从 35 降到 2（只挂视口内），全量已加载后 root 数从 350 降到 67；
  67 是本次浏览过程中曾进入视口的消息并集，不是全量 500。
- 关掉 eager Streamdown 后，纯文本消息不再生成 Markdown 包装节点，DOM 节点数
  同步下降。
- “加载更早”中位耗时下降约 41%；该耗时从 `scrollTop=0` 到消息数增加，
  包含插入与首轮懒升级。
- **限制**：headless Chromium 在该 fixture 上未产生 longtask（两侧均为 0），
  因此 longtask 指标本轮不能区分改动；500 档可自动跑，2000 档未在本轮执行。

## 3. 测试

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run test:web` | 通过，2142 项（基线 2132） |
| `bun scripts/verify-q04.ts` | `Q04 PASS checks=176` |
| `bun run test:protocol` | 通过，991 项 |
| `bun run test:web:perf`（500） | PASS：roots 2→67，DOM 4,143，olderMedian 18 ms |
| `bun run test:acceptance` | 本轮未跑（时间与工具上限；未声明通过） |

浏览器验收的调整：

- 长历史断言从“三页后至少 160 个 `.msg-markdown`”改为“只挂可见区域 + 滚动
  进入后升级 + 代码/表格/@ 高亮内容等价”。
- 14a/14c-3/14e/14f 等原 `.msg-markdown` 计数改为可见预算或懒升级稳定性等待；
  14c/14d 锚点漂移、时间胶囊、发送/回执不变量保留。
- 14f-1c 自动加载边界改为每次按当前 `scrollHeight` 计算阈值，避免懒升级改变
  高度后使用过期滚动距离。

## 4. P0：合并旧 Agent 注册表修复群成员候选

- `src/web/chat-agents-script.ts`
  - `agentRegistryRead` 同时读取 per-actor key 与 legacy 全局 key，只保留
    `owner_actor_id === 当前 human` 的条目；按 `actor_id` 去重，per-actor 优先。
  - `agentRegistryWrite` 仍只写 per-actor；legacy 数据不删除。
  - `agentRegistryAdd` 在合并结果上写入 per-actor，新建 Agent 不会让 legacy
    条目再次消失。
- `scripts/verify-web.ts` 2b-2b 回归：
  - seed legacy 2 个 Agent + per-actor 1 个 Agent + 同 actor 的 per-actor 覆盖名
    + 其他 owner 条目；
  - 建群选择器断言 3 个本机 Agent 全部出现、同 actor 只出现一次、per-actor 名称
    优先、其他 owner 不出现、受管 Agent 仍合并；
  - 选中 per-actor 与 legacy Agent 创建成功；
  - 添加成员选择器列出 legacy 覆盖名，加入后服务端成员包含对应 actor。

## 5. 与第 2 波增量 DOM 的边界

- 本轮 `renderMessageList` 仍是“整表 fragment 重建”：刷新会销毁并重新懒挂
  Markdown root，尚未按 `message_id` 跨重建移动 handle。保证的是：
  - 构建期零布局读取；
  - 离屏消息不再创建 root；
  - 已挂载 root 在同一气泡的 update/展开路径复用。
- 第 2 波做增量 patch 时可直接使用：
  - `appendHistory` 返回的首/末节点与 `lastTimestamp` 做 seam；
  - `taskMarkerVersion` + 节点索引做任务标记增量；
  - 懒 Markdown 队列与底部 300px 观察器作为“新增节点默认纯文本”的入口；
  - 如需跨重建复用 root，可按 `message_id` 缓存 wrapper 并移动 DOM，而不是
    重新 `createRoot`。
- 本轮未做窗口化；已挂载过的 root 会随浏览历史累积（500 条基准为 67）。
  root 预算/窗口化仍属第 3 波。

## 6. 限制

- 基准是本地 headless 同机对比，不是生产 RTT；数字只用于同机前后比较。
- 2000 条档未执行；longtask 在该 fixture 上为 0，不能作为收益证据。
- 懒 Markdown 的“视口上方延后升级”依赖滚动事件唤醒；如果布局在无滚动情况下
  变化，视口上方消息会保持纯文本直到下次滚动。
- 时间胶囊被移除时不再作为阅读锚点，改用消息节点；这是有意的稳定性修正。
- 未运行全量 acceptance；未部署。
