# TIBO-PATCH-APPLIED：Tibo review patch 应用与验证

- 状态：READY_FOR_REVIEW
- 分支：`fix/webots-parity-pack`
- 应用前 HEAD：`c8584fe`（已部署的生产版本）
- patch 原始基线：`fb538d2a72dd2f90396f69ac7b5ed05cdb950618`
- 交接说明：`reports/TIBO-REVIEW-HANDOFF-2026-11-08.md`
- patch 存档：`reports/patches/webots-review-fb538d2.patch`
- patch SHA-256：`d8212efd73a010dfddf43185bb6dd334d420fe7361c958f3f1bdb647be3e0804`（50,951 字节，与交接说明一致）
- 部署：本报告记录提交与验证结果；生产部署由主控在验证通过后执行。

## 应用方式

```bash
git apply --3way reports/patches/webots-review-fb538d2.patch
```

patch 涉及 13 个文件（+555 / -107）：

- 后端：`src/domain/deliveries.ts`、`src/domain/tasks.ts`
- 前端：`src/web/chat-members-script.ts`、`src/web/chat-outbox-script.ts`、
  `src/web/chat-script.ts`、`src/web/chat-session-script.ts`、`src/web/pair.ts`
- 回归脚本：`scripts/verify-delivery-authorization.ts`、
  `scripts/verify-task-attachment-access.ts`、`scripts/verify-web-modal-races.mjs`、
  `scripts/verify-web-pairing-races.mjs`、`scripts/verify-web-send-races.mjs`
- 既有单测：`scripts/lib/task-attachment-gc-unit.ts`

应用后 `git diff --cached` 与 patch 文件清单一致，无冲突标记，无 token、凭据或生产数据。
patch 内 `secret.txt` 仅是测试 fixture 文件名，不含真实内容。

## 冲突处理

只有 `src/web/chat-session-script.ts` 需要 3-way 合并：

- 上游 `c8584fe` 已在 `applyCachedRoom` / `openRoom` 引入长缓存切房修复
  （`longCache`、`ROOM_CACHE_RENDER_MAX`，超过阈值的缓存不整段预渲染）。
- patch 的同一文件只有两处发送锁修复：`clearChatError` 与 `openRoom` 用
  `composerSendingRooms.has(...)` 决定发送按钮状态。
- 合并结果保留双方：长缓存分支与 `renderItems: false` 逻辑原样保留，发送按钮
  改为查询按房间独立的发送锁。其余 12 个文件按 patch 原样应用，无冲突。

## 每项 P1 的修复点与测试证据

### P1-1 撤销成员、拉黑或解散群后旧 delivery 仍可 retry

- `src/domain/deliveries.ts:295` 新增 `deliveryExecutionGuards`：同一事务内复查
  群解散、direct 拉黑、成员资格与历史边界、actor 停用、mute_mentions 拉黑。
- claim 在 `src/domain/deliveries.ts:338` 接入这些闸门。
- retry 在 `src/domain/deliveries.ts:742` 额外检查调用者仍是成员、调用者是
  recipient/发送者/群 owner，并按 `LIMITS.pendingPerActor` 复查队列上限。
- 证据：`bun scripts/verify-delivery-authorization.ts` → 92 项断言通过。

### P1-2 创建任务引用不可见、已删除或过期附件

- `src/domain/tasks.ts:1126` 的 `validateAttachments` 在提交前同时检查房间文件
  可用性、历史可见性（`visibleCreated(file, boundary)`）与 Drive 文件可用性。
- `src/domain/tasks.ts:1158` 的事务闸门复查 active 成员、保留/过期状态、
  历史边界（`created_seq` / `joined_at`）以及 Drive 删除或过期。
- 证据：`bun scripts/verify-task-attachment-access.ts` → 67 项断言通过。

### P1-3 设备配对旧兑换响应串用新一轮 token/身份

- `src/web/pair.ts:63` 起新增 `pairingGeneration`、`pairingChallenge`、
  `credentialReady`。
- join/redeem 在响应返回后核对 generation；挑战码与 token 在提交时固定，
  输入框后续编辑不影响进行中的轮次。
- 只有成功 redeem 才置 `credentialReady`；切换身份要求已兑换，清理使用
  固定的 `pairingChallenge`，不读取当前输入框。
- 证据：`node scripts/verify-web-pairing-races.mjs` → PASS（旧成功/失败隔离、
  挑战与 token 不可变、兑换后才激活、清理键稳定）。

### P1-4 建群与添加成员的迟到响应覆盖新状态

- `src/web/chat-script.ts:835` 起，建群提交增加弹窗可见、按钮未禁用与
  `groupLoadSeq` 轮次检查；成功、失败与 finally 都只处理当前轮次。
