/** CLI 身份闸门：在 login、订阅与自动 claim 之前确认凭据归属。 */
import { CliError, type McpClient } from './mcp';
import { asString } from './output';

export class ActorMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`ERROR actor_mismatch expected=${expected} actual=${actual}`);
    this.name = 'ActorMismatchError';
  }
}

export async function assertExpectedActor(
  client: Pick<McpClient, 'callTool'>,
  expected: string | undefined,
): Promise<void> {
  if (expected === undefined) return;
  if (!/^[A-Za-z0-9_-]+$/u.test(expected)) {
    throw new CliError('--expect-actor 必须是非空 actor_id');
  }
  const me = await client.callTool('network_me');
  const actual = asString(me.actor_id);
  if (!/^[A-Za-z0-9_-]+$/u.test(actual)) {
    throw new CliError('network_me 未返回有效 actor_id');
  }
  if (actual !== expected) throw new ActorMismatchError(expected, actual);
}
