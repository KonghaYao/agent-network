import {
  avatarColor,
  firstChar,
  groupAvatarCells,
  hasUnreadAttention,
  relativeTime,
  type RoomSummary,
} from '../../lib/rooms';
import type { RoomPreferenceMap } from '../../lib/room-preferences';

/**
 * 会话列表行。
 *
 * 保留 legacy 的 `room-item`、`data-room-*`、`unread` 与 `presence-dot`
 * 契约；始终用普通链接进入 `/c/:id`，4B-6 起该路由固定由 React Chat 渲染。
 */
export function RoomRow({
  room,
  preferences = {},
}: {
  room: RoomSummary;
  preferences?: RoomPreferenceMap;
}) {
  const unread = hasUnreadAttention(room, preferences);
  const offline = room.peer_kind === 'agent' && room.peer_online === false;
  return (
    <li>
      <a
        className="room-item"
        href={`/c/${encodeURIComponent(room.room_id)}`}
        title={room.name}
        data-room-id={room.room_id}
        data-room-name={room.name}
        data-room-kind={room.kind}
      >
        <span className="avatar-wrap">
          {room.kind === 'group' ? <GroupAvatar name={room.name} /> : <Avatar name={room.name} />}
          {offline ? (
            <span
              className="presence-dot offline"
              role="img"
              aria-label="Agent 离线"
              title="离线"
            />
          ) : null}
          {unread ? <span className="unread" aria-label="未读" /> : null}
        </span>
        <div className="room-main">
          <div className="room-top">
            <span className="room-name">{room.name}</span>
            <span className="room-time">
              {relativeTime(
                room.last_message ? room.last_message.created_at : room.updated_at,
              )}
            </span>
          </div>
          <div className="room-preview">
            {room.read_only
              ? '已解散 · 只读归档'
              : room.last_message
                ? room.last_message.preview
                : '还没有消息'}
          </div>
        </div>
      </a>
    </li>
  );
}

function Avatar({ name }: { name: string }) {
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ background: avatarColor(name) }}
    >
      {firstChar(name)}
    </span>
  );
}

function GroupAvatar({ name }: { name: string }) {
  return (
    <span className="avatar avatar-grid" aria-hidden="true">
      {groupAvatarCells(name).map((cell, index) => (
        <span
          key={`${cell.char}-${index}`}
          className="avatar-cell"
          style={{ background: cell.color }}
        >
          {cell.char}
        </span>
      ))}
    </span>
  );
}
