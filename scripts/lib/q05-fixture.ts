/**
 * Q05 固定夹具：U1–U4 人类与 B1–B3 管理 Agent，以及可复用的主群与 direct 会话。
 *
 * B1–B3 由 U1 创建，因此建群时直接 active；U2/U3 是 U1 好友，通过真实定向
 * 邀请接受后加入。夹具只建立测试前置关系，不替代任何被测业务动作。
 */

import {
  acceptPendingInvites,
  befriend,
  createGroup,
  createManagedAgent,
  q05Equal,
  q05Tool,
  registerHuman,
  type Q05Actor,
  type Q05Server,
} from './q05-harness';

export interface Q05Fixture {
  u1: Q05Actor;
  u2: Q05Actor;
  u3: Q05Actor;
  u4: Q05Actor;
  u5: Q05Actor;
  b1: Q05Actor;
  b2: Q05Actor;
  b3: Q05Actor;
  /** 与 [u1,u2,u3,u4] 对齐；每个 human 拥有 3 个自有 Agent。 */
  agentsByOwner: Q05Actor[][];
  mainRoomId: string;
  directU1U2: string;
}

export async function setupQ05Fixture(server: Q05Server): Promise<Q05Fixture> {
  const [u1, u2, u3, u4, u5] = await Promise.all([
    registerHuman(server, 'Q05 U1 群主'),
    registerHuman(server, 'Q05 U2 成员'),
    registerHuman(server, 'Q05 U3 成员'),
    registerHuman(server, 'Q05 U4 群主候选'),
    registerHuman(server, 'Q05 U5 外部'),
  ]);
  const [b1, b2, b3] = await Promise.all([
    createManagedAgent(server, u1.token, 'Q05 B1 Agent'),
    createManagedAgent(server, u1.token, 'Q05 B2 Agent'),
    createManagedAgent(server, u1.token, 'Q05 B3 Agent'),
  ]);
  const [u2Agents, u3Agents, u4Agents] = await Promise.all([
    Promise.all(
      [1, 2, 3].map((index) => createManagedAgent(server, u2.token, `Q05 C${index} Agent`)),
    ),
    Promise.all(
      [1, 2, 3].map((index) => createManagedAgent(server, u3.token, `Q05 D${index} Agent`)),
    ),
    Promise.all(
      [1, 2, 3].map((index) => createManagedAgent(server, u4.token, `Q05 E${index} Agent`)),
    ),
  ]);

  // 人类成员两两好友；每个 human 与其自有 Agent 自动建联。
  const humans = [u1, u2, u3, u4];
  for (let left = 0; left < humans.length; left += 1) {
    for (let right = left + 1; right < humans.length; right += 1) {
      await befriend(server, humans[left]!, humans[right]!);
    }
  }
  const agentsByOwner = [[b1, b2, b3], u2Agents, u3Agents, u4Agents];
  for (let index = 0; index < humans.length; index += 1) {
    for (const agent of agentsByOwner[index]!) {
      const requested = await q05Tool<{ status: string }>(
        server,
        humans[index]!.token,
        'network_contact_request',
        {
          request_id: `q05_self_agent_${agent.actor_id}`,
          actor_id: agent.actor_id,
        },
      );
      if (requested.status !== 'accepted') {
        throw new Error(`管理者与自有 Agent 未自动建联: ${requested.status}`);
      }
    }
  }

  const mainRoomId = await createGroup(server, u1, [u2, u3, b1, b2, b3], 'Q05 并发对抗主群');
  const detail = await q05Tool<{
    room: { room_id: string; owner_id: string | null };
    members: { actor_id: string; role: string }[];
  }>(server, u1.token, 'network_room_get', { room_id: mainRoomId });
  q05Equal('夹具主群 owner 唯一', detail.room.owner_id, u1.actor_id);
  const active = new Set(detail.members.map((member) => member.actor_id));
  for (const actor of [u1, u2, u3, b1, b2, b3]) {
    q05Equal(`夹具成员 active (${actor.name})`, active.has(actor.actor_id), true);
  }

  // direct U1×U2 用于流通知与凭据重连补读。
  const direct = await q05Tool<{ room: { room_id: string } }>(
    server,
    u1.token,
    'network_room_create',
    {
      request_id: `q05_direct_${u2.actor_id}`,
      kind: 'direct',
      members: [u2.actor_id],
    },
  );
  await acceptPendingInvites(server, u2, direct.room.room_id);

  return {
    u1,
    u2,
    u3,
    u4,
    u5,
    b1,
    b2,
    b3,
    agentsByOwner,
    mainRoomId,
    directU1U2: direct.room.room_id,
  };
}
