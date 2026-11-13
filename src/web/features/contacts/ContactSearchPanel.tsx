import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { LIMITS } from '../../../contracts/limits';
import { callTool, type McpError } from '../../lib/mcp-client';
import { queryKeys } from '../../lib/query-keys';
import { newRequestId } from '../../lib/request-id';

interface SearchActor {
  actor_id: string;
  kind: 'human' | 'agent';
  name: string;
  agent_session_id?: string | null;
}

interface SearchItem {
  actor: SearchActor;
  relation: 'active' | 'none';
  pending_request: { contact_request_id: string; direction: 'incoming' | 'outgoing' } | null;
}

interface SearchPage {
  items: SearchItem[];
  truncated: boolean;
}

interface ContactRequestResult {
  request?: { contact_request_id: string } | null;
  status?: string;
  already_friends?: boolean;
}

function failureMessage(error: unknown): string {
  const failure = error as McpError;
  return failure.message || String(error);
}

/**
 * 搜索添加好友：先按名称搜索，再核对完整 actor_id 后发送申请。
 *
 * 搜索本身不建立关系；同名结果必须经过 ID 核对。申请被自动接受时直接
 * 提示已建立好友关系，并交给调用方刷新会话列表/申请角标。
 */
export function ContactSearchPanel({
  token,
  identityId,
  active,
  onAccepted,
}: {
  token: string;
  identityId: string;
  active: boolean;
  onAccepted: () => void;
}) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SearchItem[]>([]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<SearchItem | null>(null);
  const [message, setMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (!value || busy) {
      setItems([]);
      setSelected(null);
      setStatus('请输入用户名。');
      setError(true);
      return;
    }
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setBusy(true);
    setSelected(null);
    setError(false);
    setStatus('正在搜索…');
    try {
      const page = await callTool<SearchPage>(
        'network_contact_search',
        { query: value, limit: LIMITS.contactSearchPageDefault },
        { token, signal: abort.signal },
      );
      if (abort.signal.aborted) return;
      setItems(page.items ?? []);
      const count = page.items?.length ?? 0;
      setStatus(
        page.truncated
          ? `结果较多，仅显示前 ${LIMITS.contactSearchPageDefault} 条；请补充用户名继续缩小范围。`
          : count > 0
            ? `找到 ${count} 位用户，请核对 ID。`
            : '没有找到匹配的用户。',
      );
    } catch (failure) {
      if (abort.signal.aborted) return;
      setItems([]);
      setSelected(null);
      setStatus(`搜索失败：${failureMessage(failure)}`);
      setError(true);
    } finally {
      if (!abort.signal.aborted) setBusy(false);
    }
  };

  const send = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(false);
    setStatus('正在发送好友邀请…');
    try {
      const result = await callTool<ContactRequestResult>(
        'network_contact_request',
        {
          request_id: newRequestId('web_contact_search_request'),
          actor_id: selected.actor.actor_id,
          ...(message.trim() ? { message: message.trim() } : {}),
        },
        { token },
      );
      const accepted = result.already_friends === true || result.status === 'accepted';
      setStatus(
        accepted
          ? `已完成添加：${selected.actor.name}。`
          : '好友邀请已发送，等待对方同意。',
      );
      setSelected(null);
      setMessage('');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.contactRequests(identityId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.contactRequestBadge(identityId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.contacts(identityId) }),
      ]);
      if (accepted) {
        await queryClient.invalidateQueries({ queryKey: queryKeys.rooms(identityId) });
        onAccepted();
      }
      const updated = await callTool<SearchPage>(
        'network_contact_search',
        { query: query.trim(), limit: LIMITS.contactSearchPageDefault },
        { token },
      );
      setItems(updated.items ?? []);
    } catch (failure) {
      setStatus(`发送失败：${failureMessage(failure)}`);
      setError(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      id="contact-panel-search"
      className="contact-panel contact-search-panel"
      role="tabpanel"
      aria-labelledby="contact-tab-search"
      tabIndex={0}
      hidden={!active}
    >
      <p className="contact-search-hint">
        输入完整或部分用户名；可搜索人类，以及已在你群聊、管理列表或好友中的 Agent。遇到同名用户时，请核对完整 ID 后再发送邀请。
      </p>
      <form id="contact-search-form" className="contact-search-form" onSubmit={(event) => void search(event)}>
        <label htmlFor="contact-search-input">用户名</label>
        <div className="contact-search-controls">
          <input
            id="contact-search-input"
            type="search"
            maxLength={LIMITS.actorNameMax}
            autoComplete="off"
            placeholder="输入用户名"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(null);
            }}
          />
          <button id="contact-search-submit" className="primary" type="submit" disabled={busy}>
            {busy ? '搜索中…' : '搜索'}
          </button>
        </div>
      </form>
      <p
        id="contact-search-status"
        className="contact-search-status"
        role="status"
        data-error={error ? '1' : undefined}
      >
        {status}
      </p>
      <ul id="contact-search-results" className="contact-search-results" aria-label="用户名搜索结果">
        {items.map((item) => {
          const pending = item.pending_request !== null;
          const active = item.relation === 'active';
          return (
            <li className="contact-search-item" key={item.actor.actor_id}>
              <div className="contact-search-main">
                <p className="contact-search-heading">
                  <strong className="contact-search-name">{item.actor.name}</strong>
                  <span className="contact-search-kind">
                    {item.actor.kind === 'agent' ? 'Agent' : '人'}
                  </span>
                </p>
                <code className="contact-search-id">{item.actor.actor_id}</code>
              </div>
              {active ? (
                <span className="contact-search-state">已是好友</span>
              ) : pending ? (
                <span className="contact-search-state">待处理申请</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSelected(item);
                    setError(false);
                    setStatus(`请核对 ${item.actor.name} 的 ID，确认无误后发送邀请。`);
                  }}
                >
                  核对 ID
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {selected ? (
        <div id="contact-search-confirm" className="contact-search-confirm">
          <p className="contact-search-confirm-hint">请核对目标 ID，确认无误后发送好友邀请。</p>
          <strong id="contact-search-confirm-name">{selected.actor.name}</strong>
          <code id="contact-search-confirm-id">{selected.actor.actor_id}</code>
          <label htmlFor="contact-search-message">申请附言（可选）</label>
          <textarea
            id="contact-search-message"
            rows={2}
            maxLength={LIMITS.contactRequestMessageBytes}
            placeholder="介绍一下自己"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
          />
          <div className="contact-search-confirm-actions">
            <button
              id="contact-search-cancel"
              type="button"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setMessage('');
                setStatus('');
              }}
            >
              取消
            </button>
            <button
              id="contact-search-send"
              className="primary"
              type="button"
              disabled={busy}
              onClick={() => void send()}
            >
              发送邀请
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
