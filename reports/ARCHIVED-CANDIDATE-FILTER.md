# 群成员候选过滤归档/停用 Agent

## 现象

群设置“未加群”候选里出现已归档（archived）Agent；用户无法理解为何归档对象仍可被加入。

## 根因

- `loadManagedPickerAgents` 读取 `network_agents_managed_list` 时只取 `actor_id/name/session`，丢弃了服务端已返回的 `archived`/`disabled`。
- 本机 Agent 注册表与 managed list 合并时没有排除同一 actor 的归档状态。
- `membersCandidates` 只排除当前成员、邀请中和自己，没有再校验候选状态。

## 修复

- managed list 中 `archived === true` 或 `disabled === true` 的 Agent 记入 `hidden`，不进入候选；同 actor 的本机注册表条目也跳过。
- `membersCandidates` 增加 `archived`/`disabled` 防御过滤。
- 群创建与添加成员共用同一合并函数，两个入口同时生效。

## 验证

| 检查 | 结果 |
|---|---|
| `bun run typecheck` | 通过 |
| `bun run test:web` | 2178 项通过（候选计数排除 archived/disabled，新增归档 Agent 不出现断言） |
| `Q04` | 176 项通过 |
| `verify-isolated protocol` | 991 项通过 |

## 限制

- 归档/停用只影响“可加入候选”；已有群成员关系、历史与本地 Agent 提示词不变。
- managed list 读取失败时无法得知归档状态，仍会回退显示本机条目；服务端会拒绝无效入群。
