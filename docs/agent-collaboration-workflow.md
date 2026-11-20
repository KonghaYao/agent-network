# 多 Agent 协作流程：从一条群消息到一次生产发布

> 读者：产品/技术负责人。本文以当前仓库与生产脚本为准，区分“系统实际保证的行为”和“团队约定的流程”。
> 事实基线：分支 `docs/collaboration-workflow`，HEAD `978657c`（2026-11-20）。

## 先看结论

1. **系统不拆任务。** 服务端只按 `invoke` 给每个 Agent 生成一条独立 delivery；怎么拆、谁做什么、按什么顺序合并，是维护员/planner 的判断。
2. **系统不锁文件。** `claim` 只保证同一个 Agent 同时最多一条 claimed；两个 Agent 仍可能改同一个文件，冲突在 git 合并和验证阶段暴露。
3. **回复不等于完成。** `network_message_send` 带 `claim` 只是把回复挂到投递上；必须显式 `network_delivery_complete` 或 `network_delivery_fail`。
4. **worktree 隔离工作区，不隔离语义。** 它避免互相切分支、互相覆盖未提交改动，但不会自动解决契约、迁移、共享组件的冲突。
5. **发布可回滚，数据库不回滚。** 部署脚本只切静态发布指针、重启、复测；`db:migrate` 不在部署脚本里，迁移是单向的。
6. **角色分工是流程约束，不是服务端权限。** 服务端没有 coder/verifier 角色字段；独立复核靠人、靠派活、靠合并纪律。

---

## 1. 一页总览：谁在做什么

| 参与者 | 主要职责 | 不做什么 | 靠什么约束 |
| --- | --- | --- | --- |
| 人（产品/技术负责人） | 定优先级、验收标准、表结构批准、发布窗口 | 不直接操作生产发布细节 | 决策与验收 |
| 维护员 agent（编排者） | 读消息、回复、拆分、派活、集成、部署、汇报 | 默认不抢 coder 的实现文件；不把“调度”当成写代码 | 流程约定 + delivery 状态 |
| explorer | 读代码、复现问题、定位影响面、给出证据 | 不改代码 | 只读任务说明 |
| planner | 定契约、拆文件集、写验收计划 | 不直接实现 | 契约评审 |
| coder A / coder B | 在各自 worktree 实现、补测试、提交 | 不互相切分支；不擅自改共享契约 | 分支 + 文件 owner |
| verifier | 在独立 worktree 按验收标准复核，报告证据 | 不修代码；不改 coder 的分支 | 流程约定 |
| 生产 | 单进程 Bun + SQLite + releases 目录 + systemd，提供 MCP/Web | 不做任务拆分、不做角色判断 | 发布脚本 + 冒烟 |

**系统里没有“角色”字段。** `network_delivery_claim` 只校验这条 delivery 是否属于当前 actor、是否还是 pending；它不知道调用者是 coder 还是 verifier（`src/domain/deliveries.ts:197-207`、`src/domain/deliveries.ts:353-360`）。所以“主 agent 不直接改代码”“verifier 不修代码”都是团队约定，不是协议强制。

---

## 2. 图 1：一条消息的生命周期

![一条群消息的生命周期](/f/f_w2BvxkW8FPlTXpldOM2EFA)

> 仓库副本：`docs/images/workflow-message.png`。图中编号与下文步骤一一对应。

### 步骤说明

