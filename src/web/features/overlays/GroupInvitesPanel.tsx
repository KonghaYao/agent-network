import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { RoomView } from '../../lib/chat';
import { copyText } from '../../lib/files';
import { callTool, type McpError } from '../../lib/mcp-client';
import { newRequestId } from '../../lib/request-id';
import { confirmDialog } from '../overlays/confirm';

interface RoomInvitation {
  invitation_id: string;
  status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired' | 'exhausted';
  expires_at: string;
  revision: number;
  max_uses: number;
  used_count: number;
  inviter_name: string;
}

interface InvitationPage {
  items: RoomInvitation[];
}

interface JoinRequest {
  join_request_id: string;
  status: string;
  message: string;
  revision: number;
  applicant: { actor_id: string; name: string; kind: 'human' | 'agent' };
}

interface JoinRequestPage {
  items: JoinRequest[];
}

interface InviteCreateResult {
  invitation: RoomInvitation | null;
  invite_key: string | null;
  share_url: string | null;
}

function failureText(error: unknown): string {
  return (error as McpError).message || String(error);
}

function expiry(value: string): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Date(timestamp).toLocaleString();
}

/**
 * 群邀请链接与入群申请。
 *
 * 链接明文只在创建响应出现一次；这里保存在组件内存，撤销/关闭后丢弃。
 * 普通成员在邀请策略允许时也能创建链接，但只有 owner/admin 能看到申请列表。
 */
