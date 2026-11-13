import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';

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
import { openContextMenuAt, useLongPress } from '../../hooks/useLongPress';
import { HumanBody } from './MessageBody';
import { MarkdownIsland } from './MarkdownIsland';
import { TaskSummaryBar } from '../tasks/TaskSummaryBar';

interface ChatMessageProps {
  item: HistoryMessage;
  members: Map<string, RoomMember>;
  room: RoomView;
  identityId: string;
  identityName: string;
  identityKind: 'human' | 'agent';
  mentions: string[];
  allItems: HistoryMessage[];
  onQuote: (item: HistoryMessage) => void;
  onStatus: (message: string) => void;
  onToggleTask: (item: HistoryMessage) => void;
  onOpenTask: (rootId: string, focusMessageId: string | null) => void;
  onRecall: (item: HistoryMessage) => void;
  onForward: (item: HistoryMessage) => void;
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

interface MessageAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
}

/** 复制/引用同时供 `···` 下拉与右键菜单使用，避免两套逻辑漂移。 */
function useMessageActions(
  item: HistoryMessage,
  room: RoomView,
  identityId: string,
  identityKind: 'human' | 'agent',
  onQuote: (item: HistoryMessage) => void,
  onStatus: (message: string) => void,
  onToggleTask: (item: HistoryMessage) => void,
  onRecall: (item: HistoryMessage) => void,
  onForward: (item: HistoryMessage) => void,
): MessageAction[] {
  const truncated = item.body_bytes > messageBodyBytes(item.preview);
  const mine = item.sender_id === identityId;
  const copy = async () => {
    try {
      const text = truncated ? await readFullMessage(item.message_id) : item.preview;
      await copyText(text);
      onStatus('已复制');
    } catch (error) {
      onStatus((error as Error).message || '复制失败');
    }
  };
  const actions: MessageAction[] = [{ id: 'message-action-copy', label: '复制', run: copy }];
  if (!room.read_only) {
    actions.push({ id: 'message-action-quote', label: '引用', run: () => onQuote(item) });
  }
  const canSend = !room.read_only && room.capabilities?.send_message !== false;
  if (canSend) {
    const marked = item.task_root_id === item.message_id;
    actions.push({
      id: 'message-action-task',
      label: marked ? '取消 Task' : '标记为 Task',
      run: () => onToggleTask(item),
    });
  }
  actions.push({ id: 'message-action-forward', label: '转发', run: () => onForward(item) });
  if (identityKind === 'human' && mine && !room.read_only) {
    actions.push({ id: 'message-action-recall', label: '撤回', run: () => onRecall(item) });
  }
  return actions;
}

function MessageMenuItems({
  actions,
  Item,
}: {
  actions: MessageAction[];
  Item: React.ElementType;
}) {
  return (
    <>
      {actions.map((action) => (
        <Item
          key={action.id}
          id={action.id}
          className="room-menu-item"
          onSelect={() => {
            void action.run();
          }}
        >
          {action.label}
        </Item>
      ))}
    </>
  );
}

function MessageActions({
  item,
  room,
  identityId,
  identityKind,
  onQuote,
  onStatus,
  onToggleTask,
  onRecall,
  onForward,
}: {
  item: HistoryMessage;
  room: RoomView;
  identityId: string;
  identityKind: 'human' | 'agent';
  onQuote: (item: HistoryMessage) => void;
  onStatus: (message: string) => void;
  onToggleTask: (item: HistoryMessage) => void;
  onRecall: (item: HistoryMessage) => void;
  onForward: (item: HistoryMessage) => void;
}) {
  const actions = useMessageActions(
    item,
    room,
    identityId,
    identityKind,
    onQuote,
    onStatus,
    onToggleTask,
    onRecall,
    onForward,
  );
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button type="button" className="message-actions-trigger" aria-label="消息操作">
          ···
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          id="message-action-menu"
          className="room-menu spa-menu message-action-menu"
          aria-label="消息操作"
          sideOffset={4}
          align="start"
        >
          <MessageMenuItems actions={actions} Item={DropdownMenuPrimitive.Item} />
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

/**
 * 消息右键/长按菜单。桌面走 contextmenu；移动端由 pointer 计时后合成
 * 同一事件，Radix 负责 portal 定位、Esc 与焦点返回。
 */
function MessageContextMenu({
  item,
  room,
  identityId,
  identityKind,
  onQuote,
  onStatus,
  onToggleTask,
  onRecall,
  onForward,
  children,
}: {
  item: HistoryMessage;
  room: RoomView;
  identityId: string;
  identityKind: 'human' | 'agent';
  onQuote: (item: HistoryMessage) => void;
  onStatus: (message: string) => void;
  onToggleTask: (item: HistoryMessage) => void;
  onRecall: (item: HistoryMessage) => void;
  onForward: (item: HistoryMessage) => void;
  children: ReactNode;
}) {
  const actions = useMessageActions(
    item,
    room,
    identityId,
    identityKind,
    onQuote,
    onStatus,
    onToggleTask,
    onRecall,
    onForward,
  );
  return (
    <ContextMenuPrimitive.Root>
      <ContextMenuPrimitive.Trigger asChild>{children}</ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content
          id="message-context-menu"
          className="room-menu spa-menu message-action-menu"
          aria-label="消息操作"
        >
          <MessageMenuItems actions={actions} Item={ContextMenuPrimitive.Item} />
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}

export const ChatMessage = memo(function ChatMessage({
  item,
  members,
  room,
  identityId,
  identityName,
  identityKind,
  mentions,
  allItems,
  onQuote,
  onStatus,
  onToggleTask,
  onOpenTask,
  onRecall,
  onForward,
}: ChatMessageProps) {
  const [fullBody, setFullBody] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [longExpanded, setLongExpanded] = useState(false);
  const longPress = useLongPress(openContextMenuAt);
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
      <MessageContextMenu
        item={item}
        room={room}
        identityId={identityId}
        identityKind={identityKind}
        onQuote={onQuote}
        onStatus={onStatus}
        onToggleTask={onToggleTask}
        onRecall={onRecall}
        onForward={onForward}
      >
        <li
          className={`msg${mine ? ' mine has-receipt' : ''}`}
          data-message-id={item.message_id}
          data-sender-kind={agent ? 'agent' : 'human'}
          data-message-preview={item.preview}
          {...longPress}
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
            <TaskSummaryBar
              item={item}
              roomId={room.room_id}
              headSeq={room.head_seq}
              onOpen={onOpenTask}
            />
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
              <MessageActions
                item={item}
                room={room}
                identityId={identityId}
                identityKind={identityKind}
                onQuote={onQuote}
                onStatus={onStatus}
                onToggleTask={onToggleTask}
                onRecall={onRecall}
                onForward={onForward}
              />
            ) : null}
          </div>
        </li>
      </MessageContextMenu>
      {mine ? <Receipt item={item} members={members} identityId={identityId} /> : null}
    </>
  );
});