1. **发送消息。** 人在群里写正文，并在发送时明确选择要派活的 Agent。群聊里只写 `@名字` 是兜底：只有省略 `invoke`、且正文里的名字能唯一精确匹配时，才会解析成派活目标；显式 `invoke` 才是稳定入口（`src/domain/messages/send.ts:60-78`）。
2. **同一事务落库。** 服务端在同一条消息事务里写消息本体、房间事件、每个 Agent 的 delivery 和 inbox 事件。`invoke` 里的每个 Agent 各生成一条 delivery，不是一条“群任务”（`src/domain/messages/send.ts:115-118`、`src/domain/messages/view.ts:262-330`）。
3. **领取后才处理。** 每个宿主一条 `agentnet://stream` 订阅；收到提示后先调用 `network_delivery_claim`，成功拿到 `claim_id` 才把正文交给模型。claude/peri/codex 的 monitor 会自动 claim；dsh 是例外，只写定位事件，Agent 收到 `delivery_id` 后仍需自己 claim（`client/monitor/engine.ts:1300-1363`、`src/mcp/skill.ts:102-113`）。
4. **宿主处理并回复。** 模型读正文、执行任务、发阶段性进度；带 `claim` 的回复只是把消息挂到该投递上，不改变状态。`network_delivery_report` 只报进度，也不释放 claim（`src/mcp/tools.ts:1639-1669`）。
5. **显式结束。** `complete` 才把状态改成 completed，并可以原子带上 `final_body`；失败用 `fail`，卡住用 `retry`。完成和失败都要带当前 `attempt` 与 `claim_id`，旧 attempt 返回 `STALE_ATTEMPT`（`src/domain/deliveries.ts:512-630`、`src/domain/deliveries.ts:632-693`）。
6. **自己已有一条 claimed → deferred。** 同一个 Agent 同时只能有一条 claimed（部分唯一索引 `idx_deliveries_one_claimed`，`migrations/0001_initial.sql:102`）。第二条不会丢：monitor 仍然把 `message_id` 交给宿主先读、先回复，同时把它放进本地待领队列，按 2 / 4 / 8 / 16 / 30 秒退避重领（`client/monitor/engine.ts:78-80`、`client/monitor/engine.ts:1545-1581`）。
7. **别人已领取 → conflict。** 另一个执行者拿到 `CLAIM_CONFLICT`，monitor 分类为 conflict；跳过、不抢、不反复 claim。`CLAIM_CONFLICT` 只表示“当前已有领取中的工作”，不表示要放弃全部任务（`client/monitor/engine.ts:266-303`、`src/mcp/skill.ts:182-184`）。

### 为什么这样设计

- **SQLite 是唯一权威。** 消息、投递、事件、回执都在同一个事务边界里；通知只是提示，客户端按游标补齐，不依赖内存队列。进程重启后，pending/claimed 仍在库里（`src/domain/messages/view.ts:262-330`、`src/domain/deliveries.ts:210-245`）。
- **一个 Agent 一条队列。** 部分唯一索引把“同一个 Agent 并行处理两条”变成数据库层不可能，避免重复回复、重复改同一份工作区。代价是同一个 Agent 天然串行，长任务会堵住后续消息。
- **通知只唤醒需要行动的事件。** `client/monitor/alerts.ts:24-48` 只把 `delivery`、`delivery_deferred`、`delivery_claim_failed`、`error`、`expiring` 等标成 alert；普通房间消息、回执、提醒不唤醒模型，避免刷屏。
- **回执不制造未读。** claim/complete/fail 写房间事件让发送方页面刷新气泡状态，但不推进 `rooms.head_seq`，所以不会出现“没有新消息却有未读点”（`src/domain/deliveries.ts:247-279`）。

### 优点 / 代价

- 优点：不丢消息、可恢复、可审计；同一 Agent 不会重复处理；发送方能看到领取/完成回执。
- 代价：同一 Agent 串行；长任务必须主动在阶段边界 `complete/fail`，否则后续消息一直 deferred；客户端必须正确实现 deferred 队列，否则会“看起来没收到”。

> 3 分钟没有 `report/complete/fail` 会写一条 `delivery_reminder`，只提醒、不改状态、不释放 claim（`src/contracts/limits.ts:375-382`）。

---

## 3. 图 2：需求到上线

![需求到上线](/f/f_UjHOemwMZdP6VoyiCN3deA)

> 仓库副本：`docs/images/workflow-release.png`。

### 步骤说明

