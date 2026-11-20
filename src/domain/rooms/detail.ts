/** rooms.ts 拆分模块：detail。加载房间摘要、成员与当前查看者可见的置顶。 */

import { nowMs } from '../../storage/db';
import { LIMITS } from '../../contracts/limits';
import { listRoomPinnedMessages } from '../../storage/queries';
import { manageableAgentIds } from '../agent-access';
import { loadOwnerTransferView } from '../owner-transfers';
import { actorId, type Principal } from '../principal';
import { loadRoomAccess, roomCapabilitiesFor } from '../room-access';
import { historyBoundary } from '../room-history';
import { loadInvitedMembers, type InvitedMemberView } from '../room-invitations';
import { loadRoomView, loadMembers, type PinnedMessageView, type RoomDetail } from './views';

export async function roomDetail(db: D1Database, roomId: string, viewer: string): Promise<RoomDetail> {
  const { room, member } = await loadRoomAccess(db, roomId, viewer);
  const boundary = historyBoundary(room, member);
  const [view, members, invited, ownerTransfer, pinned] = await Promise.all([
    loadRoomView(db, room, member),
    loadMembers(db, room, member),
    roomCapabilitiesFor(room, member).approve_joins && room.dissolved_at === null
      ? loadInvitedMembers(db, room.room_id, nowMs())
      : Promise.resolve([] as InvitedMemberView[]),
    loadOwnerTransferView(db, room.room_id, viewer, nowMs()),
    room.kind === 'direct'
      ? Promise.resolve([])
      : listRoomPinnedMessages(db, room.room_id, {
          fromSeq: boundary.fromSeq,
          toSeq: boundary.toSeq,
          limit: LIMITS.roomPinnedMessagesMax,
        }),
  ]);
  const pinnedMessages: PinnedMessageView[] = pinned.map((row) => ({
    message_id: row.message_id,
    preview: row.preview,
    sender: {
      actor_id: row.sender_id,
      name: row.sender_name,
      kind: row.sender_kind,
    },
    created_seq: String(row.created_seq),
    pinned_at: String(row.pinned_at),
  }));
  return {
    room: view,
    members,
    pinned_messages: pinnedMessages,
    invited,
    owner_transfer: ownerTransfer,
  };
}

export async function roomGet(
  db: D1Database,
  principal: Principal,
  roomId: string,
): Promise<RoomDetail> {
  const viewer = actorId(principal);
  const detail = await roomDetail(db, roomId, viewer);
  if (detail.room.kind === 'direct') {
    const peer = detail.members.find((member) => member.actor_id !== viewer);
    const manageable =
      peer && peer.kind === 'agent'
        ? await manageableAgentIds(db, viewer, [peer.actor_id], nowMs())
        : null;
    detail.room.peer_can_manage = Boolean(manageable && peer && manageable.has(peer.actor_id));
  }
  return detail;
}
