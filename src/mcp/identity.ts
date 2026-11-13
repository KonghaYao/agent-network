/**
 * 服务端身份常量。
 *
 * `MCPServer` 与传输层自定义方法共用同一份身份；自定义方法应答时必须自行
 * 补齐结果级 `_meta.serverInfo`，才能与标准方法输出一致。
 */
export const SERVER_IDENTITY = {
  name: 'peri-agent-network',
  title: 'WeBots',
  version: '0.1.0',
} as const;

/** 2026-07-28 的结果级服务端身份元数据键。 */
export const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';
