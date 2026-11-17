import { lazy, Suspense } from 'react';

import type { RoomFileItem } from '../../lib/files-ui';

/**
 * 预览弹窗按需加载。
 *
 * 弹窗依赖 Radix Dialog、Markdown 渲染与文本 Range 读取，聊天入口不应
 * 为它付出首屏体积；只有用户真正打开某个文件时才请求该 chunk。
 */
const FilePreviewDialog = lazy(() =>
  import('./FilePreviewDialog').then((module) => ({ default: module.FilePreviewDialog })),
);

export function LazyFilePreviewDialog({
  item,
  onClose,
}: {
  item: RoomFileItem | null;
  onClose: () => void;
}) {
  if (!item) return null;
  return (
    <Suspense fallback={null}>
      <FilePreviewDialog item={item} onClose={onClose} />
    </Suspense>
  );
}
