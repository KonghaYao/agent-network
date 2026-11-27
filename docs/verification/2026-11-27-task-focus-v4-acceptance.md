# WeBots v4.0 Task Focus 验收记录

- 日期：2026-11-27
- 分支：`feat/webots-v4-task-focus`
- 基线：WeBots `1b8ccc65`；Peri-Swarm 锁版 `b2dcabfa`；官方 SDK `openai@7.60.0`
- 范围：本地实现与本地/离线验收。**未部署、未连接真实 Peri-Swarm、未使用真实模型。**
- 总体结论：个人看板、秘书运行时、Watch、四个秘书工具、Web 浮窗与旧 Task 退役的代码已完成；**已启动本地 Peri-Swarm（2 副本 + nginx + PG + Rivet）并用真实模型跑通两用户建卡、私有群隔离、私聊改期、归档与重启**。生产规模、同根撤权与 100 万事件仍未验收。

## 1. 证据等级

| 等级 | 含义 |
| --- | --- |
| 本地通过 | 仓库内脚本或测试真实执行并通过 |
| 本地部分 | 覆盖主路径，但缺少计划要求的真实模型/双 Agent/生产规模条件 |
| 外部阻塞 | 依赖独立部署的 Peri-Swarm、真实模型或生产数据，当前环境无法执行 |
| 未覆盖 | 本波次未实现或未安排 |

## 2. 发布 P0

| # | 计划验收项 | 证据 | 状态 |
| --- | --- | --- | --- |
| P0-1 | 代表性备份升级、空库启动、迁移中断重试、干净快照恢复、旧 Task 零残留、普通 IM 对照 | `q01-upgrade-check` 81 项：0053 后无 task 列/索引/guard/旧表，普通消息/引用链/delivery/未读保留；`verify-drizzle-schema` 397 项；空库与升级库索引一致。受管备份/生产快照不可得 | 本地通过（受管副本外部阻塞） |
| P0-2 | 两位用户同群、仅林舟开启、周敏独立开启；各自秘书/看板；开启前零作业 | `verify-focus-live`：真实 Swarm + 真实模型两位用户各得独立秘书/卡；`verify-focus-e2e` 覆盖 HTTP 链路 | 本地通过（真实模型） |
| P0-3 | 逐条回放第 1 节；同账号同卡；两人同刻不同列；周敏不泄露验收群/32/32 | `verify-focus-live`：同一委托两卡不同列；私有验收群进展更新林舟原卡；周敏搜索 32/32 为 0、无该来源 | 本地通过（真实模型，第二次运行已合回原卡） |
| P0-4 | 林舟归档后迟到回执、同包补发、旧作业重试、同线程独立复盘 | `verify-focus-live`：归档后补发同包，归档卡版本与列不变；`verify-focus-e2e`/runtime 覆盖归档屏障与重放 | 本地通过（真实模型 + 假 Swarm） |
| P0-5 | 两个工作 Agent 各自领取/报告；同名人员/项目；撤回/退群/收紧边界后读卡 | runtime/web 覆盖 delivery 领取、owner 隔离、restricted 遮蔽；未跑两个真实工作 Agent | 本地部分 |
| P0-6 | 未发言开启、静默领取、只回「收到」、无 @ 改期、重放 | `verify-focus-runtime`：Watch 对普通消息/领取事件建候选、领取流水恰一条、重放不重复；E2E 覆盖无 @ 普通消息建卡 | 本地部分（未跑完整双 Agent 剧本） |
| P0-7 | 关页面、双端并发启停、迟到/乱序、模型故障、重启、普通 Agent 不在场 | E2E 停服重启后同一秘书/卡保留；运行时覆盖暂停/重开/代次拒绝/租约；真实模型故障与双端并发未跑 | 本地部分 |
| P0-8 | 独立 Swarm 上同一 SDK 客户端运行秘书与普通群交付角色；双副本回调 | 本地 docker compose 启动 2 副本 + nginx + PG + Rivet；真实模型通过 MCP 建卡/改卡；未跑普通群交付测试角色 | 本地部分通过 |
| P0-9 | 4.5 真实链路；断线恢复同一根；串用作业引用；撤权后模型实际输入 | 真实链路已通；断线恢复/同根撤权后的模型输入未做专门注入验证 | 本地部分 / 外部依赖 |
| P0-10 | 10 万标注事件：新增 10 卡、更新 5 卡、归档复活 0；同一根会话 | 未跑；当前可用确定性夹具在本地跑业务计数，但缺少真实模型与 10 万规模环境 | 外部阻塞 |
| P0-11 | 带草稿开窗原地收起；跨会话跳到未加载原消息；返回看板 | `verify-focus-web` 59 项：草稿保留、跨房原消息高亮、返回恢复 tab/列/选中/搜索词/滚动断点 | 本地通过 |
| P1-1 | 桌面/手机走查：浮窗、快捷键、中文输入、三列、归档、重开、320px | `verify-focus-web` 覆盖 1440×900、390×844、⌘K、IME、归档、重开；来源会话筛选未实现 | 本地部分 |
| P1-2 | 60 组标注事件评测真实模型；100 用户/10 群/10 msg/s | 未连接真实模型 | 外部阻塞 |
| P1-3 | 千群、日 100 万、10 分钟 10 万突发；P95/积压/token | 未在规模环境执行 | 外部阻塞 |

