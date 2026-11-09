# 好友弹窗两栏、好友/Agent/群聊筛选与右键菜单整理

状态：READY_FOR_REVIEW

- 工作树：`/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack`
- 分支：`fix/webots-parity-pack`
- 基线：`e7a9af5`（已部署）
- 功能提交：`850c77c`
- 服务端：无改动、无迁移；工具契约与好友链接逻辑不变。

## 目标

1. 好友申请弹窗从纵向堆叠改为桌面左右两栏，窄屏回到单栏。
2. 侧栏筛选从“单聊/群聊”改为“好友/Agent/群聊”，旧值自动迁移。
3. 会话右键菜单按管理动作到安全动作重排，压缩说明文案并加分组分隔线。

## 布局与语义

### 好友申请弹窗

- 桌面（≥ 760px）为两栏网格，卡片宽度上限 880px：
  - 左栏：我的接收策略、待处理好友申请（申请列表与状态行）。
  - 右栏：好友链接（生成/复制/状态/已生成列表）、我的好友。
- `< 760px` 回退单栏：先接收策略与待处理申请，再好友链接与我的好友。
- 所有既有 DOM id/class 保留（`contact-policy-select`、`contact-request-*`、`contact-link-*`、`contact-friend-list` 等），按钮与列表行为未改。
- 1280px 与 390px 均断言不横向溢出；暗色沿用既有变量。

### 侧栏筛选

- 顺序与默认值：好友 → Agent → 群聊；默认 `friend`，`aria-selected` 与 `room-list` aria-label 同步。
- `localStorage['agent-network-room-filter']`：
  - `agent` / `group` 原样恢复；
  - 旧 `direct` 或缺失值统一迁移为 `friend`，不再写回旧值。
- 过滤规则：
  - `group`：`kind === 'group'`。
  - `agent`：`kind === 'direct' && peer_kind === 'agent'`。
  - `friend`：`kind === 'direct' && peer_kind !== 'agent'`；peer 未知时暂归好友，`fillDirectPeers` 补全后自动移入 Agent。
  - 归档 Agent 继续由 `isArchivedAgentRoom` 排除。
  - 当前 `activeRoom` 在 direct 分类中额外保留，避免 peer 后补全时突然消失。
- 进入房间：
  - group → 群聊；
  - direct 且 `peer_kind === 'agent'` → Agent；
  - direct human/unknown → 好友；
  - 列表条目尚未加载时不切换，避免无信息时把当前会话移走；
  - 房间详情返回后再次同步，覆盖深链首次加载时 peer 尚未补全的情况。
- 空态：
  - 好友：“还没有好友会话。通过好友申请或好友链接添加后即可开始。”
  - Agent：“还没有 Agent 会话。打开 Agent 分享链接即可开始。”
  - 群聊：“还没有群聊。点击右上角 + 新建群聊。”

### 会话右键菜单

- DOM 顺序固定为：
  复制 Agent 连接提示词 → 交接管理权 → 归档 → 停用/启用 Agent →
  注销并重发 token → 分隔线 → 举报 → 拉黑 → 删除好友 → 退出群聊 → 解散群聊。
- 仅显示当前房间适用的项，沿用既有 `hidden` 规则、危险样式与工具调用。
- `#room-menu-safety-hint` 改为一行短提示：
  “删除好友保留历史；拉黑拒绝新私聊/申请/邀请；退群不影响好友。”
- 管理动作与安全动作之间新增 `.room-menu-sep` 分隔线；危险项仍保留原红底样式并排在末尾。
- 390px 不横向溢出；键盘、焦点与关闭行为未改。

## 验收

| 检查 | 结果 |
|---|---|
| `bun run typecheck` | 通过 |
| `bun run test:web` | 通过 2228 项（基线 2198，新增 30） |
| `bun scripts/verify-q04.ts` | 通过 176 项 |
| `bun scripts/verify-isolated.ts protocol` | 通过 998 项 |

`verify-web` 新增覆盖：

- 默认好友分类、三 tab 顺序与 aria-label。
- Agent 单聊只在 Agent、人类单聊只在好友、群聊只在群聊。
- 旧 `direct` 值迁移、筛选持久化、进入 Agent/群聊自动切换。
- active Agent 在好友分类保持可见。
- 好友弹窗 1280px 两栏、390px 单栏与左右内容归属。
- 右键菜单顺序、分隔线与短提示文案。

## 限制

- 未部署、未建 PR、未改主 checkout；Q04 证据截图（14 个已修改的二进制文件）未提交，保持工作区原有未提交状态。
- 好友弹窗只调整 Web 布局，不改变好友申请、好友链接或联系人的服务端契约。
- active direct 房间在好友/Agent 两个 direct tab 都保留可见，这是为避免 peer 异步补全导致当前会话消失的有意例外；其余非 active 会话严格按分类过滤。
- `test:web` 的归档加载态用例对并发 `network_agents_get` 的路由延迟做了容错；不改变页面行为。
