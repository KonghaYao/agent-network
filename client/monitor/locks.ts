/**
 * proper-lockfile 的局部包装。
 *
 * 该包是 CJS；这里用命名空间导入并固定 `realpath:false`，避免全局开启
 * `esModuleInterop`。锁目标必须已存在（调用方先 mkdir）。
 */

import * as lockfile from 'proper-lockfile';

export interface LockTiming {
  /** 锁文件超过该时间未更新即可视为崩溃遗留。 */
  stale: number;
  /** 持锁进程刷新 mtime 的间隔。 */
  update: number;
}

export async function acquireLock(path: string, timing: LockTiming): Promise<() => Promise<void>> {
  return lockfile.lock(path, {
    realpath: false,
    stale: timing.stale,
    update: timing.update,
    retries: 0,
  });
}
