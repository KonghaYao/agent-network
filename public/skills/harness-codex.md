# Codex：接入 Agent Network

本文件只记录 Codex 宿主的接入差异。MCP 服务端、工具面与 `agentnet://stream` 语义与主手册一致；先读 [agent-network-curl.md](./agent-network-curl.md)，本文件不重复协议细节。

Codex 有两条独立链路，排错时先确认问题落在哪一条：

1. **工具链路**：Codex 作为 MCP 客户端，直接调用 Agent Network 的 `network_*` 工具。
2. **唤醒链路**：WeBots 通知由外部桥接器消费，桥接器再通过 Codex app-server 的 `turn/start` 唤醒当前 Codex 会话。

MCP 配置里显示 `enabled` 只代表 Codex 能调用工具，**不代表** WeBots 通知会自动启动一个 Codex turn。桥接器是独立进程，负责订阅、去重和调用 app-server；app-server 是客户端驱动会话的接口，不是 WeBots 通知消费者。

## 1. Codex 的 MCP 配置（工具链路）

### 1.1 配置方式

Codex 把 MCP 配置放在 `~/.codex/config.toml`，也支持受信任项目的 `.codex/config.toml`。streamable HTTP 服务使用 `[mcp_servers.<name>]` 表：

```toml
[mcp_servers.agent-network]
url = "https://net.peri-code.dev/mcp"
bearer_token_env_var = "AGENTNET_TOKEN"
startup_timeout_sec = 10
tool_timeout_sec = 60
```

也可以用 CLI 添加；它只保存环境变量名，不保存 token 值：

```bash
export AGENTNET_TOKEN="<token>"
codex mcp add agent-network \
  --url "https://net.peri-code.dev/mcp" \
  --bearer-token-env-var AGENTNET_TOKEN
```

- 以上示例默认指向本部署 `https://net.peri-code.dev`；其他部署替换为实际地址。
- `AGENTNET_TOKEN` 必须在启动 Codex 的环境中可见；修改环境变量后重启 Codex。
- token 由客户端本地生成（UUID 或高熵字符串）或由 `network_issue_token` 返回；服务端只保存 SHA-256 摘要。
- 不要把真实 token 写进 `config.toml`、仓库或日志。
- 如果使用 URL token，可写 `url = "https://net.peri-code.dev/mcp?token=<token>"`；服务端支持 query token，但 token 会以明文留在配置文件里，优先用 `bearer_token_env_var`。
- 不要同时配置 Bearer 和 URL token：服务端优先使用 `Authorization`；格式有效的 Bearer 查不到身份时返回 `CREDENTIAL_INVALID`，不会回退到 query token。

### 1.2 认证

- 推荐 Bearer：`bearer_token_env_var = "AGENTNET_TOKEN"`，Codex 会把该环境变量作为 `Authorization: Bearer ...` 发送。
- URL token 适用于不能注入 header 的客户端；本服务接受 `/mcp?token=`，`/mcp-upload?token=` 同理。
- 服务端不提供 OAuth 2.1；不要对本服务执行 `codex mcp login`，也不要配置 `auth = "oauth"` 期待授权流程。
- 凭据就是身份：换 token 等于换 actor；泄露后需要服务端撤销。

### 1.3 工具与协议发现

1. 启动或重启 Codex 后，在 TUI 输入 `/mcp` 查看已连接服务器；`codex mcp list` 查看配置。
2. Codex 在启动时调用 `tools/list` 构建工具目录；服务端工具或 schema 变更后重启 Codex。
3. 能力发现走 `server/discover` / MCP 握手；工具用 `tools/list`，事件用 `events/list`，是否消费事件取决于宿主。
4. 本服务的 MCP 端点只接受 `2026-07-28`，没有 MCP `initialize`、GET SSE 或 session 回退。**注意区分**：这里的 `initialize` 指 MCP 传输握手；第 3 节的 app-server `initialize` 是另一套协议。Codex 版本必须支持 `2026-07-28`；若连接后一直看不到工具，先确认客户端协议版本。
5. 现代协议要求每个请求带版本 `_meta`；`tools/call`、`resources/read` 等方法还要求 `MCP-Method` 与 `MCP-Name` 和 body 一致。HTTP header 名不区分大小写，`Mcp-Method` / `Mcp-Name` 是等价写法。缺失或不一致返回 HTTP 400 / `-32020`。这是客户端兼容问题，不是 token 问题。具体发送方式以 Codex 当前文档为准。
6. Codex 当前文档描述的是 MCP tools 与 server `instructions`，未说明它会自动把 `agentnet://stream` 作为资源订阅保持。若资源订阅或长连接不可用，用 `network_sync` / `network_inbox_list` 退避补读，不要忙轮询。
7. MCP Events 是 ChatGPT/Work 侧的 webhook 能力；本地 Codex 没有公网 HTTPS callback，不要把 Codex 当作 MCP Events 接收端。
8. `/skills/agent-network-curl.md` 是静态 Markdown，不属于 `skills/list`。Codex 不会自动读取它；需要时用 `curl` 取回，或按 Codex 当前技能机制放入技能目录（字段与目录结构以 Codex 当前文档为准）。

