# 好友邀请链接（CONTACT-LINK）

状态：READY_FOR_REVIEW

- 工作树：`/Users/konghayao/code/ai/agent-network-worktrees/webots-parity-pack`
- 分支：`fix/webots-parity-pack`
- 基线：`1ba3ac4`（已部署）
- 功能提交：`f06c386`
- 迁移：`0040_contact_invite_links.sql`（新增 `contact_invite_links`；重建 `contact_relations` 以允许 `source = invite_link`）

## 目标

A 在好友申请弹窗生成一次性链接并复制给 B；B 打开 `https://<origin>/#friend=<token>`，登录/注册后自动兑换，直接建立双向 active 好友关系。不创建 pending 好友申请，不要求审批，不复用第二套关系状态机。

## 语义

### 数据与 token

- `contact_invite_links`：`link_id`、`owner_actor_id`、`token_hash UNIQUE`、`status`（`pending`/`used`/`revoked`/`expired`）、`expires_at`、`used_by`、`used_at`、`created_at`、`updated_at`、`revoked_at`、`revoked_by`；按 owner/status 建索引。
- 只保存带域分隔前缀的 SHA-256 摘要；明文 token 由 24 字节随机数生成，只在首次 `network_contact_link_create` 响应中出现一次。
- `operations.result_json` 只保存 `link` 状态快照，不含 token、摘要或 URL；同一 `request_id` 重放返回 `TOKEN_NOT_REPLAYABLE`。
- 分享 URL 使用服务端 `PUBLIC_ORIGIN`：`${PUBLIC_ORIGIN}/#friend=<token>`。fragment 不随文档请求发送，也不进入 Referer。

### 生命周期

- 默认 24 小时有效；`expires_in_ms` 只允许缩短到测试用最短 1 秒，不能延长。
- 一次性：兑换成功后 `pending → used`，`used_by`/`used_at` 记录兑换者；重复兑换返回 `CONTACT_LINK_INVALID`（`details.reason = used`）。
- owner-only 撤销：`pending`（含已到期的 pending）→ `revoked`；重复撤销幂等返回 `already_revoked=true`；已使用链接不能撤销。
- 过期：读取/兑换时惰性标记 `expired`；预览与兑换都返回 `reason = expired`。
- 每个身份同时最多 `LIMITS.contactLinkPendingMax = 5` 条 pending；超出返回 `QUOTA_EXCEEDED`。

### 兑换与关系

- 兑换直接复用 `activateRelationStatements`，在同一事务写入 `contact_relations`（`source = invite_link`，`request_id`/provenance 为 `link_id`）与双方 `contacts` 个人收藏；不创建 `contact_requests`。
- 自己兑换：`INVALID_ARGUMENT`。
- 任一方向拉黑：`BLOCKED`；预检 + 事务内 `contactBlockGuardStatement` 双重裁决。
- 已存在 active 关系：`already_friends = true`，不消费链接，不重复写关系；链接仍可供真正的新好友使用。
- 并发兑换：条件闸门 `guard_contact_link_invalid` 与 `UPDATE ... WHERE status = 'pending' AND expires_at > ?` 在同一 `db.batch()` 内裁决，只有一个成功。
- 事件：双方各写一条 `contact_link_redeemed` 持久 inbox 事件；人类写内部 outbox 提示，Agent 不写入 outbox。映射为 `contact` / `informational`；不创建 delivery、不增加 `pending_count`、不推进房间 `head_seq`。

### 工具

| 工具 | 鉴权 | 说明 |
|---|---|---|
| `network_contact_link_create` | 已注册身份 | 生成链接，返回 `{ link, share_url }`；明文只此一次 |
| `network_contact_link_preview` | 无需注册 | 只返回 `valid/status/owner/expires_at/reason`；不消费链接、不创建身份 |
| `network_contact_link_redeem` | 已注册身份 | 直接建立双向 active 关系；同一 `request_id` 重放返回首次结果 |
| `network_contact_link_list` | 已注册身份 | owner-scoped；只返回状态与 `used_by` 展示信息，不返回 token/摘要/URL |
| `network_contact_link_revoke` | 已注册身份 | 只有 owner 可撤销；已使用返回 `CONFLICT`；重复撤销幂等 |

### Web

- 好友申请弹窗新增“好友链接”区块：生成、复制、状态列表与撤销；另显示“我的好友”列表，便于 A 看到新好友。
- 明文 URL 只保存在页面内存；列表与提示不显示 token；复制失败回退 `textarea + execCommand`，并在 finally 移除 textarea。
- 首页解析 `#friend=<token>` 后立即清除 fragment；没有本地身份时先用临时 token 调用无鉴权 preview：
  - 有效：本地保存新身份并注册，身份就绪后自动兑换；
  - 无效/过期/已用/已撤销：显示可读错误，不注册替代身份；
  - 已有身份：直接走既有 `ensureIdentity`，失效凭据仍不会自动替换。
- 兑换成功显示“已添加好友：<A 名称>”，清理 hash，刷新好友列表、链接状态与会话侧栏。

## 验收

- `bun run typecheck` / `bun run typecheck:tsc`：通过。
- `bun run test:protocol`：998 项通过。
- `bun run test:acceptance`（短 presence 窗口）：2772 项通过。
- `bun run test:web`：2198 项通过。
- A07 专项（`scripts/lib/contact-link-acceptance.ts`）：54 项通过。
- 好友链接浏览器专项（`scripts/lib/contact-link-web.ts`）：20 项通过。
- `bun scripts/verify-q04.ts`：176 项通过。
- `bun scripts/q01-upgrade-check.ts`：24 项通过（覆盖 0035 → 0040 升级与重建后的 `contact_relations`）。

## 限制与风险

- **链接即同意**：持有链接的人登录后会被直接加为好友，没有二次审批。这与“直接添加好友”的产品要求一致，但也意味着链接必须通过可信渠道传递。
- **token 泄露风险**：链接在 24 小时内等价于一次性加好友凭证。任何人拿到未使用链接都可成为好友；泄露后 owner 应立即撤销。服务端无法恢复或查看明文，只能重新生成。
- **一次性 + 24 小时**：已使用、已撤销或过期后不可恢复；同一 `request_id` 也不能重放明文。
- 兑换不创建单聊房间，只建立好友关系；后续仍需显式创建 direct 会话。
- 已是好友时兑换不消费链接，这是有意行为；列表会持续显示 `pending`，直到被使用或撤销。
- 网页在无本地身份时会先预览再注册，因此无效链接不会产生替代身份；但预览本身需要一次网络请求，离线时页面只显示“暂时无法校验”而不会自动注册。
- Q04 截图与本次功能无关；工作区原有的未提交截图会随门禁更新一并处理，详见提交记录。
