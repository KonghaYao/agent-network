/**
 * A01 身份归属与管理授权端到端验收（T01–T04）。
 *
 * 覆盖：human 原子创建 Agent、非管理者拒绝、双端认领、委托授予/撤销与
 * 重发 token 的顺序裁决、归档与停用正交、停用取消在途投递并保留任务状态。
 * 工具 schema 细节由 verify-protocol.ts 覆盖。
 */

import {
  callTool,
  check,
  checkEqual,
  connectClient,
  expectToolError,
  newRequestId,
  newToken,
  openSubscription,
  rawRpc,
  waitUntil,
  type McpConnection,
} from './harness';
import {
  registerIdentity,
  sendMessage,
  waitClosed,
  type Identity,
  type RoomDetail,
} from './acceptance-helpers';

const STREAM_URI = 'agentnet://stream';

interface AgentCreateView {
  actor_id: string;
  name: string;
  agent_session_id: string;
  share_url: string;
  token: string;
  mcp_url: string;
  management: { binding_id: string; permission_version: number; created_at: string };
}

interface ManagementView {
  actor_id: string;
  name: string;
  archived: boolean;
  disabled: boolean;
  disabled_reason: string | null;
  my_role: 'manager' | 'delegate' | 'agent';
  management: {
    manager_id: string;
    grant_source: string;
    permission_version: number;
  } | null;
  can_manage: boolean;
  can_delegate: boolean;
  pending_work: {
    pending_deliveries: number;
    claimed_deliveries: number;
    cancelled_deliveries: number;
    open_tasks: { task_id: string; status: 'pending' | 'claimed' }[];
    open_task_count: number;
  };
}

interface ClaimStartView {
  claim_id: string;
  agent_id: string;
  code: string;
  expires_at: string;
}

interface DisableView {
  actor_id: string;
  disabled: boolean;
  disabled_at: string;
  stopped: {
    pending_deliveries: number;
    claimed_deliveries: number;
    cancelled_deliveries: number;
    open_tasks: { task_id: string; status: 'pending' | 'claimed' }[];
    open_task_count: number;
  };
}

interface ReissueView {
  actor_id: string;
  token: string;
  mcp_url: string;
  revoked_count: number;
}

interface TaskView {
  task_id: string;
  status: string;
  title: string;
  owner_actor_id: string | null;
  blocked_reason: string | null;
}

interface TaskListResult {
  tasks: TaskView[];
  next_cursor: string | null;
  has_more: boolean;
}

interface AgentSummaryView {
  actor_id: string;
  archived: boolean;
  disabled: boolean;
  disabled_reason: string | null;
}

interface AgentsGetView {
  items: AgentSummaryView[];
  missing_actor_ids: string[];
}

interface RawErrorCode {
  body: { error?: { data?: { code?: string } } };
}

function rawErrorCode(result: RawErrorCode): string | undefined {
  return result.body.error?.data?.code;
}

async function expectRawError(
  label: string,
  promise: Promise<RawErrorCode>,
  expected: string,
): Promise<void> {
  const result = await promise;
  checkEqual(label, rawErrorCode(result), expected);
}

