/**
 * 工具/资源注册的最小适配层。
 *
 * `registerTools` 等注册函数只依赖 native `McpServer.registerTool` /
 * `registerResource` 的调用形状；mcp-use 的 `MCPServer` 没有同名的公开方法，
 * 但公开了声明式的 `tool()` / `resource()`。这里把两者收敛到同一个接口，
 * 避免每个注册函数判断实现，也不复制任何工具定义。
 *
 * `mcp-use` 没有公开的底层 `McpServer` 访问器，因此自定义方法
 * （`skills/*`、`events/*`）不走本适配层，仍由 native 兼容服务器处理。
 */
import type { McpServer } from '@modelcontextprotocol/server';
import type { MCPServer } from 'mcp-use';

/** 适配边界：调用方已通过 schema 约束参数，这里只关心运行时可调用。 */
type ToolCallback = (args: any) => Promise<any>;
type ResourceCallback = (uri: URL) => Promise<any>;

/** 注册函数需要的最小服务端表面。 */
export interface RegistrationServer {
  registerTool(
    name: string,
    config: Record<string, unknown>,
    callback: ToolCallback,
  ): unknown;
  registerResource(
    name: string,
    uri: string,
    config: Record<string, unknown>,
    callback: ResourceCallback,
  ): unknown;
}

/** native `McpServer` 的结构已满足该表面；仅收敛 SDK 的泛型重载。 */
export function nativeRegistrationServer(server: McpServer): RegistrationServer {
  return server as unknown as RegistrationServer;
}

/** mcp-use 的泛型重载由运行时校验，这里只保留调用形状。 */
type UseTool = (definition: Record<string, unknown>, callback: ToolCallback) => unknown;
type UseResource = (definition: Record<string, unknown>, callback: ResourceCallback) => unknown;

/**
 * 把 mcp-use 的声明式注册映射回现有注册函数的调用形状。
 *
 * `MCPServer` 会为每个请求从其 registry 重建 native server，因此这里注册的
 * schema、描述、annotations 与直接调用 SDK 完全一致。
 */
export function mcpUseRegistrationServer(server: MCPServer): RegistrationServer {
  const tool = server.tool as unknown as UseTool;
  const resource = server.resource as unknown as UseResource;
  return {
    registerTool(name, config, callback) {
      return tool.call(server, { name, ...config }, callback);
    },
    registerResource(name, uri, config, callback) {
      return resource.call(server, { name, uri, ...config }, callback);
    },
  };
}
