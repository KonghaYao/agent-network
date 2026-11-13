import { memo, useEffect, useMemo, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  chatTime,
  fullTime,
  isAgentMessage,
  messageBodyBytes,
  receiptText,
  senderName,
  type HistoryMessage,
  type RoomMember,
  type RoomView,
} from '../../lib/chat';
import { copyText, extractFileCards } from '../../lib/files';
import { readFullMessage } from '../../lib/message-body';
import { avatarColor, firstChar } from '../../lib/rooms';
import { HumanBody } from './MessageBody';
import { MarkdownIsland } from './MarkdownIsland';

interface ChatMessageProps {
  item: HistoryMessage;
  members: Map<string, RoomMember>;
  room: RoomView;
  identityId: string;
  identityName: string;
  mentions: string[];
  allItems: HistoryMessage[];
  onQuote: (item: HistoryMessage) => void;
  onStatus: (message: string) => void;
}

function Receipt({
  item,
  members,
  identityId,
}: {
  item: HistoryMessage;
  members: Map<string, RoomMember>;
  identityId: string;
}) {
  const [now, setNow] = useState(() => Date.now());
  const last = Number(item.delivery_updated_at ?? item.delivery_claimed_at ?? 0);
  useEffect(() => {
    setNow(Date.now());
    if (!Number(item.delivery_states.claimed ?? 0) || !last) return undefined;
    const delay = last + LIMITS.claimedStaleMs - Date.now();
    if (delay <= 0) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), delay + 50);
    return () => clearTimeout(timer);
  }, [item.delivery_states.claimed, item.delivery_updated_at, item.delivery_claimed_at, last]);

  const stale = Boolean(
    Number(item.delivery_states.claimed ?? 0) &&
      last > 0 &&
      now - last >= LIMITS.claimedStaleMs,
  );
  return (
    <li
      className={`msg-system msg-receipt${stale ? ' stale' : ''}`}
      data-receipt-for={item.message_id}
    >
      <span>{receiptText(item, members, identityId, now)}</span>
    </li>
  );
}

function ReplyReference({
  item,
  allItems,
  members,
  identityId,
  identityName,
}: {
  item: HistoryMessage;
  allItems: HistoryMessage[];
  members: Map<string, RoomMember>;
  identityId: string;
  identityName: string;
}) {
  const target = useMemo(
    () => allItems.find((entry) => entry.message_id === item.reply_to) ?? null,
    [allItems, item.reply_to],
  );
  const [fallback, setFallback] = useState('');
  const label = target
    ? `${senderName(target.sender_id, members, identityName, identityId)}：${target.preview.slice(0, 120)}`
    : fallback || '引用消息 · 查看上下文';
  const showTarget = () => {
    if (!item.reply_to) return;
    for (const node of document.querySelectorAll<HTMLElement>('[data-message-id]')) {
      if (node.dataset.messageId !== item.reply_to) continue;
      node.scrollIntoView({ block: 'center' });
      return;
    }
    if (fallback) return;
    void readFullMessage(item.reply_to)
      .then((text) => setFallback(`引用消息：${text.slice(0, 120)}`))
      .catch(() => setFallback('引用消息不可见'));
  };
  return (
    <button
      type="button"
      className="reply-reference"
      data-reply-to={item.reply_to ?? undefined}
      onClick={showTarget}
    >
      {label}
    </button>
  );
}

