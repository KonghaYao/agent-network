/** rooms.ts 拆分模块：detail。纯移动，行为保持不变。 */

import { BusinessError } from '../../contracts/errors';
import { nowMs } from '../../storage/db';
import { getMember, getRoom } from '../../storage/queries';
import { manageableAgentIds } from '../agent-access';
import { loadOwnerTransferView } from '../owner-transfers';
import { actorId, type Principal } from '../principal';
import { roomCapabilitiesFor } from '../room-access';
import { loadInvitedMembers, type InvitedMemberView } from '../room-invitations';
import { loadRoomView, loadMembers, type RoomDetail } from './views';

export async function roomDetail(db: D1Database, roomId: string, viewer: string): Promise<RoomDetail> {
  const room = await getRoom(db, roomId);
  if (!room) throw new BusinessError('NOT_FOUND', '房间不存在');
  const member = await getMember(db, roomId, viewer);
  if (!member || member.status !== 'active') {
    throw new BusinessError('NOT_MEMBER', '当前身份不是该房间的有效成员');
  }
  const [view, members, invited, ownerTransfer] = await Promise.all([
    loadRoomView(db, room, member),
    loadMembers(db, room, member),
    roomCapabilitiesFor(room, member).approve_joins && room.dissolved_at === null
      ? loadInvitedMembers(db, room.room_id, nowMs())
      : Promise.resolve([] as InvitedMemberView[]),
    loadOwnerTransferView(db, room.room_id, viewer, nowMs()),
  ]);
  return { room: view, members, invited, owner_transfer: ownerTransfer };
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