- `src/web/chat-members-script.ts:765` 记录 `membersLoadToken`；提交结果仍会
  同步房间详情，但只有轮次未变且弹窗仍打开时才清空选择、报错或释放
  `membersBusy`。
- 证据：`node scripts/verify-web-modal-races.mjs` → PASS（单次提交、正常完成、
  关闭/重开后的成功与失败、成员弹窗轮次隔离）。

### P1-5 刷新或切换房间解除发送锁导致重复消息

- `src/web/chat-script.ts:150` 新增独立于按钮状态的 `composerSendingRooms`。
- 提交处理在 `src/web/chat-script.ts:610` 按房间拒绝重入，`618` 加锁，
  整个对账与发送过程包在 try/finally 中；`710` 按房间释放，只有当前房间
  才重新启用按钮。
- `src/web/chat-session-script.ts:372`（`clearChatError`）与 `917`（`openRoom`）
  改为查询发送锁，刷新或切房不再把在途发送解锁。
- 证据：`node scripts/verify-web-send-races.mjs` → PASS（刷新保持锁、重复回车
  不新增意图、不同房间独立发送、旧房间完成不影响新房间、失败释放锁）。

### P1-6 跨房间迟到成功响应删除新草稿

- `src/web/chat-script.ts` 提交时保存 `composerDraft` 快照并传给 outbox。
- `src/web/chat-outbox-script.ts:393` 在离开房间后只清理与提交快照一致的草稿，
  后续编辑或新草稿保留。
- 证据：同 `verify-web-send-races.mjs` 的草稿快照场景 → PASS。

### GC fixture 调整

`scripts/lib/task-attachment-gc-unit.ts` 将附件初始状态改为有效且可见，建立
任务保留后再模拟过期，保留原有清理断言，不降低覆盖。

## 门禁结果

| 门禁 | 命令 | 结果 |
| --- | --- | --- |
| 类型检查（tsrs） | `bun run typecheck` | PASS |
| 类型检查（tsc） | `bun run typecheck:tsc` | PASS |
| 建群/成员竞态 | `node scripts/verify-web-modal-races.mjs` | PASS |
| 配对竞态 | `node scripts/verify-web-pairing-races.mjs` | PASS |
| 发送/草稿竞态 | `node scripts/verify-web-send-races.mjs` | PASS |
| delivery 授权回归 | `bun scripts/verify-delivery-authorization.ts` | 92 项通过 |
| 任务附件访问回归 | `bun scripts/verify-task-attachment-access.ts` | 67 项通过 |
| 协议验收 | `bun run test:protocol` | 991 项通过 |
| 全量 acceptance（短 presence） | `bun run test:acceptance` | 2718 项通过 |
| 浏览器验收 | `bun run test:web` | 2171 项通过 |
| Q04 桌面/移动端 | `bun scripts/verify-q04.ts` | 176 项通过（Q04 PASS） |
| 性能 small | `bun run test:perf` | 19 项检查 PASS |
| 空白检查 | `git diff --check` | 无输出 |

全量 acceptance 使用本地临时服务与短 presence 窗口：
`AGENT_PRESENCE_ACTIVITY_TTL_MS=5000`、`AGENT_PRESENCE_GRACE_MS=2000`、
`AGENT_PRESENCE_SWEEP_MS=1000`。该配置下 2718 项全部通过，无失败项。

新增测试规模：两个后端脚本共 159 项断言（92 + 67），三个 UI 异步竞态脚本
分别输出 PASS；本次未修改或删除既有断言。

## 残余限制

1. `verify-web-*-races.mjs` 是隔离执行生产内联处理函数的异步场景测试，不是
   真实浏览器端到端；本次已额外跑通 `test:web` 2171 项与 Q04 176 项，但仍
   不能覆盖所有真实网络时序。
2. patch 未包含 Tibo-for-dots 连接器的好友申请/接受/拒绝/撤销工具缺口；
   旧房间在无 active 好友关系时仍可能返回 `FRIEND_REQUIRED`，需要连接器与
   schema 单独更新，不能靠放宽服务端权限解决。
3. 短 presence 窗口是本地验收配置，不代表默认 30s/60s 窗口下的全部等待时序；
   本次与既有 acceptance 基线一致。
4. 全量门禁在 `c8584fe + patch` 上完成；交接说明提到的远程 main `d7cb314`
   组合未在本分支重复验证。
5. 紧凑的 `git apply --3way` 合并依赖当前上游长缓存实现；后续若再次改动
   `openRoom` / `applyCachedRoom`，需要重新检查发送锁与缓存渲染的交互。
