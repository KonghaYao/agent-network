# UI-WAVE-2：配对设备删除旧方式、自动生成与左右布局

- 状态：READY_FOR_REVIEW
- 基线：`16ba0b3`（docs(reports): 记录 UI-WAVE-1 验收与限制）
- 实现提交（结果 SHA）：`6d6abd8`（fix(web): 配对页删除旧方式并改为自动左右布局）
- 分支：`fix/webots-parity-pack`
- 部署：未部署。按约定由主控执行发布。

## 改动

### A. 旧配对方式从 UI 下线

- `src/web/handoff.ts`
  - 删除 `legacyTokenDialog`、`HANDOFF_ADOPT_SCRIPT`、`legacy-token-details`
    折叠区、旧链接/token 输入框与旧长期凭据确认弹窗样式。
  - 页面不再捕获 `#t=`，不写 `localStorage`，也不切换身份。
- `src/web/chat.ts`、`src/web/chat-panels.ts`、`src/web/chat-script.ts`、
  `src/web/chat-list-script.ts`、`src/web/chat-logout-script.ts`、
  `src/web/chat-identity-script.ts`
  - 移除 `legacyTokenDialog`、`HANDOFF_ADOPT_SCRIPT`、`credential-invalid-legacy`
    按钮、`legacyPending` 分支、`__agentNetworkLegacyToken` 与旧确认/解析逻辑。
  - 失效凭据只显示“用另一台设备配对”，不自动注册替代身份。
- 服务端兼容：`network_recovery_create` / `network_recovery_redeem` 未删除，
  仍可用于旧客户端 API 兼容；UI、技能与 README 不再把它作为配对入口。

### B. 打开弹窗即自动生成

- 打开“配对设备”弹窗立即调用 `network_device_pairing_create`，无需先点按钮。
- 主按钮改为“重新生成”；重新生成会先调用
  `network_device_pairing_cancel` 撤销旧挑战，再创建新挑战。旧挑战随后
  join 返回 `PAIRING_INVALID`。已兑换等不可撤销状态会继续创建新挑战。
- 创建失败显示可读错误与“重试”按钮；重试成功后隐藏重试。
- 自动生成只创建挑战，不自动 approve / redeem；仍需已登录设备核对设备名称、
  平台与确认码后明确确认。

### C. 左右布局与文案收敛

- 桌面端两栏：左栏二维码、12 位短码、有效期、重新生成/复制链接；右栏状态、
  待确认设备（名称/平台/确认码）、刷新与简短安全提示。
- `<760px` 单栏堆叠，390px 不横向溢出。
- 文案压缩为：
  - “用另一台设备扫描或输入 12 位配对码。”
  - “只在核对设备名称/平台/确认码后批准；请勿截图或分享配对码。”
- `/pair` 页面同步缩短 lead/hint 与安全说明，保留 challenge 输入、join、
  确认码、redeem 与身份切换；配对协议未改。

### D. 文档与技能

- `src/mcp/skill.ts` 与 `public/skills/agent-network-skills.md` 同步改为
  “配对仅使用 5 分钟一次性挑战；旧 `#t=` 链接不再支持”，正文与 digest 一致。
- `README.md`、`CLAUDE.md` 删除旧方式入口与长期 token 扫码说明，改为
  “旧 `#t=` 已下线，页面忽略该 fragment”。

## 测试

| 检查 | 结果 |
| --- | --- |
| `bun run typecheck` | 通过 |
| `bun run test:web` | 通过，2090 项（基线 2086） |
| `bun scripts/verify-q04.ts` | `Q04 PASS checks=176` |
| `bun run test:protocol` | 通过，991 项 |
| Q02 配对专项 | 通过，77 项 |
| Q02 同步/身份专项 | 通过，45 项 |

新增/调整的浏览器断言覆盖：

- 打开弹窗即自动出现 12 位 challenge，无需点击生成。
- 弹窗只有一个“重新生成”；旧方式详情/输入/确认弹窗均不存在，
  弹窗文本不含“旧方式”“长期凭据”。
- 打开弹窗不自动 approve / redeem。
- 桌面左右两栏不溢出；390px 单栏堆叠且不溢出。
- 复制链接只含 `/pair#c=`，成功文案为“已复制链接”。
- 创建失败显示错误与“重试”，重试后重新生成。
- 重新生成会替换短码且旧挑战返回 `PAIRING_INVALID`。
- `/#t=` 不打开旧弹窗、不切换 token、不写入旧 token、不显示旧方式提示。
- 本机身份切换、退出清理与草稿分区仍按 actor 隔离。

## 旧方式下线验证

- `scripts/verify-web.ts` 明确断言 `#legacy-token-details`、
  `#legacy-token-input`、`#legacy-token-modal` 数量为 0。
- 打开 `/#t=<target token>` 后当前账号仍为原身份，`agent-network-token`
  保持不变，页面不出现旧方式提示。
- `scripts/verify-protocol.ts` 断言首页不再包含 `legacy-token`、
  `__agentNetworkLegacyToken` 或 `#t=` 捕获脚本。
- 服务端 `network_recovery_*` 工具保留，仅用于旧客户端兼容；本波次未删除、
  未修改协议。

## 限制

- 完整 `bun run test:acceptance` 在当前环境连续两次停在既有在线状态时序断言
  `关闭最后一个连接后成员显示离线`（`scripts/acceptance.ts:1050`，45s 超时）。
  该路径未在本波次修改；同一服务上的 Q02 配对 77 项与同步/身份 45 项已单独
  通过。需主控在全新环境复核该既有用例。
- 旧 `network_recovery_*` 工具仍在服务端注册；如后续确认无旧客户端依赖，
  可另开协议变更删除。
- 未部署，未创建 PR。
