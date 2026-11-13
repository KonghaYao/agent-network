import { useEffect, useState, type KeyboardEvent } from 'react';

import { useContactRequestBadge } from '../../hooks/useContactRequests';
import { useWebSession } from '../../hooks/useWebSession';
import { ContactLinksPanel } from '../contacts/ContactLinksPanel';
import { ContactRequestsPanel } from '../contacts/ContactRequestsPanel';
import { ContactSearchPanel } from '../contacts/ContactSearchPanel';
import { Modal } from './Modal';

type ContactTab = 'search' | 'requests' | 'more';

const TABS: { value: ContactTab; label: string; id: string; panel: string }[] = [
  { value: 'search', label: '搜索添加', id: 'contact-tab-search', panel: 'contact-panel-search' },
  { value: 'requests', label: '好友申请', id: 'contact-tab-requests', panel: 'contact-panel-requests' },
  { value: 'more', label: '链接与设置', id: 'contact-tab-more', panel: 'contact-panel-more' },
];

/**
 * 添加好友弹窗：搜索添加、好友申请、链接与接收策略。
 *
 * 打开后默认进入搜索页，与 legacy 一致；好友申请页只处理 pending，
 * 链接明文只保存在 `ContactLinksPanel` 的内存状态。关闭后焦点回到
 * `#contact-requests` 由调用方负责，Radix 负责弹窗内的焦点陷阱。
 */
export function ContactRequestsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const session = useWebSession();
  const token = session.session?.token ?? null;
  const identityId = session.session?.identity.actor_id ?? null;
  const badge = useContactRequestBadge();
  const [tab, setTab] = useState<ContactTab>('search');

  useEffect(() => {
    if (!open) return;
    setTab('search');
  }, [open]);

  const focusTab = (next: ContactTab) => {
    setTab(next);
    requestAnimationFrame(() => {
      document.getElementById(`contact-tab-${next}`)?.focus();
    });
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = TABS.findIndex((entry) => entry.value === tab);
    let next = index;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else next = (index + 1) % TABS.length;
    const target = TABS[next];
    if (target) focusTab(target.value);
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="添加好友"
      titleId="contact-modal-title"
      contentId="contact-modal"
      className="contact-modal-card"
      footer={
        <div className="row modal-actions">
          <button id="contact-modal-close" type="button" onClick={() => onOpenChange(false)}>
            关闭
          </button>
        </div>
      }
    >
      <div
        className="contact-segments"
        id="contact-segments"
        role="tablist"
        aria-label="添加好友分类"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((entry) => {
          const selected = tab === entry.value;
          return (
            <button
              key={entry.value}
              id={entry.id}
              type="button"
              role="tab"
              data-contact-tab={entry.value}
              aria-selected={selected}
              aria-controls={entry.panel}
              tabIndex={selected ? 0 : -1}
              onClick={() => setTab(entry.value)}
            >
              {entry.label}
              {entry.value === 'requests' && badge.count > 0 ? (
                <span id="contact-request-count" className="contact-count contact-tab-count">
                  {badge.count}
                  {badge.hasMore ? '+' : ''}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="contact-panels">
        {token && identityId ? (
          <>
            <ContactSearchPanel
              token={token}
              identityId={identityId}
              active={tab === 'search'}
              onAccepted={() => undefined}
            />
            <ContactRequestsPanel active={tab === 'requests'} onChanged={() => undefined} />
            <ContactLinksPanel token={token} active={tab === 'more'} />
          </>
        ) : (
          <p className="contact-request-empty" role="status">
            浏览器身份尚未初始化，请稍后重试。
          </p>
        )}
      </div>
    </Modal>
  );
}
