/**
 * Agent 入群添加验收（P0 回归）。
 *
 * 覆盖建群与添加成员共用的规则：人类仍须好友；Agent 在 unclaimed 或
 * 当前调用者是其 active manager 时可无好友直接 active；被其他人管理的
 * Agent 仍须好友；拉黑优先于所有关系判断。另验证新建 Agent 的 direct
 * 会话自动建立 auto_manager 关系，以及成员变更的幂等重放。
 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  type McpConnection,
} from './harness';
import {
  registerIdentity,
  type Identity,
  type RoomDetail,
} from './acceptance-helpers';

interface ActorView {
  actor_id: string;
  name: string;
  agent_session_id?: string | null;
}

interface ManagedAgentView extends ActorView {
  token: string;
  mcp_url: string;
}

interface GroupDetail extends RoomDetail {
  invited: { actor_id: string }[];
  results?: {
    actor_id: string;
    status: 'active' | 'invited' | 'failed';
    code: string | null;
  }[];
}

interface ContactPage {
  items: { actor_id: string; relation: 'active' | 'none' }[];
}

interface ContactResult {
  status: string;
  already_friends: boolean;
  relation: { status: string; source: string } | null;
}

async function unclaimedAgent(name: string): Promise<{ connection: McpConnection; actor: Identity }> {
  const connection = await connectClient(newToken());
  const actor = await registerIdentity(connection, {
    kind: 'agent',
    name,
    sessionId: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
  return { connection, actor };
}

async function managedAgent(manager: McpConnection, name: string): Promise<ActorView> {
  return callTool<ManagedAgentView>(manager.client, 'network_agent_create', {
    request_id: newRequestId('p0_agent'),
    name,
    agent_session_id: `sess_${crypto.randomUUID().replaceAll('-', '')}`,
  });
}

function resultCode(detail: GroupDetail, actorId: string): string | null {
  return detail.results?.find((result) => result.actor_id === actorId)?.code ?? null;
}

function resultStatus(detail: GroupDetail, actorId: string): string | null {
  return detail.results?.find((result) => result.actor_id === actorId)?.status ?? null;
}

function memberIds(detail: GroupDetail): string[] {
  return detail.members.map((member) => member.actor_id).sort();
}

async function directRoom(owner: McpConnection, target: string): Promise<RoomDetail> {
  return callTool<RoomDetail>(owner.client, 'network_room_create', {
    request_id: newRequestId('p0_direct'),
    kind: 'direct',
    members: [target],
  });
}

export async function runAgentRoomAddAcceptance(): Promise<void> {
  console.log('  · P0 Agent 与人一致的入群添加');
  const ownerConnection = await connectClient(newToken());
  const otherManagerConnection = await connectClient(newToken());
  const humanStrangerConnection = await connectClient(newToken());
  const unclaimed = await unclaimedAgent('P0 存量未认领 Agent');
  const otherUnclaimed = await unclaimedAgent('P0 群内未认领 Agent');
  const blocked = await unclaimedAgent('P0 被拉黑 Agent');
  // 生产数据中的 6 个旧 Agent：无 contact_relations、无 active manager。
  const legacyAgents = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      unclaimedAgent(`P0 生产旧 Agent ${index + 1}`),
    ),
  );
  try {
    const owner = await registerIdentity(ownerConnection, { kind: 'human', name: 'P0 群主' });
    const otherManager = await registerIdentity(otherManagerConnection, {
      kind: 'human',
      name: 'P0 其他管理者',
    });
    const humanStranger = await registerIdentity(humanStrangerConnection, {
      kind: 'human',
      name: 'P0 非好友人类',
    });
    const ownManaged = await managedAgent(ownerConnection, 'P0 自有 Agent');
    const ownManagedSecond = await managedAgent(ownerConnection, 'P0 自有 Agent 二');
    const foreignManaged = await managedAgent(otherManagerConnection, 'P0 他人管理 Agent');

    // 1. 建群：unclaimed 与自有 Agent 都直接 active，结果逐对象可解释。
    const created = await callTool<GroupDetail>(ownerConnection.client, 'network_room_create', {
      request_id: newRequestId('p0_group'),
      kind: 'group',
      title: 'P0 Agent 群',
      members: [unclaimed.actor.actor_id, ownManaged.actor_id],
    });
    checkEqual('P0 建群：unclaimed Agent 记为 active', resultStatus(created, unclaimed.actor.actor_id), 'active');
    checkEqual('P0 建群：自有 managed Agent 记为 active', resultStatus(created, ownManaged.actor_id), 'active');
    checkEqual('P0 建群：active 成员含 unclaimed Agent', created.members.some((member) => member.actor_id === unclaimed.actor.actor_id), true);
    checkEqual('P0 建群：active 成员含自有 Agent', created.members.some((member) => member.actor_id === ownManaged.actor_id), true);
    checkEqual('P0 建群：没有生成 Agent 邀请', created.invited.length, 0);
    checkEqual('P0 建群：成员数为 3', created.room.member_count, 3);

    // 1b. 生产旧数据回放：6 个无关系、无 active manager 的 Agent 全部 active。
    const legacyGroup = await callTool<GroupDetail>(ownerConnection.client, 'network_room_create', {
      request_id: newRequestId('p0_legacy_group'),
      kind: 'group',
      title: 'P0 生产旧 Agent 群',
      members: legacyAgents.map((agent) => agent.actor.actor_id),
    });
    checkEqual('P0 生产旧数据：6 个 unclaimed Agent 全部 active', legacyGroup.members.length, 7);
    checkEqual('P0 生产旧数据：没有 pending 邀请', legacyGroup.invited.length, 0);
    checkEqual(
      'P0 生产旧数据：每个 Agent 都出现在有效成员中',
      legacyAgents.every((agent) =>
        legacyGroup.members.some((member) => member.actor_id === agent.actor.actor_id),
      ),
      true,
    );

    // 2. 建群预检：他人管理且非好友的 Agent、非好友人类仍 FRIEND_REQUIRED。
    const foreignCreateError = await expectToolError(
      'P0 建群：他人管理的非好友 Agent 返回 FRIEND_REQUIRED',
      callTool(ownerConnection.client, 'network_room_create', {
        request_id: newRequestId('p0_group_foreign'),
        kind: 'group',
        title: 'P0 应失败群',
        members: [foreignManaged.actor_id],
      }),
      'FRIEND_REQUIRED',
    );
    check(
      'P0 建群：失败结果标出他人管理的 Agent',
      resultCode(foreignCreateError.body.details as GroupDetail, foreignManaged.actor_id) === 'FRIEND_REQUIRED',
      foreignCreateError.body.details,
    );
    await expectToolError(
      'P0 建群：非好友人类仍返回 FRIEND_REQUIRED',
      callTool(ownerConnection.client, 'network_room_create', {
        request_id: newRequestId('p0_group_human'),
        kind: 'group',
        title: 'P0 人类应失败群',
        members: [humanStranger.actor_id],
      }),
      'FRIEND_REQUIRED',
    );

    // 3. 拉黑优先：建群与加成员都返回 BLOCKED。
    await callTool(ownerConnection.client, 'network_contact_block', {
      request_id: newRequestId('p0_block'),
      actor_id: blocked.actor.actor_id,
      reason: 'P0 验收拉黑',
    });
    await expectToolError(
      'P0 建群：拉黑的 unclaimed Agent 返回 BLOCKED',
      callTool(ownerConnection.client, 'network_room_create', {
        request_id: newRequestId('p0_group_blocked'),
        kind: 'group',
        title: 'P0 拉黑应失败群',
        members: [blocked.actor.actor_id],
      }),
      'BLOCKED',
    );

    // 4. 既有群添加：与建群同一规则，无好友的 unclaimed/自有 Agent 直接 active。
    const base = await callTool<GroupDetail>(ownerConnection.client, 'network_room_create', {
      request_id: newRequestId('p0_base'),
      kind: 'group',
      title: 'P0 添加成员群',
      members: [ownManaged.actor_id],
    });
    const roomId = base.room.room_id;
    const addRequestId = newRequestId('p0_add');
    const added = await callTool<GroupDetail>(ownerConnection.client, 'network_room_members_update', {
      request_id: addRequestId,
      room_id: roomId,
      add: [otherUnclaimed.actor.actor_id, ownManagedSecond.actor_id],
    });
    checkEqual('P0 添加成员：unclaimed Agent 直接 active', added.members.some((member) => member.actor_id === otherUnclaimed.actor.actor_id), true);
    checkEqual('P0 添加成员：自有 managed Agent 直接 active', added.members.some((member) => member.actor_id === ownManagedSecond.actor_id), true);
    checkEqual('P0 添加成员：成员数为 4', added.room.member_count, 4);

    const replay = await callTool<GroupDetail>(ownerConnection.client, 'network_room_members_update', {
      request_id: addRequestId,
      room_id: roomId,
      add: [otherUnclaimed.actor.actor_id, ownManagedSecond.actor_id],
    });
    checkEqual('P0 添加成员：同一 request_id 重放返回同一房间', replay.room.room_id, roomId);
    checkEqual('P0 添加成员：重放不重复添加', replay.room.member_count, 4);
    checkEqual(
      'P0 添加成员：重放后成员集合不变',
      memberIds(replay).join(','),
      memberIds(added).join(','),
    );

    // 5. 加成员预检：他人管理非好友 Agent 与人类非好友仍失败；拉黑优先。
    await expectToolError(
      'P0 添加成员：他人管理的非好友 Agent 返回 FRIEND_REQUIRED',
      callTool(ownerConnection.client, 'network_room_members_update', {
        request_id: newRequestId('p0_add_foreign'),
        room_id: roomId,
        add: [foreignManaged.actor_id],
      }),
      'FRIEND_REQUIRED',
    );
    await expectToolError(
      'P0 添加成员：非好友人类返回 FRIEND_REQUIRED',
      callTool(ownerConnection.client, 'network_room_members_update', {
        request_id: newRequestId('p0_add_human'),
        room_id: roomId,
        add: [humanStranger.actor_id],
      }),
      'FRIEND_REQUIRED',
    );
    await expectToolError(
      'P0 添加成员：拉黑的 Agent 返回 BLOCKED',
      callTool(ownerConnection.client, 'network_room_members_update', {
        request_id: newRequestId('p0_add_blocked'),
        room_id: roomId,
        add: [blocked.actor.actor_id],
      }),
      'BLOCKED',
    );

    // 6. Agent 有好友关系时仍允许加入（他人管理也可）。
    const friendRequest = await callTool<{ request?: { contact_request_id: string } | null }>(
      ownerConnection.client,
      'network_contact_request',
      {
        request_id: newRequestId('p0_friend_foreign'),
        actor_id: foreignManaged.actor_id,
      },
    );
    if (friendRequest.request?.contact_request_id) {
      await callTool(otherManagerConnection.client, 'network_contact_request_respond', {
        request_id: newRequestId('p0_friend_respond'),
        contact_request_id: friendRequest.request.contact_request_id,
        action: 'accept',
      });
    }
    const addedFriend = await callTool<GroupDetail>(ownerConnection.client, 'network_room_members_update', {
      request_id: newRequestId('p0_add_friend'),
      room_id: roomId,
      add: [foreignManaged.actor_id],
    });
    checkEqual(
      'P0 添加成员：他人管理 Agent 成为好友后可加入',
      addedFriend.members.some((member) => member.actor_id === foreignManaged.actor_id),
      true,
    );

    // 7. 新建 Agent 的 direct 会话自动建立 auto_manager 关系。
    const freshAgent = await managedAgent(ownerConnection, 'P0 新建直聊 Agent');
    const direct = await directRoom(ownerConnection, freshAgent.actor_id);
    checkEqual('P0 新建 Agent：direct 会话创建成功', direct.room.kind, 'direct');
    checkEqual('P0 新建 Agent：direct 含双方成员', direct.members.length, 2);
    const relationProbe = await callTool<ContactResult>(
      ownerConnection.client,
      'network_contact_request',
      {
        request_id: newRequestId('p0_relation_probe'),
        actor_id: freshAgent.actor_id,
      },
    );
    checkEqual('P0 新建 Agent：direct 后关系为 active', relationProbe.relation?.status, 'active');
    checkEqual('P0 新建 Agent：关系来源为 auto_manager', relationProbe.relation?.source, 'auto_manager');
    checkEqual('P0 新建 Agent：无需 pending 好友申请', relationProbe.already_friends, true);
    const contacts = await callTool<ContactPage>(ownerConnection.client, 'network_contacts_list', {
      limit: 100,
    });
    checkEqual(
      'P0 新建 Agent：contacts 中显示 active 关系',
      contacts.items.find((item) => item.actor_id === freshAgent.actor_id)?.relation,
      'active',
    );
  } finally {
    await Promise.all([
      ownerConnection.close(),
      otherManagerConnection.close(),
      humanStrangerConnection.close(),
      unclaimed.connection.close(),
      otherUnclaimed.connection.close(),
      blocked.connection.close(),
      ...legacyAgents.map((agent) => agent.connection.close()),
    ]);
  }
}
