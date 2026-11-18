import { Button, useLenso } from '../../app/lenso-controls';
import { Tabs } from '../../app/lenso-tabs';
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
  const lenso = useLenso();
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
    if (lenso || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
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
          <Button id="contact-modal-close" type="button" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </div>
      }
    >
      <Tabs value={tab} onValueChange={(next) => setTab(next as ContactTab)}>
        <div
          className="contact-segments"
          id="contact-segments"
          onKeyDown={onTabKeyDown}
        >
          <Tabs.List aria-label="添加好友分类" xstyle={{ display: 'flex', width: '100%' }}>
            {TABS.map((entry) => {
              return (
                <Tabs.Tab
                  key={entry.value}
                  id={entry.id}
                  value={entry.value}
                  data-contact-tab={entry.value}
                  aria-controls={entry.panel}
                >
                  {entry.label}
                  {entry.value === 'requests' && badge.count > 0 ? (
                    <span id="contact-request-count" className="contact-count contact-tab-count">
                      {badge.count}
                      {badge.hasMore ? '+' : ''}
                    </span>
                  ) : null}
                </Tabs.Tab>
              );
            })}
          </Tabs.List>
        </div>
        <div className="contact-panels">
          {token && identityId ? (
            <>
              <Tabs.Panel
                value="search"
                id="contact-panel-search"
                aria-labelledby="contact-tab-search"
                tabIndex={0}
              >
                <ContactSearchPanel
                  token={token}
                  identityId={identityId}
                  active={tab === 'search'}
                  onAccepted={() => undefined}
                />
              </Tabs.Panel>
              <Tabs.Panel
                value="requests"
                id="contact-panel-requests"
                aria-labelledby="contact-tab-requests"
                tabIndex={0}
              >
                <ContactRequestsPanel active={tab === 'requests'} onChanged={() => undefined} />
              </Tabs.Panel>
              <Tabs.Panel
                value="more"
                id="contact-panel-more"
                aria-labelledby="contact-tab-more"
                tabIndex={0}
              >
                <ContactLinksPanel token={token} active={tab === 'more'} />
              </Tabs.Panel>
            </>
          ) : (
            <p className="contact-request-empty" role="status">
              浏览器身份尚未初始化，请稍后重试。
            </p>
          )}
        </div>
      </Tabs>
    </Modal>
  );
}
