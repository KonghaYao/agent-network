import {
  McpServer,
  ProtocolError,
  type ServerCapabilities,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import { BusinessError, isBusinessError } from '../contracts/errors';
import {
  EVENTS_CALLBACK_ERROR_CODE,
  EVENTS_ERROR_CODES,
} from '../contracts/events';
import type { Env } from '../env';
import type { Principal } from '../domain/principal';
import { EventsError, invalidEventsArgument } from '../events/errors';
import {
  asRecord,
  callbackHostOf,
  createEventsLogger,
  type EventsLogger,
} from '../events/log';
import {
  listEventDefinitions,
  subscribeEvents,
  unsubscribeEvents,
  type SubscribeInput,
  type UnsubscribeInput,
} from '../events/subscriptions';

/**
 * 自定义方法用宽松对象接收参数，由本文件做显式校验：
 * SDK 的 schema 失败发生在 handler 之前，会丢失阶段日志；ChatGPT 也可能
 * 发送未知字段或显式 null，这些都不应直接变成 -32602。
 */
const RAW_PARAMS = z.record(z.string(), z.unknown());

const SUBSCRIBE_DELIVERY = z.object({
  mode: z.string().min(1),
  url: z.string().min(1),
  secret: z.string().min(1),
});

const EVENTS_SUBSCRIBE_PARAMS = z.object({
  name: z.string().min(1),
  arguments: z.unknown().optional(),
  delivery: SUBSCRIBE_DELIVERY,
  cursor: z.union([z.string(), z.number()]).nullish(),
  ttlMs: z.number().int().nonnegative().nullish(),
});

const UNSUBSCRIBE_DELIVERY = z.object({
  mode: z.string().min(1).optional(),
  url: z.string().min(1),
  secret: z.string().min(1).optional(),
});

const EVENTS_UNSUBSCRIBE_PARAMS = z.object({
  name: z.string().min(1),
  arguments: z.unknown().optional(),
  delivery: UNSUBSCRIBE_DELIVERY,
});

const SUBSCRIBE_KEYS = new Set([
  'name',
  'arguments',
  'delivery',
  'cursor',
  'ttlMs',
  '_meta',
]);
const DELIVERY_KEYS = new Set(['mode', 'url', 'secret']);
const UNSUBSCRIBE_KEYS = new Set(['name', 'arguments', 'delivery', '_meta']);

function businessErrorData(error: BusinessError): Record<string, unknown> {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
  };
}

function toProtocolError(error: unknown): unknown {
  if (error instanceof EventsError) {
    switch (error.kind) {
      case 'unknown_event':
        return new ProtocolError(
          EVENTS_ERROR_CODES.unknownEvent,
          error.message,
          { kind: 'event' },
        );
      case 'limit':
        return new ProtocolError(EVENTS_ERROR_CODES.limit, error.message, {
          limit: error.data.limit,
          max: error.data.max,
        });
      case 'delivery_mode':
        return new ProtocolError(EVENTS_ERROR_CODES.unsupportedDelivery, error.message, {
          feature: 'deliveryMode',
          value: error.data.value,
        });
      case 'callback':
        return new ProtocolError(EVENTS_CALLBACK_ERROR_CODE, error.message, {
          reason: error.data.reason,
          ...(typeof error.data.detail === 'string' ? { detail: error.data.detail } : {}),
          ...(typeof error.data.status === 'number' ? { status: error.data.status } : {}),
          // 只透传可分类的 errno 与尝试次数；不含地址、URL、secret 或签名。
          ...(typeof error.data.error_code === 'string'
            ? { error_code: error.data.error_code }
            : {}),
          ...(typeof error.data.attempts === 'number'
            ? { attempts: error.data.attempts }
            : {}),
        });
      case 'unauthorized':
        return new ProtocolError(EVENTS_ERROR_CODES.unauthorized, error.message, {
          code: error.data.code ?? 'CREDENTIAL_INVALID',
          message: error.message,
          retryable: false,
        });
      case 'invalid':
      default: {
        const details = (error.data.details ?? {}) as Record<string, unknown>;
        return new ProtocolError(EVENTS_ERROR_CODES.invalidParams, error.message, {
          code: details.code ?? 'INVALID_ARGUMENT',
          message: error.message,
          retryable: false,
          ...details,
        });
      }
    }
  }
  if (isBusinessError(error)) {
    if (
      error.code === 'CREDENTIAL_INVALID' ||
      error.code === 'NOT_MEMBER' ||
      error.code === 'NOT_FOUND'
    ) {
      return new ProtocolError(
        EVENTS_ERROR_CODES.unauthorized,
        error.message,
        businessErrorData(error),
      );
    }
    if (error.code === 'INVALID_ARGUMENT') {
      return new ProtocolError(
        EVENTS_ERROR_CODES.invalidParams,
        error.message,
        businessErrorData(error),
      );
    }
    if (error.code === 'RESOURCE_EXHAUSTED') {
      return new ProtocolError(EVENTS_ERROR_CODES.limit, error.message, {
        limit: error.details?.limit,
        max: error.details?.max,
      });
    }
    return new ProtocolError(EVENTS_ERROR_CODES.internal, 'internal events error');
  }
  return error;
}

function validationFailure(
  log: EventsLogger,
  field: string,
  reason: string,
): EventsError {
  log.warn('validate', {
    stage: 'validate',
    result: 'invalid',
    field,
    reason,
  });
  return invalidEventsArgument('events 参数不合法', {
    code: 'INVALID_ARGUMENT',
    field,
    reason,
  });
}

