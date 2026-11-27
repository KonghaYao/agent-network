/**
 * WeBots 公共 Peri-Swarm 客户端。
 *
 * 只封装官方 `openai@7.60.0` 的 `client.beta.agents.sessions`：会话开通/恢复、
 * 输入投递、事件流、取消、items 与 turn 查询。SDK 的隐式重试必须关闭，
 * 重试语义由 WeBots 的作业幂等键决定；错误统一映射为固定分类，不保留原始
 * 响应、请求头、token 或模型正文。
 */

import OpenAI from 'openai';

import type { FocusRuntimeConfig } from '../env';

export type FocusSwarmErrorCategory =
  | 'focus_session_missing'
  | 'focus_swarm_unauthorized'
  | 'focus_swarm_unavailable'
  | 'focus_swarm_rejected'
  | 'focus_swarm_contract';

const RETRYABLE_CATEGORIES: ReadonlySet<FocusSwarmErrorCategory> = new Set([
  'focus_swarm_unavailable',
]);

/** 固定分类的可重试错误；message 只含分类，不含上游正文。 */
export class FocusSwarmError extends Error {
  readonly category: FocusSwarmErrorCategory;
  readonly retryable: boolean;

  constructor(category: FocusSwarmErrorCategory) {
    super(category);
    this.name = 'FocusSwarmError';
    this.category = category;
    this.retryable = RETRYABLE_CATEGORIES.has(category);
  }
}

function classifySwarmError(error: unknown): FocusSwarmError {
  if (error instanceof FocusSwarmError) return error;
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 404) return new FocusSwarmError('focus_session_missing');
  if (status === 401 || status === 403) {
    return new FocusSwarmError('focus_swarm_unauthorized');
  }
  if (status === 408 || status === 429) {
    return new FocusSwarmError('focus_swarm_unavailable');
  }
  if (typeof status === 'number' && status >= 500) {
    return new FocusSwarmError('focus_swarm_unavailable');
  }
  if (typeof status === 'number' && status >= 400) {
    return new FocusSwarmError('focus_swarm_rejected');
  }
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'APIConnectionTimeoutError') {
    return new FocusSwarmError('focus_swarm_unavailable');
  }
  if (name === 'APIConnectionError') {
    return new FocusSwarmError('focus_swarm_unavailable');
  }
  return new FocusSwarmError('focus_swarm_unavailable');
}

/** SDK 会话响应上的扩展根 ID；两个命名都要读取并校验。 */
function readRootSessionId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['rootSessionId', 'root_session_id'] as const) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface FocusSessionBinding {
  /** 已登记的 Swarm 逻辑会话；null 表示需要首次开通。 */
  sessionId: string | null;
  /** 已登记的 Peri 根会话 ID。 */
  rootSessionId: string | null;
  /** 首次开通幂等键；重试必须复用原值。 */
  provisioningKey: string;
}

export interface FocusSessionHandle {
  sessionId: string;
  rootSessionId: string;
}

export interface FocusInputReceipt {
  inputId: string;
  accepted: boolean;
  disposition: string | null;
  mode: string | null;
  lastItemSeq: number | null;
}

export interface FocusObservation {
  /** 本次续读起点；null 表示从当前开始。 */
  after: number | null;
  /** SDK 事件流；调用方消费时必须容错，不能阻塞派发。 */
  events: AsyncIterable<unknown>;
  close(): void;
}

export interface FocusItemPage {
  items: unknown[];
  nextCursor: string | null;
}

export interface FocusTurnView {
  turnId: string;
  status: string | null;
  error: string | null;
}

export interface FocusSwarmClient {
  ensureSession(binding: FocusSessionBinding): Promise<FocusSessionHandle>;
  submitInput(sessionId: string, text: string, key: string): Promise<FocusInputReceipt>;
  observe(sessionId: string, afterSeq?: number): Promise<FocusObservation>;
  cancelActive(sessionId: string, key: string): Promise<FocusInputReceipt>;
  listItems(sessionId: string, params?: { after?: string; limit?: number }): Promise<FocusItemPage>;
  retrieveTurn(sessionId: string, turnId: string): Promise<FocusTurnView>;
}

export const FOCUS_MCP_SERVER_LABEL = 'webots_focus';
export const FOCUS_MCP_TOOLS = [
  'network_focus_job_get',
  'network_focus_evidence_read',
  'network_focus_items_find',
  'network_focus_commit',
] as const;

/**
 * 秘书角色指令。WeBots 只在这里定义角色；模型推理与工具调用在 Swarm 内执行。
 * 输入中的 `job_id` / `attempt_ref` 是机器可读的授权引用。
 */
export const FOCUS_SECRETARY_INSTRUCTIONS = [
  '你是 WeBots 的任务秘书，只维护当前用户（owner）的个人看板。',
  '你只处理本次作业给出的候选事件，不跨用户读卡，不借用他人的隐私证据。',
  '先调用 network_focus_job_get 读取作业；再用 network_focus_evidence_read 核对来源，',
  '用 network_focus_items_find 在 owner 已有事项（含已归档）中查重。',
  '新建、更新、忽略或待判断都通过 network_focus_commit 提交；同一 decision_id 重放会返回同一回执。',
  '只有已经完成的判断才把 complete 设为 true；完成前必须覆盖全部候选。',
  '回复保持简短，不转发聊天原文，不输出令牌、隐私群标题或其他用户的私聊内容。',
].join('');