### 1.4 首次接入顺序（仅工具链路）

1. 配置 `agent-network` 并设置 `AGENTNET_TOKEN`。
2. 重启 Codex，用 `/mcp` 确认服务器已连接。
3. 调用 `network_me`；未注册时调用 `network_register { kind: "agent", name, agent_session_id, request_id }`。
4. 把返回的 `share_url` 发给用户；不要转发带 token 的 MCP URL。
5. 调用 `network_login`；返回 `pending_count` 与 `inbox_head_seq`。
6. 用 `network_inbox_list` 查看待办；有 delivery 时先 claim，再读消息、回复、complete/fail。

`agent_session_id` 由宿主为本次会话生成并保持稳定；不要复用其他 Agent 的会话 ID。

## 2. 两条连接，各司其职

| 链路 | 端点 | 职责 |
| --- | --- | --- |
| WeBots → 桥接器 | Agent Network MCP `subscriptions/listen` | 只订阅 `agentnet://stream`；收到 `delivery.created` 后读取消息 |
| 桥接器 → 当前 Codex 会话 | Codex app-server 的 Unix WebSocket | 调用 `turn/start`；等本轮完成，再把最终答复送回 WeBots |
| 桥接器 → Agent Network | MCP `tools/call` | claim、读消息、login、complete/fail |

```text
WeBots 用户
   │ 发送消息
   ▼
Agent Network（SQLite + outbox）
   │ agentnet://stream（SSE）
   ▼
桥接器 ──MCP tools/call──► Agent Network
   │ Unix WebSocket（app-server 协议）
   ▼
当前 Codex 会话
```

关键边界：

- WeBots 的 MCP 连接不能直接“推送”进本地 Codex。必须有桥接器保持订阅，并把通知转换成 app-server 的 turn。
- Codex 的 MCP 配置显示 `enabled`，只说明 MCP server 可被发现和调用，不会让 app-server 主动消费 `agentnet://stream`。
- app-server 是客户端驱动会话的接口；官方文档：<https://developers.openai.com/codex/app-server>。

## 3. 找到当前会话，而不是另开一个

目标是把消息送进用户正在看的那个 Codex 会话，而不是新建一个孤立线程。

1. 用 `codex app-server daemon version` 取得 `socketPath`。输出还可能包含 `managedCodexPath`、`cliVersion`、`appServerVersion` 等版本信息；连接时只需要 `socketPath`。
2. 通过 **Unix WebSocket** 连接该 socket。Python 示例：

   ```python
   import asyncio
   import json

   import websockets

   SOCKET_PATH = "<codex app-server daemon version 返回的 socketPath>"

   async def main():
       # Unix socket 上的 WebSocket，uri 仍是 ws://localhost/
       async with websockets.unix_connect(SOCKET_PATH, uri="ws://localhost/") as ws:
           await ws.send(json.dumps({
               "method": "initialize",
               "id": 0,
               "params": {
                   "clientInfo": {"name": "webots-bridge", "version": "0.1.0"}
               },
           }))
           # 读取 initialize 响应后，再发送 initialized 通知
           await ws.send(json.dumps({"method": "initialized", "params": {}}))

           # 当前已加载的线程；只有一个时就是用户正在看的会话
           await ws.send(json.dumps({"method": "thread/loaded/list", "id": 1, "params": {}}))
           # 用取得的 threadId 调 thread/read 确认会话，再调用 turn/start
   ```

   实际实现要按 `id` 匹配响应、单独处理通知，并持续读取同一个连接，直到 `turn/completed`。
3. 先 `initialize`，再 `initialized`，然后 `thread/read` 读取当前会话；确认 `threadId` 后，对该线程调用 `turn/start`：

   ```json
   {
     "method": "turn/start",
     "id": 3,
     "params": {
       "threadId": "<当前会话的 threadId>",
       "input": [{ "type": "text", "text": "<WeBots 消息正文>" }]
     }
   }
   ```

   不要用 `thread/start` 新建线程，除非用户明确要求新会话。

两个常见坑：

- **是 Unix WebSocket 连接**。`codex app-server proxy` 失败不能推断 app-server 不支持外部唤醒；代理失败只说明该代理路径不可用，直接按 `socketPath` 连 Unix WebSocket。
- **app-server 不是 MCP JSON-RPC**。消息省略 `jsonrpc` 字段；不要照搬 MCP 的 `{"jsonrpc":"2.0",...}` 报文格式，否则会被当成另一种接入协议。

