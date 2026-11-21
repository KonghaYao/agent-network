import { FileListSkeleton } from './FileListSkeleton';

/**
 * 文件栏 chunk 到达前的同宽骨架。
 *
 * 复用最终文件栏的根 class 与加载骨架，使首帧就按最终宽度布局；骨架不占用
 * `#files-pane` id：Suspense 切换时 React 会短暂保留旧占位 DOM，两个同名 id
 * 会破坏 `getElementById` 与测试的 strict 定位。
 */
export function FilesPaneFallback() {
  return (
    <aside className="files-pane" aria-label="房间文件" aria-busy="true">
      <header className="files-head">
        <h2>文件</h2>
      </header>
      <ul className="files-list" aria-label="文件列表">
        <FileListSkeleton />
      </ul>
    </aside>
  );
}
