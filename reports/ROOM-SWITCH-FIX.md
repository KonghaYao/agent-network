# ROOM-SWITCH-FIX：长缓存切房只渲染最新页

- 状态：READY_FOR_REVIEW
- 基线：`d7cb314`（docs(perf): 记录第 1 波客户端长上下文优化与基准）
- 结果 SHA：`1cdc69f`（fix(web): 长缓存切房不预渲染全部历史）
- 分支：`fix/webots-parity-pack`
- 部署：未部署。按约定由主控执行发布；未建 PR。

## 根因

`src/web/chat-session-script.ts` 的 `openRoom` 命中 `roomCache` 时调用
`applyCachedRoom(cache)`，把该房间 `currentItems`（用户此前加载更早后的全部
历史，可能数百条）直接交给 `renderMessageList` 整表渲染；随后仍会
`await refresh(true)` 取最新页并再次整表渲染。切回长会话时，首次渲染成本与
已加载历史成正比，且立刻被第二次渲染覆盖。短会话（默认 50 条）不易感知，
长会话放大为 P0。

## 修复

### 阈值

`src/contracts/limits.ts` 新增 `webRoomCacheRenderMax: 80`，由
`CHAT_SESSION_SCRIPT` 注入为 `ROOM_CACHE_RENDER_MAX`，不在调用点硬编码。

### `applyCachedRoom(cache, options)`

- 新增 `renderItems` / `itemsLimit`。无论是否渲染消息，room、members、
  invited、ownerTransfer、header、drafts、composer 与滚动收口都立即应用。
- `cache.items.length > webRoomCacheRenderMax` 时：
  - `currentItems = []`，不调用 `renderMessageList` 渲染整段历史；
  - `setChatLoading(true, { keepContent: false, skeleton: true })` 清空消息区，
    显示加载条与骨架；
  - `olderEnded = false`、`nextOlder = null`、`timelineResumeCursor = null`，
    旧游标不会跳过最新页；分页状态由 `fetchLatestPage` 重新建立。
- 短缓存（`<= 80`）保持原路径：整段缓存立即渲染、恢复到底状态与草稿、
  回到底部。

### `openRoom`

- 缓存超过阈值时调用 `applyCachedRoom(cache, { renderItems: false })`，不预渲染
  历史，随后 `refresh(true)` 只取最新页（默认 50 条）。
- 短缓存仍即时预览并在刷新后校准，行为不变。
- 长缓存刷新失败时不再保留空白或旧长缓存：走 `handleRoomError` 显示可读错误与
  `#chat-error-retry` 重试入口；短缓存失败仍保持原有“旧预览 + 状态栏提示”。

## 测试

### 新增 `scripts/verify-web.ts` 切房场景

- 长缓存：会话预置 150 条消息，进入后加载更早到 150 条；切到短会话再切回。
  延迟最新页请求期间断言消息数为 0（`<= webRoomCacheRenderMax`）、显示加载条
  与骨架、标题来自缓存、草稿保留、无错误；放行后断言最终只有最新页 50 条、
  无重复、仍到底；点击加载更早可到 100 条且无重复。
- 短缓存：6 条会话切回后同步立即显示 6 条，无加载条/骨架/错误，刷新后仍为
  6 条。
- 失败与重试：长缓存刷新返回错误时显示可读错误、消息区为空、提供重试；重试后
  恢复最新页 50 条并隐藏错误。
- 390px：长缓存切回后的页面与消息区均不横向溢出。

### 结果

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run test:web` | 通过，2171 项（基线 2142，新增 29 项）；长缓存切回加载态 0 条，最终最新页 50 条，加载更早 100 条 |
| `bun scripts/verify-q04.ts` | `Q04 PASS checks=176` |
| `bun run test:protocol` | 通过，991 项（本地 8792 + 临时 `DATA_DIR`，`PUBLIC_ORIGIN=http://127.0.0.1:8792`） |

### 既有断言

- 未删除既有断言；短缓存切回、加载更早、草稿/成员/header、回执、scroll 锚点
  与 presence 用例保持原样并通过。
- 只在 `scripts/verify-web.ts` 增加独立验收函数，不改变既有场景的数据规模或
  断言条件。

## 限制

- 阈值按“已加载条数”而不是字节/节点高度；少量超大消息仍可能让最新页渲染
  偏慢，本轮不引入窗口化。
- 长缓存只限制渲染；`roomCache` 仍保留完整已加载历史（最多 20 个房间），
  本轮不做内存截断。
- 长缓存切回会重新请求最新页并重建分页游标，用户此前“加载更早”的位置不保留；
  这是避免旧游标跳过最新页的取舍。
- 未运行 `test:acceptance`；未做生产环境 RTT/长任务实测，新增断言验证的是
  “不预渲染全部历史”的结构性行为。
- 未部署；部署由主控执行。
