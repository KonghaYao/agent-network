import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { isBusinessError } from '../contracts/errors';
import { recordToolContract } from './client-contract';
import type { RegistrationServer } from './registration';

type ToolReturn = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/**
 * SDK 的 registerTool 重载在泛型封装下无法正确选择 Standard Schema 分支；
 * 运行时行为不变，这里只收敛类型断言。
 */
type RegisterToolCall = (
  name: string,
  config: Record<string, unknown>,
  callback: (args: unknown) => Promise<ToolReturn>,
) => unknown;

function failure(error: unknown, safeErrors = false): ToolReturn {
  if (isBusinessError(error)) {
    return {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(error.toBody()) }],
    };
  }
  if (safeErrors) {
    // 局部安全路径：不记录原始异常、cause、SQL 绑定或输入，避免诊断文本泄露。
    console.error('agent-network tool failed: INTERNAL_ERROR');
  } else {
    console.error('agent-network tool failed', error);
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ code: 'INTERNAL_ERROR', message: '内部错误', retryable: false }),
      },
    ],
  };
}

export interface RegisterOptions {
  /** 仅反馈工具启用：未知异常只记录固定分类，不输出原始错误。 */
  safeErrors?: boolean;
}

export function register<
  I extends StandardSchemaWithJSON,
  O extends StandardSchemaWithJSON,
>(
  server: RegistrationServer,
  name: string,
  description: string,
  inputSchema: I,
  outputSchema: O,
  handler: (
    args: StandardSchemaWithJSON.InferInput<I>,
  ) => Promise<StandardSchemaWithJSON.InferOutput<O>>,
  annotations?: Record<string, unknown>,
  options: RegisterOptions = {},
): void {
  const call = server.registerTool as unknown as RegisterToolCall;
  call.call(server, name, { description, inputSchema, outputSchema, ...(annotations ? { annotations } : {}) }, async (args) => {
    try {
      const value = (await handler(args as StandardSchemaWithJSON.InferInput<I>)) as Record<
        string,
        unknown
      >;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
        structuredContent: value,
      };
    } catch (error) {
      return failure(error, options.safeErrors);
    }
  });
  recordToolContract(server, name, { description, inputSchema, outputSchema, annotations });
}
