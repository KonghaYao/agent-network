import { Tooltip } from '../../app/lenso-tooltip';
import { Avatar, LENSO_AVATAR_FILL } from '../../app/lenso-controls';

import { Link } from '../../app/router';
import { groupColorFor, groupColorStyle } from '../../lib/group-colors';
import { isOfflineAgent } from '../../lib/presence';
import {
  avatarColor,
  firstChar,
  groupAvatarLabel,
  isUnread,
  relativeTime,
  type RoomSummary,
} from '../../lib/rooms';
import { roomPreference, type RoomPreferenceMap } from '../../lib/room-preferences';
import { RoomRowMenu } from './RoomRowMenu';

/**
 * 会话列表行。
 *
 * 保留 legacy 的 `room-item`、`data-room-*`、`unread` 与 `presence-dot`
 * 契约；用真实链接进入 `/c/:id`，由 `Link` 接管同源左键点击，避免整页
 * 重载造成白闪。修饰键与中键仍走浏览器默认行为。
 *
 * 桌面右键与移动端长按 500ms 打开 `RoomRowMenu`；长按结束后浏览器补发的
 * click 会被短暂抑制，避免误触进入会话。键盘可用 Shift+F10 / ContextMenu
 * 打开同一菜单。
 */
export function RoomRow({
  room,
  preferences = {},
  onStatus,
}: {
  room: RoomSummary;
  preferences?: RoomPreferenceMap;
  onStatus?: (message: string) => void;
}) {
  const preference = roomPreference(preferences, room.room_id);
  const unread = isUnread(room);
  const offline = isOfflineAgent(room.peer_kind, room.peer_online);
  const preferenceLabel = [preference.pinned ? '置顶' : '', preference.muted ? '免打扰' : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <li>
      <RoomRowMenu room={room} onStatus={onStatus}>
        <Tooltip as={Link}
          className="room-item"
          to={`/c/${encodeURIComponent(room.room_id)}`}
          hint="右键或长按打开会话操作"
          data-room-id={room.room_id}
          data-room-name={room.name}
          data-room-kind={room.kind}
          aria-haspopup="menu"
        >
          <span className="avatar-wrap">
            {room.kind === 'group' ? (
              <GroupAvatar name={room.name} roomId={room.room_id} />
            ) : (
              <RoomAvatar name={room.name} offline={offline} />
            )}
            {offline ? (
              <Tooltip as="span"
                className="presence-dot offline"
                role="img"
                aria-label="Agent 离线"
                hint="离线"
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
        </Tooltip>
      </RoomRowMenu>
    </li>
  );
}

function RoomAvatar({ name, offline }: { name: string; offline: boolean }) {
  return (
    <span
      className="avatar"
      aria-hidden="true"
      data-presence={offline ? 'offline' : undefined}
      style={{ background: avatarColor(name) }}
    >
      <Avatar style={LENSO_AVATAR_FILL}>{firstChar(name)}</Avatar>
    </span>
  );
}

function GroupAvatar({ name, roomId }: { name: string; roomId: string }) {
  const color = groupColorFor(roomId);
  const label = groupAvatarLabel(name);
  return (
    <span
      className="avatar avatar-tile"
      aria-hidden="true"
      data-group-color={color.index}
      data-label-length={label.length}
      data-script={label.script}
      style={{ ...groupColorStyle(color), backgroundColor: color.hex }}
    >
      <Avatar style={LENSO_AVATAR_FILL}>{label.text}</Avatar>
    </span>
  );
}
