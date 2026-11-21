import type { RoomDetail, RoomPage } from '../domain/rooms';
import type { Env } from '../env';
import { presenceOfMany } from '../realtime/presence';

export async function withRoomMemberPresence(env: Env, detail: RoomDetail): Promise<RoomDetail> {
  const agentIds = detail.members
    .filter((member) => member.kind === 'agent')
    .map((member) => member.actor_id);
  const presences = await presenceOfMany(env, agentIds);
  const members = detail.members.map((member) => {
    if (member.kind !== 'agent') return member;
    return { ...member, online: presences.get(member.actor_id)?.online ?? null };
  });
  return {
    room: detail.room,
    members,
    pinned_messages: detail.pinned_messages,
    invited: detail.invited,
    owner_transfer: detail.owner_transfer,
  };
}

/**
 * 为 rooms_list 当前页的 direct Agent 对端批量补充在线快照。
 *
 * 域层只返回 peer 的稳定资料，online 保持 null；这里用一次批量
 * presence 查询覆盖整页，避免把浏览器的逐房间补全转移成逐 Agent
 * 的数据库查询。人类对端保持 null。
 */
export async function withRoomListPresence(env: Env, page: RoomPage): Promise<RoomPage> {
  const agentIds = page.items.flatMap((item) =>
    item.peer && item.peer.kind === 'agent' ? [item.peer.actor_id] : [],
  );
  if (agentIds.length === 0) return page;
  const presences = await presenceOfMany(env, agentIds);
  return {
    ...page,
    items: page.items.map((item) => {
      if (!item.peer || item.peer.kind !== 'agent') return item;
      const presence = presences.get(item.peer.actor_id);
      return {
        ...item,
        peer: { ...item.peer, online: presence ? presence.online : null },
      };
    }),
  };
}
