import { useEffect, useMemo, useState } from 'react';

import { useRooms } from '../../hooks/useRooms';
import type { HistoryMessage } from '../../lib/chat';
import { callTool, type McpError } from '../../lib/mcp-client';
import { extractFileCards } from '../../lib/files';
import { readFullMessage } from '../../lib/message-body';
import { newRequestId } from '../../lib/request-id';
import { Modal } from '../overlays/Modal';

function failureText(error: unknown): string {
  return (error as McpError).message || '转发失败，可重试';
}

/**
 * 转发消息：必须显式选择目标会话。
 *
 * 正文重新从服务端读取，避免使用过期 preview；含附件卡片的消息不转发，
 * 避免只复制文本丢失文件。转发显式发送 `invoke: []`，不会自动唤醒 Agent。
 */
export function ForwardDialog({
  open,
  onOpenChange,
  item,
  senderLabel,
  sourceRoomId,
  token,
  onSent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  item: HistoryMessage | null;
  senderLabel: string;
  sourceRoomId: string;
  token: string;
  onSent: (roomName: string) => void;
}) {
  const rooms = useRooms();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setSelected(null);
    setText(null);
    setStatus('正在读取消息…');
    setBusy(false);
  }, [open, item?.message_id]);

  useEffect(() => {
    if (!open || !item) return;
    let active = true;
    void readFullMessage(item.message_id, token)
      .then((full) => {
        if (!active) return;
        if (!full) throw new Error('消息已撤回');
        if (extractFileCards(full).length > 0) {
          throw new Error('含附件的消息暂不支持转发；请下载附件后在目标会话发送。');
        }
        setText(`【转发消息】${senderLabel}：\n${full}`);
        setStatus('选择接收会话，再确认转发');
      })
      .catch((failure) => {
        if (active) setStatus(failureText(failure));
      });
    return () => {
      active = false;
    };
  }, [item, open, senderLabel, token]);

  const targets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rooms.rooms.filter((room) => {
      if (room.room_id === sourceRoomId || room.read_only || room.peer_archived) return false;
      if (!needle) return true;
      return (
        room.name.toLowerCase().includes(needle) ||
        (room.last_message?.preview ?? '').toLowerCase().includes(needle)
      );
    });
  }, [query, rooms.rooms, sourceRoomId]);

  const send = async () => {
    if (!selected || !text || busy) return;
    const target = targets.find((room) => room.room_id === selected);
    if (!target) return;
    setBusy(true);
    setStatus('正在转发…');
    try {
      await callTool(
        'network_message_send',
        {
          request_id: newRequestId('web_forward'),
          client_message_id: newRequestId('web_forward_client'),
          room_id: selected,
          body: text,
          invoke: [],
        },
        { token },
      );
      onSent(target.name);
      onOpenChange(false);
    } catch (failure) {
      setStatus(failureText(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="转发消息"
      titleId="forward-title"
      contentId="forward-modal"
      className="forward-card"
      footer={
        <div className="row modal-actions">
          <button id="forward-cancel" type="button" disabled={busy} onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button
            id="forward-send"
            className="primary"
            type="button"
            disabled={!selected || text === null || busy}
            onClick={() => void send()}
          >
            {busy ? '正在转发…' : '确认转发'}
          </button>
        </div>
      }
    >
      <p id="forward-preview" className="forward-preview">
        {text ?? '正在读取消息…'}
      </p>
      <label className="field">
        <span>选择转发会话</span>
        <input
          id="forward-search"
          type="search"
          placeholder="搜索会话"
          autoComplete="off"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div id="forward-rooms" className="forward-rooms" role="group" aria-label="转发目标">
        {targets.map((room) => (
          <button
            key={room.room_id}
            type="button"
            aria-pressed={selected === room.room_id}
            disabled={busy}
            onClick={() => {
              setSelected(room.room_id);
              setStatus(`转发给 ${room.name}（不会自动唤醒 Agent）`);
            }}
          >
            {room.kind === 'group' ? '群聊' : '单聊'} · {room.name}
          </button>
        ))}
        {targets.length === 0 ? <p className="list-hint">没有匹配的会话</p> : null}
        {rooms.hasMore ? (
          <button
            id="forward-more"
            className="list-retry"
            type="button"
            disabled={rooms.loadingMore}
            onClick={() => void rooms.loadMore()}
          >
            {rooms.loadingMore ? '正在加载…' : '加载更多会话'}
          </button>
        ) : null}
      </div>
      <p id="forward-status" className="contact-search-status" role="status">
        {status}
      </p>
    </Modal>
  );
}
