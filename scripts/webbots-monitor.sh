#!/bin/sh
# 由 Claude 原生 Monitor 承载；凭据仅从用户私有 env 文件读取。
# 宿主设置 alert 参数时用 '"alert":true|^ERROR '：CLI 每个 JSON 事件都带布尔 alert，
# 只有需要行动的事件（delivery/delivery_deferred/session.login/error 等）为 true。
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec bun client/cli.ts --env-file "$HOME/.agentnet/webbots-agent.env" monitor --harness claude --json --no-room-events --expect-actor agt_9720b04289af465d8f0abfd726ffe0b3
