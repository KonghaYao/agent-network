# 配对列表“待授权”误报修复

## 现象

已登录设备打开“配对设备”弹窗后，左侧自动生成配对码，但“待确认的新设备”立即出现“当前设备·MacIntel、确认码 —、等待确认”一行，并启用“确认新设备”。点击后服务端返回“新设备尚未完成配对申请”，用户看到错误。

## 根因

`chat-identity-script.ts` 的 `refreshPairings` 只按 `status === 'pending' || 'approved'` 过滤，没有区分：

- 挑战刚创建、尚无新设备 join（`confirm_code` 为空）；
- 新设备已 join、可以核对确认码并批准（`confirm_code` 非空）。

`pairingItem` 又对所有 `pending` 条目渲染“确认新设备”，导致对未 join 的自己创建的挑战提前批准。

## 修复

- 只有 `confirm_code` 非空的 `pending`/`approved` 条目进入“待确认的新设备”列表；未 join 的挑战只保留在左侧配对码/二维码区域。
- “确认新设备”按钮额外要求 `pending && confirm_code`，避免未来过滤回退时再次提前可点。
- 无待确认设备时提示“暂无待确认设备；左侧配对码正在等待新设备扫描。”

## 验证

| 检查 | 结果 |
|---|---|
| `bun run typecheck` | 通过 |
| `bun run test:web` | 2176 项通过（新增 2 项：未 join 不显示待确认设备、不显示确认按钮） |
| `Q04` | 176 项通过 |
| `verify-isolated protocol` | 991 项通过 |

## 限制

- 真实新设备 join 后的确认流程仍由既有 `N02` 配对验收覆盖；本次只修正未 join 时的误报。
- 本次未改动服务端配对状态机或数据库。
