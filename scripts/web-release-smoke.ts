/**
 * 运行中实例的发布冒烟：版本接口、HTML 元数据、全部资源字节、
 * 固定别名与非 GET /mcp。用于部署脚本与人工复核。
 */

import {
  defaultReleasesRoot,
  parseArgs,
  probeLiveRelease,
} from './lib/web-release';
import { readCurrentBuildId } from '../src/web/web-release';

const args = parseArgs(process.argv.slice(2));
const base = args.values.get('base') ?? process.env.AGENTNET_URL ?? 'http://127.0.0.1:8792';
const root = args.values.get('root') ?? defaultReleasesRoot();
const expected = args.values.get('expect-build') ?? (await readCurrentBuildId(root));

if (!expected) {
  console.error(`没有当前发布指针，也没有提供 --expect-build（root: ${root}）`);
  process.exit(1);
}

try {
  const result = await probeLiveRelease(base, root, expected);
  console.log(
    JSON.stringify(
      {
        base,
        buildId: result.buildId,
        deploymentId: result.deploymentId,
        assets: result.assets,
        bytes: result.bytes,
      },
      null,
      2,
    ),
  );
  console.log('发布冒烟通过。');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
