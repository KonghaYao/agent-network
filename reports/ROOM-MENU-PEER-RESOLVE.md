# 右键菜单 Agent 操作缺失修复

## 现象

direct Agent 会话右键时只看到“复制 Agent 连接提示词”，看不到“注销并重发 token”“归档”“停用/启用”“交接管理权”等 Agent 管理操作。

## 根因

右键菜单通过 `roomEntries` 的 `peer_kind`/`peer_actor_id` 判断是否 direct Agent。列表初始化时这两个字段由后台 `fillDirectPeers` 异步补全；在补全完成前右键，`isAgentDirect` 为 false，Agent 专属菜单项被隐藏。功能和代码没有删除，是时序依赖。

## 修复

- `openRoomMenu` 改为 async：direct 房间缺少 peer 时，先按 `room_id` 调用 `network_room_get` 解析对方；拿到 `kind/actor_id` 后再决定菜单项。
- 用 `roomMenuOpenSeq` 防止补查期间关闭菜单/再次右键导致旧结果覆盖新菜单。
- 补查失败或无 peer 时仍打开菜单，只展示通用复制项。
- 解析成功后回写 `roomEntries` 与 `peerDetails`，减少后续重复查询。

## 验证

| 检查 | 结果 |
|---|---|
| `bun run typecheck` | 通过 |
| `bun run test:web` | 2198 项通过；新增“强制清空 peer 后右键仍显示注销并重发 token”回归 |
| `verify-isolated protocol` | 998 项通过 |
| `Q04` | 176 项通过 |

## 限制

- 首次右键在后台 peer 补全前会多一次 `network_room_get`；补全完成后不再请求。
- “复制身份”仍通过“复制 Agent 连接提示词”完成（提示词含 Agent 名称、actor_id、MCP URL/token 与房间信息）；没有单独的“复制 actor_id”菜单项。