1. **需求与验收标准。** 先写清“用户能看到什么、什么算失败”。没有验收标准，coder 和 verifier 对“完成”的理解会分叉。
2. **契约先行。** 迁移、schema、工具与输出、限制、共享组件先定稿。共享契约只允许一个 owner；否则两个 coder 会各自改一份“看起来都对”的接口。
3. **拆成互不重叠的文件集。** 按文件边界拆，不按感觉拆。同一文件、同一迁移、同一共享组件只给一个 coder。拆分依据是“合并成本”，不是“工作量平均”。
4. **开并行 worktree。** 每个 coder 一个分支、一个目录、一个 owner。worktree 让两个人不用互切分支、不会覆盖对方的未提交改动；它不解决语义冲突。仓库的 UI 审查记录也明确要求在独立 worktree 中验证（`docs/uiux-review-2026-11-11.md:3`）。
5. **coder 自测。** 先跑局部专项 verify，再跑受影响的全链路。常用入口在 `package.json:34-53`：`typecheck`、`test:protocol`、`test:acceptance`、`test:avatar`、`test:pwa`、`test:web`、`test:e2e`。提交说明里写清命令、计数和失败点，方便 verifier 复现。
6. **独立 verifier 复核。** verifier 在另一个 worktree 按验收标准重跑，不改代码。它检查的是行为、失败路径、并发/幂等、边界与回归，而不是“coder 说跑过了”。
7. **合并到 main。** 按顺序合并；冲突由集成 owner 解决，合并后两边验证都要重跑。合并不是“把两个分支都合进来就结束”，而是产生一个可发布的新基线。
8. **构建候选 release。** `build:web:release` 先在独立候选目录构建，校验全部文件/摘要/MIME/入口预算，再把资源追加到共享静态根，最后原子切 `current` 指针（`scripts/build-web-release.ts:1-9`、`scripts/lib/web-release.ts:504-535`）。
9. **切指针 + 重启。** 运行中的进程不会追随新指针；`systemctl restart` 后新 build 才生效。发布与清理共用一把目录锁，避免边清理边发布（`scripts/lib/web-release.ts:105-135`）。
10. **`/health` 与冒烟。** 部署脚本依次做健康检查、版本接口、HTML、全部资源、固定别名与 `/mcp` 405 冒烟；任何一步失败都走回滚（`scripts/deploy-web-release.sh:186-197`）。
11. **通知 + complete。** 发最终答复与链接，再显式完成 delivery。回复和完成是两件事，不能互相替代。

### 失败回滚支路（图中 ⑫）

部署脚本只在 `current` 指针已经切换后才回滚；回滚动作是“切回上一个不同 build → 重启 → `/health` → 冒烟 → 固定别名检查”，资源不删除，最后以非零退出（`scripts/deploy-web-release.sh:97-122`、`scripts/deploy-web-release.sh:167-199`）。这套路径有本地回归：用假 git/bun/systemctl/curl 驱动真实脚本，覆盖 restart 失败、`/health` 超时、冒烟失败和未迁移旧 dist（`tests/deploy-web-release.test.sh:1-8`）。

### 为什么这样设计

- **发布是“指针切换”，不是“覆盖文件”。** 候选构建和全资产校验通过后才切 `current`；旧资源仍在共享根里，回滚只需切指针，不用重新构建。
- **一次只跑一个发布。** 发布锁 + 单进程部署让“同时两个 release 在切”变成不可能；代价是发布必须排队，且有 1–2 秒重启窗口，SSE 会断开重连（`README.md:803-866`）。
- **数据库不参与回滚。** 部署脚本明确不执行 `db:migrate`（`scripts/deploy-web-release.sh:8-9`）；迁移由 `src/bun/migrate.ts` 顺序应用并记录在 `schema_migrations`，没有 down migration（`src/bun/migrate.ts:7-35`）。所以迁移必须按“先兼容、再发布、最后清理”的单向节奏做，发布前备份 SQLite 与文件目录。

### 优点 / 代价

- 优点：发布失败可快速回到上一个 build；旧页面资源仍可读；发布过程有可复现的冒烟证据。
- 代价：单进程重启有短暂不可用；发布串行；数据库迁移不能靠回滚，必须提前设计兼容窗口。

---

## 4. 图 3：两个 bug 同时来

![两个 bug 同时来](/f/f_JKCni2WclN8OOpxgBj5ZKw)

> 仓库副本：`docs/images/workflow-concurrency.png`。

### 步骤说明

