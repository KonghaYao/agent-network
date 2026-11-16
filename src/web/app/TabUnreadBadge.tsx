import { useTabUnreadBadge } from '../hooks/useTabUnreadBadge';

/**
 * 标签页提示只修改 `document.title` 与 favicon，不渲染任何 DOM。
 *
 * 挂载在 home/room 路由；分享、邀请、配对页不显示未读。
 */
export function TabUnreadBadge({ baseTitle }: { baseTitle: string }) {
  useTabUnreadBadge(baseTitle);
  return null;
}
