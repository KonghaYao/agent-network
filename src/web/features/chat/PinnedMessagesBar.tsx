import { useCallback, useState } from 'react';

import { LIMITS } from '../../../contracts/limits';
import {
  chatTime,
  fullTime,
  pinnedPreviewText,
  type PinnedMessage,
  type RoomMember,
} from '../../lib/chat';

interface PinnedMessagesBarProps {
  pins: PinnedMessage[];
  members: Map<string, RoomMember>;
  identityId: string;
  identityName: string;
  canManage: boolean;
  busy?: boolean;
  /** 契约不兼容等原因禁用取消置顶，并说明原因。 */
  disabledReason?: string | null;
  onLocate: (pin: PinnedMessage) => void;
  onUnpin: (pin: PinnedMessage) => void;
}

function senderLabel(
  pin: PinnedMessage,
  members: Map<string, RoomMember>,
  identityId: string,
  identityName: string,
): string {
  if (pin.sender.actor_id === identityId) return identityName || '我';
  return pin.sender.name || members.get(pin.sender.actor_id)?.name || '未知成员';
}

/**
 * 群头部置顶区：最多三行，点击定位，owner 可在此取消置顶。
 *
 * 置顶是房间级状态，不参与消息排序；空列表不渲染占位。收起只影响本组件，
 * 不改变时间线滚动或已读。
 */
export function PinnedMessagesBar({
  pins,
  members,
  identityId,
  identityName,
  canManage,
  busy = false,
  disabledReason = null,
  onLocate,
  onUnpin,
}: PinnedMessagesBarProps) {
  const [collapsed, setCollapsed] = useState(false);
  const visible = pins.slice(0, LIMITS.roomPinnedMessagesMax);
  const toggle = useCallback(() => setCollapsed((value) => !value), []);
  if (visible.length === 0) return null;

  return (
    <section
      id="pinned-messages"
      className="pinned-messages"
      aria-label="置顶消息"
      data-pinned-count={visible.length}
    >
      <div className="pinned-head">
        <span className="pinned-title">置顶消息</span>
        <span className="pinned-count">{visible.length}</span>
        <button
          type="button"
          id="pinned-toggle"
          className="pinned-toggle"
          aria-expanded={!collapsed}
          aria-controls="pinned-list"
          onClick={toggle}
        >
          {collapsed ? '展开' : '收起'}
        </button>
      </div>
      <ul id="pinned-list" className="pinned-list" hidden={collapsed}>
        {visible.map((pin) => {
          const sender = senderLabel(pin, members, identityId, identityName);
          const preview = pinnedPreviewText(pin.preview) || '此消息已撤回';
          const label = `定位置顶消息：${sender}：${preview}`;
          return (
            <li className="pinned-item" key={pin.message_id}>
              <button
                type="button"
                className="pinned-locate"
                data-pinned-message-id={pin.message_id}
                aria-label={label}
                onClick={() => onLocate(pin)}
              >
                <span className="pinned-sender">{sender}</span>
                <span className="pinned-preview">{preview}</span>
                <span className="pinned-time" title={fullTime(pin.pinned_at)}>
                  {chatTime(pin.pinned_at)}
                </span>
              </button>
              {canManage ? (
                <button
                  type="button"
                  className="pinned-unpin"
                  data-pinned-unpin-id={pin.message_id}
                  aria-label={`取消置顶：${sender}：${preview}`}
                  title={disabledReason ?? undefined}
                  disabled={busy || Boolean(disabledReason)}
                  onClick={() => onUnpin(pin)}
                >
                  取消置顶
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