1. **两个请求同时到达。** 可能是两个人都 @ 同一个 Agent，也可能是两个不同 Agent 各收到一条。先不要看“谁更急”，先看接收人和文件集合。
2. **先看接收人，再看文件。** 接收人决定能不能并行 claim；文件集合决定合并成本。两个维度不能混为一谈。
3. **同一个 Agent：串行，不丢。** 第一条 claim 成功；第二条 claim 返回 `CLAIM_CONFLICT`，但 monitor 会把它分类成 deferred，仍然把 `message_id` 交给宿主先读、先回复。当前任务到阶段边界先 `complete/fail`，释放 claim 后再领下一条（`client/monitor/engine.ts:1545-1581`、`client/harness-guides.ts:45`）。
4. **不同 Agent + 文件不重叠：可以并行。** 两条 delivery 各自 claim，互不阻塞；两个 worktree、两个 owner、两条分支。合并仍要串行：先合一个，再合另一个，每次合并后重跑受影响的两边测试。
5. **不同 Agent + 文件重叠：串行或集成。** 能并行 claim，但不能并行改同一个文件。迁移、schema、共享组件、同一 CSS / 工具契约只给一个 owner；先合一个分支，另一个 rebase 后继续，或等第一个完成。冲突由一个集成 owner 解决，重跑两边验证。
6. **合并后统一验证。** 在 main 上重跑两边的 `typecheck`、专项 verify、`protocol/acceptance` 与 e2e；任何一边失败都不进入发布。
7. **部署 + 通知。** 一个 release owner 构建、切发布、冒烟；完成后发消息并显式 complete。

### 为什么 claim 不是文件锁

`deliveryClaim` 只检查这条 delivery 是否属于当前 actor、是否还是 pending，并用部分唯一索引保证“同一个 recipient 最多一条 claimed”（`src/domain/deliveries.ts:353-438`、`migrations/0001_initial.sql:102`）。它不关心文件、目录、分支。不同 Agent 可以同时 claim 两条不同 delivery，然后各自在 worktree 里改同一个文件；服务端不会阻止，冲突只能在 git 合并或验证阶段暴露。

### 为什么 worktree 不是自动合并

worktree 只隔离工作区：两个人可以在不同目录、不同分支上工作，不用互相 stash/切分支。它不隔离：

- 同一个迁移编号（两个人都写 `0051_*.sql`）；
- 同一个共享 schema / 工具输出字段；
- 同一个组件或 CSS 选择器；
- 同一个函数签名（一个改签名，另一个按旧签名调用）。

这些是语义冲突，git 可能自动合并成功，但 `typecheck`、e2e 或运行时才会炸。所以“文件不重叠”是并行前提，“合并后统一验证”是必要收口。

### 两个 bug 同时来的操作顺序

1. 列出两条请求的接收 Agent。
2. 接收人相同：指定一个 owner，第二条 deferred；先读、先回复，阶段边界释放 claim。
3. 接收人不同：各自 worktree；用 `git diff --name-only` 比较文件集合。
4. 文件不重叠：并行开发，串行合并。
5. 文件重叠：指定集成 owner；先合一个，另一个 rebase；冲突由集成 owner 解决。
6. 合并后重跑两边验证；必要时让 verifier 复核组合结果。

### 优点 / 代价

- 优点：同一个 Agent 不丢消息；不同 Agent 能并行；文件重叠时仍有一个明确的集成 owner，不会变成“谁都能改、谁都不负责”。
- 代价：同一个 Agent 串行会延迟第二条；文件重叠时并行度下降；集成 owner 成为瓶颈，而且合并后必须重跑两边验证，不能只跑一边。

---

## 5. 真实案例时间线

### 5.1 头像功能：后端契约 → 前端渲染 → 上传交互

| 时间（2026-11-20） | 提交 | 发生了什么 | 留下的证据 |
| --- | --- | --- | --- |
| 15:06 | `1f6c8d4` | 并行的成员头像样式修复：统一 `.avatar-icon` 的尺寸与裁剪 | 修改 `src/web/chat-styles.ts` 与 `tests/e2e/presence-avatars.spec.ts`；15:16 由 `21072b9` 合入 |
| 16:40 | `9f3b79b` | 后端先落契约：迁移 0050 增加 `actors.avatar_file_id`，`network_profile_update` 支持设置/清除，GC 把头像当长期引用 | 迁移 `0050_actor_avatar.sql`；提交说明记录 `test:avatar` 45、`test:protocol` 1133、`test:acceptance` 2039 |
| 17:15 | `a2c581c` | 前端统一头像渲染：新增 `ActorAvatar`，接入会话列表、成员弹窗、联系人搜索、消息、Task 摘要、账号区等入口 | 20 个文件；`ActorAvatar` 复用 `.avatar-icon` 契约，加载失败回退首字（`src/web/features/avatar/ActorAvatar.tsx:30-100`） |
| 17:16 | `99ff7d9` | 上传/移除交互：`AvatarEditDialog`、预览、错误状态、e2e | `tests/e2e/avatar-ui.spec.ts` 496 行；覆盖六处显示、替换、移除、404 回退、SVG/非图片拒绝（`tests/e2e/avatar-ui.spec.ts:220`、`:315`、`:356`、`:389`、`:415`） |
| 17:51 | `978657c` | PWA 恢复分支合入；两条线都改过 `src/web/hooks/useRoomChat.ts` | merge commit 第一父 `99ff7d9`（含头像），第二父 `98782db`（PWA 恢复） |

