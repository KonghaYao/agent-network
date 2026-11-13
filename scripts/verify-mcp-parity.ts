/**
 * 对比实时 MCP 行为与固定 baseline。
 *
 * 4D-5 起 mcp-use 是唯一实现；baseline 继续约束工具契约、协议帧与 SSE
 * 顺序，任何差异都视为回归。
 *
 * 失败时输出第一个差异路径；协议/工具契约的变更必须先说明并重新录制：
 * `bun scripts/capture-mcp-baseline.ts`。
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  assertNoSecrets,
  firstDifference,
  recordBaseline,
  type Baseline,
} from './lib/mcp-parity';

const FIXTURE = resolve(import.meta.dir, '../tests/fixtures/mcp-baseline.json');

async function main() {
  const expected = JSON.parse(await readFile(FIXTURE, 'utf8')) as Baseline;
  const actual = await recordBaseline();
  assertNoSecrets(actual, ['parity ping', 'parity stream', 'parity file']);
  const diff = firstDifference(
    { ...actual, digest: '<digest>' },
    { ...expected, digest: '<digest>' },
  );
  if (diff) {
    console.error(`MCP parity mismatch: ${diff}`);
    console.error(
      `expected digest ${expected.digest}; actual digest ${actual.digest} ` +
        `(tools ${expected.toolCount} -> ${actual.toolCount}, ` +
        `toolset ${expected.toolsetSha256} -> ${actual.toolsetSha256})`,
    );
    process.exit(1);
  }
  console.log(
    [
      'MCP parity passed (mcp-use)',
      `tools: ${actual.toolCount}`,
      `toolset_sha256: ${actual.toolsetSha256}`,
      `frames: ${actual.frames.length}`,
      `sse: ${actual.sse.length}`,
      `transports: ${actual.transports.length}`,
      `digest: ${actual.digest}`,
    ].join('\n'),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
