import { useEffect, useRef, useState } from 'react';

import { Link, navigate } from '../app/router';
import { callTool, type McpError } from '../lib/mcp-client';
import { browserToken, newRequestId } from '../lib/token-handoff';

interface Invitation {
  invitation_id: string;
  room_id: string;
  room_title: string;
  inviter_id: string;
  inviter_name: string;
  status: string;
  next_step: string;
  member_count: number;
  expires_at: string;
  can_respond: boolean;
  join_request_id?: string | null;
  join_request_status?: string | null;
}

interface InvitationPage {
  items: Invitation[];
}

interface RespondResult {
  status: string;
  room_id: string;
  join_request_id?: string | null;
}

interface JoinPageProps {
  /** 格式非法时服务端返回 null，并保留 404。 */
  inviteKey: string | null;
}

function actionLabel(item: Invitation): string {
  if (item.next_step === 'request') return '申请加入';
  if (item.next_step === 'pending_approval') return '等待管理员批准';
  if (item.next_step === 'join') return '加入群聊';
  if (item.next_step === 'member') return '进入群聊';
  return '无法加入';
}

function actionHint(item: Invitation): string {
  if (item.status === 'expired') return '邀请已过期，请向群管理员索取新的链接。';
  if (item.status === 'revoked') return '邀请已被管理员撤销，旧二维码和链接都已失效。';
  if (item.status === 'exhausted') return '邀请次数已用尽，请联系管理员重新创建。';
  if (item.next_step === 'removed') return '你已被移出该群，旧链接不能重新加入；需要管理员重新邀请。';
  if (item.next_step === 'blocked') return '你与邀请人之间存在拉黑关系，无法加入。';
  if (item.next_step === 'member') return '你已经是该群成员，可以直接进入。';
  if (item.next_step === 'pending_approval') return '申请已提交，等待群主或管理员批准。';
  if (item.next_step === 'request') return '该群开启审批；确认后先提交申请，批准后才成为成员。';
  if (item.next_step === 'join') return '确认后立即加入群聊；加入前的历史默认不可见。';
  return '该邀请当前不可用。';
}

async function ensureIdentity(token: string): Promise<unknown> {
  try {
    return await callTool('network_me', {}, { token });
  } catch (error) {
    if ((error as McpError).code !== 'CREDENTIAL_INVALID') throw error;
  }
  return callTool(
    'network_register',
    {
      request_id: newRequestId('web_join_reg'),
      kind: 'human',
      name: `网页访客 ${token.replaceAll('-', '').slice(0, 4)}`,
    },
    { token },
  );
}

/**
 * `/j/:inviteKey` 群邀请落地页。
 *
 * 服务端只输出邀请壳与说明；群名、人数与审批策略由浏览器 token 调用
 * `network_room_invite_get` 读取，加入前不读取任何群消息，也不在 HTML
 * 中泄露群存在性。
 */
export function JoinPage({ inviteKey }: JoinPageProps) {
  if (!inviteKey) return <InvalidJoinPage />;
  return <ValidJoinPage inviteKey={inviteKey} />;
}