function MessageActions({
  item,
  room,
  onQuote,
  onStatus,
}: {
  item: HistoryMessage;
  room: RoomView;
  onQuote: (item: HistoryMessage) => void;
  onStatus: (message: string) => void;
}) {
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const truncated = item.body_bytes > messageBodyBytes(item.preview);

  useEffect(() => {
    if (!menu) return undefined;
    const close = () => setMenu(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [menu]);

  const copy = async () => {
    try {
      const text = truncated ? await readFullMessage(item.message_id) : item.preview;
      await copyText(text);
      onStatus('已复制');
    } catch (error) {
      onStatus((error as Error).message || '复制失败');
    }
  };

  return (
    <>
      <button
        type="button"
        className="message-actions-trigger"
        aria-label="消息操作"
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(event) => {
          event.stopPropagation();
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu((current) =>
            current
              ? null
              : {
                  top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - 112)),
                  left: Math.max(8, Math.min(rect.left, window.innerWidth - 156)),
                },
          );
        }}
      >
        ···
      </button>
      {menu ? (
        <div
          id="message-action-menu"
          className="message-action-menu"
          role="menu"
          aria-label="消息操作"
          style={{ top: menu.top, left: menu.left }}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="room-menu-item"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              void copy();
            }}
          >
            复制
          </button>
          {!room.read_only ? (
            <button
              type="button"
              className="room-menu-item"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onQuote(item);
              }}
            >
              引用
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

export const ChatMessage = memo(function ChatMessage({
  item,
  members,
  room,
  identityId,
  identityName,
  mentions,
  allItems,
  onQuote,
  onStatus,
}: ChatMessageProps) {
  const [fullBody, setFullBody] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [longExpanded, setLongExpanded] = useState(false);
  const mine = item.sender_id === identityId;
  const agent = isAgentMessage(item, members);
  const name = senderName(item.sender_id, members, identityName, identityId);
  const truncated = item.body_bytes > messageBodyBytes(item.preview);
  const longBody = item.body_bytes >= LIMITS.webLongMessageCollapseBytes;
  const shown = fullBody ?? item.preview;
  const collapsed = longBody && fullBody !== null && !longExpanded;
  const cards = useMemo(() => extractFileCards(shown), [shown]);

  const loadFull = async () => {
    if (fullBody !== null || loadingFull) return;
    setLoadingFull(true);
    try {
      const text = await readFullMessage(item.message_id);
      setFullBody(text);
      setLongExpanded(false);
    } catch (error) {
      onStatus((error as Error).message || '读取正文失败');
    } finally {
      setLoadingFull(false);
    }
  };

  if (item.body_bytes === 0) {
    return (
      <li className="msg-system msg-recalled" data-message-id={item.message_id}>
        <span>此消息已撤回</span>
      </li>
    );
  }

  return (
    <>
      <li
        className={`msg${mine ? ' mine has-receipt' : ''}`}
        data-message-id={item.message_id}
        data-sender-kind={agent ? 'agent' : 'human'}
        data-message-preview={item.preview}
      >
        <span
          className="msg-avatar"
          aria-hidden="true"
          style={{ background: avatarColor(mine ? identityName : name) }}
        >
          {firstChar(mine ? identityName : name)}
        </span>
        <div className="msg-content">
          {!mine && room.kind === 'group' ? <div className="msg-sender">{name}</div> : null}
          <div
            className={`bubble${collapsed ? ' is-collapsed' : ''}`}
            title={fullTime(item.created_at)}
          >
            {agent ? (
              <MarkdownIsland
                text={shown}
                mentions={mentions}
                preview={truncated && fullBody === null}
              />
            ) : (
              <HumanBody text={shown} mentions={mentions} />
            )}
          </div>
          {cards.length > 0 ? (
            <div className="msg-files">
              {cards.map((card) => (
                <a
                  className="msg-file"
                  key={card.fileId}
                  href={card.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label={`打开附件 ${card.fileId}`}
                >
                  <span className="msg-file-kind" aria-hidden="true">
                    FILE
                  </span>
                  <span className="msg-file-main">
                    <span className="msg-file-name">附件 {card.fileId.slice(0, 10)}</span>
                  </span>
                </a>
              ))}
            </div>
          ) : null}
          {item.reply_to ? (
            <ReplyReference
              item={item}
              allItems={allItems}
              members={members}
              identityId={identityId}
              identityName={identityName}
            />
          ) : null}
          {fullBody === null && truncated ? (
            <button
              type="button"
              className="expand"
              aria-expanded="false"
              disabled={loadingFull}
              onClick={() => void loadFull()}
            >
              {loadingFull ? '正在展开…' : '查看全文'}
            </button>
          ) : null}
          {fullBody !== null && longBody ? (
            <button
              type="button"
              className="expand"
              aria-expanded={longExpanded}
              onClick={() => setLongExpanded((value) => !value)}
            >
              {longExpanded ? '收起' : '展开全文'}
            </button>
          ) : null}
          {item.body_bytes > 0 ? (
            <MessageActions item={item} room={room} onQuote={onQuote} onStatus={onStatus} />
          ) : null}
        </div>
      </li>
      {mine ? <Receipt item={item} members={members} identityId={identityId} /> : null}
    </>
  );
});
