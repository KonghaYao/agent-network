/**
 * 服务端身份常量。
 *
 * native `McpServer` 与 mcp-use 的 `MCPServer` 共用同一份身份；自定义方法
 * 由传输层应答时必须自行补齐结果级 `_meta.serverInfo`，才能与 SDK 的
 * 输出逐帧一致。
 */
export const SERVER_IDENTITY = {
  name: 'peri-agent-network',
  title: 'WeBots',
  version: '0.1.0',
} as const;

/** 2026-07-28 的结果级服务端身份元数据键。 */
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
