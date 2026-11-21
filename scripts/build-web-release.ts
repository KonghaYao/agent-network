/**
 * 构建候选发布并（默认）切换 `current` 指针。
 *
 * 步骤：Bun 模块 → Vite 候选目录 → 全资产校验 → 追加资产/索引
 * → 写 release.json → 写 deployment 记录 → 原子切指针。
 *
 * 进程内的运行实例不会追随新指针；需要在发布窗口内重启服务。
 * 本命令不执行数据库迁移、生产测试或部署。
 */

import { LIMITS } from '../src/contracts/limits';
import {
  buildCandidate,
  defaultReleasesRoot,
  formatBytes,
  parseArgs,
  publishCandidate,
} from './lib/web-release';

const args = parseArgs(process.argv.slice(2));
const root = args.values.get('root') ?? defaultReleasesRoot();
const nonce = args.values.get('nonce') ?? crypto.randomUUID();

try {
  const candidate = await buildCandidate({
    releasesRoot: root,
    nonce,
    log: (message) => console.log(message),
  });
  const result = await publishCandidate(candidate, {
    releasesRoot: root,
    activate: !args.flags.has('no-activate'),
    pin: args.flags.has('pin') ? 'build' : undefined,
    freezeLegacy: args.flags.has('freeze-legacy'),
    keepCandidate: args.flags.has('keep-candidate'),
    log: (message) => console.log(message),
  });
  if (args.flags.has('pin')) {
    console.log(`已 pin: ${result.buildId}`);
  }
  console.log(
    JSON.stringify(
      {
        root,
        buildId: result.buildId,
        deploymentId: result.deploymentId,
        releaseDir: result.releaseDir,
        assets: result.assets,
        legacyFrozen: result.legacyFrozen,
      },
      null,
      2,
    ),
  );
  console.log(
    `候选入口与全部资源已就绪（${result.assets} 个文件）。重启服务后新 build 生效。`,
  );
  console.log(`入口字节上限: ${formatBytes(LIMITS.webEntryHardLimitBytes)}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
