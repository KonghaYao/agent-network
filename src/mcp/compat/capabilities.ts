/**
 * `server/discover` 能力修正。
 *
 * mcp-use 的 `MCPServer` 会声明 `logging`、`prompts` 与
 * `resources.listChanged` 等自身默认能力，也不会知道 MCPP Files 挂载与
 * 顶层 `events` 扩展。能力目录由本层按固定契约修正：
 *
 * - 删除未声明的 `logging` / `prompts` 与 `resources.listChanged`；
 * - 固定 `resources.subscribe: true`；
 * - 声明 SEP-2640 Skills 扩展（技能面由 compat 传输层提供，不使用
 *   mcp-use 的文件式 Skills，因此值恒为 `{}`）；
 * - 文件存储启用时并入 MCPP Files 能力；
 * - `EVENTS` 启用时声明顶层 `events`；
 * - 保留 mcp-use 的 `supportedVersions`、instructions、`resultType`、缓存
 *   提示与 `_meta.serverInfo`。
 */
import { asRecord } from '../../events/log';

const SKILLS_EXTENSION = 'io.modelcontextprotocol/skills';
const FILES_EXTENSION = 'io.mcpp/files';

export interface DiscoverCapabilities {
  readonly events: boolean;
  /** `fileService.capability(uploadPath)`；未启用文件存储时为 null。 */
  readonly files: Record<string, unknown> | null;
}

export function patchDiscoverResult(
  result: Record<string, unknown>,
  options: DiscoverCapabilities,
): Record<string, unknown> {
  const source = asRecord(result.capabilities) ?? {};
  const extensions: Record<string, unknown> = {
    ...(asRecord(source.extensions) ?? {}),
    [SKILLS_EXTENSION]: {},
  };
  if (options.files === null) {
    delete extensions[FILES_EXTENSION];
  } else {
    extensions[FILES_EXTENSION] = options.files;
  }

  const capabilities: Record<string, unknown> = {
    tools: asRecord(source.tools) ?? {},
    resources: { ...(asRecord(source.resources) ?? {}), subscribe: true },
    extensions,
  };
  if (options.events) capabilities.events = {};

  return { ...result, capabilities };
}

/** 只重写 JSON 响应中的 `result`，保留 status、headers 与缓存提示。 */
export async function patchDiscoverResponse(
  response: Response,
  options: DiscoverCapabilities,
): Promise<Response> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) return response;
  const text = await response.text();
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return new Response(text, response);
  }
  const result = asRecord(message.result);
  if (result === null) return new Response(text, response);
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(JSON.stringify({ ...message, result: patchDiscoverResult(result, options) }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