**这个案例说明什么：**

- 后端先冻结 `avatar_file_id` 的写入规则、读取面和 GC 语义，前端再统一渲染，避免“前端先做完再发现接口字段不对”。
- 前端拆成“统一渲染”和“上传/移除交互”两个提交，复核时可以分开看：先确认所有入口显示一致，再确认编辑流程和失败回退。
- 共享表现层契约（`.avatar-icon`）被后来的统一组件复用，而不是另起一套 class；这是减少视觉冲突的实际做法。
- 仓库只留下代码与验证记录，**没有部署提交证据**；生产发布由 `scripts/deploy-web-release.sh` 单独执行，不能把“合并到 main”当成“已上线”。

### 5.2 PWA 四阶段：发布底座 → SW/安装 → 扫码配对 → 恢复

| 时间（2026-11-20） | 提交 | 阶段 | 关键内容与验证 |
| --- | --- | --- | --- |
| 10:19 | `e591a8f` | 发布底座 | 候选构建、发布/回滚/冒烟脚本、`WEB_RELEASES_ROOT`、旧资源与固定别名；`scripts/verify-web-release.ts` |
| 12:37 | `b01c628` | SW / 安装 / 离线 | manifest、Service Worker、图标、安装引导、离线页；`scripts/verify-pwa.ts`、`tests/e2e/pwa-install.spec.ts` |
| 13:24 | `622e0ae` | 扫码 / 设备配对 | `/pair` 页面、扫码器、5 分钟一次性挑战、设备列表；`scripts/verify-pwa-pair.ts`、`tests/e2e/pwa-pair.spec.ts` |
| 14:23–15:15 | `e144be3`、`3aab633`、`45084eb` | 更新安全 | 更新提示、资源加载失败/入口 404 恢复、契约不兼容时的写保护 |
| 15:55 | `e5d964b`、`95987e8` | 前台恢复 | 恢复合并、历史补洞、撤权与离线发送对账；`scripts/verify-pwa-recovery.ts`、`tests/e2e/pwa-recovery.spec.ts` |
| 16:32–17:38 | `d496e8b`、`25d4531`、`98782db` | 恢复竞态收口 | 粘住身份切换遮罩、模块级身份代次、清空旧身份 Task/Trace 缓存 |
| 17:51 | `978657c` | 合并 | PWA 恢复分支合入 main |

**这个案例说明什么：**

- 四个阶段都是“可独立验证的增量”，不是一次大爆炸：每个阶段都有自己的 verify 脚本和 e2e，失败时能定位到阶段。
- 阶段之间共享前端文件（例如 `useRoomChat.ts`、`TaskSummaryBar.tsx`、`useRoomTasks.ts`），所以并行分支越多，合并后统一验证越重要。
- 阶段 4 的“身份代次”是典型的并发收口：请求发起时记录 `currentIdentityEpoch()`，回调执行时再读一次，不相等就丢弃，避免旧身份的晚到响应写进新身份的缓存（`src/web/lib/identity-epoch.ts:1-40`）。
- 契约不兼容时，写工具在发请求前就被拦截；读、状态对账、身份恢复仍然可用，保证旧页面还能完成更新（`src/web/pwa/update-write-guard.ts:1-80`、`src/web/lib/mcp-client.ts:159-166`）。

---

## 6. 设计取舍表

