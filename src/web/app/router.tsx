import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { useEffect, useState } from 'react';

/**
 * 约 100 行的 history router。
 *
 * 4B-1 只用 home；其余 route 仍由服务端渲染 legacy，解析函数先固定语义，
 * 4B-2/3 接管时不需要换路由库。`Link` 只拦截同源普通左键点击。
 */
export type AppRoute =
  | { name: 'home' }
  | { name: 'room'; roomId: string }
  | { name: 'share'; sessionId: string }
  | { name: 'join'; inviteKey: string }
  | { name: 'pair' };

function segment(pathname: string, prefix: string): string {
  const raw = pathname.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export function parseRoute(pathname: string): AppRoute {
  if (pathname === '/') return { name: 'home' };
  if (pathname === '/pair') return { name: 'pair' };
  if (pathname.startsWith('/c/')) {
    const roomId = segment(pathname, '/c/');
    return roomId ? { name: 'room', roomId } : { name: 'home' };
  }
  if (pathname.startsWith('/a/')) {
    const sessionId = segment(pathname, '/a/');
    return sessionId ? { name: 'share', sessionId } : { name: 'home' };
  }
  if (pathname.startsWith('/j/')) {
    const inviteKey = segment(pathname, '/j/');
    return inviteKey ? { name: 'join', inviteKey } : { name: 'home' };
  }
  return { name: 'home' };
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, '', path);
  else window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute(): AppRoute {
  const [route, setRoute] = useState<AppRoute>(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  return route;
}

interface LinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  to: string;
  children: ReactNode;
}

export function Link({ to, children, onClick, ...rest }: LinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    if (rest.target && rest.target !== '_self') return;
    if (!to.startsWith('/')) return;
    event.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={handleClick} {...rest}>
      {children}
    </a>
  );
}
