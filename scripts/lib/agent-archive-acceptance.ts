/**
 * Agent 软归档端到端验收。
 *
 * 固定在跨层语义上：归档从管理列表、好友列表、群成员/邀请与候选列举中
 * 隐藏 Agent，但保留 `network_agents_get` 详情、direct 会话对端与历史；
 * 不影响认证、消息、投递、统一流、在线状态与 login。
 * 工具契约细节（输入上限、输出 schema）由 `scripts/verify-protocol.ts` 覆盖。
 */

import {
  CheckFailure,
  baseUrl,
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  notificationCollector,
  openSubscription,
  sleep,
  type McpConnection,
} from './harness';
import {
  befriend,
  inbox,
  registerIdentity,
  sendMessage,
  type Delivery,
  type HistoryPage,
  type Identity,
  type LoginResult,
  type RoomDetail,
} from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';
const STREAM_EVENT_META = 'io.agent-network/event';

interface AgentSummaryView {
  actor_id: string;
  kind: string;
  name: string;
  agent_session_id: string | null;
  share_url: string | null;
  archived: boolean;
  archived_at: string | null;
  archived_by: string | null;
}

interface AgentsGetView {
  items: AgentSummaryView[];
  missing_actor_ids: string[];
}

interface ArchiveView {
  actor_id: string;
  archived: boolean;
  archived_at: string | null;
  archived_by: string | null;
}

interface AgentsManagedView {
  items: { actor_id: string; archived: boolean; disabled: boolean }[];
  has_more: boolean;
}

interface StreamItemView {
  source?: string;
  delivery_id?: string;
  message_id?: string;
}

function hasStreamItem(
  event: { params: Record<string, unknown> },
  predicate: (item: StreamItemView) => boolean,
): boolean {
  if (event.params.uri !== STREAM_URI) return false;
  const meta = event.params._meta as Record<string, unknown> | undefined;
  const payload = meta?.[STREAM_EVENT_META] as { items?: StreamItemView[] } | undefined;
  return (payload?.items ?? []).some(predicate);
}

/**
 * 输入 schema 由 MCP 层校验：SDK 把校验失败包成 `isError` 的
 * `Input validation error`，部分客户端返回协议错误 -32602；两者都要求
 * 调用失败。业务错误码仍由工具错误体给出。
 */
async function expectInvalidParams(label: string, promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : String(error);
    check(label, code === -32602 || message.includes('Input validation error'), {
      code,
      message,
    });
    return;
  }
  throw new CheckFailure(label, '期望参数校验失败，但调用成功');
}

