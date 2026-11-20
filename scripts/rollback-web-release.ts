/**
 * 回滚到上一个不同 build 或显式 buildId。
 *
 * 只切换指针并写新的 deployment 记录，不重建、不覆盖资源。
 * 目标发布的全部资源必须仍在共享资产根中且摘要匹配。
 */

import { defaultReleasesRoot, parseArgs, rollbackTo } from './lib/web-release';

const args = parseArgs(process.argv.slice(2));
const root = args.values.get('root') ?? defaultReleasesRoot();
const target = args.values.get('to') ?? 'previous';

try {
  const result = await rollbackTo(root, target);
  console.log(
    JSON.stringify(
      {
        root,
        target,
        buildId: result.buildId,
        deploymentId: result.deploymentId,
      },
      null,
      2,
    ),
  );
  console.log('指针已切换；重启服务后生效。');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