function ValidJoinPage({ inviteKey }: { inviteKey: string }) {
  const [title, setTitle] = useState('群邀请');
  const [avatar, setAvatar] = useState('群');
  const [meta, setMeta] = useState('正在读取邀请…');
  const [lead, setLead] = useState(
    '邀请码有效不等于已加入。确认后才会成为成员或提交审批申请。',
  );
  const [inviter, setInviter] = useState('—');
  const [members, setMembers] = useState('—');
  const [expires, setExpires] = useState('—');
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);
  const pendingRequestId = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadPreview() {
      try {
        const token = browserToken();
        await ensureIdentity(token);
        const page = await callTool<InvitationPage>(
          'network_room_invite_get',
          { invite_key: inviteKey, limit: 1 },
          { token },
        );
        const item = page.items?.[0];
        if (!item) throw new Error('邀请不存在');
        if (cancelled) return;
        setInvitation(item);
        setTitle(item.room_title || '群聊');
        setAvatar(Array.from((item.room_title || '群聊').trim())[0] || '群');
        setMeta(`群邀请 · ${item.member_count} 人`);
        setLead(actionHint(item));
        setInviter(item.inviter_name || item.inviter_id);
        setMembers(`${item.member_count} 人`);
        setExpires(new Date(Number(item.expires_at)).toLocaleString());
        pendingRequestId.current =
          item.next_step === 'pending_approval' ? item.join_request_id ?? null : null;
        if (item.next_step === 'member') {
          setStatus('你已经是群成员。');
          setError(false);
        } else if (item.next_step === 'pending_approval') {
          setStatus('入群申请已提交，等待管理员批准。');
          setError(false);
        } else if (item.can_respond) {
          setStatus('');
          setError(false);
        }
      } catch (failure) {
        if (cancelled) return;
        setLoadFailed(true);
        setTitle('邀请不可用');
        setMeta('链接可能已过期、被撤销或不是有效的群邀请。');
        setLead('请向群管理员索取新的邀请链接。');
        setStatus((failure as McpError).message || String(failure));
        setError(true);
      }
    }
    void loadPreview();
    return () => {
      cancelled = true;
    };
  }, [inviteKey]);

  async function confirmJoin() {
    if (busy || !invitation) return;
    if (invitation.next_step === 'member') {
      navigate(`/c/${encodeURIComponent(invitation.room_id)}`);
      return;
    }
    setBusy(true);
    setStatus('');
    setError(false);
    try {
      const token = browserToken();
      const result = await callTool<RespondResult>(
        'network_room_invite_respond',
        {
          request_id: pendingRequestId.current || newRequestId('web_join'),
          invitation_id: invitation.invitation_id,
          invite_key: inviteKey,
          action: 'accept',
        },
        { token },
      );
      if (result.status === 'requested') {
        pendingRequestId.current = result.join_request_id ?? null;
        setInvitation({
          ...invitation,
          next_step: 'pending_approval',
          can_respond: false,
          join_request_status: 'pending',
        });
        setStatus('入群申请已提交，等待群主或管理员批准。');
        return;
      }
      setStatus('已加入群聊，正在进入…');
      navigate(`/c/${encodeURIComponent(result.room_id)}`);
    } catch (failure) {
      setStatus(`加入失败：${(failure as McpError).message || String(failure)}`);
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  const label = busy ? '正在确认…' : invitation ? actionLabel(invitation) : loadFailed ? '无法加入' : '确认加入';
  const disabled =
    busy || !invitation || (!invitation.can_respond && invitation.next_step !== 'member');

  return (
    <main>
      <div className="share-head">
        <div className="share-avatar" id="join-avatar" aria-hidden="true">
          {avatar}
        </div>
        <h1 id="join-title">{title}</h1>
        <p className="muted" id="join-meta">
          {meta}
        </p>
      </div>
      <p className="share-lead" id="join-lead">
        {lead}
      </p>
      <dl>
        <dt>邀请人</dt>
        <dd id="join-inviter">{inviter}</dd>
        <dt>群成员</dt>
        <dd id="join-members">{members}</dd>
        <dt>有效期至</dt>
        <dd id="join-expires">{expires}</dd>
      </dl>
      <div className="row share-actions">
        <button
          className="primary"
          id="join-action"
          type="button"
          disabled={disabled}
          onClick={() => {
            void confirmJoin();
          }}
        >
          {label}
        </button>
        <button
          id="join-home"
          type="button"
          onClick={() => {
            navigate('/');
          }}
        >
          返回 WeBots
        </button>
      </div>
      <p id="status" role="status" data-error={error ? '1' : undefined}>
        {status}
      </p>
      <details>
        <summary>加入规则</summary>
        <p>链接默认 7 天有效、最多 20 次成功加入；群管理员可随时撤销。</p>
        <p>开启审批的群需要管理员批准后才会成为成员；被移出的成员不能复用旧链接。</p>
        <p>本页不会读取加入前的群消息，也不会把邀请码当作登录凭据。</p>
      </details>
    </main>
  );
}

function InvalidJoinPage() {
  return (
    <main>
      <div className="share-head">
        <div className="share-avatar" aria-hidden="true">
          !
        </div>
        <h1>邀请无效</h1>
        <p className="muted">链接格式不正确</p>
      </div>
      <p className="share-lead">请确认链接完整，或向群管理员索取新的邀请。</p>
      <p>
        <Link to="/">返回 WeBots</Link>
      </p>
    </main>
  );
}
