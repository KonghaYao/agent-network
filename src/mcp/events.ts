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
import { MESSAGE_CREATED_ARGUMENTS } from '../events/definitions';
import { EventsError } from '../events/errors';
import {
  listEventDefinitions,
  subscribeEvents,
  unsubscribeEvents,
} from '../events/subscriptions';

const META = z.record(z.string(), z.unknown()).optional();

const EVENTS_LIST_PARAMS = z.strictObject({
  cursor: z.string().optional(),
  _meta: META,
});

const SUBSCRIBE_DELIVERY = z.strictObject({
  mode: z.string().min(1),
  url: z.string().min(1),
  secret: z.string().min(1),
});

const EVENTS_SUBSCRIBE_PARAMS = z.strictObject({
  name: z.string().min(1),
  arguments: MESSAGE_CREATED_ARGUMENTS.optional(),
  delivery: SUBSCRIBE_DELIVERY,
  cursor: z.string().regex(/^\d{1,18}$/u).nullable().optional(),
  ttlMs: z.number().int().nonnegative().nullable().optional(),
  _meta: META,
});

const UNSUBSCRIBE_DELIVERY = z.strictObject({
  mode: z.string().min(1).optional(),
  url: z.string().min(1),
  secret: z.string().min(1).optional(),
});

const EVENTS_UNSUBSCRIBE_PARAMS = z.strictObject({
  name: z.string().min(1),
  arguments: MESSAGE_CREATED_ARGUMENTS.optional(),
  delivery: UNSUBSCRIBE_DELIVERY,
  _meta: META,
});

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

/** 只在 EVENTS 配置有效时注册；未声明能力时客户端应得到 -32601。 */
export function registerEvents(server: McpServer, env: Env, principal: Principal): void {
  server.server.setRequestHandler(
    'events/list',
    { params: EVENTS_LIST_PARAMS },
    async () => listEventDefinitions(),
  );

  server.server.setRequestHandler(
    'events/subscribe',
    { params: EVENTS_SUBSCRIBE_PARAMS },
    async (params) => {
      try {
        return await subscribeEvents(env, principal, params);
      } catch (error) {
        throw toProtocolError(error);
      }
    },
  );

  server.server.setRequestHandler(
    'events/unsubscribe',
    { params: EVENTS_UNSUBSCRIBE_PARAMS },
    async (params) => {
      try {
        return await unsubscribeEvents(env, principal, params);
      } catch (error) {
        throw toProtocolError(error);
      }
    },
  );
}

export type EventsCapabilities = ServerCapabilities & {
  events?: Record<string, unknown>;
};