export function GroupInvitesPanel({
  room,
  token,
  active,
}: {
  room: RoomView;
  token: string;
  active: boolean;
}) {
  const canInvite = room.capabilities?.invite_members === true && !room.read_only;
  const canApprove = room.capabilities?.approve_joins === true && !room.read_only;
  const [invitations, setInvitations] = useState<RoomInvitation[]>([]);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [days, setDays] = useState(7);
  const [uses, setUses] = useState(20);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!canInvite && !canApprove) return;
    setError(false);
    try {
      if (canInvite) {
        const page = await callTool<InvitationPage>(
          'network_room_invite_get',
          { room_id: room.room_id, status: 'pending', limit: 50 },
          { token },
        );
        setInvitations(page.items ?? []);
      }
      if (canApprove) {
        const page = await callTool<JoinRequestPage>(
          'network_room_join_request_list',
          { room_id: room.room_id, status: 'pending', limit: 50 },
          { token },
        );
        setRequests(page.items ?? []);
      }
    } catch (failure) {
      setError(true);
      setStatus(`读取邀请与申请失败：${failureText(failure)}`);
    }
  }, [canApprove, canInvite, room.room_id, token]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !canInvite) return;
    if (!Number.isFinite(days) || days < 1 || days > 30) {
      setError(true);
      setStatus('有效天数需在 1 到 30 之间。');
      return;
    }
    if (!Number.isFinite(uses) || uses < 1 || uses > 100) {
      setError(true);
      setStatus('可加入次数需在 1 到 100 之间。');
      return;
    }
    setBusy(true);
    setError(false);
    setStatus('正在创建邀请链接…');
    try {
      const result = await callTool<InviteCreateResult>(
        'network_room_invite_create',
        {
          request_id: newRequestId('web_room_invite'),
          room_id: room.room_id,
          max_uses: Math.round(uses),
          expires_in_ms: Math.round(days * 86_400_000),
        },
        { token },
      );
      setShareUrl(result.share_url);
      setStatus('已创建邀请链接，明文只显示这一次。');
      await load();
    } catch (failure) {
      setError(true);
      setStatus(`创建邀请链接失败：${failureText(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!shareUrl) return;
    try {
      await copyText(shareUrl);
      setError(false);
      setStatus('已复制邀请链接');
    } catch (failure) {
      setError(true);
      setStatus(`复制失败：${failureText(failure)}`);
    }
  };

  const revoke = async (item: RoomInvitation) => {
    if (busy) return;
    const confirmed = await confirmDialog({
      title: '撤销邀请',
      message: '撤销该邀请？撤销后所有设备上的旧链接和二维码立即失效。',
      confirmText: '撤销',
      danger: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setError(false);
    setStatus('正在撤销邀请…');
    try {
      await callTool(
        'network_room_invite_revoke',
        {
          request_id: newRequestId('web_room_invite_revoke'),
          invitation_id: item.invitation_id,
          expected_revision: item.revision,
        },
        { token },
      );
      setStatus('已撤销邀请链接。');
      await load();
    } catch (failure) {
      setError(true);
      setStatus(`撤销失败：${failureText(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  const respond = async (item: JoinRequest, action: 'approve' | 'reject') => {
    if (busy) return;
    setBusy(true);
    setError(false);
    setStatus(action === 'approve' ? '正在批准…' : '正在拒绝…');
    try {
      await callTool(
        'network_room_join_request_respond',
        {
          request_id: newRequestId('web_room_join_respond'),
          join_request_id: item.join_request_id,
          action,
          expected_revision: item.revision,
        },
        { token },
      );
      setStatus(action === 'approve' ? '已批准入群申请。' : '已拒绝入群申请。');
      await load();
    } catch (failure) {
      setError(true);
      setStatus(`${action === 'approve' ? '批准' : '拒绝'}失败：${failureText(failure)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!canInvite && !canApprove) return null;

  return (
    <>
      {canInvite ? (
        <section className="members-invites" id="members-invites">
          <div className="members-section-head">
            <h3>邀请链接</h3>
            <span id="members-invites-count" className="members-count" aria-live="polite">
              {invitations.length}
            </span>
          </div>
          <form className="members-invite-form" onSubmit={(event) => void create(event)}>
            <label>
              有效天数
              <input
                id="members-invite-days"
                type="number"
                min={1}
                max={30}
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              />
            </label>
            <label>
              可加入次数
              <input
                id="members-invite-uses"
                type="number"
                min={1}
                max={100}
                value={uses}
                onChange={(event) => setUses(Number(event.target.value))}
              />
            </label>
            <button id="members-invite-create" className="primary" type="submit" disabled={busy}>
              {busy ? '正在创建…' : '创建邀请链接'}
            </button>
          </form>
          {shareUrl ? (
            <div id="members-invite-share" className="members-invite-share">
              <p id="members-invite-url" className="members-invite-url">
                {shareUrl}
              </p>
              <div className="row">
                <button id="members-invite-copy" type="button" onClick={() => void copy()}>
                  复制链接
                </button>
                <button
                  id="members-invite-dismiss"
                  type="button"
                  onClick={() => setShareUrl(null)}
                >
                  收起
                </button>
              </div>
            </div>
          ) : null}
          <ul id="members-invites-list" className="member-roster" aria-label="本群邀请链接">
            {invitations.length === 0 ? (
              <li className="members-empty">没有待使用的邀请链接。</li>
            ) : (
              invitations.map((item) => (
                <li className="member-roster-item" key={item.invitation_id}>
                  <span>
                    {item.used_count}/{item.max_uses} 次 · 有效至 {expiry(item.expires_at)}
                  </span>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    aria-label={`撤销邀请 ${item.invitation_id}`}
                    onClick={() => void revoke(item)}
                  >
                    撤销
                  </button>
                </li>
              ))
            )}
          </ul>
        </section>
      ) : null}
      {canApprove ? (
        <section className="members-requests" id="members-requests">
          <div className="members-section-head">
            <h3>入群申请</h3>
            <span id="members-requests-count" className="members-count" aria-live="polite">
              {requests.length}
            </span>
          </div>
          <ul id="members-requests-list" className="member-roster" aria-label="待审批的入群申请">
            {requests.length === 0 ? (
              <li id="members-requests-empty" className="members-empty">
                没有待审批的申请
              </li>
            ) : (
              requests.map((item) => (
                <li className="member-roster-item" key={item.join_request_id}>
                  <span>
                    {item.applicant.name}
                    {item.message ? `：${item.message}` : ''}
                  </span>
                  <span className="row">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      aria-label={`批准 ${item.applicant.name}`}
                      onClick={() => void respond(item, 'approve')}
                    >
                      批准
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      aria-label={`拒绝 ${item.applicant.name}`}
                      onClick={() => void respond(item, 'reject')}
                    >
                      拒绝
                    </button>
                  </span>
                </li>
              ))
            )}
          </ul>
        </section>
      ) : null}
      <p
        id="members-invites-status"
        className="form-error"
        role="status"
        aria-live="polite"
        data-error={error ? '1' : undefined}
      >
        {status}
      </p>
    </>
  );
}
