import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { EmptyPane } from '../app/AppShell';
import { AppSidebar } from '../features/layout/AppSidebar';
import { SplitLayout } from '../features/layout/SplitLayout';
import { useWebSession } from '../hooks/useWebSession';
import {
  friendLinkFailure,
  friendLinkReason,
  previewFriendLink,
  redeemFriendLink,
  takeFriendLinkToken,
} from '../lib/friend-link';
import { queryKeys } from '../lib/query-keys';

/**
 * Home：会话列表、搜索、分类与空状态。
 *
 * 只读 `network_me` / `network_rooms_list`；服务端状态由 React Query 持有，
 * SSE 只失效列表查询。筛选是 UI 偏好，存 zustand 并继续写回 legacy key。
 */
export function HomePage() {
  const queryClient = useQueryClient();
  const session = useWebSession();
  const friendToken = useRef<string | null>(null);
  const friendRead = useRef(false);
  const [friendNotice, setFriendNotice] = useState<{ message: string; error: boolean } | null>(
    null,
  );

  useEffect(() => {
    if (friendRead.current) return;
    friendRead.current = true;
    friendToken.current = takeFriendLinkToken();
  }, []);

  useEffect(() => {
    if (!friendToken.current) return;
    if (session.status === 'logged-out' || session.status === 'credential-invalid') {
      setFriendNotice({
        message: '好友链接需要可用的浏览器身份；请先创建身份或完成设备配对后重新打开链接。',
        error: true,
      });
      friendToken.current = null;
      return;
    }
    const token = session.session?.token;
    const identity = session.session?.identity;
    if (session.status !== 'ready' || !token || !identity) return;
    const pending = friendToken.current;
    friendToken.current = null;
    void (async () => {
      try {
        const preview = await previewFriendLink(pending, token);
        if (!preview.valid) {
          setFriendNotice({ message: friendLinkReason(preview.reason), error: true });
          return;
        }
        const result = await redeemFriendLink(pending, token);
        const ownerName = result.owner?.name ?? preview.owner?.name ?? '对方';
        setFriendNotice({
          message: result.already_friends
            ? `已是好友：${ownerName}`
            : `已添加好友：${ownerName}`,
          error: false,
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identity.actor_id) }),
          queryClient.invalidateQueries({ queryKey: queryKeys.contacts(identity.actor_id) }),
        ]);
      } catch (failure) {
        setFriendNotice({ message: `添加好友失败：${friendLinkFailure(failure)}`, error: true });
      }
    })();
  }, [queryClient, session.session, session.status]);

  const empty: { title?: string; hint?: string } =
    session.status === 'logged-out'
      ? {
          title: '已退出登录',
          hint: '点击左侧「创建新身份并继续」，或打开 Agent 分享链接。',
        }
      : session.status === 'credential-invalid'
        ? {
            title: '凭据已失效',
            hint: '请用另一台已登录设备生成配对码后打开 /pair。',
          }
        : {};

  return (
    <SplitLayout
      sidebar={<AppSidebar notice={friendNotice} />}
      main={<EmptyPane title={empty.title} hint={empty.hint} />}
    />
  );
}
