/**
 * rooms_list direct peer 摘要验收。
 *
 * 覆盖：direct 返回 actor_id/name/kind/online，group 显式为 null；
 * limit+1 分页与游标不重复；按 updated_at 倒序；解散群默认过滤；
 * peer.online 与 room_get 的成员在线语义一致，人类对端为 null。
 */

import { callTool, check, checkEqual, newRequestId } from './harness';
import { createActor, makeFriends, type ActorPair } from './group-history-helpers';

interface PeerView {
  actor_id: string;
  name: string;
  kind: 'human' | 'agent';
  online: boolean | null;
}

interface RoomListItem {
  room_id: string;
  kind: 'direct' | 'group';
  updated_at: string;
  peer?: PeerView | null;
  peer_archived?: boolean;
}

interface RoomListPage {
  items: RoomListItem[];
  next_cursor: string | null;
  has_more: boolean;
}

interface RoomDetailView {
  members: {
    actor_id: string;
    kind: 'human' | 'agent';
    name: string;
    online: boolean | null;
  }[];
}

function roomOf(page: RoomListPage, roomId: string): RoomListItem | undefined {
  return page.items.find((item) => item.room_id === roomId);
}

export async function runRoomsListPeerAcceptance(): Promise<void> {
  const owner = await createActor('rooms_list peer 验收 owner', 'human');
  const agentA = await createActor('rooms_list peer 验收 Agent A', 'agent');
  const agentB = await createActor('rooms_list peer 验收 Agent B', 'agent');
  const humanPeer = await createActor('rooms_list peer 验收人类好友', 'human');
  try {
    await makeFriends(owner, agentA);
    await makeFriends(owner, agentB);
    await makeFriends(owner, humanPeer);

    const directAgent = await callTool<{ room: { room_id: string } }>(
      owner.connection.client,
      'network_room_create',
      {
        request_id: newRequestId('rooms_peer_direct_agent'),
        kind: 'direct',
        members: [agentA.actor.actor_id],
      },
    );
    const directHuman = await callTool<{ room: { room_id: string } }>(
      owner.connection.client,
      'network_room_create',
      {
        request_id: newRequestId('rooms_peer_direct_human'),
        kind: 'direct',
        members: [humanPeer.actor.actor_id],
      },
    );
    const group = await callTool<{ room: { room_id: string } }>(
      owner.connection.client,
      'network_room_create',
      {
        request_id: newRequestId('rooms_peer_group'),
        kind: 'group',
        members: [agentA.actor.actor_id, agentB.actor.actor_id],
        title: 'rooms_list peer 验收群',
      },
    );
    // 额外群聊让分页有第二页，并保持倒序断言稳定。
    for (let index = 0; index < 2; index += 1) {
      await callTool(owner.connection.client, 'network_room_create', {
        request_id: newRequestId('rooms_peer_group_extra'),
        kind: 'group',
        members: [agentA.actor.actor_id],
        title: `rooms_list peer 分页群 ${index + 1}`,
      });
    }

    const page = await callTool<RoomListPage>(owner.connection.client, 'network_rooms_list', {
      limit: 100,
    });
    const directAgentItem = roomOf(page, directAgent.room.room_id);
    const directHumanItem = roomOf(page, directHuman.room.room_id);
    const groupItem = roomOf(page, group.room.room_id);
    check('rooms_list 返回 direct Agent 会话', Boolean(directAgentItem), directAgentItem);
    check('rooms_list 返回 direct 人类会话', Boolean(directHumanItem), directHumanItem);
    check('rooms_list 返回群聊', Boolean(groupItem), groupItem);

    const agentPeer = directAgentItem?.peer;
    check(
      'direct Agent peer 含稳定 actor_id/name/kind',
      Boolean(agentPeer) &&
        agentPeer!.actor_id === agentA.actor.actor_id &&
        agentPeer!.name === agentA.actor.name &&
        agentPeer!.kind === 'agent',
      agentPeer,
    );
    checkEqual('direct Agent peer_archived 默认 false', directAgentItem?.peer_archived, false);
    checkEqual('群聊 peer 显式为 null', groupItem?.peer, null);
    checkEqual('direct 人类 peer kind 为 human', directHumanItem?.peer?.kind, 'human');
    checkEqual('人类 peer online 恒为 null', directHumanItem?.peer?.online, null);
    check(
      'Agent peer online 是布尔快照',
      typeof agentPeer?.online === 'boolean',
      agentPeer,
    );

    const detail = await callTool<RoomDetailView>(owner.connection.client, 'network_room_get', {
      room_id: directAgent.room.room_id,
    });
    const detailMember = detail.members.find((member) => member.actor_id === agentA.actor.actor_id);
    checkEqual(
      'rooms_list peer.online 与 room_get 成员在线语义一致',
      agentPeer?.online,
      detailMember?.online,
    );

    // 分页：limit+1 只用于判断 has_more，游标分页不重复且保持倒序。
    const first = await callTool<RoomListPage>(owner.connection.client, 'network_rooms_list', {
      limit: 2,
    });
    checkEqual('rooms_list 分页首屏返回 limit 条', first.items.length, 2);
    check('rooms_list 分页返回 has_more', first.has_more, first);
    check('rooms_list 分页返回 next_cursor', Boolean(first.next_cursor), first.next_cursor);
    const second = await callTool<RoomListPage>(owner.connection.client, 'network_rooms_list', {
      limit: 2,
      cursor: first.next_cursor as string,
    });
    const firstIds = new Set([...first.items, ...second.items].map((item) => item.room_id));
    checkEqual(
      'rooms_list 两页不重复',
      firstIds.size,
      first.items.length + second.items.length,
    );
    const all = [...first.items, ...second.items];
    check(
      'rooms_list 按 updated_at 倒序',
      all.every(
        (item, index) =>
          index === 0 || Number(all[index - 1]!.updated_at) >= Number(item.updated_at),
      ),
      all.map((item) => item.updated_at),
    );

    // 解散群默认不返回；仍可用 room_get 读取只读归档。
    await callTool(owner.connection.client, 'network_room_dissolve', {
      request_id: newRequestId('rooms_peer_dissolve'),
      room_id: group.room.room_id,
      reason: 'rooms_list peer 验收解散',
    });
    const afterDissolve = await callTool<RoomListPage>(owner.connection.client, 'network_rooms_list', {
      limit: 100,
    });
    check(
      'rooms_list 默认过滤已解散群',
      !afterDissolve.items.some((item) => item.room_id === group.room.room_id),
      afterDissolve.items.map((item) => item.room_id),
    );
    const archivedGroup = await callTool<{ room: { status: string; read_only: boolean } }>(
      owner.connection.client,
      'network_room_get',
      { room_id: group.room.room_id },
    );
    checkEqual('解散群仍可用 room_get 读取', archivedGroup.room.status, 'dissolved');
    checkEqual('解散群为只读归档', archivedGroup.room.read_only, true);
  } finally {
    await Promise.all([
      owner.connection.close(),
      agentA.connection.close(),
      agentB.connection.close(),
      humanPeer.connection.close(),
    ]);
  }
}