export async function runAgentArchiveAcceptance(): Promise<void> {
  const ownerConn: McpConnection = await connectClient(newToken());
  const agentConn: McpConnection = await connectClient(newToken());
  const peerConn: McpConnection = await connectClient(newToken());

  try {
    const owner = await registerIdentity(ownerConn, { kind: 'human', name: '归档验收人类' });
    const agent = await registerIdentity(agentConn, {
      kind: 'agent',
      name: '归档验收 Agent',
      sessionId: `archive_agent_${crypto.randomUUID()}`,
    });
    const peer = await registerIdentity(peerConn, {
      kind: 'agent',
      name: '归档验收 Peer',
      sessionId: `archive_peer_${crypto.randomUUID()}`,
    });

    // 自注册 Agent 默认 unclaimed；owner 必须先完成双端认领才能归档。
    const archiveClaim = await callTool<{ claim_id: string; code: string }>(
      agentConn.client,
      'network_agent_claim_start',
      { request_id: newRequestId('claim_start') },
    );
    await callTool(ownerConn.client, 'network_agent_claim_confirm', {
      request_id: newRequestId('claim_confirm'),
      claim_id: archiveClaim.claim_id,
      code: archiveClaim.code,
    });

    const collector = notificationCollector(agentConn.client);
    const subscription = await openSubscription(agentConn.client, [STREAM_URI]);
    const loginBefore = await callTool<LoginResult>(agentConn.client, 'network_login');
    checkEqual('归档前 Agent 可上线', loginBefore.online, true);
    await collector.waitFor(
      (event) => hasStreamItem(event, (item) => item.source === 'session.login'),
      '等待归档前 session.login',
    );

    await callTool(ownerConn.client, 'network_contact_add', {
      request_id: newRequestId('contact'),
      actor_id: agent.actor_id,
    });
    await befriend(agentConn, agent.actor_id, peerConn, peer.actor_id);
    const room = await callTool<RoomDetail>(agentConn.client, 'network_room_create', {
      request_id: newRequestId('room'),
      kind: 'direct',
      members: [peer.actor_id],
    });
    const roomId = room.room.room_id;
    const baseline = await sendMessage(agentConn, roomId, '归档前基线消息');
    const beforeArchive = await callTool<RoomDetail>(peerConn.client, 'network_room_get', {
      room_id: roomId,
    });
    const archiveGroup = await callTool<RoomDetail>(ownerConn.client, 'network_room_create', {
      request_id: newRequestId('group'),
      kind: 'group',
      title: '归档成员过滤群',
      members: [agent.actor_id, peer.actor_id],
    });
    const archiveGroupId = archiveGroup.room.room_id;
    check(
      '归档前群成员包含 Agent',
      archiveGroup.members.some((member) => member.actor_id === agent.actor_id),
      archiveGroup.members,
    );
    await sleep(300);
    collector.reset();

    const archiveRequest = newRequestId('archive');
    const archived = await callTool<ArchiveView>(ownerConn.client, 'network_agent_archive', {
      request_id: archiveRequest,
      actor_id: agent.actor_id,
    });
    check('归档成功返回 archived: true', archived.archived === true, archived);
    checkEqual('归档记录调用者 actor_id', archived.archived_by, owner.actor_id);
    check('归档返回毫秒时间戳', Number.isInteger(Number(archived.archived_at)), archived.archived_at);
    await sleep(400);
    checkEqual('归档不产生 stream 通知', collector.events.length, 0);

    const got = await callTool<AgentsGetView>(ownerConn.client, 'network_agents_get', {
      actor_ids: [agent.actor_id, peer.actor_id, agent.actor_id, owner.actor_id, 'agt_missing'],
    });
    checkEqual(
      'agents_get 去重并保持输入顺序',
      got.items.map((item) => item.actor_id).join(','),
      [agent.actor_id, peer.actor_id].join(','),
    );
    checkEqual('agents_get 缺失列表包含人类与未知 ID', got.missing_actor_ids.length, 2);
    check(
      'agents_get 把人类与未知 ID 放入 missing',
      got.missing_actor_ids.includes(owner.actor_id) && got.missing_actor_ids.includes('agt_missing'),
      got.missing_actor_ids,
    );
    const summary = got.items[0]!;
    checkEqual('agents_get 返回 archived: true', summary.archived, true);
    checkEqual('agents_get 返回首次归档者', summary.archived_by, owner.actor_id);
    checkEqual('agents_get 保留 Agent kind', summary.kind, 'agent');
    check(
      'agents_get 返回分享链接但不返回凭据',
      typeof summary.share_url === 'string' &&
        summary.share_url.startsWith(`${baseUrl().replace(/\/+$/u, '')}/a/`) &&
        !Object.keys(summary).includes('metadata') &&
        !JSON.stringify(summary).includes('token'),
      summary,
    );

    const replayed = await callTool<ArchiveView>(ownerConn.client, 'network_agent_archive', {
      request_id: archiveRequest,
      actor_id: agent.actor_id,
    });
    checkEqual('同一 request_id 归档重放返回同一结果', replayed.archived_at, archived.archived_at);
    const repeated = await callTool<ArchiveView>(ownerConn.client, 'network_agent_archive', {
      request_id: newRequestId('archive'),
      actor_id: agent.actor_id,
    });
    checkEqual('不同 request_id 重复归档保留首次时间', repeated.archived_at, archived.archived_at);
    checkEqual('重复归档保留首次归档者', repeated.archived_by, owner.actor_id);

    await expectToolError(
      '归档未知 actor 返回 NOT_FOUND',
      callTool(ownerConn.client, 'network_agent_archive', {
        request_id: newRequestId('archive'),
        actor_id: 'agt_missing_actor',
      }),
      'NOT_FOUND',
    );
    await expectToolError(
      '归档人类 actor 返回 INVALID_ARGUMENT',
      callTool(ownerConn.client, 'network_agent_archive', {
        request_id: newRequestId('archive'),
        actor_id: owner.actor_id,
      }),
      'INVALID_ARGUMENT',
    );
    await expectToolError(
      '同一 request_id 改 actor_id 返回 IDEMPOTENCY_CONFLICT',
      callTool(ownerConn.client, 'network_agent_archive', {
        request_id: archiveRequest,
        actor_id: peer.actor_id,
      }),
      'IDEMPOTENCY_CONFLICT',
    );
    await expectInvalidParams(
      'agents_get 空数组被参数校验拒绝',
      callTool(ownerConn.client, 'network_agents_get', { actor_ids: [] }),
    );
    await expectInvalidParams(
      'agents_get 超过 100 个 ID 被参数校验拒绝',
      callTool(ownerConn.client, 'network_agents_get', {
        actor_ids: Array.from({ length: 101 }, (_, index) => `agt_limit_${index}`),
      }),
    );

    const meWhileArchived = await callTool<Identity>(agentConn.client, 'network_me');
    checkEqual('归档后 network_me 仍返回本人', meWhileArchived.actor_id, agent.actor_id);
    checkEqual('归档不改变 Agent 名称', meWhileArchived.name, agent.name);
    check('network_me 不暴露归档状态', !Object.keys(meWhileArchived).includes('archived'));

    const contacts = await callTool<{ items: { actor_id: string }[] }>(
      ownerConn.client,
      'network_contacts_list',
      {},
    );
    check(
      '归档后好友列表隐藏该 Agent',
      !contacts.items.some((item) => item.actor_id === agent.actor_id),
      contacts.items,
    );

    const managedDefault = await callTool<AgentsManagedView>(
      ownerConn.client,
      'network_agents_managed_list',
      { limit: 100 },
    );
    check(
      '管理列表默认隐藏归档 Agent',
      !managedDefault.items.some((item) => item.actor_id === agent.actor_id),
      managedDefault.items,
    );
    const managedWithArchived = await callTool<AgentsManagedView>(
      ownerConn.client,
      'network_agents_managed_list',
      { limit: 100, include_archived: true },
    );
    const archivedManaged = managedWithArchived.items.find(
      (item) => item.actor_id === agent.actor_id,
    );
    check(
      'include_archived 管理列表保留归档 Agent 与状态',
      archivedManaged?.archived === true && archivedManaged.disabled === false,
      managedWithArchived.items,
    );

    const roomWhileArchived = await callTool<RoomDetail>(peerConn.client, 'network_room_get', {
      room_id: roomId,
    });
    checkEqual('归档不改变房间 head', roomWhileArchived.room.head_seq, beforeArchive.room.head_seq);
    const archivedMember = roomWhileArchived.members.find(
      (member) => member.actor_id === agent.actor_id,
    );
    check('direct 会话保留归档 Agent 对端', Boolean(archivedMember), roomWhileArchived.members);
    checkEqual('归档不影响 direct 对端在线状态', archivedMember?.online, true);

    const groupWhileArchived = await callTool<RoomDetail>(ownerConn.client, 'network_room_get', {
      room_id: archiveGroupId,
    });
    check(
      '归档 Agent 不出现在群成员列表',
      !groupWhileArchived.members.some((member) => member.actor_id === agent.actor_id),
      groupWhileArchived.members,
    );
    check(
      '未归档成员仍出现在群成员列表',
      groupWhileArchived.members.some((member) => member.actor_id === peer.actor_id),
      groupWhileArchived.members,
    );

    const loginWhileArchived = await callTool<LoginResult>(agentConn.client, 'network_login');
    checkEqual('归档后仍可 login', loginWhileArchived.online, true);
    checkEqual('归档后 login 返回同一 actor', loginWhileArchived.actor_id, agent.actor_id);

    const deliveryStart = collector.events.length;
    const work = await sendMessage(peerConn, roomId, '归档后派活', {
      invoke: [agent.actor_id],
    });
    const deliveryId = work.delivery_ids[0];
    check('归档后仍可创建 delivery', Boolean(deliveryId), work.delivery_ids);
    await collector.waitFor(
      (event) =>
        hasStreamItem(
          event,
          (item) => item.source === 'delivery.created' && item.delivery_id === deliveryId,
        ),
      '等待归档后的 delivery.created',
    );
    check('归档后统一流仍推送 delivery', collector.events.length > deliveryStart);

    const pendingWhileArchived = await inbox(agentConn, 'pending');
    const pendingDelivery = pendingWhileArchived.items.find(
      (item) => item.delivery_id === deliveryId,
    );
    check('归档后 inbox 仍能读取待办', Boolean(pendingDelivery), pendingWhileArchived.items);
    const claimed = await callTool<Delivery>(agentConn.client, 'network_delivery_claim', {
      request_id: newRequestId('claim'),
      delivery_id: deliveryId as string,
    });
    checkEqual('归档后仍可 claim', claimed.state, 'claimed');
    const completed = await callTool<{ delivery: Delivery }>(
      agentConn.client,
      'network_delivery_complete',
      {
        request_id: newRequestId('complete'),
        delivery_id: deliveryId as string,
        attempt: claimed.attempt,
        claim_id: claimed.claim_id,
        final_body: '归档后完成',
      },
    );
    checkEqual('归档后仍可 complete', completed.delivery.state, 'completed');
    const history = await callTool<HistoryPage>(agentConn.client, 'network_history_list', {
      room_id: roomId,
    });
    check(
      '归档前后消息历史保持可读',
      history.items.some((item) => item.message_id === baseline.message.message_id) &&
        history.items.some((item) => item.preview === '归档后完成'),
      history.items.map((item) => item.message_id),
    );

    const unarchivedRequest = newRequestId('unarchive');
    const unarchived = await callTool<ArchiveView>(ownerConn.client, 'network_agent_unarchive', {
      request_id: unarchivedRequest,
      actor_id: agent.actor_id,
    });
    check('取消归档返回 archived: false', unarchived.archived === false, unarchived);
    checkEqual('取消归档清空 archived_at', unarchived.archived_at, null);
    checkEqual('取消归档清空 archived_by', unarchived.archived_by, null);
    const afterUnarchive = await callTool<AgentsGetView>(ownerConn.client, 'network_agents_get', {
      actor_ids: [agent.actor_id],
    });
    checkEqual('agents_get 反映取消归档', afterUnarchive.items[0]?.archived, false);
    const contactsAfter = await callTool<{ items: { actor_id: string }[] }>(
      ownerConn.client,
      'network_contacts_list',
      {},
    );
    check(
      '取消归档后好友列表重新包含该 Agent',
      contactsAfter.items.some((item) => item.actor_id === agent.actor_id),
      contactsAfter.items,
    );
    const managedAfter = await callTool<AgentsManagedView>(
      ownerConn.client,
      'network_agents_managed_list',
      { limit: 100 },
    );
    check(
      '取消归档后默认管理列表重新包含该 Agent',
      managedAfter.items.some(
        (item) => item.actor_id === agent.actor_id && item.archived === false,
      ),
      managedAfter.items,
    );
    const groupAfter = await callTool<RoomDetail>(ownerConn.client, 'network_room_get', {
      room_id: archiveGroupId,
    });
    check(
      '取消归档后群成员列表重新包含该 Agent',
      groupAfter.members.some((member) => member.actor_id === agent.actor_id),
      groupAfter.members,
    );
    const unarchiveReplay = await callTool<ArchiveView>(
      ownerConn.client,
      'network_agent_unarchive',
      { request_id: unarchivedRequest, actor_id: agent.actor_id },
    );
    checkEqual('同一 request_id 取消归档重放成功', unarchiveReplay.archived, false);
    await expectToolError(
      '取消归档未知 actor 返回 NOT_FOUND',
      callTool(ownerConn.client, 'network_agent_unarchive', {
        request_id: newRequestId('unarchive'),
        actor_id: 'agt_missing_actor',
      }),
      'NOT_FOUND',
    );
    const rearchived = await callTool<ArchiveView>(ownerConn.client, 'network_agent_archive', {
      request_id: newRequestId('archive'),
      actor_id: agent.actor_id,
    });
    check(
      '取消归档后可重新归档并刷新时间',
      rearchived.archived_at !== null &&
        Number(rearchived.archived_at) >= Number(archived.archived_at),
      { before: archived.archived_at, after: rearchived.archived_at },
    );

    await subscription.close();
  } finally {
    await Promise.all([
      ownerConn.close(),
      agentConn.close(),
      peerConn.close(),
    ]);
  }
}
