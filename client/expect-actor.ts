/** CLI 身份闸门：在 login、订阅与自动 claim 之前确认凭据归属。 */
import type { McpClient } from './mcp';

export class ActorMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`ERROR actor_mismatch expected=${expected} actual=${actual}`);
    this.name = 'ActorMismatchError';
  }
}

export async function assertExpectedActor(
  client: Pick<McpClient, 'verifyActor'>,
  expected: string | undefined,
): Promise<void> {
  if (expected === undefined) return;
  await client.verifyActor(expected);
}
