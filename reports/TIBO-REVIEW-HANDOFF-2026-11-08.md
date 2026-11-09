# Tibo review 修复交接说明（2026-11-08）

- 审计记录：本文件是 Tibo review 交接说明的仓库内副本，正文保持原样。
- patch：`reports/patches/webots-review-fb538d2.patch`
- patch SHA-256：`d8212efd73a010dfddf43185bb6dd334d420fe7361c958f3f1bdb647be3e0804`
- 应用记录：`reports/TIBO-PATCH-APPLIED.md`

---

WeBots 修复交接说明
日期：2026-11-08

附件：webots-review-fb538d2.patch（50,951 字节）
SHA-256：d8212efd73a010dfddf43185bb6dd334d420fe7361c958f3f1bdb647be3e0804
原始基线：fb538d2a72dd2f90396f69ac7b5ed05cdb950618
最近核实的远程 main：d7cb3148e46678a0f33ae7242ac107dd25c930d7
没有执行 push、合并或部署。

已修复的六类问题
1. 撤销成员、拉黑或解散群后，旧 delivery 仍可被 retry 重新入队。现在 retry/claim 在事务内重新检查权限、历史边界、停用状态和队列上限。
2. 创建任务可引用入群前不可见的文件，或将过期附件重新保留。现在提交前及事务内同时检查可见性、删除与过期状态。
3. 设备配对的旧兑换响应可能串用新一轮 token 和身份。现在按配对轮次固定参数，忽略旧响应，仅成功兑换后允许切换。
4. 建群重复提交、取消或重开弹窗后的迟到响应可能覆盖新状态；添加成员的旧响应可能清空新选择。现在加入单次提交及轮次检查。
5. 刷新或切换房间可能解除仍在发送中的锁，导致重复消息。现在按房间独立锁定整个对账和发送过程。
6. A 房间发送延迟时编辑新草稿，再切换到 B，旧成功响应可能删除 A 的新草稿。现在按提交时快照清理，保留后续编辑。

实际验证结果
在 fb538d2 + patch 上：全量 acceptance 2718 项、protocol 991 项、新增 delivery 92 项、新增附件访问 67 项、三组 UI 异步竞态回归、tsrs 与 tsc 类型检查通过。
现有 GC 单元测试 fixture 已修正为引用附件时仍有效、建立保留后再模拟过期，保留原清理断言。
在最新已核实 d7cb314 + patch 上：干净应用检查、新增后端 159 项断言、三组 UI 竞态回归、tsrs 类型检查及空白检查通过。此最新组合未重跑全量 acceptance/protocol。

验证限制
UI 回归是隔离执行实际生产处理函数的异步场景测试，不等于真实浏览器端到端验证。当前环境禁止 Chromium 创建所需本地 socket，因此 test:web 和 Q04 未完成；应用 patch 后必须补跑。维护员公布的 test:web 2142 / Q04 176 / protocol 991 是其上游版本的结果，不代表已验证本 patch。
本次发现并修复上述问题，不声称所有业务与界面场景均无缺陷。

当前上游协调与合并注意
维护员已处理 Agent 候选列表合并、长历史性能第一波和手动展开旧错误污染，未重复纳入本 patch。
最新消息指出维护员正修改 chat-session-script.ts 的 applyCachedRoom/openRoom：超过 80 条的房间缓存不再整段预渲染，只加载最新 50 条；维护员表示不改发送锁/草稿逻辑。这与 patch 同文件，尚未验证未发布代码，应用前须重新核实最新 HEAD 与冲突，保留双方修复。
先执行 git apply --check webots-review-fb538d2.patch，确认无冲突后再应用；遇到新的上游修改应重新合并与测试，不能覆盖最新文件。

连接器兼容问题（未包含代码修复）
当前 Tibo-for-dots 工具列表缺少好友申请、申请列表、接受/拒绝和撤销工具；服务端 contact_add 仅收藏，旧单聊发新消息也要求 active 好友关系。无新关系的旧房间可能报 FRIEND_REQUIRED，应更新连接器工具与 schema，并通过明确同意流程建立关系，不应自动补双方同意或降低权限。

交付状态
按用户要求直接提供这两个文件。未向 Webots 上传或交付 patch。此前官方 HTTP 上传返回 401 UNAUTHENTICATED，未重试或绕过认证。
