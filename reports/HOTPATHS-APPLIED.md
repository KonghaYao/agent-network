# Hotpaths + Tibo review patch 合并记录

## 基线

- Hotpaths 基线：`c8584fe7def6b20adb5d531f16942fd0eba77913`
- Tibo patch 基线：`fb538d2a72dd2f90396f69ac7b5ed05cdb950618`，已在 `aefec56` 应用
- 合并 commit：`bcaf36d`（parents：`2fdf74c` hotpaths、`aefec56` Tibo patch）
- 无数据库迁移、无依赖升级；hotpaths 新增 `network_room_rename` 工具，工具面 130。

## 应用方式

1. 从 `c8584fe` 创建临时 worktree，应用 `webots-hotpaths-c8584fe.patch`，提交 `2fdf74c`。
2. merge `fix/webots-parity-pack`（`aefec56`），4 个文件冲突：`chat-members-script.ts`、`chat-outbox-script.ts`、`chat-script.ts`、`chat-session-script.ts`。
3. 以 hotpaths 版本为基线，重新补入 Tibo patch 的增量，保留双方修复，提交 `bcaf36d`。

## 冲突处理

| 文件 | 保留的 hotpaths | 保留的 Tibo / 既有 |
|---|---|---|
| `chat-script.ts` | 提交逻辑拆分、`composerRequests`/`syncComposerSendState`、`sentMentionSelections`、`outboxFinishCommitted`、建群移入 `chat-group-create-script.ts` | `composerSendingRooms` 独立发送锁、`composerDraft` 输入快照、跨房间迟到结果保护；建群 generation/hidden 守卫由 hotpaths 新脚本提供 |
| `chat-outbox-script.ts` | `outboxFinishCommitted` 的 mention/附件独立消费 | `composerDraft` 精确快照：离开房间后只清理提交时的原文 |
| `chat-session-script.ts` | `syncComposerSendState()` 统一按钮状态、增量时间线/房间隔离 | 长缓存切房 `longCache` / `ROOM_CACHE_RENDER_MAX`；`composerSendingRooms` 并入 `syncComposerSendState` |
| `chat-members-script.ts` | `formGeneration`、invitations 计数、候选剔除、成员菜单 | 先 `applyRoomDetail(result)` 同步权威房间状态，再按 generation/hidden 丢弃迟到 UI；关闭弹窗递增 token |

## 合并后标记核对

- `composerSendingRooms`、`composerDraft`、`syncComposerSendState`：发送锁与草稿快照
- `longCache`、`ROOM_CACHE_RENDER_MAX`：长缓存不预渲染全部历史
- `deliveryExecutionGuards`：delivery retry/claim 事务权限
- `network_room_rename`、`chat-group-profile-script.ts`、`chat-timeline-render-script.ts`、`chat-history-script.ts`、`chat-group-create-script.ts`：hotpaths 重构
- `verify-hotpaths.ts`、`verify-web-modal-races.mjs`、`verify-web-send-races.mjs`、`verify-web-pairing-races.mjs`：双方专项

## 合并后验证

| 验收 | 结果 |
|---|---:|
| `bun run typecheck` / `bun run typecheck:tsc` | 通过 |
| hotpaths 专项（`bun run test:hotpaths`） | 26 组通过，页面异常 0 |
| 协议（`verify-isolated protocol`） | 991 项，130 工具 |
| 业务/通知（`verify-isolated acceptance`） | 2718 项 |
| 浏览器（`bun run test:web`） | 2174 项，页面异常 0 |
| Q04（`bun scripts/verify-q04.ts`） | 176 项 |
| delivery 授权 | 92 项 |
| 任务附件访问 | 67 项 |
| modal / pairing / send 竞态 | 全部 PASS（modal/send 已适配 hotpaths 文件拆分） |
| 服务端性能（`bun run test:perf`） | 19 项 |
| 网页性能 500 条 | roots 2→65，DOM 4120，加载更早中位 28ms |
| 网页性能 2000 条 | roots 2→135，DOM 15670，加载更早中位 30ms |

上游 hotpaths 包原始证据保存在 `reports/evidence/hotpaths/`；上游 `REPORT.md` 保存在 `reports/2026-11-09-web-hotpaths-REPORT.md`。`reports/2026-11-09-web-hotpaths.md` 为补丁自带报告。

## 限制

- 上游性能数字（500 条 81.0→50.6ms、2000 条 211.1→62.1ms）来自其 c8584fe 环境；本次合并后只记录了结构指标与加载更早中位值，未重跑同一 A/B 计时。
- modal/send 竞态脚本按 hotpaths 文件拆分做了测试适配，仍为隔离异步处理函数测试；真实浏览器覆盖由 `test:web` / Q04 提供。
- Q04 截图由本次运行重新生成，保持未提交，避免二进制噪声。
- 合并后未部署；部署由主控在独立验证后执行。
- 长历史已加载 DOM 仍无固定上限；2000 条结果不外推为无限历史的内存保证。
