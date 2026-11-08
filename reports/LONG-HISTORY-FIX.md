# LONG-HISTORY-FIX：长历史按可见分片加载与会话列表分页

- 状态：READY_FOR_REVIEW
- 基线：`ca839bc`（docs(reports): 记录 UI-WAVE-2 验收与限制）
- 结果 SHA：`17031f9`（fix(web): 长历史按可见分片加载与会话列表分页）
- 分支：`fix/webots-parity-pack`
- 部署：未部署。按约定由主控执行发布。

## 根因

1. **长历史首屏请求风暴**：`src/web/chat-render-script.ts` 的 `messageItem`
   对当前页每条 Agent 截断消息立即调用 `autoExpandAgentMessage`。一页 50 条
   会同时发起大量 `network_message_read`（每条还可能多次分片），长历史房间
   首屏卡顿并造成请求风暴。
2. **会话列表静默截断**：`src/web/chat-list-script.ts` 的 `loadRooms` 只请求
   `network_rooms_list { limit: 50 }`，忽略 `next_cursor` / `has_more`；
   超过 50 个会话后，旧会话无法继续加载。

## 修复

### A. 长消息按可见分片自动展开

- `src/web/chat-render-script.ts`
  - 新增视口观察：`IntersectionObserver` 的 `root` 为消息滚动容器
    `#messages`，`rootMargin` 约 200px；只有进入视口附近的候选才入队。
  - 自动展开队列并发上限 2；同一 `message_id` 继续复用 `readMessageShared`，
    避免刷新重建节点时重复读取；正文仍由现有 `readMessage` 按分片读取。
  - 仅 `body_bytes <= LIMITS.webAgentAutoExpandBytes`（16KB）的 Agent 截断
    消息参与自动展开；超过阈值的消息保持手动「展开全文」。
  - 未进入视口的候选保留可点击按钮；进入视口入队时隐藏按钮，成功读取后移除，
    失败恢复按钮；成功结果写入 `expandedMessageBodies`，重建 DOM 不再读取。
  - `IntersectionObserver` 不可用时退化为只扫描当前可见/首屏最多 3 条候选，
    其余保留按钮，不退回全量并发。
  - `renderMessageList`、清空消息区、加载失败与退出房间时
    `disconnect`/`unobserve` 并清空待处理队列；加载更早只观察 prepend 的新节点，
    不重建已有节点的观察状态。
- `src/web/chat-session-script.ts`
  - 在 `setChatLoading`/`setChatError` 清空消息区前调用同一重置函数，
    避免房间切换或重新渲染泄漏观察器。

### B. 会话列表分页

- `src/web/chat-list-script.ts`
  - `loadRooms` 保存 `roomsNextCursor` / `roomsHasMore`，首屏仍为 50 条。
  - 新增 `loadMoreRooms`：单飞、去重（按 `room_id` 合并）、按
    `sortRooms` 排序；保留 active 房间与已加载旧条目，新房间插入正确位置。
  - 侧栏滚动接近底部（160px 阈值）自动加载；同时提供明确的“加载更多会话”
    按钮。加载中、失败重试与“已加载全部会话”均有可读状态，不静默截断。
  - 后台刷新（流通知等）只更新/合并命中条目，不把用户已加载的旧页丢回 50 条。
  - 页脚增加 `#room-list-more`（复用现有 `.list-retry` 样式），桌面与移动端
    单栏布局均不新增横向溢出。
- `src/web/chat-panels.ts`
  - 侧栏静态标记增加 `#room-list-more` 按钮。

## 测试

### 新增验收（`scripts/verify-web.ts`）

- 长历史房间：55 条低于 16KB 的 Agent 长消息 + 1 条超过 16KB 的消息。
  - 首屏 50 条中仅视口附近少量消息触发 `network_message_read`：实测首屏
    3 次（3/50），滚动到中部后 3→8，滚动到历史顶部后 9→13/56；未进入视口
    的消息保留展开按钮。
  - 滚动到中部触发增量读取，读取数只小幅增加；超过 16KB 的消息手动展开成功。
  - 点击「加载更早」按一个游标分片补齐 56 条，无重复消息；prepend 不批量读取；
    滚动到历史顶部后仍只读取视口附近消息。
- 会话列表：新建 55 个群会话。
  - 首屏只请求一页 50 条且不带游标；active 房间正确。
  - 分页请求失败时可读并可重试，已加载的 50 条与 active 房间不丢失。
  - 按钮重试后加载到 55 条，第二页带游标且 limit 50，无重复；active 房间与
    聊天标题不变；到底显示“已加载全部会话”。
  - 390px 首屏与分页后均不横向溢出。

### 结果

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run test:web` | 通过，2119 项（基线 2090，新增 29 项）；首屏读取 3/50，滚动后 3→8，历史顶部 9→13/56 |
| `bun scripts/verify-q04.ts` | `Q04 PASS checks=176` |
| `bun run test:protocol` | 通过，991 项（本地 8792 + 临时 `DATA_DIR`，`PUBLIC_ORIGIN=http://127.0.0.1:8792`） |

## 限制

- 自动展开只覆盖 16KB 以内的 Agent 截断消息；更大的消息仍由用户手动展开。
- 已在读取中的请求无法取消；房间切换后依靠节点 `isConnected` 丢弃结果，
  网络请求本身仍会完成。
- 会话列表按页加载但不做虚拟滚动；已加载的 DOM 会随页数增长。分页游标由
  服务端 `updated_at` keyset 决定，客户端只负责去重与本地排序。
- 分页按钮与滚动自动加载共用单飞锁；失败后不会无限自动重试，需要用户点击
  按钮或重新进入页面。
- 本次未运行全量 acceptance；协议验收需要显式启动本地 8792 服务。
