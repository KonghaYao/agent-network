import { useCallback, useEffect, useMemo, useState } from 'react';

import { AppShell } from '../app/AppShell';
import { Composer, type ComposerSendInput } from '../features/chat/Composer';
import { Timeline } from '../features/chat/Timeline';
import { useRoomChat } from '../hooks/useRoomChat';
import { useSendQueue } from '../hooks/useSendQueue';
import {
  buildSendPlan,
  composeMessageBody,
  mentionNames,
  senderName,
  type HistoryMessage,
} from '../lib/chat';

interface ChatPageProps {
  roomId: string;
}

function onlineLabel(online: boolean | null): string {
  if (online === true) return '在线';
  if (online === false) return '离线';
  return '未知';
}

/**
 * React Chat 页：`/c/:room_id` 在 `WEB_SPA_ROUTES=room` 时接管。
 *
 * 保留 legacy 的 DOM id/class（`composer`、`messages`、`title`、`subtitle`、
 * `status` 等），复用同一 MCP 工具与 localStorage key。发送意图在服务端
 * 确认前持久化，SSE 只作为刷新提示，不直接把通知正文写进页面。
 */
export function ChatPage({ roomId }: ChatPageProps) {
  const chat = useRoomChat(roomId);
  const [status, setStatus] = useState('');
  const [reply, setReply] = useState<{ messageId: string; label: string } | null>(null);
  const [forcePinToken, setForcePinToken] = useState(0);

  const identity = chat.session?.identity ?? null;
  const token = chat.session?.token ?? null;
  const room = chat.detail?.room ?? null;
  const members = useMemo(
    () => new Map((chat.detail?.members ?? []).map((member) => [member.actor_id, member])),
    [chat.detail],
  );
  const mentions = useMemo(
    () => mentionNames(members, identity?.name ?? null),
    [members, identity?.name],
  );

  const refresh = chat.refresh;
  const queue = useSendQueue({
    actorId: identity?.actor_id ?? null,
    token,
    roomId,
    onCommitted: useCallback(() => {
      void refresh();
    }, [refresh]),
  });

  useEffect(() => {
    setReply(null);
    setStatus('');
  }, [roomId]);

  useEffect(() => {
    const known = new Set<string>();
    for (const item of chat.items) {
      if (item.kind !== 'presence') known.add(item.message_id);
    }
    queue.prune(known);
  }, [chat.items, queue.prune]);


  const peer = useMemo(() => {
    if (!room || room.kind !== 'direct' || !identity) return null;
    for (const member of members.values()) {
      if (member.actor_id !== identity.actor_id) return member;
    }
    return null;
  }, [room, identity, members]);

  const title = !room
    ? '会话'
    : room.kind === 'direct'
      ? peer?.name ?? '单聊'
      : room.title || '群聊';
  const subtitle = !room
    ? '正在加载…'
    : room.kind === 'group'
      ? `群聊 · ${chat.detail?.members.length ?? room.member_count} 人`
      : peer?.kind === 'agent'
        ? onlineLabel(peer.online)
        : '';

  const onQuote = useCallback((item: HistoryMessage) => {
    setReply({
      messageId: item.message_id,
      label: `${senderName(item.sender_id, members, identity?.name ?? null, identity?.actor_id ?? null)}：${item.preview.slice(0, 120)}`,
    });
    document.getElementById('body')?.focus();
  }, [members, identity]);

  const onStatus = useCallback((message: string) => {
    setStatus(message);
  }, []);

  const onSend = useCallback(
    async (input: ComposerSendInput) => {
      if (!room || !identity) return { ok: false, error: '房间尚未加载' };
      const body = composeMessageBody(input.text, input.urls);
      const plan = buildSendPlan({
        room,
        members,
        identityId: identity.actor_id,
        body,
        selections: input.selections,
      });
      if (plan.error) {
        setStatus(plan.error);
        return { ok: false, error: plan.error };
      }
      const outcome = await queue.send({
        body,
        invoke: plan.invoke,
        mentions: plan.mentions,
        // 页面始终显式发送 invoke（含 []），阻止服务端再从正文猜测目标。
        invokeExplicit: true,
        replyTo: reply?.messageId ?? null,
      });
      if (outcome.ok) {
        setReply(null);
        setStatus('');
        setForcePinToken((value) => value + 1);
        await refresh();
      } else {
        setStatus(outcome.error || '发送失败');
      }
      return outcome;
    },
    [room, identity, members, queue, reply, refresh],
  );

  const onRetryOutbox = useCallback(
    async (clientMessageId: string) => {
      const outcome = await queue.retry(clientMessageId);
      if (outcome.ok) {
        setStatus('');
        setForcePinToken((value) => value + 1);
        await refresh();
      } else {
        setStatus(outcome.error || '重试失败');
      }
    },
    [queue, refresh],
  );

  const shownStatus = status || chat.refreshError || chat.streamError || '';
  const ready = chat.status === 'ready' && Boolean(room && identity && token);

  return (
    <AppShell
      main={
        <section className="chat-pane" aria-label="聊天区">
          <header className="chat-head">
            <a className="back" id="back" href="/" aria-label="返回会话列表">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M15 6l-6 6 6 6" />
              </svg>
            </a>
            <div className="chat-id">
              <div className="title-row">
                <h2 id="title">{title}</h2>
              </div>
              <p className="muted" id="subtitle" hidden={!subtitle}>
                {subtitle}
              </p>
            </div>
          </header>
          {room?.announcement ? (
            <div id="room-announcement" className="room-announcement" role="note">
              {room.announcement}
            </div>
          ) : null}
          {room?.read_only ? (
            <div id="room-archive-banner" className="room-archive-banner" role="note">
              群聊已解散，当前为只读归档；截至解散点的历史仍可查看。
            </div>
          ) : null}
          <div className="chat-body" id="chat-body" aria-busy={chat.status === 'loading'}>
            <div id="chat-loading" className="chat-loading" role="status" hidden={chat.status !== 'loading'}>
              正在加载会话…
            </div>
            <div id="chat-error" className="chat-error" role="alert" hidden={chat.status !== 'error'}>
              <p id="chat-error-text">{chat.error || '读取会话失败'}</p>
              <div className="chat-error-actions">
                <button id="chat-error-retry" type="button" onClick={() => void chat.load()}>
                  重试
                </button>
                <a id="chat-error-back" href="/">
                  返回会话列表
                </a>
              </div>
            </div>
            {ready && room && identity ? (
              <Timeline
                items={chat.items}
                room={room}
                members={members}
                identityId={identity.actor_id}
                identityName={identity.name}
                mentions={mentions}
                outbox={queue.items}
                olderLoading={chat.olderLoading}
                olderError={chat.olderError}
                olderEnded={chat.olderEnded}
                hasOlder={chat.hasOlder}
                forcePinToken={forcePinToken}
                onLoadOlder={chat.loadOlder}
                onRetryOutbox={(id) => void onRetryOutbox(id)}
                onRemoveOutbox={queue.remove}
                onQuote={onQuote}
                onStatus={onStatus}
                onMarkRead={chat.markRead}
              />
            ) : null}
            <p id="status" role="status">
              {shownStatus}
            </p>
            {ready && room && identity && token && !room.read_only ? (
              <Composer
                room={room}
                members={members}
                identity={identity}
                token={token}
                reply={reply}
                sending={false}
                onCancelReply={() => setReply(null)}
                onSend={onSend}
                onStatus={onStatus}
              />
            ) : null}
          </div>
        </section>
      }
    />
  );
}
