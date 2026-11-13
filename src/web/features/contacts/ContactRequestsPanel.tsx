import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import {
  useContactRequests,
  type ContactRequestActor,
  type ContactRequestView,
} from '../../hooks/useContactRequests';
import { useWebSession } from '../../hooks/useWebSession';
import { callTool } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';

function actorLabel(actor: ContactRequestActor | undefined): string {
  if (!actor || typeof actor.name !== 'string') return '未知身份';
  return `${actor.name}${actor.kind === 'agent' ? ' · Agent' : ' · 人'}`;
}

function requestTitle(item: ContactRequestView, identityId: string | null): string {
  if (item.direction === 'incoming') {
    const forManagedAgent = item.to_actor && item.to_actor.actor_id !== identityId;
    return `${actorLabel(item.from_actor)}${
      forManagedAgent ? ` 请求添加 ${actorLabel(item.to_actor)} 为好友` : ' 请求添加你为好友'
    }`;
  }
  return `你向 ${actorLabel(item.to_actor)} 发送了好友申请`;
}

/**
 * 好友申请列表：只处理 pending 申请，接受后服务端建立 direct 会话。
 *
 * 组件只负责列表与操作；角标由侧栏独立查询，会话列表由调用方在成功后失效。
 */
export function ContactRequestsPanel({
  active,
  onChanged,
}: {
  active: boolean;
  onChanged: () => void;
}) {
  const session = useWebSession();
  const identityId = session.session?.identity.actor_id ?? null;
  const token = session.session?.token ?? null;
  const requests = useContactRequests(active);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!active) return;
    setStatus('');
    setError(false);
    setBusyId(null);
  }, [active]);

  const pending = requests.items.filter((item) => item.status === 'pending');
  const incoming = pending.filter((item) => item.direction === 'incoming').length;

  const refresh = async () => {
    if (!identityId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.contactRequests(identityId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.contactRequestBadge(identityId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identityId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.contacts(identityId) }),
    ]);
    onChanged();
  };

  const setMessage = (message: string, isError = false) => {
    setStatus(message);
    setError(isError);
  };

  const respond = async (item: ContactRequestView, action: 'accept' | 'reject') => {
    if (!token || busyId) return;
    setBusyId(item.contact_request_id);
    setMessage(action === 'accept' ? '正在接受…' : '正在拒绝…');
    try {
      await callTool(
        'network_contact_request_respond',
        {
          request_id: newRequestId('web_contact_respond'),
          contact_request_id: item.contact_request_id,
          action,
        },
        { token },
      );
      setMessage(action === 'accept' ? '已接受好友申请。' : '已拒绝好友申请。');
      await refresh();
    } catch (failure) {
      setMessage(
        `处理失败：${failure instanceof Error ? failure.message : String(failure)}`,
        true,
      );
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (item: ContactRequestView) => {
    if (!token || busyId) return;
    setBusyId(item.contact_request_id);
    setMessage('正在撤销…');
    try {
      await callTool(
        'network_contact_request_cancel',
        {
          request_id: newRequestId('web_contact_cancel'),
          contact_request_id: item.contact_request_id,
        },
        { token },
      );
      setMessage('已撤销好友申请。');
      await refresh();
    } catch (failure) {
      setMessage(
        `撤销失败：${failure instanceof Error ? failure.message : String(failure)}`,
        true,
      );
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      id="contact-panel-requests"
      className="contact-panel contact-requests-panel"
      role="tabpanel"
      aria-labelledby="contact-tab-requests"
      tabIndex={0}
      hidden={!active}
    >
      <p className="contact-request-summary">
        <span className="contact-count" hidden={incoming === 0}>
          {incoming}
          {requests.hasMore ? '+' : ''}
        </span>
        <span className="contact-request-summary-text">
          {incoming === 0 ? '暂无待处理申请。' : `${incoming} 条待处理申请`}
        </span>
      </p>
      <p
        id="contact-request-status"
        className="contact-search-status"
        role="status"
        data-error={error ? '1' : undefined}
      >
        {status}
      </p>
      <ul id="contact-request-list" className="contact-request-list" aria-label="待处理好友申请">
        {requests.loading ? (
          <li className="contact-request-empty" role="status">
            正在读取好友申请…
          </li>
        ) : pending.length === 0 ? (
          <li className="contact-request-empty">暂无待处理申请。</li>
        ) : (
          pending.map((item) => {
            const rowBusy = busyId === item.contact_request_id;
            return (
              <li
                key={item.contact_request_id}
                className="contact-request-item"
                data-contact-request-id={item.contact_request_id}
                data-direction={item.direction}
              >
                <div className="contact-request-main">
                  <p className="contact-request-title">{requestTitle(item, identityId)}</p>
                  {item.message ? <p className="contact-request-message">{item.message}</p> : null}
                  <p className="contact-request-meta">
                    {item.auto_accepted ? '已自动建立' : '等待确认'}
                  </p>
                </div>
                <div className="contact-request-actions">
                  {item.direction === 'incoming' && item.can_respond ? (
                    <>
                      <button
                        type="button"
                        className="primary"
                        disabled={busyId !== null}
                        onClick={() => void respond(item, 'accept')}
                      >
                        {rowBusy ? '处理中…' : '接受'}
                      </button>
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void respond(item, 'reject')}
                      >
                        拒绝
                      </button>
                    </>
                  ) : null}
                  {item.can_cancel ? (
                    <button
                      type="button"
                      disabled={busyId !== null}
                      onClick={() => void cancel(item)}
                    >
                      {rowBusy ? '处理中…' : '撤销申请'}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })
        )}
      </ul>
      {requests.error ? (
        <p className="field-error" role="alert">
          {requests.error}
        </p>
      ) : null}
      <button
        id="contact-request-more"
        className="list-retry"
        type="button"
        hidden={!requests.hasMore}
        disabled={requests.loadingMore}
        onClick={() => void requests.loadMore()}
      >
        {requests.loadingMore ? '正在加载…' : '加载更多申请'}
      </button>
    </section>
  );
}
