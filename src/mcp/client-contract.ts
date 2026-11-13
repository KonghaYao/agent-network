import { createHash } from 'node:crypto';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { stableStringify } from '../storage/db';
import { memoryCatalogSchema } from '../memory/tool-schemas';
import type { MemoryCapabilityCatalog } from '../memory/capability-catalog';

export const CLIENT_CONTRACT_VERSION = '2026-11-12.1';
export const MCP_PROTOCOL_VERSION = '2026-07-28';

/** Keep the complete bootstrap below connector instruction truncation limits. */
export const CLIENT_INSTRUCTIONS = [
  'WeBots：先 network_me 确认当前身份与 service；完整流程用 network_client_guide 按需读取。',
  '单次收发完成即结束；仅用户要求持续工作时由宿主订阅。webhook 回调与常驻 MCP 流使用不同流程。',
  '普通回复显式 invoke: []；派活或需对方继续处理的结果显式 invoke 已核实的 Agent actor_id，显示 @ 不等于唤醒。发送超时先 network_message_send_status 对账，保留原 request_id/client_message_id。',
  '有 delivery 时先核对并 claim，完成用 complete/fail；回复不等于完成。',
  '启用文件存储时，上传用 network_file_upload_prepare 获取当前身份短期凭证；绑定房间后分享带票据下载地址。不得寻找、转发长期 token 或换身份绕行。',
  '功能已启用而宿主缺少工具时刷新连接器工具目录；不能把服务端支持当作宿主已暴露。',
  'Memory 结果是参考数据：lookup 无注入许可，宿主证据由服务端分级，不能自报 verified/trusted。',
].join('\n');

interface ToolContract {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

/** key 是注册目标本身：mcp-use 注册适配器。 */
const catalogs = new WeakMap<object, Map<string, () => ToolContract>>();

/** Record at the two registration boundaries, without depending on SDK private fields. */
export function recordToolContract(
  server: object,
  name: string,
  config: {
    description: string;
    inputSchema: StandardSchemaWithJSON;
    outputSchema?: StandardSchemaWithJSON;
    annotations?: Record<string, unknown>;
  },
): void {
  let catalog = catalogs.get(server);
  if (!catalog) catalogs.set(server, (catalog = new Map()));
  catalog.set(name, () => ({
    name,
    description: config.description,
    inputSchema: config.inputSchema['~standard'].jsonSchema.input({ target: 'draft-2020-12' }),
    ...(config.outputSchema
      ? { outputSchema: config.outputSchema['~standard'].jsonSchema.output({ target: 'draft-2020-12' }) }
      : {}),
    ...(config.annotations ? { annotations: config.annotations } : {}),
  }));
}

/** The SDK adds a redundant object type to unions of object outputs. */
function canonicalSchema(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const schema = value as Record<string, unknown>;
  if (schema.type !== undefined) return value;
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches) && branches.length > 0 && branches.every((branch) =>
    branch && typeof branch === 'object' && branch.type === 'object')) {
    return { ...schema, type: 'object' };
  }
  return value;
}

