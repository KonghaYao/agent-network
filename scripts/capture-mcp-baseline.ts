/**
 * 录制当前 MCP 协议基线。
 *
 * 只在隔离临时实例上运行；baseline 不含 token、上传票据、webhook secret
 * 或消息正文。协议/工具契约变化后需要重新录制并 review fixture diff。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { assertNoSecrets, recordBaseline } from './lib/mcp-parity';

const FIXTURE = resolve(import.meta.dir, '../tests/fixtures/mcp-baseline.json');

async function main() {
  const baseline = await recordBaseline();
  assertNoSecrets(baseline, ['parity ping', 'parity stream', 'parity file']);
  await mkdir(resolve(import.meta.dir, '../tests/fixtures'), { recursive: true });
  await writeFile(FIXTURE, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    [
      `mcp baseline written: ${FIXTURE}`,
      `tools: ${baseline.toolCount}`,
      `toolset_sha256: ${baseline.toolsetSha256}`,
      `frames: ${baseline.frames.length}`,
      `sse: ${baseline.sse.length}`,
      `transports: ${baseline.transports.length}`,
      `digest: ${baseline.digest}`,
    ].join('\n'),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
