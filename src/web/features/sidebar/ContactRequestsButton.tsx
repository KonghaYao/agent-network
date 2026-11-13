import { useContactRequestBadge } from '../../hooks/useContactRequests';

/**
 * 侧栏“添加好友”入口：角标只统计收到的 pending 申请。
 *
 * 数据来自 `network_contact_requests_list { direction: 'incoming' }`，收到
 * `agentnet://stream` 的 contact 事件时由首页失效查询；不轮询、不阻塞会话列表。
 */
export function ContactRequestsButton({ onOpen }: { onOpen: () => void }) {
  const badge = useContactRequestBadge();
  const title =
    badge.count > 0
      ? `添加好友（${badge.count}${badge.hasMore ? '+' : ''} 条待处理申请）`
      : '添加好友';
  return (
    <button
      className="icon-btn"
      id="contact-requests"
      type="button"
      aria-label={title}
      title={title}
      onClick={onOpen}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M19 8v6M22 11h-6" />
      </svg>
      <span id="contact-requests-badge" className="request-badge" hidden={badge.count === 0}>
        {badge.count}
        {badge.hasMore ? '+' : ''}
      </span>
    </button>
  );
}
