# Peri-Swarm 本地联调记录（2026-11-27）

- Peri 基线：`b2dcabfa`（本机 `/Users/konghayao/code/ai/peri`，`deploy/` 已含 Compose）
- WeBots 分支：`feat/webots-v4-task-focus`
- 模型：`deepseek-v4-flash`（通过本机 Peri provider 配置，secret 不进入仓库）
- 结果：2 个 `peri-swarm` 副本 + nginx + PostgreSQL + Rivet 全部健康；真实模型通过 MCP 建卡/改卡；`verify-focus-live` 20 项通过。

## 1. 镜像与平台

- GHCR `ghcr.io/konghayao/peri-swarm:main` 只有 `linux/amd64`；本机 Docker 为 arm64，使用 Docker 的 amd64 模拟运行。
- 拉取并重命名：
  ```bash
  docker pull --platform linux/amd64 ghcr.io/konghayao/peri-swarm:main
  docker tag ghcr.io/konghayao/peri-swarm:main peri-swarm:local
  ```
- `deploy/docker-compose.local.yml`（本地、不提交）为 `peri-swarm` 指定 `platform: linux/amd64`，并加 `host.docker.internal:host-gateway`，让容器回调宿主机 WeBots。

## 2. Secrets（只写本地，不提交）

1. `deploy/.env`：`POSTGRES_PASSWORD`、`PERI_SWARM_API_KEY`、`RIVET_ADMIN_TOKEN` 用 `openssl rand -hex` 生成；`PERI_SWARM_PORT=8080`。
2. `deploy/config/peri-swarm/settings.json`：复制本机 `~/.peri/settings.json` 的 `config`（provider/profile/active_alias）；文件 `0600`，Compose secret 只读挂载，entrypoint 再复制到容器 HOME。
3. 不把 token、DSN、provider key 写入日志、PR 或验收记录。

## 3. 启动与检查

```bash
cd deploy
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --no-build
docker compose -f docker-compose.yml -f docker-compose.local.yml ps
curl -fsS http://127.0.0.1:8080/healthz
docker compose -f docker-compose.yml -f docker-compose.local.yml exec --index=1 peri-swarm \
  sh -c 'curl -fsS -H "Authorization: Bearer $PERI_SWARM_RIVET_TOKEN" \
  "http://rivet-engine:6420/pools/peri-swarm/nodes?namespace=default"'
```

预期：两个 `peri-swarm` 副本 `healthy`；`rivet-init` 退出 0；节点列表两条 `connected:true`；两副本读到同一 machine-id。

## 4. WeBots 侧环境

WeBots 在宿主机运行；容器通过 `host.docker.internal` 访问 MCP：

```text
WEBOTS_SWARM_BASE_URL=http://127.0.0.1:8080/v1
WEBOTS_SWARM_API_KEY=<deploy/.env 的 PERI_SWARM_API_KEY>
WEBOTS_FOCUS_MODEL=deepseek-v4-flash
WEBOTS_FOCUS_MCP_URL=http://host.docker.internal:<WeBots端口>/mcp
WEBOTS_FOCUS_SERVICE_TOKEN=<随机生成，仅本机>
PUBLIC_ORIGIN=http://127.0.0.1:<WeBots端口>
```

服务身份在启动时登记为 `act_focus_service`，其 `tools/list` 只返回 4 个 Focus 工具；Human/Agent 的 `tools/list` 为 142 个，不含秘书工具。

## 5. Live 验收

```bash
PERI_SWARM_API_KEY="$(grep '^PERI_SWARM_API_KEY=' deploy/.env | cut -d= -f2-)" \
  bun scripts/verify-focus-live.ts
```

覆盖（20 项）：

1. 两位 Human 各自唯一秘书、active/runtime_ready。
2. 同一条群委托 → 两张卡、不同列/下一步。
3. 仅林舟可见的验收群回归 → 林舟原卡吸收（强化秘书指令后合回原卡）；周敏搜索 `32/32` 为 0，卡与来源均不含该群。
4. 周敏私聊交付（无 @）→ 林舟原卡版本递增并出现私聊来源。
5. 林舟归档 → 周敏补发同包 → 归档卡不回三列、版本不变、仍可回看。
6. WeBots 同端口/同 dataDir 重启 → 同一秘书、卡保留、Swarm 会话可复用。
7. Human 工具目录不含秘书工具。

首轮真实运行曾把私有群进展建成新卡；强化 `FOCUS_SECRETARY_INSTRUCTIONS`（同一交付物/决定/委托必须更新原卡、旧 candidate_id 失效）后，第二轮合回原卡。

## 6. 未执行

1. 同根撤权后的模型实际输入过滤（需要运行时注入合成标记并检查下一轮/恢复/压缩后的请求）。
2. 两个真实工作 Agent 的领取/报告/完成与同名消歧。
3. 10 万事件、100 万/日、60 组模型评测与生产规模 P95。
4. 普通群交付测试角色与双副本回调的单独用例（当前双副本已健康，秘书链路已跨副本成功）。
5. 生产部署：本次仅本机 Compose；镜像为 amd64 模拟，生产应使用原生平台或多架构镜像。

## 7. 本地运行状态

- `peri-swarm` Compose 仍在运行（2 副本 + nginx + PG + Rivet）。
- `deploy/.env`、`deploy/config/peri-swarm/settings.json`、`deploy/docker-compose.local.yml` 是本地文件，未提交。
- WeBots 临时联调实例已停止；Live 脚本自行启动/清理临时实例。
