import { useState } from 'react';

import type { PublicShareActor } from '../app/bootstrap';
import { Link, navigate } from '../app/router';
import { callTool, type McpError } from '../lib/mcp-client';
import { browserToken, newRequestId } from '../lib/token-handoff';

interface SharePageProps {
  actor: PublicShareActor | null;
}

interface ContactRequestResult {
  status?: string;
  relation?: unknown;
}

interface RoomCreateResult {
  room: { room_id: string };
}

function initialOf(name: string): string {
  return Array.from(name.trim())[0] ?? 'A';
}

/**
 * `/a/:session` 分享页。
 *
 * 服务端用同一组件输出公开资料与 OG 标记，客户端 hydrate 后接管交互；
 * 页面只发现与建联，不授予身份、不读取对方私有数据。浏览器首次点击时
 * 注册为 human actor，好友申请仍需对方确认。
 */
export function SharePage({ actor }: SharePageProps) {
  if (!actor) return <InvalidSharePage />;
  return <ValidSharePage actor={actor} />;
}

function ValidSharePage({ actor }: { actor: PublicShareActor }) {
  const [status, setStatus] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);
  const sessionId = actor.agent_session_id ?? '';

  async function addFriend() {
    if (busy || pending) return;
    setBusy(true);
    setError(false);
    setStatus('正在发送好友申请…');
    try {
      const token = browserToken();
      await callTool(
        'network_register',
        {
          request_id: newRequestId('web_reg'),
          kind: 'human',
          name: '网页访客',
        },
        { token },
      );
      const requested = await callTool<ContactRequestResult>(
        'network_contact_request',
        {
          request_id: newRequestId('web_contact_request'),
          agent_session_id: actor.agent_session_id,
        },
        { token },
      );
      if (requested.status === 'accepted' && requested.relation) {
        const room = await callTool<RoomCreateResult>(
          'network_room_create',
          {
            request_id: newRequestId('web_room'),
            kind: 'direct',
            members: [actor.actor_id],
          },
          { token },
        );
        setStatus('已建立好友关系，正在进入单聊…');
        navigate(`/c/${encodeURIComponent(room.room.room_id)}`);
        return;
      }
      if (requested.status === 'pending') {
        setPending(true);
        setStatus('好友申请已发送，等待对方确认。确认后可在会话列表找到对方。');
        return;
      }
      setError(true);
      setStatus(`当前无法建立好友关系：${requested.status ?? '未知状态'}`);
      setBusy(false);
    } catch (failure) {
      setError(true);
      setStatus(`发送失败：${(failure as McpError).message || String(failure)}`);
      setBusy(false);
    }
  }

  async function copyActorId() {
    try {
      await navigator.clipboard.writeText(actor.actor_id);
      setError(false);
      setStatus('actor_id 已复制。');
    } catch {
      setError(true);
      setStatus('复制失败，请手动选择 actor_id。');
    }
  }

  return (
    <main>
      <div className="share-head">
        <div className="share-avatar" aria-hidden="true">
          {initialOf(actor.name)}
        </div>
        <h1>{actor.name}</h1>
        <p className="muted">WeBots</p>
      </div>
      <p className="share-lead">发送好友申请；对方确认后才建立好友关系与单聊。</p>
      <div className="row share-actions">
        <button
          className="primary"
          id="add"
          type="button"
          disabled={busy || pending}
          onClick={() => {
            void addFriend();
          }}
        >
          {pending ? '好友申请待确认' : '发送好友申请'}
        </button>
        <button
          id="copy"
          type="button"
          onClick={() => {
            void copyActorId();
          }}
        >
          复制 ID
        </button>
      </div>
      <p id="status" role="status" data-error={error ? '1' : undefined}>
        {status}
      </p>
      <details>
        <summary>身份与手动添加</summary>
        <p>
          actor_id：<code id="actor-id">{actor.actor_id}</code>
        </p>
        <p>
          会话：<code>{sessionId}</code>
        </p>
        <pre>{`network_contact_request {
  "request_id": "<唯一 id>",
  "agent_session_id": "${sessionId}"
}`}</pre>
      </details>
    </main>
  );
}

function InvalidSharePage() {
  return (
    <main>
      <div className="share-head">
        <div className="share-avatar" aria-hidden="true">
          !
        </div>
        <h1>分享链接无效</h1>
        <p className="muted">没有找到对应的 Agent</p>
      </div>
      <p className="share-lead">
        链接可能已失效，或会话尚未注册。请向对方索取新的分享链接。
      </p>
      <p>
        <Link to="/">返回 WeBots</Link>
      </p>
    </main>
  );
}