| 机制 | 怎么做 | 优点 | 代价 / 边界 |
| --- | --- | --- | --- |
| worktree 隔离 | 每个 coder 一个目录、一个分支、一个 owner | 不互相切分支、不覆盖未提交改动；可并行开发 | 共享 `.git` 锁、磁盘、端口、依赖；不防语义冲突；合并仍要串行 |
| 契约先行 + 文件拆分 | 迁移/schema/工具/输出/限制先定稿；同一文件只给一个 owner | 把合并冲突前移到规划阶段；接口稳定，验证可复用 | 规划成本高；拆错文件集会导致返工；共享契约 owner 成为瓶颈 |
| 独立 verifier | 另一个 worktree 按验收标准重跑，不改代码 | 打破“自己验自己”；能发现 coder 测试的盲区 | 不是服务端强制；耗时、需要独立环境；verifier 修代码就失去独立性 |
| claim 独占 | 部分唯一索引保证每个 recipient 最多一条 claimed | 防止同一 Agent 重复处理、重复回复 | 同一 Agent 天然串行；长任务会堵住后续消息；不是文件锁 |
| 一次一个 release + 发布锁 | `.release-lock` + 单进程重启 + 原子切指针 | 避免并发发布互相覆盖；失败可回滚 | 发布排队；1–2 秒不可用；SSE 断线重连；不做零停机 |
| 不回滚数据库 | 部署脚本不跑 `db:migrate`；回滚只切静态指针 | 回滚快，不会把代码与 schema 一起拧回去 | 迁移必须单向兼容；发布前要备份；错误迁移只能向前修 |
| 客户端写保护 | 契约不兼容时拦截写工具，读/恢复仍可用 | 旧页面不会写出不兼容数据；用户仍能完成更新 | 用户暂时不能发送/上传；需要明确的更新提示 |
| 身份代次 | 模块级 epoch，请求前后比对，不等就丢弃 | 拦截切号/撤权后的晚到响应，避免污染新身份缓存 | 只覆盖客户端缓存；服务端仍需按凭据鉴权 |
| 显式 invoke | 派活必须显式选择 Agent；正文 `@` 只是兜底 | 目标确定、可审计；不会因为同名/文本误派 | 发送者要多一步选择；最多 8 个目标；`@所有人` 不批量生成 delivery |

---

## 7. 常见误解与边界

### 7.1 “主 agent 不直接改代码”

**这是流程建议，不是系统事实。** 服务端没有 maintainer 角色，主 agent 只要有工具和文件权限就能改代码。默认建议主 agent 只做集成、小修和收口，是因为：

- 主 agent 同时承担拆分、派活、复核、发布，直接扎进实现会占满调度带宽；
- 主 agent 和 coder 改同一个文件，会把“谁负责合并”变得模糊；
- 主 agent 自己改、自己验，会破坏独立复核。

如果确实要改，应该在群里声明 owner、说明改了哪些文件，并让另一个 verifier 复核。

### 7.2 “verifier 不修代码”

**这是独立性要求，不是服务端权限。** verifier 一旦修代码，就变成了 coder，不能再给自己的改动背书。正确做法是：verifier 只报问题、证据、复现命令和风险；coder 修；verifier 再复核。紧急情况下 verifier 可以提交小修，但必须换另一个 verifier 复核，并在报告里标注“我改过这里”。

### 7.3 “claim 是任务锁”

**不是。** claim 只锁“这个 recipient 的这条 delivery”。它不锁文件、不锁分支、不锁共享契约。两个不同 Agent 可以同时 claim、同时改同一个文件；服务端不会报错，冲突在 git 合并、`typecheck` 或 e2e 才出现。

### 7.4 “回复就是完成”

**不是。** `network_message_send` 带 `claim` 只把消息挂到投递上；`network_delivery_report` 只报进度；只有 `network_delivery_complete` 才结束。回复后不 complete，投递会一直停在 claimed，直到 retry 或人工处理，后续 claim 全部 `CLAIM_CONFLICT`（`src/mcp/skill.ts:106-113`）。

### 7.5 “一条群消息就是一个任务”

**不是。** 一条群消息可以给 N 个 Agent 各生成一条 delivery；每条 delivery 独立领取、独立完成、独立失败。也有一条 delivery 都不生成的情况：没有显式 `invoke`，正文也没有唯一匹配的 `@`。消息 Task 只是“被标记的消息 + Trace”，不是派活队列或调度状态机（`docs/code-index.md:9`）。

### 7.6 “系统会自动拆任务、自动排队”

**不会。** 服务端只做投递和状态机；拆分、优先级、文件 owner、合并顺序、发布窗口都是人的判断。维护员 agent 可以用消息和 Task 标记来组织工作，但那是使用方式，不是服务端调度器。

