import { useRef } from 'react';

import { Link } from '../../app/router';
import { openContextMenuAt, useLongPress } from '../../hooks/useLongPress';
import { groupColorFor, groupColorStyle } from '../../lib/group-colors';
import {
  avatarColor,
  firstChar,
  groupAvatarCells,
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
  const suppressNextClickRef = useRef(false);
  const longPress = useLongPress((element, x, y) => {
    // 长按结束后浏览器仍会补发 click；抑制紧随其后的这一次点击。
    suppressNextClickRef.current = true;
    openContextMenuAt(element, x, y);
  });
  const preference = roomPreference(preferences, room.room_id);
  const unread = isUnread(room);
  const offline = room.peer_kind === 'agent' && room.peer_online === false;
  const preferenceLabel = [preference.pinned ? '置顶' : '', preference.muted ? '免打扰' : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <li>
      <RoomRowMenu room={room} onStatus={onStatus}>
        <Link
          className="room-item"
          to={`/c/${encodeURIComponent(room.room_id)}`}
          title={`${room.name}（右键或长按打开会话操作）`}
          data-room-id={room.room_id}
          data-room-name={room.name}
          data-room-kind={room.kind}
          aria-haspopup="menu"
          {...longPress}
          onPointerDown={(event) => {
            // 开始新手势时重置抑制，避免长按后浏览器没有补发 click 时
            // 吞掉用户的下一次正常点击。
            suppressNextClickRef.current = false;
            longPress.onPointerDown(event);
          }}
          onClick={(event) => {
            if (!suppressNextClickRef.current) return;
            suppressNextClickRef.current = false;
            event.preventDefault();
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            // 键盘激活不是长按后的补发 click；先解除抑制，避免第一次
            // Enter 被吞掉。
            if (event.key === 'Enter' || event.key === ' ') {
              suppressNextClickRef.current = false;
            }
            if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) {
              return;
            }
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            openContextMenuAt(
              event.currentTarget,
              rect.left + 24,
              rect.top + rect.height / 2,
            );
          }}
        >
          <span className="avatar-wrap">
            {room.kind === 'group' ? (
              <GroupAvatar name={room.name} roomId={room.room_id} />
            ) : (
              <Avatar name={room.name} />
            )}
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
      </RoomRowMenu>
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

function GroupAvatar({ name, roomId }: { name: string; roomId: string }) {
  const color = groupColorFor(roomId);
  return (
    <span
      className="avatar avatar-grid"
      aria-hidden="true"
      data-group-color={color.index}
      style={groupColorStyle(color.hex)}
    >
      {groupAvatarCells(name, color.hex).map((cell, index) => (
        <span key={`${cell.char}-${index}`} className="avatar-cell">
          {cell.char}
        </span>
      ))}
    </span>
  );
}
