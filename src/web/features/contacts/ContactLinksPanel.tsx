import { useCallback, useEffect, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import { copyText } from '../../lib/files';
import { callTool, type McpError } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';
import { confirmDialog } from '../overlays/confirm';

interface ContactLink {
  link_id: string;
  status: 'pending' | 'used' | 'revoked' | 'expired';
  expires_at: string;
  used_by: { actor_id: string; name: string; kind: 'human' | 'agent' } | null;
  can_revoke: boolean;
}

interface LinkPage {
  items: ContactLink[];
}

interface LinkCreateResult {
  link: ContactLink | null;
  share_url: string;
}

interface PolicyResult {
  policy: 'self_approval' | 'manager_approval' | 'auto_accept';
}

function failureMessage(error: unknown): string {
  const failure = error as McpError;
  return failure.message || String(error);
}

function timeLabel(value: string): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

function linkState(link: ContactLink): string {
  if (link.status === 'used') return '已使用';
  if (link.status === 'revoked') return '已撤销';
  if (link.status === 'expired') return '已过期';
  return '待使用';
}

function linkDetail(link: ContactLink): string {
  if (link.status === 'used' && link.used_by) return `由 ${link.used_by.name} 使用`;
  if (link.status === 'pending') return `有效至 ${timeLabel(link.expires_at)}`;
  return '';
}

/**
 * 好友链接与接收策略：链接明文只保存在本次页面内存。
 *
 * 创建接口只在首次响应返回 `share_url`；列表接口不返回 token。重置/撤销
 * 后旧链接立即失效。复制走 `copyText`，非安全上下文使用 execCommand 回退。
 */
export function ContactLinksPanel({
  token,
  active,
}: {
  token: string;
  active: boolean;
}) {
  const [links, setLinks] = useState<ContactLink[]>([]);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  const [linkStatus, setLinkStatus] = useState('');
  const [linkError, setLinkError] = useState(false);
  const [policy, setPolicy] = useState<'self_approval' | 'auto_accept'>('self_approval');
  const [policyStatus, setPolicyStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [page, current] = await Promise.all([
        callTool<LinkPage>(
          'network_contact_link_list',
          { limit: LIMITS.contactLinkListMax },
          { token },
        ),
        callTool<PolicyResult>('network_contact_policy_get', {}, { token }),
      ]);
      setLinks(page.items ?? []);
      const next = current.policy === 'auto_accept' ? 'auto_accept' : 'self_approval';
      setPolicy(next);
      setPolicyStatus(
        next === 'auto_accept'
          ? '自动接受所有好友申请（包括陌生 Agent）。'
          : '好友申请需要你本人确认。',
      );
    } catch (failure) {
      setLinks([]);
      setLinkStatus(`读取好友链接失败：${failureMessage(failure)}`);
      setLinkError(true);
    }
  }, [token]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setLinkError(false);
    setLinkStatus('正在生成好友链接…');
    try {
      const result = await callTool<LinkCreateResult>(
        'network_contact_link_create',
        { request_id: newRequestId('web_contact_link') },
        { token },
      );
      if (!result.share_url) throw new Error('服务端未返回可复制的链接');
      setPlaintext(result.share_url);
      setLinkStatus('链接已生成，24 小时内有效、只能使用一次。点击“复制链接”发给对方。');
      const page = await callTool<LinkPage>(
        'network_contact_link_list',
        { limit: LIMITS.contactLinkListMax },
        { token },
      );
      setLinks(page.items ?? []);
    } catch (failure) {
      setLinkStatus(`生成失败：${failureMessage(failure)}`);
      setLinkError(true);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!plaintext) {
      setLinkError(true);
      setLinkStatus('链接明文只保留在本次页面会话；请重新生成后再复制。');
      return;
    }
    try {
      await copyText(plaintext);
      setLinkError(false);
      setLinkStatus('已复制。链接只能使用一次，请通过可信渠道发送。');
    } catch (failure) {
      setLinkError(true);
      setLinkStatus(`复制失败：${failureMessage(failure)}`);
    }
  };

  const revoke = async (link: ContactLink) => {
    if (busy || !link.can_revoke) return;
    const confirmed = await confirmDialog({
      title: '撤销好友链接',
      message: '撤销后该链接立即失效，不能再用于添加好友。确定撤销？',
      confirmText: '撤销',
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setLinkError(false);
    setLinkStatus('正在撤销…');
    try {
      await callTool(
        'network_contact_link_revoke',
        {
          request_id: newRequestId('web_contact_link_revoke'),
          link_id: link.link_id,
        },
        { token },
      );
      if (plaintext && links.some((item) => item.link_id === link.link_id)) setPlaintext(null);
      setLinkStatus('已撤销好友链接。');
      const page = await callTool<LinkPage>(
        'network_contact_link_list',
        { limit: LIMITS.contactLinkListMax },
        { token },
      );
      setLinks(page.items ?? []);
    } catch (failure) {
      setLinkStatus(`撤销失败：${failureMessage(failure)}`);
      setLinkError(true);
    } finally {
      setBusy(false);
    }
  };

  const savePolicy = async (next: 'self_approval' | 'auto_accept') => {
    setPolicy(next);
    setPolicyStatus('正在保存…');
    try {
      const result = await callTool<PolicyResult>(
        'network_contact_policy_set',
        {
          request_id: newRequestId('web_contact_policy'),
          policy: next,
        },
        { token },
      );
      const saved = result.policy === 'auto_accept' ? 'auto_accept' : 'self_approval';
      setPolicy(saved);
      setPolicyStatus(
        saved === 'auto_accept'
          ? '自动接受所有好友申请（包括陌生 Agent）。'
          : '好友申请需要你本人确认。',
      );
    } catch (failure) {
      setPolicyStatus(`保存失败：${failureMessage(failure)}`);
    }
  };

  return (
    <section
      id="contact-panel-more"
      className="contact-panel contact-more-panel"
      role="tabpanel"
      aria-labelledby="contact-tab-more"
      tabIndex={0}
      hidden={!active}
    >
      <section className="contact-link-panel" aria-label="好友链接">
        <div className="contact-section-head">
          <h3>好友链接</h3>
        </div>
        <p className="contact-link-hint">一次性链接，24 小时内有效；对方登录后直接成为好友。</p>
        <div className="contact-link-actions">
          <button
            id="contact-link-create"
            className="primary"
            type="button"
            disabled={busy}
            onClick={() => void create()}
          >
            {busy ? '正在生成…' : '生成好友链接'}
          </button>
          <button
            id="contact-link-copy"
            type="button"
            hidden={!plaintext}
            onClick={() => void copy()}
          >
            复制链接
          </button>
        </div>
        <p
          id="contact-link-status"
          className="contact-link-status"
          role="status"
          data-error={linkError ? '1' : undefined}
        >
          {linkStatus}
        </p>
        <ul id="contact-link-list" className="contact-link-list" aria-label="已生成的好友链接">
          {links.length === 0 ? (
            <li className="contact-request-empty">还没有生成好友链接。</li>
          ) : (
            links.map((link) => (
              <li className="contact-link-item" key={link.link_id}>
                <div className="contact-link-main">
                  <span
                    className="contact-link-state"
                    data-status={link.status}
                  >
                    {linkState(link)}
                  </span>
                  {linkDetail(link) ? (
                    <span className="contact-link-meta">{linkDetail(link)}</span>
                  ) : null}
                </div>
                {link.can_revoke ? (
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`撤销好友链接 ${link.link_id}`}
                    onClick={() => void revoke(link)}
                  >
                    撤销
                  </button>
                ) : null}
              </li>
            ))
          )}
        </ul>
      </section>
      <section className="contact-policy" aria-label="我的接收策略">
        <label className="contact-policy-field" htmlFor="contact-policy-select">
          我的接收策略
          <select
            id="contact-policy-select"
            value={policy}
            onChange={(event) =>
              void savePolicy(event.target.value === 'auto_accept' ? 'auto_accept' : 'self_approval')
            }
          >
            <option value="self_approval">本人确认</option>
            <option value="auto_accept">自动接受</option>
          </select>
        </label>
        <p id="contact-policy-status" className="contact-policy-status" role="status">
          {policyStatus}
        </p>
      </section>
    </section>
  );
}
