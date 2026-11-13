import { useCallback, useEffect, useMemo, useState } from 'react';

import { useContacts } from '../../hooks/useContacts';
import { copyText } from '../../lib/files';
import { callTool, type McpError } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';
import { Modal } from './Modal';

interface TransferView {
  transfer_id: string;
  agent_id: string;
  agent_name: string;
  from_manager_name: string;
  to_manager_name: string;
  status: string;
  expires_at: string;
  context: {
    snapshot?: {
      room_count?: number;
      pending_deliveries?: number;
    } | null;
  };
  can_accept: boolean;
  can_reject: boolean;
  can_cancel: boolean;
}

interface ManagementView {
  actor_id: string;
  name: string;
  my_role: 'manager' | 'delegate' | 'agent' | 'successor';
  management: { manager_name: string; permission_version: number } | null;
  can_transfer: boolean;
  pending_transfer: TransferView | null;
  in_flight_deliveries: {
    pending: number;
    claimed: number;
    items: { delivery_id: string; room_id: string; state: string; attempt: number }[];
  };
}

interface TransferAccepted {
  token: string | null;
  mcp_url: string | null;
}

const TRANSFER_TOKEN_WARNING =
  '新 token 只显示一次；只通过受控渠道配置，勿发群、截图或写日志。旧 token 已立即失效。';

const ROLE_TEXT: Record<ManagementView['my_role'], string> = {
  manager: '你是当前管理者',
  delegate: '你是受托管理人',
  agent: '你是该 Agent 本人',
  successor: '你是待确认的接任者',
};

/**
 * direct Agent 的管理权交接。
 *
 * 入口由房间菜单的 `peer_can_manage` 控制；面板只读公开管理工具，
 * 不读取原管理者的私聊或联系人。接受成功后新 token 仅在本次响应出现，
 * 关闭时立即从组件状态清除。
 */
