/** 第一版对外可见的业务错误码（§8.3）。 */
export type BusinessErrorCode =
  | 'NOT_MEMBER'
  | 'NOT_OWNER'
  | 'QUEUE_FULL'
  | 'PAYLOAD_TOO_LARGE'
  | 'CLAIM_CONFLICT'
  | 'STALE_ATTEMPT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CURSOR_EXPIRED'
  | 'RATE_LIMITED'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'ACTOR_EXISTS'
  | 'CREDENTIAL_INVALID'
  | 'TOKEN_NOT_REPLAYABLE'
  | 'RECOVERY_INVALID'
  | 'ROOM_FULL'
  | 'FRIEND_REQUIRED'
  | 'FILE_UNAVAILABLE'
  | 'DRIVE_UNAVAILABLE'
  | 'ROOM_FILE_LIMIT'
  | 'RESOURCE_EXHAUSTED'
  | 'PERMISSION_DENIED'
  | 'MEMBERSHIP_STALE'
  | 'VERSION_CONFLICT'
  | 'ASSIGNMENT_STALE'
  | 'REVIEW_STALE'
  | 'QUOTA_EXCEEDED'
  | 'REQUEST_EXPIRED'
  | 'INVITE_EXHAUSTED'
  | 'BLOCKED'
  | 'ACTOR_DISABLED'
  | 'PAIRING_INVALID'
  | 'CONTACT_LINK_INVALID'
  // Memory（MF01）：状态类结果用 src/memory/contracts.ts 的 MemoryAvailability 表达；
  // 这里只放可抛出的业务错误，避免 UI 与宿主各自定义错误名。
  | 'MEMORY_DISABLED'
  | 'MEMORY_UNAVAILABLE'
  | 'MEMORY_NOT_READY'
  | 'MEMORY_UNSUPPORTED'
  | 'MEMORY_UNSUPPORTED_GRANULARITY'
  | 'MEMORY_TARGET_INVALID'
  | 'MEMORY_EVIDENCE_INSUFFICIENT'
  | 'CONFLICT';

export interface BusinessErrorBody {
  code: BusinessErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

const RETRYABLE: ReadonlySet<BusinessErrorCode> = new Set([
  'RATE_LIMITED',
  'CONFLICT',
  'DRIVE_UNAVAILABLE',
  // 记忆引擎未就绪/暂不可用时聊天不应失败；调用方可在退避后重试同一请求。
  'MEMORY_NOT_READY',
  'MEMORY_UNAVAILABLE',
]);

export class BusinessError extends Error {
  readonly code: BusinessErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: BusinessErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BusinessError';
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.details = details;
  }

  toBody(): BusinessErrorBody {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isBusinessError(error: unknown): error is BusinessError {
  return error instanceof BusinessError;
}
