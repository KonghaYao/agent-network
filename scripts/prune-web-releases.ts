/**
 * 清理追加式静态资产根。默认 dry-run；只有显式 `--apply` 才删除。
 *
 * 保留集合：当前发布、最近 7 天部署、最近两个不同 build、显式 pin、
 * 迁移基线。固定别名字节永不自动删除。
 */

import { LIMITS } from '../src/contracts/limits';
import {
  defaultReleasesRoot,
  formatBytes,
  parseArgs,
  pruneReleases,
} from './lib/web-release';

const args = parseArgs(process.argv.slice(2));
const root = args.values.get('root') ?? defaultReleasesRoot();
const apply = args.flags.has('apply');
const graceHours = Number(args.values.get('grace-hours') ?? LIMITS.webReleaseGcGraceMs / 3_600_000);
if (!Number.isFinite(graceHours) || graceHours < 0) {
  console.error('--grace-hours 必须是非负数');
  process.exit(1);
}

try {
  const result = await pruneReleases({
    root,
    apply,
    graceMs: graceHours * 3_600_000,
    log: (message) => console.log(message),
  });
  console.log(
    JSON.stringify(
      {
        root,
        apply,
        graceHours,
        retainedBuilds: result.retainedBuilds,
        referencedUrls: result.originals.length,
        candidates: result.candidates.length,
        bytes: result.bytes,
        removed: result.removed,
      },
      null,
      2,
    ),
  );
  if (!apply) {
    console.log(
      `dry-run：未删除任何文件。确认后运行同一命令并加 --apply（可清理 ${formatBytes(result.bytes)}）。`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
