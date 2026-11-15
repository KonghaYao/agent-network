import { Link } from '../../app/router';
import {
  avatarColor,
  firstChar,
  groupAvatarCells,
  isUnread,
  relativeTime,
  type RoomSummary,
} from '../../lib/rooms';
import { roomPreference, type RoomPreferenceMap } from '../../lib/room-preferences';

/**
 * 会话列表行。
 *
 * 保留 legacy 的 `room-item`、`data-room-*`、`unread` 与 `presence-dot`
 * 契约；用真实链接进入 `/c/:id`，由 `Link` 接管同源左键点击，避免整页
 * 重载造成白闪。修饰键与中键仍走浏览器默认行为。
 */
export function RoomRow({
  room,
  preferences = {},
}: {
  room: RoomSummary;
  preferences?: RoomPreferenceMap;
}) {
  const preference = roomPreference(preferences, room.room_id);
  const unread = isUnread(room);
  const offline = room.peer_kind === 'agent' && room.peer_online === false;
  const preferenceLabel = [preference.pinned ? '置顶' : '', preference.muted ? '免打扰' : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <li>
      <Link
        className="room-item"
        to={`/c/${encodeURIComponent(room.room_id)}`}
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
          {unread ? (
            <span
              className={preference.muted ? 'unread muted' : 'unread'}
              aria-label={preference.muted ? '未读，消息免打扰' : '未读'}
            />
          ) : null}
        </span>
        <div className="room-main">
          <div className="room-top">
            <span className="room-name">{room.name}</span>
            {preferenceLabel ? (
              <span className="room-pref-label" aria-label={preferenceLabel}>
                {preferenceLabel}
              </span>
            ) : null}
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
      </Link>
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
