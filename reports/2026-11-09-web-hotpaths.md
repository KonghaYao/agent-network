# WeBots 聊天与群组热点重构

基线：`KonghaYao/agent-network`，`c8584fe7def6b20adb5d531f16942fd0eba77913`。日期：2026-11-09。改动已在本地实现，交付补丁、修改后的源码与验收证据；未发布到线上。

## 已完成

聊天刷新改为按稳定 key 更新消息和侧栏节点；历史分页、时间线渲染、建群与群资料从大脚本中拆出。房间切换、弹窗打开、请求提交分别有明确的状态归属，迟到响应只处理对应操作。群名编辑复用既有权限与事务，无数据库迁移、临时表或依赖升级。

| 热点/触发方式 | 修复后的行为 | 主要位置 |
|---|---|---|
| 长历史收到消息或回执，整段 DOM/Markdown 被销毁重建 | 保留未变化的消息、React root、全文与侧栏节点；只增删变化部分，回执单独更新 | `chat-timeline-render-script.ts`、`chat-list-script.ts` |
| 展开纯文本 Agent 消息后反复读取；Markdown 首次 404 后无法恢复 | 纯文本全文视为成功；全文缓存限制为 256 条/4 MiB；失败资源允许一次独立 URL 重试 | `chat-render-script.ts`、`chat-markdown-script.ts` |
| 无缓存切群仍显示旧群消息；旧刷新收尾影响新会话 | 立即清空旧消息和成员状态、显示加载态；roomId + epoch 隔离；统一销毁观察器/root/定时器 | `chat-session-script.ts`、`chat-router-script.ts` |
| 请求历史期间用户继续滚动 | 在结果应用前记录当前位置，前插后恢复当前阅读锚点 | `chat-history-script.ts` |
| 消息发送未返回时写下一条草稿并切群；附件单独重试 | 迟到结果保留新草稿，仅清理本次已发送附件；文件-only 重试正确清理附件 | `chat-outbox-script.ts`、`chat-script.ts` |
| 消息提交成功后切群取消刷新，或后续刷新返回 503 | 提交结果与刷新结果分离；不抛未捕获异常，不把成功消息标成发送失败或提供重复发送入口 | `chat-outbox-script.ts` |
| 上传中点发送，附件未完成却只发出文字 | 统一计算发送可用状态，上传完成后才可发送；聊天刷新不会提前解锁 | `chat-upload-script.ts`、`chat-script.ts` |
| 删除旧 @ 后重新选择同名成员；发送中继续输入下一条 | 清理已不在正文中的旧 actor 选择；成功只消费本次提交的选择，保留发送期间的新选择；新选择决定实际 invoke，正文草稿持久保存 | `chat-mention-script.ts` |
| 成员改名/成员变化后，保留节点里的 @ 高亮过期 | 成员名称版本变化时更新消息内容；普通刷新继续复用节点 | `chat-timeline-render-script.ts` |
| 群资料入口不完整，退群/解散藏在右键菜单 | 群头部提供“群设置”：改名、成员搜索/选择、邀请、退出或解散；移动端操作按钮固定可见 | `chat-group-profile-script.ts`、`chat-panels.ts`、`chat-group-styles.ts` |
| 连点建群、关闭重开表单、创建响应丢失 | 单飞提交；按表单代次隔离；相同创建意图重试同一 request_id，只创建一个群 | `chat-group-create-script.ts` |
| 成员或邀请响应迟到；其他设备已加人成员仍可勾选 | 按打开代次和房间 epoch 校验；从权威结果统计成功/邀请状态，剔除失效候选 | `chat-members-script.ts`、`chat-invites-script.ts`、`chat-member-picker.ts` |
| 新消息刷新关闭成员操作菜单 | 只在成员、邀请、角色或能力真的变化时更新成员视图 | `chat-session-script.ts` |
| 退出后台群导致当前页面重载；旧列表把退群重新加回 | SPA 内更新对应群；在途列表记录失权条目，迟到结果不复活群；其他设备的 left/removed 同样清理列表和缓存 | `chat-safety-script.ts`、`chat-stream-script.ts`、`chat-list-script.ts` |
| 公告或群名被并发覆盖 | 公告使用打开时的 revision；群名使用 expected_title 事务 CAS；失败保留草稿，群名响应丢失可复用请求 ID 重试，旧表单响应不能回滚新群名 | `chat-announcement-script.ts`、`room-profile.ts` |

## 群名契约

新增 `network_room_rename { request_id, room_id, title, expected_title }`，名称 trim 后 1–160 字符。`edit_profile` 能力统一在 `room-access.ts` 派生，遵循现有 `member_profile_policy`：owner/admin 或策略允许的 active member；事务内再次检查权限、解散状态和当前名称。两次并发改名使用同一旧名称时，只允许一个成功，另一个返回 `VERSION_CONFLICT`。

