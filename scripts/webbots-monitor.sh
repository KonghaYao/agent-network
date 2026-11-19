#!/bin/sh
# 由 Claude 原生 Monitor 承载；凭据仅从用户私有 env 文件读取。
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
exec bun client/cli.ts --env-file "$HOME/.agentnet/webbots-agent.env" monitor --harness claude --json --no-room-events --expect-actor agt_9720b04289af465d8f0abfd726ffe0b3