function parseSubscribeInput(raw: Record<string, unknown>, log: EventsLogger): SubscribeInput {
  const parsed = EVENTS_SUBSCRIBE_PARAMS.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw validationFailure(
      log,
      issue?.path.join('.') || 'params',
      issue?.code ?? 'invalid_type',
    );
  }
  const delivery = asRecord(raw.delivery) ?? {};
  const ignoredParams = Object.keys(raw).filter((key) => !SUBSCRIBE_KEYS.has(key));
  const ignoredDelivery = Object.keys(delivery).filter((key) => !DELIVERY_KEYS.has(key));
  log.info('validate', {
    stage: 'validate',
    result: 'ok',
    event_name: parsed.data.name,
    has_arguments: parsed.data.arguments !== undefined && parsed.data.arguments !== null,
    delivery_mode: parsed.data.delivery.mode,
    callback_host: callbackHostOf(parsed.data.delivery.url),
    cursor_kind:
      parsed.data.cursor === null || parsed.data.cursor === undefined
        ? 'null'
        : typeof parsed.data.cursor,
    ttl_kind:
      parsed.data.ttlMs === null
        ? 'null'
        : parsed.data.ttlMs === undefined
          ? 'absent'
          : 'number',
    ignored_params: ignoredParams.sort(),
    ignored_delivery_keys: ignoredDelivery.sort(),
  });
  return {
    name: parsed.data.name,
    ...(parsed.data.arguments !== undefined ? { arguments: parsed.data.arguments } : {}),
    delivery: parsed.data.delivery,
    cursor: parsed.data.cursor,
    ttlMs: parsed.data.ttlMs,
  };
}

function parseUnsubscribeInput(
  raw: Record<string, unknown>,
  log: EventsLogger,
): UnsubscribeInput {
  const parsed = EVENTS_UNSUBSCRIBE_PARAMS.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw validationFailure(
      log,
      issue?.path.join('.') || 'params',
      issue?.code ?? 'invalid_type',
    );
  }
  const delivery = asRecord(raw.delivery) ?? {};
  log.info('validate', {
    stage: 'validate',
    result: 'ok',
    event_name: parsed.data.name,
    has_arguments: parsed.data.arguments !== undefined && parsed.data.arguments !== null,
    callback_host: callbackHostOf(parsed.data.delivery.url),
    ignored_params: Object.keys(raw)
      .filter((key) => !UNSUBSCRIBE_KEYS.has(key))
      .sort(),
    ignored_delivery_keys: Object.keys(delivery)
      .filter((key) => !DELIVERY_KEYS.has(key))
      .sort(),
  });
  return {
    name: parsed.data.name,
    ...(parsed.data.arguments !== undefined ? { arguments: parsed.data.arguments } : {}),
    delivery: parsed.data.delivery,
  };
}

function failureFields(error: unknown): Record<string, string | number | null> {
  if (error instanceof EventsError) {
    return {
      error_kind: error.kind,
      error_code:
        error.kind === 'callback'
          ? EVENTS_CALLBACK_ERROR_CODE
          : typeof error.data.code === 'number'
            ? error.data.code
            : null,
      reason: typeof error.data.reason === 'string' ? error.data.reason : null,
      detail: typeof error.data.detail === 'string' ? error.data.detail : null,
      status: typeof error.data.status === 'number' ? error.data.status : null,
    };
  }
  if (isBusinessError(error)) {
    return { error_kind: 'business', error_code: error.code, reason: null, detail: null, status: null };
  }
  return { error_kind: 'internal', error_code: null, reason: null, detail: null, status: null };
}

/** 只在 EVENTS 配置有效时注册；未声明能力时客户端应得到 -32601。 */
export function registerEvents(server: McpServer, env: Env, principal: Principal): void {
  server.server.setRequestHandler('events/list', { params: RAW_PARAMS }, async (raw, ctx) => {
    const log = createEventsLogger('events/list', ctx.mcpReq.id);
    log.info('list', {
      stage: 'list',
      param_keys: Object.keys(raw).sort(),
    });
    const result = await listEventDefinitions();
    log.info('list', { stage: 'list', result: 'ok', event_count: result.events.length });
    return result;
  });

  server.server.setRequestHandler(
    'events/subscribe',
    { params: RAW_PARAMS },
    async (raw, ctx) => {
      const log = createEventsLogger('events/subscribe', ctx.mcpReq.id);
      try {
        const input = parseSubscribeInput(raw, log);
        const result = await subscribeEvents(env, principal, input, log);
        log.info('subscribe', {
          stage: 'subscribe',
          result: 'ok',
          subscription_id: result.id,
          cursor_kind: result.cursor === null ? 'null' : 'string',
          truncated: result.truncated,
        });
        return result;
      } catch (error) {
        log.warn('subscribe', {
          stage: 'subscribe',
          result: 'failed',
          ...failureFields(error),
        });
        throw toProtocolError(error);
      }
    },
  );

  server.server.setRequestHandler(
    'events/unsubscribe',
    { params: RAW_PARAMS },
    async (raw, ctx) => {
      const log = createEventsLogger('events/unsubscribe', ctx.mcpReq.id);
      try {
        const input = parseUnsubscribeInput(raw, log);
        const result = await unsubscribeEvents(env, principal, input, log);
        log.info('unsubscribe', { stage: 'unsubscribe', result: 'ok' });
        return result;
      } catch (error) {
        log.warn('unsubscribe', {
          stage: 'unsubscribe',
          result: 'failed',
          ...failureFields(error),
        });
        throw toProtocolError(error);
      }
    },
  );
}

export type EventsCapabilities = ServerCapabilities & {
  events?: Record<string, unknown>;
};