改名只更新现有 `rooms.title/updated_at`，复用 operations 幂等记录与持久 events/outbox；`room_profile_updated` 通知 active human 刷新资料，不创建聊天消息、delivery 或未读。其他设备通过现有 actor stream 更新群名。此次没有任何迁移文件变动。

## 验收

全部测试使用临时 SQLite 数据目录、随机本地端口和合成身份。运行环境：Linux、Bun 1.4.4、Chromium 141（由 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` 指定）；生产依赖与锁文件未改。

| 验收 | 结果 |
|---|---:|
| `bun run typecheck` / `bun run typecheck:tsc` | 通过 |
| 协议验收 | 991 项通过；130 个工具 |
| 业务/通知验收 | 2718 项通过 |
| 全量浏览器验收 | 2174 项通过，页面异常 0 |
| `bun run test:hotpaths` | 26 组通过，页面异常 0 |
| 500/2000 条完整历史性能夹具 | 4 轮通过；每轮完整加载目标数量，页面异常 0 |
| 补丁在干净基线应用 | 通过；干净基线应用后类型检查通过 |

专项包含：发送成功后刷新取消/失败、节点身份保留、保留已加载历史、无缓存切换/迟到响应、新草稿保护、纯文本展开、公告冲突、改名重放/权限/并发、成员搜索/菜单保持、候选剔除、@ 名称更新、建群单飞/表单重开/丢响应重试、退群迟到列表、重新入群、跨设备退群和移除、解散归档后切换、上传期间禁发、仅附件重试与 390px 按钮可达性。

旧验收中同时校正了可复现的时序假设：本地 outbox 已显示正文不等于服务端提交，消息等待改为匹配真实消息行；配对码必须非空再比较；附件 chip 出现不等于 bind 已完成；房间标题出现不等于历史已加载；气泡用例自建短消息，不依赖可能已翻出首屏的共享历史。无缓存切房与外部加入后的候选断言更新为本次明确的新行为，仍检查真实服务结果和工具调用次数。

发送后切群的 AbortError 已用固定时序复现并修复，修复前失败记录 `evidence/hotpaths-post-send-abort-before-fix.log` 与修复后专项结果一并交付。

## 性能实测

同一台机器、相同夹具与浏览器，基线只增加测量代码；加载全部历史后，各测量 5 次 `refresh(true)`。耗时包含本地 MCP 往返与更新，并非纯 render CPU 时间，也不是线上网络指标。

| 完整历史 | 基线刷新中位数 | 重构后中位数 | 降低 | 保留的消息节点 |
|---|---:|---:|---:|---:|
| 500 条 | 81.0 ms | 50.6 ms | 37.5% | 0 → 500 |
| 2000 条 | 211.1 ms | 62.1 ms | 70.6% | 0 → 2000 |

每次刷新均检查 DOM 对象身份：基线保留 0 条消息节点，重构后完整保留本次加载的 500/2000 条。原始记录包含每次耗时、DOM/root 数和 longtask 指标。

边界：2000 条全部分页加载用时 9.70 → 9.79 秒；分页全过程 longtask 累计 424 → 601 ms，最大单次 101 → 124 ms，未体现一致改善。500 条累计 412 → 208 ms，但最大单次 92 → 116 ms。主要收益是刷新时避免整段历史重建，不把它称为所有加载阶段都变快。每档仅 5 个刷新样本，测量期间另有浏览器回归负载，数值用于本地诊断；稳定节点复用结果不依赖计时波动。

## 复现与应用

在对应基线的干净工作树执行：

```bash
git apply --check webots-hotpaths-c8584fe.patch
git apply webots-hotpaths-c8584fe.patch
bun install --frozen-lockfile
bun run typecheck
bun run typecheck:tsc
bun scripts/verify-isolated.ts protocol
bun scripts/verify-isolated.ts acceptance
bunx playwright install chromium
bun run test:hotpaths
bun run test:web
PERF_WEB_MESSAGES=500 bun run test:web:perf --out perf-500.json
PERF_WEB_MESSAGES=2000 bun run test:web:perf --out perf-2000.json
```

也可通过 `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium` 使用已有浏览器。`verify-isolated.ts` 会启动临时服务并统一测试与服务端的 presence 时间参数，退出清理数据库。

此次验证覆盖上述常用路径与既有完整浏览器用例；没有使用线上流量、Safari 或真实手机。长历史仍采用按需 Markdown 与 content-visibility，已加载消息 DOM 不设固定上限，不将 2000 条结果外推为无限历史的内存保证。
