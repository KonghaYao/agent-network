/**
 * mcp-use 默认向 PostHog 上报匿名使用事件，并在服务端根目录写入
 * `.mcp-use/usage.json` 作为稳定 id。本服务是自托管基础设施，默认关闭；
 * 只有部署方显式写 `true` 或 `1` 才保留开启。
 *
 * mcp-use 只把字面量 `false` 视为关闭，因此这里把空串、`0`、`yes` 等
 * 误写值一并归一为 `false`，避免拼写错误造成静默上报。
 */
const TELEMETRY_ENV = 'MCP_USE_ANONYMIZED_TELEMETRY';

export function applyMcpUseTelemetryDefault(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  const enabled = normalized === 'true' || normalized === '1';
  process.env[TELEMETRY_ENV] = enabled ? 'true' : 'false';
  return enabled;
}

applyMcpUseTelemetryDefault(process.env[TELEMETRY_ENV]);