function parseReceipt(payload: unknown): FocusInputReceipt {
  const record = readRecord(payload);
  const inputId = optionalString(record?.inputId);
  if (!inputId) throw new FocusSwarmError('focus_swarm_contract');
  return {
    inputId,
    accepted: record?.accepted === true,
    disposition: optionalString(record?.disposition),
    mode: optionalString(record?.mode),
    lastItemSeq: optionalNumber(record?.lastItemSeq),
  };
}

function parseHandle(payload: unknown, expectedRoot?: string | null): FocusSessionHandle {
  const record = readRecord(payload);
  const sessionId = optionalString(record?.id);
  const remoteRoot = readRootSessionId(payload);
  if (!sessionId || !remoteRoot) throw new FocusSwarmError('focus_session_missing');
  if (expectedRoot && expectedRoot !== remoteRoot) {
    // 原根不符说明远端把会话路由到了别的持久历史，不能继续写入。
    throw new FocusSwarmError('focus_session_missing');
  }
  return { sessionId, rootSessionId: remoteRoot };
}

export function createFocusSwarmClient(config: FocusRuntimeConfig): FocusSwarmClient {
  const client = new OpenAI({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
    // 重试只由作业/决定幂等键驱动，SDK 不得隐式重试。
    maxRetries: 0,
  });

  const mcpTool = {
    type: 'mcp' as const,
    server_label: FOCUS_MCP_SERVER_LABEL,
    transport: {
      type: 'http' as const,
      server_url: config.mcpUrl,
      headers: { Authorization: `Bearer ${config.serviceToken}` },
    },
    allowed_tools: [...FOCUS_MCP_TOOLS],
    required: true,
  };

  return {
    async ensureSession(binding) {
      try {
        if (binding.sessionId) {
          const current = await client.beta.agents.sessions.retrieve(binding.sessionId);
          const record = readRecord(current);
          const sessionId = optionalString(record?.id);
          if (!sessionId) throw new FocusSwarmError('focus_session_missing');
          return parseHandle(current, binding.rootSessionId);
        }
        const created = await client.beta.agents.sessions.create(
          {
            environment: { type: 'none' },
            agent: {
              model: config.model,
              instructions: FOCUS_SECRETARY_INSTRUCTIONS,
              tools: [mcpTool],
            },
            metadata: {
              webots_role: 'task_focus_secretary',
              webots_binding: binding.provisioningKey,
            },
          },
          // 官方 SDK 只有配置 idempotencyHeader 才把 idempotencyKey 转成
          // 请求头；这里显式发送，保证 Swarm 同键收敛到同一逻辑会话。
          {
            idempotencyKey: binding.provisioningKey,
            headers: { 'Idempotency-Key': binding.provisioningKey },
          },
        );
        return parseHandle(created);
      } catch (error) {
        throw classifySwarmError(error);
      }
    },

    async submitInput(sessionId, text, key) {
      try {
        const response = await client.beta.agents.sessions.events
          .create(sessionId, {
            'Idempotency-Key': key,
            events: [
              {
                type: 'agent.session.input.message',
                input: [
                  {
                    role: 'user',
                    content: [{ type: 'input_text', text }],
                  },
                ],
              },
            ],
          })
          .asResponse();
        if (response.status !== 202) throw new FocusSwarmError('focus_swarm_rejected');
        return parseReceipt(await response.json());
      } catch (error) {
        throw classifySwarmError(error);
      }
    },

    async observe(sessionId, afterSeq) {
      try {
        // SDK 的 EventStreamParams 未声明 `after`；Swarm 以查询参数续读，
        // 这里只用窄类型断言补齐，不扩散 any。
        const query: Record<string, unknown> =
          afterSeq === undefined ? {} : { after: afterSeq };
        const stream = await client.beta.agents.sessions.events.stream(
          sessionId,
          query as unknown as { include_obfuscation?: boolean },
          {},
        );
        return {
          after: afterSeq ?? null,
          events: stream,
          close: () => stream.controller.abort(),
        };
      } catch (error) {
        throw classifySwarmError(error);
      }
    },

    async cancelActive(sessionId, key) {
      try {
        const response = await client.beta.agents.sessions.events
          .create(sessionId, {
            'Idempotency-Key': key,
            events: [{ type: 'agent.session.input.cancel' }],
          })
          .asResponse();
        if (response.status !== 202) throw new FocusSwarmError('focus_swarm_rejected');
        return parseReceipt(await response.json());
      } catch (error) {
        throw classifySwarmError(error);
      }
    },

    async listItems(sessionId, params = {}) {
      try {
        const page = await client.beta.agents.sessions.items.list(sessionId, {
          ...(params.after ? { after: params.after } : {}),
          ...(params.limit ? { limit: params.limit } : {}),
        });
        // CursorPage 只承诺 data/has_more；Swarm 的原始页另有 nextCursor，
        // 这里读取原始 body，缺失时退回最后一项 ID。
        const body = (page as unknown as { body?: Record<string, unknown> }).body;
        const rawCursor = optionalString(body?.nextCursor) ?? optionalString(body?.next_cursor);
        const last = page.data.at(-1) as { id?: unknown } | undefined;
        const fallback = optionalString(last?.id);
        return {
          items: page.data as unknown[],
          nextCursor: rawCursor ?? (page.has_more ? fallback : null),
        };
      } catch (error) {
        throw classifySwarmError(error);
      }
    },

    async retrieveTurn(sessionId, turnId) {
      try {
        const turn = await client.beta.agents.sessions.turns.retrieve(turnId, {
          session_id: sessionId,
        });
        const record = readRecord(turn);
        return {
          turnId: optionalString(record?.id) ?? turnId,
          status: optionalString(record?.status),
          error: optionalString(record?.error),
        };
      } catch (error) {
        throw classifySwarmError(error);
      }
    },
  };
}