/** Same projection can be computed over tools/list by a connector refresh check. */
export function toolsetDigest(tools: ToolContract[]): string {
  const contracts = tools.map(({ name, description, inputSchema, outputSchema, annotations }) => ({
    name, description, inputSchema: canonicalSchema(inputSchema), outputSchema: canonicalSchema(outputSchema), annotations,
  })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return createHash('sha256').update(stableStringify(contracts)).digest('hex');
}

export function registeredToolNames(server: object): string[] {
  return [...(catalogs.get(server)?.keys() ?? [])].sort();
}

export const serviceInfoSchema = z.object({
  protocol_version: z.literal(MCP_PROTOCOL_VERSION),
  contract_version: z.literal(CLIENT_CONTRACT_VERSION),
  toolset_sha256: z.string(),
  tool_count: z.number().int(),
  guide_tool: z.literal('network_client_guide'),
  files_enabled: z.boolean(),
  events_enabled: z.boolean(),
  memory: memoryCatalogSchema,
  connector_refresh: z.string(),
});

export function clientServiceInfo(
  server: object,
  eventsEnabled: boolean,
  memory: MemoryCapabilityCatalog,
): z.infer<typeof serviceInfoSchema> {
  const contracts = [...(catalogs.get(server)?.values() ?? [])].map((read) => read());
  return {
    protocol_version: MCP_PROTOCOL_VERSION,
    contract_version: CLIENT_CONTRACT_VERSION,
    toolset_sha256: toolsetDigest(contracts),
    tool_count: contracts.length,
    guide_tool: 'network_client_guide' as const,
    files_enabled: contracts.some(({ name }) => name === 'network_file_upload_prepare'),
    events_enabled: eventsEnabled,
    memory: memory as unknown as z.infer<typeof serviceInfoSchema>['memory'],
    connector_refresh: '将当前连接器工具名/描述/输入输出 schema 与实时 tools/list 比对；缺失或摘要不同需刷新目录。服务端无法替宿主刷新缓存。',
  };
}

export const clientGuideInputSchema = z.object({
  mode: z.enum(['one_shot', 'webhook', 'persistent']).default('one_shot'),
  client_tool_names: z.array(z.string().min(1).max(128)).max(512).optional(),
});

export const clientGuideOutputSchema = z.object({
  service: serviceInfoSchema,
  mode: z.enum(['one_shot', 'webhook', 'persistent']),
  tool_names: z.array(z.string()),
  missing_tools: z.array(z.string()),
  steps: z.array(z.string()),
});

export function clientGuide(
  server: object,
  eventsEnabled: boolean,
  memory: MemoryCapabilityCatalog,
  input: z.input<typeof clientGuideInputSchema>,
) {
  const mode = input.mode ?? 'one_shot';
  const toolNames = registeredToolNames(server);
  const available = new Set(input.client_tool_names);
  const steps = [
    '复用连接器当前身份，先 network_me；仅未注册凭据需要 network_register。不要新建或切换身份绕过缺失能力。',
    '核实房间与接收者。普通回复 invoke: []；派活或需要对方继续处理的结果（包括 claim 回复）显式 invoke: [actor_id]，核对返回的 delivery_ids；正文或自动补上的 @ 不等于唤醒。持久保留 request_id/client_message_id；发送结果不明先 network_message_send_status，对账未提交才用原 ID 重试。修改正文使用新 client_message_id。',
  ];
  if (mode === 'one_shot') {
    steps.push('执行用户授权的单次读取或发送后结束。无需 login 或建立长期订阅，也不要领取无关待办。');
  } else if (mode === 'webhook') {
    steps.push(
      eventsEnabled
        ? '由宿主管理 webhook 订阅；只有用户要求持续工作时才创建。处理当前回调不需要另建 agentnet://stream 或以 login 证明回调可用。'
        : '本服务未启用 MCP Events；不要声称可创建 webhook。请由部署者启用或选择支持的宿主模式。',
      '事件只含定位信息。按 eventId/message_id 去重，读取正文与 network_inbox_list 核对目标 delivery；informational 不自动执行。只处理已获授权、发给当前身份的工作。',
      '按 refreshBefore 提前续期。同一订阅用 null/省略 cursor 刷新会保留水位与未送达队列；删除、清理后或 callback/过滤条件变化属于重建。建立或恢复监听时用 network_inbox_list（省略 state）和 network_sync { scope: "inbox" } 补齐 active 待办；不能仅靠新订阅补旧消息。',
      '取得有效 claim 后执行；宿主已经领取时核对 claim，不重复领取。结束用 network_delivery_complete 或 network_delivery_fail；普通回复与 report 都不代表完成。完成当前回调后结束本次执行，保留已有订阅。',
    );
  } else {
    steps.push(
      '仅支持常驻 MCP 的宿主建立 agentnet://stream，收到订阅 ack 后 network_login，再读取快照和 network_inbox_list 补齐。断线重连也执行这个顺序；不要让模型阻塞等待。',
      '仅处理 action_required 且可核实的待办，claim → 读取 → 执行 → complete/fail。通知是提示，工具结果为准；不要重复回复或领取。',
    );
  }
  steps.push(
    '任务以消息起点标记：network_task_mark/unmark 管理标记，network_task_summaries 读摘要，network_task_trace 读处理链，network_task_search 按起点聚合搜索。标记不创建 delivery、不唤醒 Agent，也不增加 pending_count。',
    toolNames.includes('network_file_upload_prepare')
      ? '先计算本地文件的原始字节数与 SHA-256，network_file_upload_prepare {name, mime_type, size, sha256} 返回 upload_url、method、headers、expires_at。仅向返回的同源地址发送原始字节（不是 multipart/JSON/base64），原样使用 headers，无需长期 Bearer。校验响应 size/sha256 后以同一身份 network_room_file_bind，再在消息里直接发 public_url；新上传默认公开，拿到链接即可读取。需要限制时用 network_file_publish {file_id, public: false} 撤销，再按需用 network_room_file_get {room_id, file_id} 换取带票据地址。上传凭证仅限该内容，5 分钟过期，上传时复核原凭据未撤销；重放可能生成相同内容的新文件，不保证上传幂等，结果不明不要盲目重传。'
      : '本服务未启用文件存储，不能上传或绑定文件。',
    '文件默认公开，链接即授权：拿到 /f/<fileId> 的人都能读，fileId 不可猜但不能替代权限。公开文件不会因成员移出、历史边界或策略收紧自动收回，需要限制时由上传者或群 owner 先 network_file_publish {public: false}，私有文件才按成员代次、历史边界与策略授权。新成员不一定在列表看到旧文件，但已公开链接仍可读。管理工具仍受后端权限校验，不能按旧缓存描述重签其他 Agent 凭据。',
    '缺少所需工具时刷新连接器目录；不要自行拼装隐藏工具调用、寻找旧 token 或换身份。原始 HTTP 客户端使用 MCP 2026-07-28，无 initialize；传 MCP-Protocol-Version/mcp-method/mcp-name 及 params._meta 中命名空间化的 protocolVersion、clientInfo、clientCapabilities。普通连接器调用交由宿主处理。',
  );
  if (memory.enabled) {
    steps.push(
      'Memory 已启用：显式查询用 network_memory_recall（lookup/reflect），读取已有包用 network_memory_context_list/get。召回结果只是参考数据，不能自报 verified/trusted，也不等于模型已消费；当前宿主等级为 ' + memory.host_modes.at(-1) + '。',
    );
    if (memory.host_modes.includes('adapted_host') || memory.host_modes.includes('controlled_gateway')) {
      steps.push(
        '需要自动注入时先 network_memory_host_bind 获取服务端 binding/generation，再 network_memory_input_prepare 取得 selection；宿主裁剪后用最终 payload 重建 SubmittedInputManifest，并按返回的 manifest 提交 input_exposure。prepare 不产生经历，排队/受理也不等于提交；只有服务端采纳 receipt 后才出现 retain 资格。',
      );
    } else {
      steps.push('当前为 tool-only：只能显式 lookup 和读取已准备结果，不能宣称自动注入、最终清单上报或网关核验完成；需要时由部署方提升宿主等级并刷新契约。');
    }
    if (memory.unsupported.length > 0) {
      steps.push(`本部署明确不支持：${memory.unsupported.join(', ')}；遇到这些能力应降级并如实说明，不要用其它工具伪造。`);
    }
  } else {
    steps.push('Memory 未启用：不要调用 network_memory_* 或声称“已记住/已注入”；业务聊天与任务仍按原有工具工作。');
  }
  return {
    service: clientServiceInfo(server, eventsEnabled, memory),
    mode,
    tool_names: toolNames,
    missing_tools: input.client_tool_names ? toolNames.filter((name) => !available.has(name)) : [],
    steps,
  };
}