export function TransferDialog({
  open,
  onOpenChange,
  agentId,
  token,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string | null;
  token: string | null;
}) {
  const contacts = useContacts(open);
  const [view, setView] = useState<ManagementView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [accepted, setAccepted] = useState<TransferAccepted | null>(null);

  const load = useCallback(async () => {
    if (!open || !agentId || !token) return;
    setLoading(true);
    setError('');
    try {
      const result = await callTool<ManagementView>(
        'network_agent_management_get',
        { actor_id: agentId },
        { token },
      );
      setView(result);
    } catch (failure) {
      const failureValue = failure as McpError;
      setError(
        failureValue.code === 'PERMISSION_DENIED'
          ? '只有该 Agent 的管理者、受托人或待确认接任者可以查看交接。'
          : failureValue.message || '读取管理关系失败',
      );
    } finally {
      setLoading(false);
    }
  }, [agentId, open, token]);

  useEffect(() => {
    if (!open) {
      setView(null);
      setSelected('');
      setSearch('');
      setError('');
      setNotice('');
      setAccepted(null);
      return;
    }
    void load();
  }, [load, open]);

  const successors = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return contacts.contacts.filter(
      (contact) =>
        contact.kind === 'human' &&
        (!needle || contact.name.toLowerCase().includes(needle)),
    );
  }, [contacts.contacts, search]);

  const pending = view?.pending_transfer ?? null;

  const propose = async () => {
    if (!agentId || !token || !selected || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const transfer = await callTool<{ to_manager_name: string }>(
        'network_agent_transfer_propose',
        {
          request_id: newRequestId('web_transfer'),
          actor_id: agentId,
          to_manager_id: selected,
        },
        { token },
      );
      setSelected('');
      await load();
      setNotice(`已发起交接，等待 ${transfer.to_manager_name} 确认。`);
    } catch (failure) {
      setError(`发起交接失败：${(failure as McpError).message || String(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  const respond = async (decision: 'accept' | 'reject') => {
    if (!token || !pending || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await callTool<TransferAccepted & { status?: string }>(
        'network_agent_transfer_respond',
        {
          request_id: newRequestId('web_transfer'),
          transfer_id: pending.transfer_id,
          decision,
        },
        { token },
      );
      if (decision === 'accept' && result.token && result.mcp_url) {
        setAccepted({ token: result.token, mcp_url: result.mcp_url });
      }
      await load();
      setNotice(decision === 'accept' ? '已接受管理权。' : '已拒绝交接。');
    } catch (failure) {
      setError(`交接操作失败：${(failure as McpError).message || String(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!token || !pending || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await callTool(
        'network_agent_transfer_cancel',
        {
          request_id: newRequestId('web_transfer'),
          transfer_id: pending.transfer_id,
        },
        { token },
      );
      await load();
      setNotice('已取消交接。');
    } catch (failure) {
      setError(`取消失败：${(failure as McpError).message || String(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
      title="交接 Agent 管理权"
      titleId="transfer-title"
      contentId="transfer-modal"
      className="transfer-card"
      footer={
        <div className="row modal-actions">
          <button id="transfer-close" type="button" onClick={() => onOpenChange(false)}>
            关闭
          </button>
        </div>
      }
    >
      {loading ? (
        <p id="transfer-loading" className="muted">
          正在读取管理关系…
        </p>
      ) : null}
      {error ? (
        <p id="transfer-status" className="form-error" role="status">
          {error}
        </p>
      ) : null}
      {notice ? <p className="transfer-notice" role="status">{notice}</p> : null}
      {view ? (
        <div id="transfer-body">
          <p id="transfer-summary" className="muted">
            {view.name} · {ROLE_TEXT[view.my_role] ?? view.my_role} · 当前管理者：
            {view.management?.manager_name ?? '未知'}
            {view.management ? ` · 权限版本 ${view.management.permission_version}` : ''}
          </p>

          {view.can_transfer ? (
            <div id="transfer-propose-section" className="transfer-section">
              <h3>选择接任者</h3>
              <input
                id="transfer-successor-search"
                className="transfer-search"
                type="search"
                placeholder="搜索好友名称"
                autoComplete="off"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
              <ul id="transfer-successors" className="transfer-list" aria-label="接任者候选">
                {successors.map((contact) => (
                  <li key={contact.actor_id}>
                    <label className="transfer-successor">
                      <input
                        type="radio"
                        name="transfer-successor"
                        value={contact.actor_id}
                        checked={selected === contact.actor_id}
                        onChange={() => setSelected(contact.actor_id)}
                      />
                      <span>{contact.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
              {successors.length === 0 ? (
                <p id="transfer-successors-empty" className="muted">
                  {contacts.contacts.length === 0 ? '没有可交接的好友' : '没有匹配的好友'}
                </p>
              ) : null}
              <p className="new-agent-warning">
                接任者必须是有有效凭据的真人；接受前管理权不变。
              </p>
              <div className="transfer-actions">
                <button
                  className="primary"
                  id="transfer-propose"
                  type="button"
                  disabled={busy || !selected}
                  onClick={() => void propose()}
                >
                  {busy ? '正在发起…' : '发起交接'}
                </button>
              </div>
              {contacts.hasMore ? (
                <button
                  className="list-retry"
                  type="button"
                  disabled={contacts.loadingMore}
                  onClick={() => void contacts.loadMore()}
                >
                  {contacts.loadingMore ? '正在加载…' : '加载更多好友'}
                </button>
              ) : null}
            </div>
          ) : null}

          {pending ? (
            <div id="transfer-pending" className="transfer-section">
              <h3>交接状态</h3>
              <p id="transfer-pending-text">
                状态：{pending.status}；发起人：{pending.from_manager_name}；接任者：
                {pending.to_manager_name}
              </p>
              <p id="transfer-pending-note" className="muted">
                在途快照：群 {pending.context?.snapshot?.room_count ?? 0} 个、待处理投递{' '}
                {pending.context?.snapshot?.pending_deliveries ?? 0} 条。接受前管理权不变。
              </p>
              <div className="transfer-actions">
                {pending.can_accept ? (
                  <button
                    className="primary"
                    id="transfer-accept"
                    type="button"
                    disabled={busy}
                    onClick={() => void respond('accept')}
                  >
                    接受
                  </button>
                ) : null}
                {pending.can_reject ? (
                  <button
                    id="transfer-reject"
                    type="button"
                    disabled={busy}
                    onClick={() => void respond('reject')}
                  >
                    拒绝
                  </button>
                ) : null}
                {pending.can_cancel ? (
                  <button
                    className="danger"
                    id="transfer-cancel"
                    type="button"
                    disabled={busy}
                    onClick={() => void cancel()}
                  >
                    取消交接
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          <div id="transfer-work" className="transfer-section">
            <h3>在途工作</h3>
            <p id="transfer-work-summary">
              待处理投递 {view.in_flight_deliveries.pending} 条（已领取{' '}
              {view.in_flight_deliveries.claimed} 条）
            </p>
            <ul id="transfer-work-deliveries" className="transfer-list">
              {view.in_flight_deliveries.items.map((delivery) => (
                <li key={delivery.delivery_id}>
                  {delivery.state} · 房间 {delivery.room_id} · 尝试 {delivery.attempt}
                </li>
              ))}
            </ul>
          </div>

          {accepted ? (
            <div id="transfer-token-panel" className="transfer-section new-agent-result">
              <p className="new-agent-warning" id="transfer-token-warning">
                {TRANSFER_TOKEN_WARNING}
              </p>
              <label className="field">
                <span>新 MCP URL</span>
                <input
                  id="transfer-token"
                  className="transfer-token"
                  type="text"
                  readOnly
                  value={accepted.mcp_url ?? ''}
                />
              </label>
              <button
                className="new-agent-copy"
                id="transfer-token-copy"
                type="button"
                onClick={() => {
                  if (accepted.mcp_url) void copyText(accepted.mcp_url);
                }}
              >
                复制 MCP URL
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