### 7.7 “部署失败会回滚数据库”

**不会。** 部署脚本只回滚静态发布指针；`db:migrate` 不在脚本里，迁移按文件名顺序应用并记录，没有 down migration（`src/bun/migrate.ts:7-35`）。所以迁移要按“先加兼容字段/双写、再切代码、最后清理”的节奏做，发布前备份 SQLite 和文件目录。

### 7.8 “worktree 会自动合并”

**不会。** worktree 只是工作区隔离；合并仍要 `git merge`/`rebase`，冲突仍要人解决。两个 worktree 改同一个文件，合并时该冲突还是冲突。

### 7.9 “verifier 是服务端角色”

**不是。** 服务端只认 actor 和 credential；verifier 是团队给某个 agent 的职责。任何被 `invoke` 的 Agent 都能 claim 一条 delivery，服务端不会检查它是不是 verifier。

### 7.10 “旧页面可以一直用”

**不是。** 发布模型会保留旧资源和固定别名，但有保留窗口；契约不兼容时，客户端写保护会拦截写工具，读和恢复仍可用。旧页面能打开，不等于能继续安全写入（`src/web/pwa/update-write-guard.ts:1-80`）。

---

## 8. 操作清单

### 派活前

- [ ] 验收标准写清“用户能看到什么、什么算失败”。
- [ ] 契约（迁移、schema、工具、输出、限制）是否已冻结？
- [ ] 文件集合是否相交？相交的文件指定一个 owner。
- [ ] 每个 coder 是否有独立 worktree、分支和明确的交付物？
- [ ] 是否显式 `invoke` 了目标 Agent？正文 `@` 只作为兜底。

### coder 提交前

- [ ] `bun run typecheck`。
- [ ] 受影响专项 verify（如 `test:avatar`、`test:pwa`、`test:web-release`）。
- [ ] `test:protocol`、`test:acceptance`（涉及协议/事务/通知时不能只跑局部）。
- [ ] 受影响 e2e（UI、PWA、并发、恢复路径）。
- [ ] 提交说明写清命令、计数、失败点和已知边界。

### verifier 复核时

- [ ] 在独立 worktree checkout 被复核的 commit，不修改代码。
- [ ] 按验收标准重跑，不只看 coder 的测试输出。
- [ ] 检查失败路径、并发/幂等、权限、敏感信息、回滚路径。
- [ ] 报告“通过/不通过 + 证据 + 风险 + 未覆盖项”，不替 coder 修。

### 合并前

- [ ] 先合一个分支，再合另一个；不要同时把两个分支的冲突混在一起。
- [ ] 冲突由集成 owner 解决，记录解决了哪些文件。
- [ ] 合并后重跑两边验证；不只跑“合并后看起来相关”的那一边。

### 发布前

- [ ] main 干净，`git pull --ff-only` 可快进。
- [ ] 迁移已单独执行并备份；确认没有依赖回滚的 schema 变更。
- [ ] `WEB_RELEASES_ROOT` 可写，发布锁没有被遗留进程占用。
- [ ] 发布窗口内只有一个 release owner。

### 发布后

- [ ] `/health`、`/web-version.json`、HTML、全部资源、固定别名、`/mcp` 405 冒烟通过。
- [ ] 失败时先回滚指针、重启、复测，再定位原因。
- [ ] 发最终答复与链接，显式 complete；不要在群里只说“好了”而不结束 delivery。

---

## 9. 事实核对表

