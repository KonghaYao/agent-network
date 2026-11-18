import { useState } from 'react';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { AppShell } from './AppShell';
import { Link } from './router';

/** 只画几何骨架，不挂载业务表单、sidebar 查询或房间订阅，也不占业务 id。 */
export function ChatRouteFallback() {
  const desktop = useMediaQuery('(min-width: 1200px)');
  const [filesOpen] = useState(() => {
    try { return localStorage.getItem('agent-network-files-open') !== '0'; }
    catch { return true; }
  });
  return (
    <AppShell
      sidebar={
        <aside className="sidebar" aria-label="正在加载会话列表" aria-busy="true">
          <header className="sidebar-head"><h1>WeBots</h1></header>
          <div className="sidebar-list" aria-hidden="true">
            {Array.from({ length: 4 }, (_, index) => (
              <div className="room-skeleton" key={index}>
                <span className="skeleton-avatar" />
                <span className="skeleton-lines"><span /><span /></span>
              </div>
            ))}
          </div>
        </aside>
      }
      main={
        <>
        <section className="chat-pane" aria-label="聊天区" aria-busy="true" data-chat-route-fallback="">
          <header className="chat-head chat-head--loading">
            <Link className="back" to="/" aria-label="返回会话列表">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>
            </Link>
            <div className="chat-id chat-id--loading" aria-hidden="true">
              <span className="chat-skeleton-line chat-skeleton-line--title" />
              <span className="chat-skeleton-line chat-skeleton-line--subtitle" />
            </div>
          </header>
          <div className="chat-skeleton"><p className="muted" role="status">正在加载会话…</p></div>
          <div className="composer composer--loading" aria-hidden="true">
            <div className="composer-main"><span className="chat-route-input-skeleton" /></div>
          </div>
        </section>
        {desktop && filesOpen ? (
          <aside className="files-pane" aria-label="房间文件" aria-busy="true">
            <header className="files-head"><h2>文件</h2></header>
            <div className="files-list" aria-hidden="true" />
          </aside>
        ) : null}
        </>
      }
    />
  );
}
