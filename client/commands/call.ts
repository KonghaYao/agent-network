/** 通用逃生口：`call <tool> '<json>'` 覆盖所有 network_* 工具。 */

import type { CliArgs } from '../args';
import { assertKnownFlags } from '../args';
import type { McpClient, ResolvedConfig } from '../mcp';
import { CliError } from '../mcp';
import { emit, line } from '../output';

async function readArguments(raw: string | undefined): Promise<Record<string, unknown>> {
  let text = raw ?? '{}';
  if (text === '-') text = await Bun.stdin.text();
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(`工具参数不是合法 JSON：${reason}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('工具参数必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

export async function call(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, []);
  const tool = args.positionals[1];
  if (!tool) throw new CliError(`用法：agentnet call <tool> '<json>'`);
  if (!/^[a-z0-9_]+$/u.test(tool)) {
    throw new CliError(`工具名不合法：${tool}`);
  }
  const input = await readArguments(args.positionals[2]);
  const result = await client.callTool(tool, input);
  // 通用调用不假设输出结构，人类模式同样输出完整 JSON。
  emit(config, result, (value) => {
    line(JSON.stringify(value, null, 2));
  });
}