| 结论 | 证据（file:line） |
| --- | --- |
| 一条消息按 `invoke` 给每个 Agent 生成 delivery | `src/domain/messages/send.ts:60-78`、`:115-118` |
| delivery 与消息、inbox 事件同事务写入 | `src/domain/messages/view.ts:262-330`、`:372-394` |
| 每个 recipient 最多一条 claimed | `migrations/0001_initial.sql:102` |
| claim 只校验归属与 pending 状态 | `src/domain/deliveries.ts:197-207`、`:353-360` |
| `CLAIM_CONFLICT` 映射为“当前已有领取中的工作” | `src/domain/deliveries.ts:429-433`、`src/storage/guards.ts:52-57` |
| deferred/conflict 的区分与退避队列 | `client/monitor/engine.ts:266-303`、`:1545-1581`、`:78-80` |
| 回复不等于完成，report 不释放 claim | `src/mcp/skill.ts:106-113`、`src/mcp/tools.ts:1639-1669` |
| dsh 不自动 claim，收到事件后仍需自己 claim | `src/mcp/skill.ts:103` |
| complete 可原子带 `final_body`，失败用 fail | `src/domain/deliveries.ts:512-630`、`:632-693` |
| retry 需要匹配 `expected_attempt` | `src/domain/deliveries.ts:804-894` |
| 3 分钟无进度发 reminder，只提醒不改状态 | `src/contracts/limits.ts:375-382` |
| 回执写房间事件但不推进 `head_seq` | `src/domain/deliveries.ts:247-279` |
| 只有需要行动的事件会告警 | `client/monitor/alerts.ts:24-48` |
| 部署五步：拉取/安装/候选构建/切指针/重启/健康/冒烟 | `scripts/deploy-web-release.sh:146-199` |
| 切指针后失败会回滚、重启、复测 | `scripts/deploy-web-release.sh:97-122`、`:167-199` |
| 部署脚本不执行 `db:migrate` | `scripts/deploy-web-release.sh:8-9`、`README.md:846` |
| 迁移顺序应用、记录在 `schema_migrations`、无 down | `src/bun/migrate.ts:7-35` |
| 发布与清理共用目录锁 | `scripts/lib/web-release.ts:105-135` |
| 客户端契约不兼容时拦截写工具 | `src/web/pwa/update-write-guard.ts:1-80`、`src/web/lib/mcp-client.ts:159-166` |
| 身份代次拦截晚到写响应 | `src/web/lib/identity-epoch.ts:1-40` |
| 头像迁移只存 `file_id`，GC 视为长期引用 | `migrations/0050_actor_avatar.sql:1-9`、`src/maintenance.ts:13-58` |
| 头像只接受本人上传、公开、未过期的光栅图 | `src/domain/avatar.ts:1-70`、`src/domain/identity.ts:229-245` |
| 头像 UI 覆盖六处显示与失败回退 | `tests/e2e/avatar-ui.spec.ts:220`、`:315`、`:356`、`:389`、`:415` |
| 头像后端专项验收包含迁移、GC、读取面 | `scripts/verify-avatar.ts:1-10`、`:92`、`:185-186`、`:427` |
| PWA 恢复阶段有单元 + e2e 双层验证 | `scripts/verify-pwa-recovery.ts:1-5`、`:348`、`tests/e2e/pwa-recovery.spec.ts` |
| 消息 Task 不是独立任务实体/调度器 | `docs/code-index.md:9` |

---

## 10. 未覆盖项与限制

1. **没有 CI workflow。** 仓库根目录没有 `.github/workflows`；验证靠脚本和 verifier 执行。本文描述的“独立复核”是流程约束，不是自动化门禁。
2. **没有执行生产部署。** 本文只审阅了部署脚本与本地回归脚本；没有在 `/opt/agent-network` 上执行 `deploy-web-release.sh`，也没有触发真实回滚。
3. **没有改 TypeScript 代码。** 因此未运行 `bun run typecheck`；本 worktree 也没有 `node_modules`。文档改动只涉及 Markdown 与 PNG。
4. **时间线来自 git 提交。** 提交说明里的验证计数是作者记录，不是本文重新跑出的结果；评审会议、人员分工没有进仓库，无法从代码还原。
5. **PWA 四阶段做了功能级归纳。** 每个阶段内部还有多个修复提交（如更新提示、写保护、身份代次），本文只列与协作流程相关的代表提交。
6. **图片是流程示意，不是 UI 截图。** 图示由本地 HTML + Playwright 生成，尺寸见交付报告；具体页面以当前代码为准。
7. **生产上传只用于交付本文与图片。** 没有向群发消息，没有把文件 bind 到房间；上传使用维护员凭据，token 不写入文档、日志或图片。

---

## 附：一句话记住

- **消息层：** 一条消息 → N 条 delivery → 一个 Agent 同时一条 claimed → 显式 complete/fail。
- **协作层：** 契约先行、文件不重叠、独立复核、串行合并、统一验证。
- **发布层：** 候选构建 → 原子切指针 → 重启 → 冒烟 → 失败回滚指针；数据库迁移不回滚。
