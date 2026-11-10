/** `login` 与 `me`。login 只建立推送门控，不改变投递状态。 */

import type { CliArgs } from '../args';
import { assertKnownFlags } from '../args';
import type { McpClient, ResolvedConfig } from '../mcp';
import { asNumber, asString, emit, field, line } from '../output';

export async function login(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, []);
  const result = await client.callTool('network_login');
  emit(config, result, (value) => {
    line(
      `已上线 ${field('pending_count', asNumber(value.pending_count))} ${field(
        'inbox_head_seq',
        asString(value.inbox_head_seq, '-'),
      )}`,
    );
  });
}

export async function me(
  client: McpClient,
  config: ResolvedConfig,
  args: CliArgs,
): Promise<void> {
  assertKnownFlags(args, []);
  const result = await client.callTool('network_me');
  emit(config, result, (value) => {
    line(`${asString(value.name, '(未命名)')} (${asString(value.actor_id, '-')})`);
    line(`kind=${asString(value.kind, '-')} pending_count=${asNumber(value.pending_count)}`);
    line(`inbox_head_seq=${asString(value.inbox_head_seq, '-')}`);
    if (typeof value.share_url === 'string') line(`share_url=${value.share_url}`);
  });
}
