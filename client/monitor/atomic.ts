/**
 * write-file-atomic 的局部包装。
 *
 * 该包是 CJS 且没有自带类型；`client/write-file-atomic.d.ts` 提供最小声明，
 * 这里兼容 Bun 的 `namespace.default` 形态并固定本地状态文件权限。
 */

import * as writeFileAtomicModule from 'write-file-atomic';

type WriteFileAtomic = (
  path: string,
  data: string,
  options?: { mode?: number },
) => Promise<void>;

const writeFileAtomic = ((writeFileAtomicModule as { default?: WriteFileAtomic }).default ??
  writeFileAtomicModule) as WriteFileAtomic;

/** 原子写本地状态；失败时旧文件保持不变。 */
export async function writeAtomicFile(path: string, content: string): Promise<void> {
  await writeFileAtomic(path, content, { mode: 0o600 });
}
