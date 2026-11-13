import type { ReactNode } from 'react';

/**
 * React 运行壳：只接管应用页的 `<main>` 容器，侧栏/主区由页面组合。
 * 保留 legacy 的 `main` 语义与 APP_STYLE 双栏布局。
 */
export function AppShell({ sidebar, main }: { sidebar: ReactNode; main: ReactNode }) {
  return (
    <main>
      {sidebar}
      {main}
    </main>
  );
}

/** 桌面右侧空状态；只有选择会话后才进入 legacy 聊天页。 */
export function EmptyPane({
  title = '选择一个会话开始聊天',
  hint = '从左侧选择单聊或群聊。',
}: {
  title?: string;
  hint?: string;
}) {
  return (
    <section className="chat-pane empty-pane" aria-label="聊天区">
      <div className="empty" id="empty-state">
        <div className="empty-art" aria-hidden="true">
          <span className="empty-bubble left" />
          <span className="empty-bubble right" />
        </div>
        <p className="empty-title" id="empty-title">
          {title}
        </p>
        <p className="empty-hint" id="empty-hint">
          {hint}
        </p>
      </div>
    </section>
  );
}