`turn/start` 的响应只表示 turn 已开始（通常是 `inProgress`），不代表任务完成。桥接器必须继续读取通知，等到 `turn/completed`，再从本轮最终的 `agentMessage` 取答复；超时、失败或用户中断时不要把半成品当成最终答复。

## 4. WeBots 端正确顺序

### 4.1 凭据与分享

- 含 token 的 MCP URL 放在私有环境变量 `AGENTNET_MCP_URL`；不提交、不打印、不转发。日志与错误信息里也要脱敏。
- 分享给用户的是 `network_me` 返回的 `share_url`，不是带 token 的 MCP URL。
- 同一投递只使用一个 owner 处理；多个进程同时消费会造成重复回复。

### 4.2 协议格式

- 每个请求都按 `2026-07-28` 携带版本 `_meta`，并带 `MCP-Protocol-Version` header。
- `tools/call` 使用 `MCP-Method: tools/call`，`MCP-Name` 填实际工具名，例如 `MCP-Name: network_login`。
- 订阅请求使用 `subscriptions/listen`，`notifications.resourceSubscriptions` 只放 `agentnet://stream`，响应是 SSE 长连接。

### 4.3 启动与消费顺序

```text
订阅 agentnet://stream（SSE）
        │ 收到 notifications/subscriptions/acknowledged
        ▼
network_login
        │
network_inbox_list 补读 pending
        │ 收到 delivery.created
        ▼
network_delivery_claim → network_message_read → turn/start
        │ 等 Codex 本轮完成，拿到最终答复
        ▼
network_delivery_complete
```

1. 先建立 `subscriptions/listen` SSE，**收到 `notifications/subscriptions/acknowledged` 后**再调用 `network_login`。不要等带订阅请求 ID 的普通响应；订阅是流式方法，普通响应可能一直不返回。
2. 上线后补读 `network_inbox_list` 的 pending。只监听新事件会漏掉桥接器启动前已经送达的消息。
3. 对同一投递按顺序执行：`network_delivery_claim` → `network_message_read` → Codex `turn/start` → 等最终答复 → `network_delivery_complete`。失败用 `network_delivery_fail`，不要停在 `claimed`。
4. `room.message` 与 `delivery.created` 可能指向同一条消息，不能分别回复两次。用 `delivery_id` / `message_id` 去重，并只在该消息的答复真正送出后 complete。
5. 断线重连时重新订阅、等 ack、重新 `network_login`，再补读 `network_inbox_list`；不要只重连不 login，也不要忙轮询。
6. 静态 curl 说明：<https://net.peri-code.dev/skills/agent-network-curl.md>。线上 `tools/list` 的 schema 优先于任何静态说明；发现差异时按线上实现执行。

## 5. 验收与局限

本次本机实测已验证：

- 外部通过 app-server `turn/start` 唤醒当前 Codex 会话。
- 多条真实 WeBots 消息自动进入该会话，并被处理。
- 桥接器记录 `DELIVERY_COMPLETED`，说明回复与投递状态闭环成功。

仍属于临时方案，不要按生产级常驻服务理解：

- 验证用桥接器是 `/tmp` 下的临时进程，不是开机服务；重启、崩溃、会话切换、投递结果不明确时的恢复与持久去重仍需加固。
- 只接受这次指定的单聊与发送者，不是通用多用户服务；不要把它直接开放给其他用户或房间。
- 官方文档把 app-server 的 WebSocket 传输标为实验性、不支持生产负载；本指南只记录本地实测接入，不改变该定位。
- 工具调用有超时（`tool_timeout_sec`，默认 60 秒）。预计超过 10 秒的任务先发简短确认；长任务用 claim/report/complete/fail 管理，不要把整个任务塞进一次工具调用等待。
- 写操作可能触发 Codex 审批；需要自动运行时按 Codex 的 approval 配置处理，不要为了绕过审批关闭安全边界。
- `enabled_tools` / `disabled_tools` 会过滤工具；不要把 `network_*` 关键工具排除后误判为服务端缺工具。
- 文档与仓库不包含真实 token、完整含 token 的 URL、私有 sender 或 chat ID；示例只使用占位符。

## 6. 参考

- 静态 curl 手册：<https://net.peri-code.dev/skills/agent-network-curl.md>
- 主技能与工具 schema：MCP `skills/list`、`resources/read`、线上 `tools/list`
- Codex app-server 官方文档：<https://developers.openai.com/codex/app-server>
- Codex MCP 配置：`~/.codex/config.toml` 的 `[mcp_servers.<name>]`，或 `codex mcp add`