export async function runAgentIdentityAcceptance(): Promise<void> {
  const managerConn: McpConnection = await connectClient(newToken());
  const otherConn: McpConnection = await connectClient(newToken());
  const extraConns: McpConnection[] = [];

  try {
    const manager = await registerIdentity(managerConn, {
      kind: 'human',
      name: 'A01 管理者 U1',
    });
    const other = await registerIdentity(otherConn, {
      kind: 'human',
      name: 'A01 旁观者 U2',
    });

    // ------------------------------------------------------------------ T01
    console.log('  A01-T01 创建者管理与非管理者拒绝');
    const createRequest = newRequestId('a01_create');
    const created = await callTool<AgentCreateView>(managerConn.client, 'network_agent_create', {
      request_id: createRequest,
      name: 'A01 Agent B1',
    });
    checkEqual('network_agent_create 返回 Agent actor_id', created.actor_id.startsWith('agt_'), true);
    check(
      'network_agent_create 返回绑定与一次性 token',
      created.management.binding_id.startsWith('amb_') &&
        created.management.permission_version === 1 &&
        created.token.length > 0 &&
        new URL(created.mcp_url).searchParams.get('token') === created.token,
    );
    await expectToolError(
      'network_agent_create 同一 request_id 不重放 token',
      callTool(managerConn.client, 'network_agent_create', {
        request_id: createRequest,
        name: 'A01 Agent B1',
      }),
      'TOKEN_NOT_REPLAYABLE',
    );

    const agentConn = await connectClient(created.token);
    extraConns.push(agentConn);
    const agentIdentity = await callTool<Identity>(agentConn.client, 'network_me');
    checkEqual('新 Agent 用自己的 token 读取到同一身份', agentIdentity.actor_id, created.actor_id);

    const managed = await callTool<ManagementView>(
      managerConn.client,
      'network_agent_management_get',
      { actor_id: created.actor_id },
    );
    checkEqual('创建者读取管理关系为 manager', managed.my_role, 'manager');
    checkEqual('创建关系 grant_source 为 created', managed.management?.grant_source, 'created');
    checkEqual('创建者可以管理该 Agent', managed.can_manage, true);

    const renamed = await callTool<{ name: string }>(managerConn.client, 'network_agent_rename', {
      request_id: newRequestId('a01_rename'),
      actor_id: created.actor_id,
      name: 'A01 Agent B1 改名',
    });
    checkEqual('管理者可以重命名', renamed.name, 'A01 Agent B1 改名');

    await expectToolError(
      '非管理者无法改名',
      callTool(otherConn.client, 'network_agent_rename', {
        request_id: newRequestId('a01_rename_other'),
        actor_id: created.actor_id,
        name: '旁观者改名',
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      '非管理者无法重发 token',
      callTool(otherConn.client, 'network_agent_reissue_token', {
        request_id: newRequestId('a01_reissue_other'),
        actor_id: created.actor_id,
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      '非管理者无法归档',
      callTool(otherConn.client, 'network_agent_archive', {
        request_id: newRequestId('a01_archive_other'),
        actor_id: created.actor_id,
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      '非管理者无法读取管理关系',
      callTool(otherConn.client, 'network_agent_management_get', {
        actor_id: created.actor_id,
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      'Agent 自己不能重命名自己',
      callTool(agentConn.client, 'network_agent_rename', {
        request_id: newRequestId('a01_rename_self'),
        actor_id: created.actor_id,
        name: 'Agent 自改名',
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      '已有管理者的 Agent 不能再发起认领',
      callTool(agentConn.client, 'network_agent_claim_start', {
        request_id: newRequestId('a01_claim_managed'),
      }),
      'CLAIM_CONFLICT',
    );

    // ------------------------------------------------------------------ T02
    console.log('  A01-T02 旧 Agent 双端认领');
    const legacyToken = newToken();
    const legacyConn = await connectClient(legacyToken);
    extraConns.push(legacyConn);
    const legacy = await registerIdentity(legacyConn, {
      kind: 'agent',
      name: 'A01 旧 Agent',
      sessionId: `sess_a01_legacy_${crypto.randomUUID().replaceAll('-', '')}`,
    });
    const legacySelf = await callTool<ManagementView>(
      legacyConn.client,
      'network_agent_management_get',
      { actor_id: legacy.actor_id },
    );
    checkEqual('自注册 Agent 保持未认领', legacySelf.management, null);
    checkEqual('未认领 Agent 自身只读角色', legacySelf.my_role, 'agent');
    checkEqual('未认领 Agent 不能管理自己', legacySelf.can_manage, false);

    await expectToolError(
      '知道 actor_id 的人类不能直接改名接管',
      callTool(managerConn.client, 'network_agent_rename', {
        request_id: newRequestId('a01_legacy_rename'),
        actor_id: legacy.actor_id,
        name: '未授权改名',
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      '非管理者不能读取旧 Agent 管理关系',
      callTool(managerConn.client, 'network_agent_management_get', {
        actor_id: legacy.actor_id,
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      'human 不能代替 Agent 发起认领',
      callTool(otherConn.client, 'network_agent_claim_start', {
        request_id: newRequestId('a01_human_claim'),
      }),
      'PERMISSION_DENIED',
    );

    const claimRequestId = newRequestId('a01_claim_start');
    const claim = await callTool<ClaimStartView>(legacyConn.client, 'network_agent_claim_start', {
      request_id: claimRequestId,
    });
    check(
      '认领返回一次性 code 与尝试上限',
      claim.code.length >= 16 && claim.agent_id === legacy.actor_id,
      { claim_id: claim.claim_id },
    );
    await expectToolError(
      '认领 code 不能通过重放再次取得',
      callTool(legacyConn.client, 'network_agent_claim_start', {
        request_id: claimRequestId,
      }),
      'TOKEN_NOT_REPLAYABLE',
    );
    await expectToolError(
      '错误 code 不能绑定管理者',
      callTool(otherConn.client, 'network_agent_claim_confirm', {
        request_id: newRequestId('a01_claim_wrong'),
        claim_id: claim.claim_id,
        code: 'wrong-code-wrong-code-wrong',
      }),
      'PERMISSION_DENIED',
    );
    const confirmRequestId = newRequestId('a01_claim_confirm');
    const claimConfirmed = await callTool<{
      manager_id: string;
      agent_id: string;
      binding_id: string;
      confirmed_at: string;
    }>(
      otherConn.client,
      'network_agent_claim_confirm',
      {
        request_id: confirmRequestId,
        claim_id: claim.claim_id,
        code: claim.code,
      },
    );
    checkEqual('确认 code 后 human 成为管理者', claimConfirmed.manager_id, other.actor_id);
    checkEqual('认领绑定目标 Agent', claimConfirmed.agent_id, legacy.actor_id);
    const confirmReplay = await callTool<{ binding_id: string; confirmed_at: string }>(
      otherConn.client,
      'network_agent_claim_confirm',
      {
        request_id: confirmRequestId,
        claim_id: claim.claim_id,
        code: claim.code,
      },
    );
    checkEqual('确认认领重放返回同一绑定', confirmReplay.binding_id, claimConfirmed.binding_id);
    checkEqual('确认认领重放不重新写权限版本', confirmReplay.confirmed_at, claimConfirmed.confirmed_at);
    const legacyManaged = await callTool<ManagementView>(
      otherConn.client,
      'network_agent_management_get',
      { actor_id: legacy.actor_id },
    );
    checkEqual('认领后 grant_source 为 claim', legacyManaged.management?.grant_source, 'claim');
    await expectToolError(
      '认领后原旁观者立即失权',
      callTool(managerConn.client, 'network_agent_rename', {
        request_id: newRequestId('a01_legacy_rename_after'),
        actor_id: legacy.actor_id,
        name: '未授权改名',
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      'Agent 不能在已认领后再次发起认领',
      callTool(legacyConn.client, 'network_agent_claim_start', {
        request_id: newRequestId('a01_claim_again'),
      }),
      'CLAIM_CONFLICT',
    );

    // ------------------------------------------------------------------ T03
    console.log('  A01-T03 委托撤销与重发 token 顺序裁决');
    const granted = await callTool<{ delegation_id: string; delegate_actor_id: string }>(
      otherConn.client,
      'network_agent_delegate_grant',
      {
        request_id: newRequestId('a01_delegate_grant'),
        actor_id: legacy.actor_id,
        delegate_actor_id: manager.actor_id,
      },
    );
    checkEqual('委托授予目标 human', granted.delegate_actor_id, manager.actor_id);
    const delegateView = await callTool<ManagementView>(
      managerConn.client,
      'network_agent_management_get',
      { actor_id: legacy.actor_id },
    );
    checkEqual('受托人读取角色为 delegate', delegateView.my_role, 'delegate');
    checkEqual('受托人可以管理', delegateView.can_manage, true);
    const delegateRenamed = await callTool<{ name: string }>(
      managerConn.client,
      'network_agent_rename',
      {
        request_id: newRequestId('a01_delegate_rename'),
        actor_id: legacy.actor_id,
        name: 'A01 旧 Agent 受托改名',
      },
    );
    checkEqual('受托人可以重命名', delegateRenamed.name, 'A01 旧 Agent 受托改名');

    // 旧凭据建立的 stream 在重发 token 后必须由服务端关闭，不能继续收到新帧。
    const legacySubscription = await openSubscription(legacyConn.client, [STREAM_URI]);
    await waitUntil('旧凭据 stream 已建立', () =>
      Boolean(legacySubscription.honoredFilter.resourceSubscriptions?.length),
    );

    await expectToolError(
      '权限版本不匹配时重发 token 返回 VERSION_CONFLICT',
      callTool(managerConn.client, 'network_agent_reissue_token', {
        request_id: newRequestId('a01_reissue_stale_version'),
        actor_id: legacy.actor_id,
        expected_permission_version: 999,
      }),
      'VERSION_CONFLICT',
    );
    await expectToolError(
      '权限版本不匹配时改名返回 VERSION_CONFLICT',
      callTool(managerConn.client, 'network_agent_rename', {
        request_id: newRequestId('a01_rename_stale_version'),
        actor_id: legacy.actor_id,
        name: '版本不匹配改名',
        expected_permission_version: 999,
      }),
      'VERSION_CONFLICT',
    );

    const reissued = await callTool<ReissueView>(
      managerConn.client,
      'network_agent_reissue_token',
      {
        request_id: newRequestId('a01_delegate_reissue'),
        actor_id: legacy.actor_id,
      },
    );
    checkEqual('受托人可以重发 token', reissued.actor_id, legacy.actor_id);
    check('重发撤销至少一条旧凭据', reissued.revoked_count >= 1, reissued.revoked_count);
    checkEqual('重发后旧凭据 stream 被服务端关闭', await waitClosed(legacySubscription), 'graceful');
    await expectRawError(
      '重发后旧 token 立即失效',
      rawRpc('tools/call', { name: 'network_me', arguments: {} }, { token: legacyToken }) as Promise<RawErrorCode>,
      'CREDENTIAL_INVALID',
    );
    const newLegacyCall = await rawRpc(
      'tools/call',
      { name: 'network_me', arguments: {} },
      { token: reissued.token },
    );
    const newLegacyIdentity = (newLegacyCall.body.result as
      | { structuredContent?: { actor_id?: string } }
      | undefined)?.structuredContent;
    checkEqual('重发的新 token 可读取同一 actor', newLegacyIdentity?.actor_id, legacy.actor_id);

    const revokeRequestId = newRequestId('a01_delegate_revoke');
    const revoked = await callTool<{ delegation_id: string; revoked_at: string }>(
      otherConn.client,
      'network_agent_delegate_revoke',
      {
        request_id: revokeRequestId,
        actor_id: legacy.actor_id,
        delegate_actor_id: manager.actor_id,
      },
    );
    const revokeReplay = await callTool<{ delegation_id: string; revoked_at: string }>(
      otherConn.client,
      'network_agent_delegate_revoke',
      {
        request_id: revokeRequestId,
        actor_id: legacy.actor_id,
        delegate_actor_id: manager.actor_id,
      },
    );
    checkEqual('撤销委托重放返回同一结果', revokeReplay.delegation_id, revoked.delegation_id);
    checkEqual('撤销委托重放不重复写时间', revokeReplay.revoked_at, revoked.revoked_at);
    await expectToolError(
      '撤销委托后重发 token 失败',
      callTool(managerConn.client, 'network_agent_reissue_token', {
        request_id: newRequestId('a01_reissue_revoked'),
        actor_id: legacy.actor_id,
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      '撤销委托后改名失败',
      callTool(managerConn.client, 'network_agent_rename', {
        request_id: newRequestId('a01_rename_revoked'),
        actor_id: legacy.actor_id,
        name: '撤销后改名',
      }),
      'PERMISSION_DENIED',
    );
    await expectToolError(
      '权限版本不匹配时归档返回 VERSION_CONFLICT',
      callTool(otherConn.client, 'network_agent_archive', {
        request_id: newRequestId('a01_archive_version'),
        actor_id: legacy.actor_id,
        expected_permission_version: 999,
      }),
      'VERSION_CONFLICT',
    );

    // ------------------------------------------------------------------ T04
    console.log('  A01-T04 归档与停用正交以及待处理可见');
    const target = await callTool<AgentCreateView>(managerConn.client, 'network_agent_create', {
      request_id: newRequestId('a01_t04_create'),
      name: 'A01 Agent T04',
    });
    const targetConn = await connectClient(target.token);
    extraConns.push(targetConn);
    const room = await callTool<RoomDetail>(managerConn.client, 'network_room_create', {
      request_id: newRequestId('a01_t04_room'),
      kind: 'direct',
      members: [target.actor_id],
    });
    const roomId = room.room.room_id;

    await callTool(managerConn.client, 'network_agent_archive', {
      request_id: newRequestId('a01_t04_archive'),
      actor_id: target.actor_id,
    });
    const archivedSend = await sendMessage(targetConn, roomId, '归档后仍可发送');
    checkEqual('归档不阻止 Agent 聊天', archivedSend.message.preview, '归档后仍可发送');
    const archivedMe = await callTool<Identity>(targetConn.client, 'network_me');
    checkEqual('归档不阻止 Agent 工具调用', archivedMe.actor_id, target.actor_id);

    const task = await callTool<{ task: TaskView }>(managerConn.client, 'network_task_create', {
      request_id: newRequestId('a01_t04_task'),
      room_id: roomId,
      title: '停用后必须保持未完成的任务',
    });
    await callTool(targetConn.client, 'network_task_claim', {
      request_id: newRequestId('a01_t04_claim'),
      task_id: task.task.task_id,
    });
    await sendMessage(managerConn, roomId, '停用前投递', { invoke: [target.actor_id] });
    const beforeDisable = await callTool<ManagementView>(
      managerConn.client,
      'network_agent_management_get',
      { actor_id: target.actor_id },
    );
    check('停用前存在待处理投递', beforeDisable.pending_work.pending_deliveries >= 1, beforeDisable.pending_work);
    check(
      '停用前任务处于 claimed',
      beforeDisable.pending_work.open_tasks.some(
        (item) => item.task_id === task.task.task_id && item.status === 'claimed',
      ),
      beforeDisable.pending_work.open_tasks,
    );
    const targetSubscription = await openSubscription(targetConn.client, [STREAM_URI]);
    await waitUntil('被停用 Agent 的 stream 已建立', () =>
      Boolean(targetSubscription.honoredFilter.resourceSubscriptions?.length),
    );

    const disabled = await callTool<DisableView>(managerConn.client, 'network_agent_disable', {
      request_id: newRequestId('a01_t04_disable'),
      actor_id: target.actor_id,
      reason: 'A01 验收停用',
    });
    checkEqual('停用返回 disabled', disabled.disabled, true);
    checkEqual('停用后旧凭据 stream 被服务端关闭', await waitClosed(targetSubscription), 'graceful');
    check('停用报告取消的在途投递', disabled.stopped.pending_deliveries >= 1, disabled.stopped);
    check(
      '停用报告未完成的任务',
      disabled.stopped.open_tasks.some((item) => item.task_id === task.task.task_id),
      disabled.stopped.open_tasks,
    );
    await expectRawError(
      '停用后旧凭据工具调用返回 ACTOR_DISABLED',
      rawRpc('tools/call', { name: 'network_me', arguments: {} }, { token: target.token }) as Promise<RawErrorCode>,
      'ACTOR_DISABLED',
    );
    await expectToolError(
      '停用后新的 invoke 投递被拒绝',
      sendMessage(managerConn, roomId, '停用后投递', { invoke: [target.actor_id] }),
      'ACTOR_DISABLED',
    );
    const afterDisable = await callTool<ManagementView>(
      managerConn.client,
      'network_agent_management_get',
      { actor_id: target.actor_id },
    );
    checkEqual('停用状态可读', afterDisable.disabled, true);
    checkEqual('停用原因可读', afterDisable.disabled_reason, 'A01 验收停用');
    checkEqual('停用后 pending 投递清零', afterDisable.pending_work.pending_deliveries, 0);
    check('停用后投递标记为 cancelled', afterDisable.pending_work.cancelled_deliveries >= 1, afterDisable.pending_work);
    // D04 起停用会撤销执行资格：任务转 blocked、清空负责人与 current assignment，
    // 因此不再出现在“我的未完成任务”列表；权威状态必须仍可读取且不是 accepted。
    check(
      '停用后任务不再显示为本人 claimed',
      !afterDisable.pending_work.open_tasks.some(
        (item) => item.task_id === task.task.task_id,
      ),
      afterDisable.pending_work.open_tasks,
    );
    const taskList = await callTool<TaskListResult>(managerConn.client, 'network_task_list', {
      room_id: roomId,
    });
    const taskAfterDisable = taskList.tasks.find((item) => item.task_id === task.task.task_id);
    checkEqual('任务列表显示停用后进入 blocked', taskAfterDisable?.status, 'blocked');
    checkEqual('停用后任务负责人被清空', taskAfterDisable?.owner_actor_id, null);
    checkEqual(
      '停用后任务阻塞原因为 owner_lost_eligibility',
      taskAfterDisable?.blocked_reason,
      'owner_lost_eligibility',
    );
    check(
      '停用后任务没有被悄悄标成完成',
      taskAfterDisable !== undefined && taskAfterDisable.status !== 'accepted',
      taskAfterDisable,
    );
    checkEqual(
      '任务没有被计为已验收',
      taskList.tasks.filter((item) => item.status === 'accepted').length,
      0,
    );

    const summaries = await callTool<AgentsGetView>(managerConn.client, 'network_agents_get', {
      actor_ids: [target.actor_id],
    });
    checkEqual('agents_get 暴露停用状态', summaries.items[0]?.disabled, true);
    checkEqual('agents_get 保留归档状态', summaries.items[0]?.archived, true);

    await callTool(managerConn.client, 'network_agent_enable', {
      request_id: newRequestId('a01_t04_enable'),
      actor_id: target.actor_id,
    });
    const enabledMe = await callTool<Identity>(targetConn.client, 'network_me');
    checkEqual('启用后旧凭据恢复可用', enabledMe.actor_id, target.actor_id);
    const enabledTask = await callTool<{ task: TaskView }>(targetConn.client, 'network_task_get', {
      task_id: task.task.task_id,
    });
    checkEqual('启用后可读取被撤销执行资格的任务', enabledTask.task.status, 'blocked');
    checkEqual('启用不会自动恢复负责人', enabledTask.task.owner_actor_id, null);
  } finally {
    for (const connection of extraConns) await connection.close();
    await managerConn.close();
    await otherConn.close();
  }
}