## 3. 本地验证命令与结果

| 命令 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run build:web` | 通过 |
| `bun scripts/verify-focus.ts` | `Task Focus 后端核心通过：137 项检查` |
| `bun scripts/verify-focus-runtime.ts` | `Focus 运行时验收通过：141 项检查` |
| `bun scripts/verify-focus-swarm.ts` | `Swarm 客户端验收通过：51 项检查` |
| `bun scripts/verify-focus-web.ts` | `59 项检查通过` |
| `bun scripts/verify-focus-e2e.ts` | 22 项 HTTP 端到端检查通过（假 Swarm；两 owner、归档、重启） |
| `PERI_SWARM_API_KEY=... bun scripts/verify-focus-live.ts` | 20 项真实 Swarm/真实模型检查通过（两用户、私有群、私聊、归档、重启） |
| `bun scripts/verify-drizzle-schema.ts` | `schema parity checks passed: 397`（49 个迁移） |
| `bun scripts/verify-mcp-parity.ts` | `MCP parity passed`，tools 146 |
| `bun scripts/q01-upgrade-check.ts` | `Q01 升级检查通过: 81 项`（含 0053 零残留） |
| `bun scripts/verify-protocol.ts` | `协议验收通过: 1101 项`（需本地实例，`PUBLIC_ORIGIN` 显式设置） |
| `bun scripts/q01-doc-check.ts` | `Q01 文档/工具一致性检查通过: 48 项` |
| `bun scripts/verify-web.ts` | `浏览器验收通过 266 项` |
| Playwright `search-ui` / `chat` / `entries` | 17 / 17 / 12 通过 |
| `bun scripts/verify-client-contract.ts` | `client contract acceptance: 70 checks passed` |
| `bun scripts/verify-client-cli.ts` | `358 checks passed` |
| `bun scripts/verify-memory-intake.ts` / `injection` / `contracts` | 全部通过 |
| `bun scripts/verify-message-reply-room.ts` | `跨房间引用链隔离通过：13 项检查` |
| `bun scripts/verify-spa-shell.ts` | `spa shell checks passed: 71` |
| `bun run test:units` | 21 pass / 0 fail |
| `bun scripts/verify-pwa-recovery.ts` / `verify-pwa-update.ts` | 通过 |
| `git diff --check` | 无输出 |

真实 Swarm 部署：`deploy/docker-compose.yml` + `docker-compose.local.yml`（arm64 主机使用 amd64 镜像；2 副本、nginx、PostgreSQL、Rivet）；模型 `deepseek-v4-flash`；首轮真实运行曾把私有群进展拆成新卡，强化秘书指令后第二轮合回原卡。`verify-focus-live` 需要 `PERI_SWARM_API_KEY`，不进入默认 CI。

补充：`lenso-alerts` / `lenso-overlays` 的 6 个既有失败在基线 `3227fb9` 同样复现（基线 7 个，含已删除的 TaskTrace 用例）；失败签名与本次改动无关，未纳入本 PR 修复。

## 4. 未覆盖 / 残留风险

1. **真实模型与独立 Peri-Swarm 部署未验收**：Swarm 客户端只对假 Swarm 验证请求形状、幂等键、续读与错误分类；真实模型判断质量、同根撤权过滤、双副本回调属于外部联调。
2. **P1 未实现**：
   - 暂停期间对已跟踪未归档卡的进展核对；
   - 首次开启按 C→H 最近 7 天回看（当前从开启水位之后接续）；
   - Web 来源会话筛选；
   - Web 列表超过 50 件时的翻页（计数仍为后端完整口径）。
3. **服务身份边界**：所有秘书共用一个部署 Bearer；普通 Agent 被拒，跨 owner 由 `attempt_ref` 归属约束。`tools/list` 仍返回全部工具，Swarm 侧 `allowed_tools` 只声明四项，逐项授权在 WeBots 工具层执行。若需从请求区分具体秘书，需要上游传 `binding_ref`。
4. **Watch 为粗筛**：owner 可见的普通消息与领取事件都会成为候选，相关性交给秘书判断；大群/大流量下候选量与扫描成本偏高，需要真实规模调参。
5. **旧 Task 受管副本**：本地迁移、升级库与恢复路径已清零；生产备份/快照/外部记忆库中的旧投影需按部署清单核销，本仓库无法执行。
6. **Memory 枚举**：`memory_sources.source_kind` 仍保留 `task_*` 取值以兼容历史表结构，但停止写入并清理了数据；未重建枚举。
7. **文档记录**：`README.full`/`docs/code-index.md` 中保留“已退役”历史说明；协议工具数/验收项数以实际脚本输出为准。
