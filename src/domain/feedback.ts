import { BusinessError } from '../contracts/errors';
import { LIMITS } from '../contracts/limits';
import type { FeedbackCreateInput } from '../contracts/schemas';
import { newId, nowMs, sha256Hex, stableStringify, utf8Bytes } from '../storage/db';
import { operationsStatement, runIdempotent } from '../storage/transactions/runner';
import { actorId, type Principal } from './principal';

/**
 * Agent 问题反馈只做认证写入：feedback 行是唯一业务副作用。
 * 不写 events/outbox，不推进 pending_count 或房间 head，也不产生 stream/webhook。
 */
export interface FeedbackCreateResult {
  feedback_id: string;
  created_at: string;
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
/** harness 是单行标识符，不允许任何 C0/C1 控制字符。 */
const HARNESS_CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
/** 诊断正文允许制表、换行与回车，其余 C0/C1 一律拒绝。 */
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

const URL_PLACEHOLDER = '[REDACTED_URL]';
const SECRET_PLACEHOLDER = '[REDACTED]';

/**
 * 确定性脱敏：只防常见误传，不是 DLP 保证。
 *
 * 完整 HTTP(S)/agentnet URL、Authorization Bearer 值与常见
 * token/secret/password 赋值中的值替换为固定占位符。幂等 hash 仍取
 * 原始输入，因此“仅敏感值不同”的两个请求会触发 IDEMPOTENCY_CONFLICT，
 * 不会因脱敏后文本相同而误判为同一操作。
 */
export function redactFeedbackText(text: string): string {
  return text
    .replace(/\b(?:https?|agentnet):\/\/[^\s<>"']+/giu, URL_PLACEHOLDER)
    .replace(/\bauthorization\s*:\s*bearer\s+[^\s,;]+/giu, `Authorization: Bearer ${SECRET_PLACEHOLDER}`)
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${SECRET_PLACEHOLDER}`)
    .replace(
      /\b(AGENTNET_TOKEN|AGENTNET_MCP_URL|access[_-]?token|auth[_-]?token|api[_-]?key|apikey|client[_-]?secret|password|passwd|secret|token)\b(\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu,
      `$1$2${SECRET_PLACEHOLDER}`,
    );
}

function requireRequestId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    utf8Bytes(value) > LIMITS.feedbackRequestIdBytes ||
    !REQUEST_ID.test(value)
  ) {
    throw new BusinessError(
      'INVALID_ARGUMENT',
      'request_id 必须是 1–128 个 ASCII 标识符字符',
      { field: 'request_id' },
    );
  }
  return value;
}

function requireText(
  value: unknown,
  field: 'environment' | 'harness' | 'problem',
  maxBytes: number,
  forbiddenControl: RegExp,
): string {
  if (typeof value !== 'string') {
    throw new BusinessError('INVALID_ARGUMENT', `${field} 必须是字符串`, { field });
  }
  if (utf8Bytes(value) > maxBytes) {
    throw new BusinessError('PAYLOAD_TOO_LARGE', `${field} 超过 UTF-8 字节上限`, {
      field,
      max_bytes: maxBytes,
    });
  }
  if (forbiddenControl.test(value)) {
    throw new BusinessError('INVALID_ARGUMENT', `${field} 包含不允许的控制字符`, { field });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BusinessError('INVALID_ARGUMENT', `${field} 不能为空`, { field });
  }
  return trimmed;
}

/** 只接受已注册 actor；actor_id 完全来自 principal，不接受客户端提供。 */
export async function createFeedback(
  db: D1Database,
  principal: Principal,
  input: FeedbackCreateInput,
): Promise<FeedbackCreateResult> {
  const caller = actorId(principal);
  const requestId = requireRequestId(input.request_id);
  const environment = requireText(
    input.environment,
    'environment',
    LIMITS.feedbackEnvironmentBytes,
    TEXT_CONTROL,
  );
  const harness = requireText(input.harness, 'harness', LIMITS.feedbackHarnessBytes, HARNESS_CONTROL);
  const problem = requireText(
    input.problem,
    'problem',
    LIMITS.feedbackProblemBytes,
    TEXT_CONTROL,
  );

  // 幂等 hash 使用原始输入（含未脱敏值），tool 域分隔避免跨工具 request_id 误重放。
  const payloadHash = await sha256Hex(
    stableStringify({
      tool: 'network_feedback_create',
      request_id: requestId,
      environment: input.environment,
      harness: input.harness,
      problem: input.problem,
    }),
  );

  const at = nowMs();
  const feedbackId = newId('fb');
  const result: FeedbackCreateResult = {
    feedback_id: feedbackId,
    created_at: String(at),
  };

  const written = await runIdempotent(db, {
    actorId: caller,
    requestId,
    payloadHash,
    result,
    build: (resultJson) => [
      operationsStatement(db, caller, requestId, payloadHash, resultJson, at),
      db
        .prepare(
          `INSERT INTO feedback (feedback_id, actor_id, environment, harness, problem, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          feedbackId,
          caller,
          redactFeedbackText(environment),
          redactFeedbackText(harness),
          redactFeedbackText(problem),
          at,
        ),
    ],
  });

  return written as FeedbackCreateResult;
}
